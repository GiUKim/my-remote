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
const { safeName, freePath, stagedPath, sweep } = require('../host/files');

const PRELOAD = path.join(__dirname, 'preload.js');
// Not 'clipboard-read': the page (sent by the host) never reads this PC's clipboard itself. Pasted text
// and files reach it through the paste event, and copied text through shell:clipPoll, which hands over
// only text that changed while a session is on, never what a password manager marked as private.
const ALLOWED = new Set(['window-management', 'fullscreen', 'keyboardLock', 'pointerLock', 'clipboard-sanitized-write']);
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
//   files that cannot go onto the clipboard either     -> into the Downloads folder, as a browser saves them
// Clicking and typing on this PC happen only here, only on Windows, and only for a drop this process
// saw the person make: a mouse button pressed over one of this app's windows and let go elsewhere
// just before the page asked where (personsDrop). The page comes from the host, so its word is not
// enough for that. Never on the taskbar, the Start menu or a console (NO_CLICK). On Linux (X11) only
// the desktop counts as a folder and nothing is ever clicked or typed: everything else goes onto the
// clipboard. The window under the pointer and the clipboard's file list come from the host's module
// (host/input.js: Win32 or X11 through koffi); without it (macOS) files go into Downloads and text
// onto the clipboard.
const FRESH_MS = 8000;
const REAL_MS = 400; // from letting go of the button to the page asking where that was
const FOLDERISH = new Set(['Progman', 'WorkerW', 'CabinetWClass', 'ExploreWClass']); // the desktop, Explorer windows
// Where a click does something else than put the cursor there: the taskbar and its pop-ups (it would
// minimise a window, open a menu or bring another program forward), the Start menu, and consoles,
// where pasted lines run as commands. What is let go there only goes onto the clipboard.
const NO_CLICK = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'TaskListThumbnailWnd', 'Windows.UI.Core.CoreWindow', 'ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS']);
const drops = new Map();  // id -> { at, x, y, hwnd, cls, desktop, own, real, folder: Promise<path | null> }
const staged = new Map(); // id -> { path, fd, done, group }: files being received
// Forgets a received file, closing it if it is still being written.
function unstage(id) {
  const f = staged.get(id);
  if (!f) return;
  staged.delete(id);
  if (f.fd != null) { try { fs.closeSync(f.fd); } catch {} f.fd = null; }
}
let dropSeq = 0, native;
function win32() { // Win32 on Windows, X11 on Linux
  if (native === undefined) { try { native = require('../host/input'); } catch (e) { console.error('the input module is not available:', e.message); native = null; } }
  return native;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (win) => { const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0); };
// Whether a top-level window is one of this app's: of the client `s`, or of any client.
const ownWindow = (hwnd, s) => (s ? [s] : [...shells.values()]).some((x) => [x.win, ...x.children].some((w) => !w.isDestroyed() && hwndOf(w) === hwnd));
// The mouse buttons as last read (Windows): when they were all let go, and whether that press began
// over one of our windows. A drag out of the remote picture always does.
const press = { held: 0, own: false, fromOwn: false, upAt: 0 };
// Reads the buttons and notes a press or a release. False where they cannot be read (not Windows).
function trackButtons() {
  const w = process.platform === 'win32' ? win32() : null;
  let held = null;
  try { held = w ? w.buttonsHeld() : null; } catch {}
  if (typeof held !== 'number') return false;
  if (held && !press.held) {
    let at = null;
    try { at = w.underPointer(); } catch {}
    press.own = !!at && ownWindow(at.hwnd);
  } else if (!held && press.held) { press.upAt = Date.now(); press.fromOwn = press.own; }
  press.held = held;
  return true;
}
// Whether the person has just let go of something dragged out of one of our windows: the buttons
// are up, they went up at most REAL_MS ago, and the press began over our window. One release counts
// for one drop only, so asking again gets false.
function personsDrop() {
  if (!trackButtons() || press.held || !press.fromOwn || Date.now() - press.upAt > REAL_MS) return false;
  press.fromOwn = false;
  return true;
}
// Received files wait here until they are placed: this user's own folder (on Linux the temp folder is shared by all users).
const stageDir = () => (process.platform === 'win32' ? path.join(os.tmpdir(), 'my-remote-drop')
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'my-remote-drop'));
// Moves a received file or folder into `dir` under a free name; across drives it is copied.
function moveInto(dir, file) {
  const to = freePath(dir, path.basename(file));
  try { fs.renameSync(file, to); } catch {
    if (fs.statSync(file).isDirectory()) { fs.cpSync(file, to, { recursive: true, errorOnExist: true, force: false }); fs.rmSync(file, { recursive: true, force: true }); }
    else { fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL); fs.unlinkSync(file); }
  }
  return to;
}
// Moves received files into `dir`; the staging folders they leave empty go too.
function saveInto(dir, files) {
  for (const f of files) { moveInto(dir, f); try { fs.rmdirSync(path.dirname(f)); } catch {} }
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
  if (p.desktop || p.cls === 'Progman' || p.cls === 'WorkerW') return Promise.resolve(app.getPath('desktop')); // X11 says `desktop`; Windows by class
  if (p.cls === 'CabinetWClass' || p.cls === 'ExploreWClass') return explorerFolder(p.hwnd);
  return Promise.resolve(null);
}
// Whether a drop may be clicked on: the person's own (personsDrop), not over our own windows or
// something a click would set off, not long ago (the person has moved on), and not clicked on before.
const mayClick = (d, now = Date.now()) => !!d && d.real === true && !d.own && !d.clicked && !NO_CLICK.has(d.cls) && now - d.at <= FRESH_MS;
// One click where the thing was let go, then Ctrl+V. Only on Windows.
async function pasteAt(d) {
  const w = win32();
  if (process.platform !== 'win32' || !w || !mayClick(d)) return false;
  d.clicked = true;
  try { w.clickAt(d.x, d.y); await sleep(160); w.tap(['ControlLeft', 'KeyV']); return true; } catch (e) { console.error('paste at the drop point', e); return false; }
}
// Received files (in the staging folder) go to where they were dropped. Returns { how, where }.
async function placeFiles(files, d) {
  const folder = d ? await d.folder : null;
  if (folder) {
    try {
      saveInto(folder, files);
      return { how: 'saved', where: path.basename(folder) || folder };
    } catch (e) { console.error('saving into the folder', e); }
  }
  const left = files.filter((f) => fs.existsSync(f)), w = win32();
  let ok = false;
  try { ok = !!w && left.length > 0 && !!(await w.setClipboardFiles(left)); } catch (e) { console.error('files onto the clipboard', e); } // a promise on Linux
  if (ok) return { how: (await pasteAt(d)) ? 'pasted' : 'clipboard' };
  // Neither a folder nor the clipboard (no way to put files there on this system, as on macOS, or
  // another program holds the clipboard): into Downloads, else onto the desktop, where they are
  // found again, rather than staying in the staging folder. `where` is the whole path.
  for (const name of left.length ? ['downloads', 'desktop'] : []) {
    try {
      const dir = app.getPath(name);
      fs.mkdirSync(dir, { recursive: true });
      saveInto(dir, left.filter((f) => fs.existsSync(f)));
      return { how: 'saved', where: dir };
    } catch (e) { console.error(`saving into ${name}`, e); }
  }
  return { how: '', where: left.length ? path.dirname(left[0]) : '' };
}

let ipcReady = false;
function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
  // Received files that were never placed are thrown away after two days.
  sweep(stageDir(), 2 * 86400000);
  // The buttons are read every 25 ms while one of our windows has the focus (a drag out of the
  // picture begins with a press in one, which gives it the focus) or a button is held. Windows only.
  if (process.platform === 'win32') {
    const poll = setInterval(() => {
      if ((press.held || BrowserWindow.getFocusedWindow()) && !trackButtons()) clearInterval(poll);
    }, 25);
  }
  ipcMain.handle('shell:dropPoint', (e) => {
    const s = shellOf(e.sender), w = win32();
    if (!s || !w) return null;
    const real = personsDrop();
    let at = null;
    try { at = w.underPointer(); } catch (err) { console.error('drop point', err); }
    if (!at) return null;
    const own = ownWindow(at.hwnd, s);
    const id = ++dropSeq;
    drops.set(id, { at: Date.now(), ...at, own, real, folder: own ? Promise.resolve(null) : targetFolder(at) });
    if (drops.size > 20) drops.delete(drops.keys().next().value);
    return id;
  });
  // Whether the real pointer is over one of this client's windows (true) or another program (false)
  // right now: the page's own reckoning from window rectangles cannot see a window lying over ours.
  // Null where it cannot be told (only Windows says).
  ipcMain.handle('shell:pointerOwn', (e) => {
    const s = shellOf(e.sender), w = process.platform === 'win32' ? win32() : null;
    if (!s || !w) return null;
    let at = null;
    try { at = w.underPointer(); } catch {}
    return at && at.hwnd ? ownWindow(at.hwnd, s) : null;
  });
  // The clipboard is shared with the host in both directions, in a window and in fullscreen (the one
  // exception to "fullscreen is the host, a window is this PC"). The page asks about twice a second
  // while connected; text copied here goes over at once. Not what a password manager marked as not to
  // be kept or passed on, and not a file list (files go over when pasted on the host).
  // (Electron's clipboard reads and writes return promises since Electron 44.)
  ipcMain.handle('shell:clipPoll', async (e, lastSeq) => {
    const m = shellOf(e.sender) ? win32() : null;
    if (!m) return null;
    try {
      const seq = m.clipSeq();
      if (seq === lastSeq) return { seq };
      if (await m.clipboardPrivate()) return { seq, private: true };
      if ((await m.clipboardFiles()).length) return { seq, files: true };
      const text = String((await clipboard.readText()) || '');
      return { seq, text: text.length <= 60000 ? text : '' };
    } catch { return null; }
  });
  // Text copied on the host, onto this PC's clipboard at once (also while none of our windows has the
  // focus, which the page's own clipboard writing needs).
  ipcMain.handle('shell:clipWrite', async (e, text) => {
    if (!shellOf(e.sender) || typeof text !== 'string' || text.length > 60000) return false;
    await clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('shell:dropText', async (e, id, text) => {
    if (!shellOf(e.sender) || typeof text !== 'string' || text.length > 200000) return '';
    await clipboard.writeText(text); // before Ctrl+V is pressed at the drop point
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
  // A transfer that was cut off (the connection dropped, the host gave up): the file being written is
  // closed and thrown away together with the rest of its transfer, instead of staying open until the
  // app quits and lying in the staging folder for two days.
  ipcMain.handle('shell:fileAbort', (e, id) => {
    const f = shellOf(e.sender) ? staged.get(id) : null;
    if (!f) return false;
    if (f.group) {
      for (const [k, x] of staged) if (x.group === f.group) unstage(k);
      try { fs.rmSync(f.group, { recursive: true, force: true }); } catch (err) { console.error('removing a cut-off transfer', err); }
    } else {
      unstage(id);
      try { fs.rmSync(f.path, { force: true }); fs.rmdirSync(path.dirname(f.path)); } catch {}
    }
    return true;
  });
  ipcMain.handle('shell:dropFiles', async (e, id, ids, group) => {
    if (!shellOf(e.sender) || !Array.isArray(ids)) return { how: '' };
    const got = ids.map((x) => staged.get(x)).filter((f) => f && f.done);
    for (const x of ids) unstage(x);
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

// An empty address: window.open('') may arrive as '', 'about:blank' or 'about:blank#blocked'.
const blank = (url) => !url || /^about:blank([?#]|$)/.test(url);
// Every window gets mrShell, so none may go anywhere else than the page it shows (a file let go
// beside the picture would otherwise replace the page). A reload, which the page does to fetch its
// new version from the host, stays possible.
function stayOnPage(wc) {
  wc.on('will-navigate', (e, url) => {
    const to = String((e && e.url) || url || '');
    if (blank(to)) return;
    try {
      const a = new URL(to), b = new URL(wc.getURL());
      if (a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname && a.search === b.search) return;
    } catch {}
    e.preventDefault();
  });
}

// Tells a window's page when the window is minimized or hidden and when it is back (see preload.js):
// with backgroundThrottling off its visibilityState stays 'visible', and the host would go on sending
// what nobody sees.
function reportShown(bw) {
  const send = () => { if (!bw.isDestroyed()) bw.webContents.send('shell:shown', bw.isVisible() && !bw.isMinimized()); };
  for (const ev of ['minimize', 'restore', 'hide', 'show']) bw.on(ev, send);
}

function attach(win) {
  setupIpc();
  const wc = win.webContents;
  const state = { win, children: new Set() };
  shells.set(wc.id, state);
  win.on('closed', () => shells.delete(wc.id));
  reportShown(win);

  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  wc.session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // A window the page opens with a position goes, borderless, onto the screen at that position. The
  // page opens empty windows and fills them itself; nothing else is opened, since it would get mrShell.
  wc.setWindowOpenHandler(({ url, features }) => {
    if (!blank(url)) return { action: 'deny' };
    const num = (k) => { const r = new RegExp('(?:^|,)\\s*' + k + '=(-?\\d+)').exec(features || ''); return r ? Number(r[1]) : null; };
    const left = num('left'), top = num('top');
    const opts = { autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: { preload: PRELOAD, backgroundThrottling: false } };
    if (left != null && top != null) {
      const d = screen.getDisplayNearestPoint({ x: left + 20, y: top + 20 });
      Object.assign(opts, { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false });
    }
    return { action: 'allow', overrideBrowserWindowOptions: opts };
  });
  stayOnPage(wc);
  wc.on('did-create-window', (child) => {
    state.children.add(child);
    child.setMenuBarVisibility(false);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // the page opens its windows from the main one
    stayOnPage(child.webContents);
    reportShown(child);
    child.on('closed', () => state.children.delete(child));
  });
  return state;
}

module.exports = { attach, PRELOAD, _drop: { safeName, freePath, placeFiles, explorerFolder, stagedPath, moveInto, mayClick, NO_CLICK } };
