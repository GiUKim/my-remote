// What the client app adds over a plain browser tab. The page itself is the same
// one a browser gets (it is fetched from the host by the loader); a browser only
// allows one new window and one fullscreen request per click and limits where
// windows may go. Here the page's windows are put on the screen they ask for and
// made fullscreen without further clicks, and nothing asks for permission.
const { BrowserWindow, ipcMain, screen, clipboard, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PRELOAD = path.join(__dirname, 'preload.js');
const ALLOWED = new Set(['window-management', 'fullscreen', 'keyboardLock', 'pointerLock', 'clipboard-read', 'clipboard-sanitized-write']);
const FULLSCREEN_JS = `document.documentElement.requestFullscreen()
  .then(() => (navigator.keyboard && navigator.keyboard.lock ? navigator.keyboard.lock() : null))
  .then(() => true, () => false)`;
const shells = new Map(); // main webContents id -> { win, children }

function shellOf(sender) {
  for (const s of shells.values()) {
    if (s.win.webContents === sender) return s;
    for (const c of s.children) if (!c.isDestroyed() && c.webContents === sender) return s;
  }
  return null;
}

// ---- things dragged out of the remote picture and let go over this PC ---------------
// The page tells us the moment the pointer is let go (dropPoint); what was dragged arrives a
// little later (text) or possibly much later (files). Where it then goes:
//   files, let go over a folder window or the desktop  -> written into that folder; nothing is clicked or typed
//   anything else, while the drop is still recent      -> onto the clipboard, one click at that spot, Ctrl+V
//   otherwise                                          -> onto the clipboard; the page asks for Ctrl+V
// Clicking and typing on this PC happen only here, only right after the person's own drop, and
// only at the spot they chose. Win32 comes from the host's module (host/input.js, koffi); without
// it things only reach the clipboard.
const FRESH_MS = 8000;
const FOLDERISH = new Set(['Progman', 'WorkerW', 'CabinetWClass', 'ExploreWClass']); // the desktop, Explorer windows
const drops = new Map();  // id -> { at, x, y, hwnd, cls, own, folder: Promise<path | null> }
const staged = new Map(); // id -> { path, fd, done }: files being received
let dropSeq = 0, native;
function win32() {
  if (native === undefined) { try { native = require('../host/input'); } catch (e) { console.error('Win32 module not available:', e.message); native = null; } }
  return native;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stageDir = () => path.join(os.tmpdir(), 'my-remote-drop');
// A file name that is safe to create here, whatever the other side called the file.
function safeName(name) {
  const n = String(name).replace(/[\\/]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 200);
  return n && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n) ? n : 'file';
}
// "name.ext", or "name (2).ext", "name (3).ext", ... when that is taken.
function freePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) { const f = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`); if (!fs.existsSync(f)) return f; }
  throw new Error('no free file name');
}
// Moves a received file or folder into `dir` under a free name; across drives it is copied.
function moveInto(dir, file) {
  const to = freePath(dir, path.basename(file));
  try { fs.renameSync(file, to); } catch {
    if (fs.statSync(file).isDirectory()) { fs.cpSync(file, to, { recursive: true, errorOnExist: true, force: false }); fs.rmSync(file, { recursive: true, force: true }); }
    else { fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL); fs.unlinkSync(file); }
  }
  return to;
}
// A path inside `base` for a name from the other side ('folder/sub/file.txt'): every part made safe,
// nothing that could climb out of `base`.
function stagedPath(base, name) {
  const parts = String(name).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeName).slice(0, 64);
  return path.join(base, ...(parts.length ? parts : ['file']));
}
// The folder an Explorer window shows (asked of the shell, read-only). Null when it is not a real
// folder (This PC, a library, ...) or when the window has several tabs and it is unclear which one is in front.
function explorerFolder(hwnd) {
  return new Promise((resolve) => {
    const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$r=@();foreach($w in (New-Object -ComObject Shell.Application).Windows()){try{if([int64]$w.HWND -eq ${Number(hwnd)}){$r+=$w.Document.Folder.Self.Path}}catch{}};$r -join [char]10`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => {
      const list = [...new Set(String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
      let dir = null;
      try { if (!err && list.length === 1 && path.isAbsolute(list[0]) && fs.statSync(list[0]).isDirectory()) dir = list[0]; } catch {}
      resolve(dir);
    });
  });
}
function targetFolder(p) {
  if (p.cls === 'Progman' || p.cls === 'WorkerW') return Promise.resolve(app.getPath('desktop'));
  if (p.cls === 'CabinetWClass' || p.cls === 'ExploreWClass') return explorerFolder(p.hwnd);
  return Promise.resolve(null);
}
const hwndOf = (win) => { const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
// One click where the thing was let go, then Ctrl+V. Not when the drop is old (the person has moved on).
async function pasteAt(d) {
  const w = win32();
  if (!w || !d || d.own || Date.now() - d.at > FRESH_MS) return false;
  try { w.clickAt(d.x, d.y); await sleep(160); w.tap(['ControlLeft', 'KeyV']); return true; } catch (e) { console.error('paste at the drop point', e); return false; }
}
// Received files (in the staging folder) go to where they were dropped. Returns { how, where }.
async function placeFiles(files, d) {
  const folder = d ? await d.folder : null;
  if (folder) {
    try {
      for (const f of files) { moveInto(folder, f); try { fs.rmdirSync(path.dirname(f)); } catch {} }
      return { how: 'saved', where: path.basename(folder) || folder };
    } catch (e) { console.error('saving into the folder', e); }
  }
  const left = files.filter((f) => fs.existsSync(f)), w = win32();
  let ok = false;
  try { ok = !!w && left.length > 0 && w.setClipboardFiles(left); } catch (e) { console.error('files onto the clipboard', e); }
  if (!ok) return { how: '', where: left.length ? path.dirname(left[0]) : '' };
  return { how: (await pasteAt(d)) ? 'pasted' : 'clipboard' };
}

let ipcReady = false;
function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
  // Received files that were never placed are thrown away after two days.
  try { for (const n of fs.readdirSync(stageDir())) { const f = path.join(stageDir(), n); if (Date.now() - fs.statSync(f).mtimeMs > 2 * 86400000) fs.rmSync(f, { recursive: true, force: true }); } } catch {}
  ipcMain.handle('shell:dropPoint', (e) => {
    const s = shellOf(e.sender), w = win32();
    if (!s || !w) return null;
    let at = null;
    try { at = w.underPointer(); } catch (err) { console.error('drop point', err); }
    if (!at) return null;
    const own = [s.win, ...s.children].some((x) => !x.isDestroyed() && hwndOf(x) === at.hwnd);
    const id = ++dropSeq;
    drops.set(id, { at: Date.now(), ...at, own, folder: own ? Promise.resolve(null) : targetFolder(at) });
    if (drops.size > 20) drops.delete(drops.keys().next().value);
    return id;
  });
  ipcMain.handle('shell:dropText', async (e, id, text) => {
    if (!shellOf(e.sender) || typeof text !== 'string' || text.length > 200000) return '';
    clipboard.writeText(text);
    const d = drops.get(id);
    if (d && FOLDERISH.has(d.cls)) return 'copied'; // a folder cannot take text
    return (await pasteAt(d)) ? 'pasted' : 'copied';
  });
  // `group` (pages from 2026-11-13 on): every file of one transfer goes under one folder, keeping the
  // folders a dragged folder had; `name` may then be 'folder/sub/file'. Without it, each file gets a
  // folder of its own (older pages).
  const groupDir = (group) => (typeof group === 'string' && /^[a-z0-9]{4,32}$/.test(group) ? path.join(stageDir(), 'g-' + group) : null);
  ipcMain.handle('shell:fileBegin', (e, name, group) => {
    if (!shellOf(e.sender)) return null;
    const g = groupDir(group);
    const file = g ? stagedPath(g, name) : path.join(stageDir(), crypto.randomBytes(6).toString('hex'), safeName(name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = crypto.randomBytes(8).toString('hex'), at = fs.existsSync(file) ? freePath(path.dirname(file), path.basename(file)) : file;
    staged.set(id, { path: at, fd: fs.openSync(at, 'wx'), done: false, group: g });
    return id;
  });
  ipcMain.handle('shell:makeDir', (e, name, group) => {
    const g = groupDir(group);
    if (!shellOf(e.sender) || !g) return false;
    fs.mkdirSync(stagedPath(g, name), { recursive: true });
    return true;
  });
  ipcMain.handle('shell:fileChunk', (_e, id, bytes) => {
    const f = staged.get(id);
    if (!f || f.fd == null) throw new Error('no such file');
    fs.writeSync(f.fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return true;
  });
  ipcMain.handle('shell:fileEnd', (_e, id) => {
    const f = staged.get(id);
    if (!f || f.fd == null) return false;
    fs.closeSync(f.fd);
    f.fd = null; f.done = true;
    return true;
  });
  ipcMain.handle('shell:dropFiles', async (e, id, ids, group) => {
    if (!shellOf(e.sender) || !Array.isArray(ids)) return { how: '' };
    const got = ids.map((x) => staged.get(x)).filter((f) => f && f.done);
    for (const x of ids) staged.delete(x);
    // What goes to the drop target: the top-level files and folders of the transfer.
    const g = groupDir(group);
    let items = got.map((f) => f.path);
    if (g) { try { items = fs.readdirSync(g).map((n) => path.join(g, n)); } catch {} }
    const r = items.length ? await placeFiles(items, drops.get(id)) : { how: '' };
    if (g && r.how === 'saved') { try { fs.rmdirSync(g); } catch {} }
    return r;
  });
  // Screens in the coordinates window.open() uses, left to right is up to the page.
  ipcMain.handle('shell:screens', (e) => {
    const s = shellOf(e.sender);
    const here = s ? screen.getDisplayMatching(s.win.getBounds()).id : screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      left: d.bounds.x, top: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      availLeft: d.bounds.x, availTop: d.bounds.y, availWidth: d.bounds.width, availHeight: d.bounds.height,
      current: d.id === here, scale: d.scaleFactor,
    }));
  });
  // Fullscreen every window of this client, as if each had been clicked.
  ipcMain.handle('shell:fullscreenAll', async (e) => {
    const s = shellOf(e.sender);
    if (!s) return false;
    const wins = [s.win, ...s.children].filter((w) => !w.isDestroyed());
    const res = await Promise.all(wins.map((w) => w.webContents.executeJavaScript(FULLSCREEN_JS, true).catch(() => false)));
    return res.every(Boolean);
  });
}

function attach(win) {
  setupIpc();
  const wc = win.webContents;
  const state = { win, children: new Set() };
  shells.set(wc.id, state);
  win.on('closed', () => shells.delete(wc.id));

  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  wc.session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // A window the page opens with a position goes, borderless, onto the screen at that position.
  wc.setWindowOpenHandler(({ features }) => {
    const num = (k) => { const r = new RegExp('(?:^|,)\\s*' + k + '=(-?\\d+)').exec(features || ''); return r ? Number(r[1]) : null; };
    const left = num('left'), top = num('top');
    const opts = { autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: { preload: PRELOAD, backgroundThrottling: false } };
    if (left != null && top != null) {
      const d = screen.getDisplayNearestPoint({ x: left + 20, y: top + 20 });
      Object.assign(opts, { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false });
    }
    return { action: 'allow', overrideBrowserWindowOptions: opts };
  });
  wc.on('did-create-window', (child) => {
    state.children.add(child);
    child.setMenuBarVisibility(false);
    child.on('closed', () => state.children.delete(child));
  });
  return state;
}

module.exports = { attach, PRELOAD, _drop: { safeName, freePath, placeFiles, explorerFolder, stagedPath, moveInto } };
