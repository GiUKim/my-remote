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
// The app's icon for its windows (the taskbar, Alt+Tab, X11's window list): the installed app's shell has
// it in resources/app, a source folder in app/. Without it Windows showed the exe's own icon (Electron's)
// for windows of an app started without our shortcut, and X11 a generic one.
const ICON = (() => {
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png'];
  for (const dir of [path.join(process.resourcesPath || '', 'app'), path.join(__dirname, '..', 'app')]) {
    for (const n of names) { const f = path.join(dir, n); if (fs.existsSync(f)) return f; }
  }
  return undefined;
})();
// Not 'clipboard-read': the page (sent by the host) never reads this PC's clipboard itself. Pasted text
// and files reach it through the paste event, and copied text through shell:clipPoll, which hands over
// only text that changed while a session is on, never what a password manager marked as private.
const ALLOWED = new Set(['window-management', 'fullscreen', 'keyboardLock', 'pointerLock', 'clipboard-sanitized-write']);
// Keyboard Lock only through the safe wrapper the preload put in (keylock.js): a lock taken while Ctrl, Alt or the
// Windows key is held leaves that key pressed for the whole system. Without the wrapper, no lock (the system's
// shortcuts then stay on this PC in fullscreen, which is the lesser harm).
const FULLSCREEN_JS = `document.documentElement.requestFullscreen()
  .then(() => (navigator.keyboard && navigator.keyboard.lock && window.Keyboard && Keyboard.prototype.__mrSafe ? navigator.keyboard.lock() : null))
  .then(() => true, () => false)`;
// The wrapper's text, for the preload to put into the page's own world (a sandboxed preload cannot require it).
const KEYLOCK_JS = `(${require('./keylock').safeKeyboardLock})(window, () => (window.mrShell && window.mrShell.modsHeld ? window.mrShell.modsHeld() : null));`;
const shells = new Map(); // main webContents id -> { win, children, host }
// The app's list of PCs (client/main.js), when there is one: { key(id) -> Promise<key | null>,
// info(id, what the page says about its session), home(), and for this PC as a device of a host:
// device(id) -> Promise<{ id, secret } | null>, hello(), paired(id, { id, secret }), verified(id, tokenFp),
// and whether that PC's host has signed a page: signedSeen(id), markSigned(id) (see pagecheck.decide) }.
// A window opened for a PC of that list (attach(win, { host: id })) gets that PC's key or token from here;
// see shell:bootKey and shell:bootDevice.
let list = null;
function setList(hooks) { list = hooks || null; }
// Pages a release signed (client/pagecheck.js): only they get what the app adds to a browser. The release keys
// are the shell's; a test adds one of its own (client/main.js --trust-page-key=, with --loader= only).
const pagecheck = require('./pagecheck');
let testPageKey = '';
function setTestPageKey(k) { testPageKey = typeof k === 'string' && /^[A-Za-z0-9+/=]{40,120}$/.test(k) ? k : ''; }
const pageKeys = () => [...pagecheck.releaseKeys(), ...(testPageKey ? [testPageKey] : [])];

// ---- connections that come back on themselves (host/cycle.js; from 0.9.0) -----------------------------
// The page puts into its hello which host runs on this PC (that host's id for this start, from its running.json:
// localHost, set by client/main.js), and says which host its window controls (liveHost: the id in that host's
// offer; '' when the session ends). Those ids are kept in live.json in this app's profile while any window
// controls a host, written again every 10 s (one older than 30 s is from an app that is gone, see cycle.js) and
// removed when none does. This PC's host reads it and turns away the client app of a PC this app controls.
let localHostOf = () => '';
function setLocalHost(fn) { localHostOf = typeof fn === 'function' ? fn : () => ''; }
const HOST_ID = /^[A-Za-z0-9_-]{8,40}$/;
let liveTimer = null, liveWritten = false;
function writeLive() {
  const hosts = [...new Set([...shells.values()].map((s) => s.liveHost).filter(Boolean))];
  if (!hosts.length && !liveWritten) return;
  const file = path.join(app.getPath('userData'), 'live.json');
  try {
    if (hosts.length) {
      fs.writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, at: Date.now(), hosts }));
      fs.renameSync(file + '.tmp', file);
      liveWritten = true;
    } else { fs.rmSync(file, { force: true }); liveWritten = false; }
  } catch (e) { console.error('[client] live.json', e.message); }
  if (hosts.length && !liveTimer) liveTimer = setInterval(writeLive, 10000);
  else if (!hosts.length && liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}
function setLiveHost(state, id) {
  const v = typeof id === 'string' && HOST_ID.test(id) ? id : '';
  if (state.liveHost === v) return;
  state.liveHost = v;
  writeLive();
}

function shellOf(sender) {
  for (const s of shells.values()) {
    if (s.win.webContents === sender) return s;
    for (const c of s.children) if (!c.isDestroyed() && c.webContents === sender) return s;
  }
  return null;
}
// The shell of a window whose page a release signed (shell:pageCheck), or of one a test trusts (attach's
// `trust`): saving files, the clipboard, the click and Ctrl+V after a drop; also the page of a PC whose host
// never signed one (a host from before 0.8.0: pagecheck.decide's `legacy`). Device tokens only for a signed
// page (`signedPage`). Other pages run as in a browser.
function trusted(e) { const s = shellOf(e.sender); return s && (s.trusted || s.trustAlways) ? s : null; }
function signedPage(e) { const s = shellOf(e.sender); return s && ((s.trusted && !s.legacy) || s.trustAlways) ? s : null; }

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

// ---- what is being carried out, shown at the pointer --------------------------------
// While something dragged on the host is carried over to this PC, the real pointer is outside the
// remote picture, where a page cannot draw: the host's own drag picture stays behind at the edge of
// the picture, and the person saw a bare pointer. This small window follows the pointer with what is
// being brought (as a local drag shows its item) until the page says it is over. It takes no clicks
// and no focus, sits beside the pointer, never under it (so the window under the pointer is still the
// drop target), and is none of the client's windows (ownWindow). It also goes away by itself: when no
// button is held any more (Windows, where the buttons can be read) or 20 s after the page last said so.
const GHOST_PAGE = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
  #chip { display: inline-flex; align-items: center; gap: 8px; max-width: 300px; box-sizing: border-box; margin: 2px; padding: 6px 12px 6px 8px;
    border-radius: 9px; background: rgba(29, 34, 41, .96); border: 1px solid #4a8dff; color: #e6e8eb; font: 13px "Segoe UI", "Malgun Gothic", sans-serif;
    box-shadow: 0 3px 10px rgba(0, 0, 0, .45); }
  #icon { flex: none; width: 22px; height: 22px; }
  #text { min-width: 0; }
  #name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
  #hint { font-size: 11px; color: #8fb8ff; white-space: nowrap; }
</style><div id="chip"><svg id="icon" viewBox="0 0 24 24"></svg><div id="text"><div id="name"></div><div id="hint"></div></div></div><script>
  const ICON = {
    files: '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#dfe6ee"/><path d="M14 2v5h5" fill="#aeb9c6"/>',
    text: '<rect x="3" y="4" width="18" height="16" rx="2" fill="#dfe6ee"/><path d="M7 9h10M7 12h10M7 15h6" stroke="#5b6573" stroke-width="1.6"/>',
  };
  window.set = (o) => {
    document.getElementById('icon').innerHTML = ICON[o.kind] || ICON.files;
    document.getElementById('name').textContent = o.name;
    document.getElementById('hint').textContent = o.hint;
    const r = document.getElementById('chip').getBoundingClientRect();
    return { w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 };
  };
</script>`;
let ghost = null; // { win, ready, timer, until }
function ghostOff() {
  if (!ghost) return;
  clearInterval(ghost.timer);
  ghost.timer = null;
  if (!ghost.win.isDestroyed()) ghost.win.hide();
}
function ghostGone() {
  if (!ghost) return;
  clearInterval(ghost.timer);
  if (!ghost.win.isDestroyed()) ghost.win.destroy();
  ghost = null;
}
async function ghostOn(o) {
  if (!ghost || ghost.win.isDestroyed()) {
    const win = new BrowserWindow({
      width: 240, height: 48, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, hasShadow: false, fullscreenable: false, minimizable: false, maximizable: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver'); // also above a fullscreen client window
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    ghost = { win, timer: null, until: 0, ready: win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(GHOST_PAGE)) };
  }
  const g = ghost;
  g.until = Date.now() + 20000;
  await g.ready;
  if (ghost !== g || g.win.isDestroyed()) return false;
  // What is shown is text only, put there as text (the page that names it comes from the host).
  const kind = o.kind === 'text' ? 'text' : 'files';
  const name = String(o.label || '').slice(0, 120) || (kind === 'text' ? '선택한 글자' : '끌어온 항목');
  const size = await g.win.webContents.executeJavaScript(`set(${JSON.stringify({ kind, name, hint: '＋ 놓으면 이 PC로 복사' })})`).catch(() => null);
  if (ghost !== g || g.win.isDestroyed()) return false;
  if (size && size.w > 0 && size.h > 0) g.win.setContentSize(Math.min(320, size.w), Math.min(80, size.h));
  // Beside the pointer, wherever that is; false when it is over: no button is held any more (where
  // that can be read), or the page went quiet.
  const follow = () => {
    if (g.win.isDestroyed() || Date.now() > g.until || (process.platform === 'win32' && trackButtons() && !press.held)) return false;
    const p = screen.getCursorScreenPoint();
    g.win.setPosition(p.x + 16, p.y + 18, false);
    return true;
  };
  if (!g.timer) {
    if (!follow()) { ghostOff(); return false; }
    g.win.showInactive();
    g.timer = setInterval(() => { if (!follow()) ghostOff(); }, 16);
  }
  return true;
}

let ipcReady = false;
function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
  // What is being carried out of the remote picture, shown at the pointer (see above). `o.on` false ends it.
  // A window opened for a PC of the app's list. Its loader is given that PC's key (preload.js puts it into
  // the loader's own field and presses its button), so the person is not asked and the key is never in
  // an address. Only the window's own top page gets it: the loader file, or the page the loader wrote
  // in its place, which has the key anyway; the window can go nowhere else (stayOnPage).
  const listed = (e) => { const s = shellOf(e.sender); return s && s.host && list && e.sender === s.win.webContents && (!e.senderFrame || e.senderFrame === e.sender.mainFrame) ? s : null; };
  ipcMain.on('shell:inList', (e) => { e.returnValue = !!listed(e); });
  // Keyboard Lock without stuck modifier keys (keylock.js): the wrapper for every window of ours, and whether the
  // system holds Ctrl, Alt or a Windows key now (Windows; null elsewhere). Answered only to a window that has the
  // focus, which sees those keys itself then: a page must not learn of keys pressed in other programs.
  // (The wrapper to anyone: a window the page opened asks before it is known as one of ours, and it is our own code.)
  ipcMain.on('shell:keylock', (e) => { e.returnValue = KEYLOCK_JS; });
  ipcMain.handle('shell:modsHeld', (e) => {
    const bw = shellOf(e.sender) ? BrowserWindow.fromWebContents(e.sender) : null;
    const w = bw && bw.isFocused() && process.platform === 'win32' ? win32() : null;
    try { return w ? !!w.modifiersHeld() : null; } catch { return null; }
  });
  ipcMain.handle('shell:bootKey', async (e) => { const s = listed(e); return s ? list.key(s.host) : null; });
  // A window opened for a one-time code (client/main.js home:oneTime): the code, once, to its own top page.
  const coded = (e) => { const s = shellOf(e.sender); return s && s.code && e.sender === s.win.webContents && (!e.senderFrame || e.senderFrame === e.sender.mainFrame) ? s : null; };
  ipcMain.on('shell:hasCode', (e) => { e.returnValue = !!coded(e); });
  ipcMain.handle('shell:bootCode', (e) => { const s = coded(e); if (!s) return null; const c = s.code; s.code = ''; return c; });
  // This PC as a device of that host (see "Devices" in CLAUDE.md): the token the loader connects with
  // instead of the key, what the host is told about this PC, the token the host gave, and that it worked.
  // The relay a token's loader talks to is its own (the one it is built for), never one a page names.
  ipcMain.handle('shell:bootDevice', async (e) => { const s = listed(e); return s && list.device ? list.device(s.host) : null; });
  // Only a page a release signed takes part in device tokens (a page from someone posing as the host must not
  // leave this app a token of theirs, nor make it let go of the key).
  ipcMain.handle('shell:deviceHello', (e) => (listed(e) && signedPage(e) && list.hello ? list.hello() : null));
  ipcMain.handle('shell:devicePaired', async (e, dev) => {
    const s = listed(e);
    if (!s || !signedPage(e) || !list.paired || !dev || typeof dev !== 'object') return false;
    return list.paired(s.host, { id: String(dev.id || ''), secret: String(dev.secret || '') });
  });
  ipcMain.handle('shell:deviceVerified', async (e, fp) => { const s = listed(e); return !!(s && signedPage(e) && list.verified && (await list.verified(s.host, String(fp || '')))); });
  // The page about to run in a window (its loader asks before it writes it in): one a release signed? Asked by
  // the window's own top page only, and once per load: the hash is the loader's word for the page it is about
  // to run, and the page that then runs must not ask again with another page's hash for its own code. The
  // answer holds until the window loads anything else.
  ipcMain.handle('shell:pageCheck', (e, o) => {
    const s = shellOf(e.sender);
    if (!s || e.sender !== s.win.webContents || (e.senderFrame && e.senderFrame !== e.sender.mainFrame)) return false;
    if (s.checked) return !!(s.trusted && !s.legacy);
    s.checked = true;
    const r = pagecheck.verifyPage(o && typeof o === 'object' ? o : {}, pageKeys());
    // A PC of the list whose host never sent a signed page keeps what it had before 0.8.0 (pagecheck.decide).
    const inList = !!(s.host && list), pinned = inList && !!(list.signedSeen && list.signedSeen(s.host));
    const d = pagecheck.decide(r, { listed: inList, pinned });
    s.trusted = d.trusted;
    s.legacy = d.legacy;
    if (d.pin && list.markSigned) list.markSigned(s.host);
    if (!r.ok && !s.toldUnsigned) {
      s.toldUnsigned = true;
      console.log(d.legacy ? '[client] the host sent no signed page (a host from before 0.8.0): its page keeps what it had, without device tokens'
        : `[client] the host's page is not one a release signed (${r.why}): it runs as in a browser, without saving files, the clipboard or device tokens`);
    }
    return r.ok;
  });
  // What the page says about its session: connected or not, and what the host said it is.
  ipcMain.handle('shell:hostInfo', (e, info) => { const s = listed(e); if (!s) return false; list.info(s.host, info && typeof info === 'object' ? info : {}); return true; });
  // Connections that come back on themselves (see writeLive above): pages a release signed only.
  ipcMain.handle('shell:localHost', (e) => { if (!trusted(e)) return ''; try { return String(localHostOf() || ''); } catch { return ''; } });
  ipcMain.handle('shell:liveHost', (e, id) => {
    const s = trusted(e);
    if (!s || e.sender !== s.win.webContents) return false;
    setLiveHost(s, id);
    return true;
  });
  app.on('will-quit', () => { for (const s of shells.values()) s.liveHost = ''; writeLive(); });
  ipcMain.handle('shell:home', (e) => { if (!listed(e)) return false; list.home(); return true; });
  ipcMain.handle('shell:dragGhost', async (e, o) => {
    if (!shellOf(e.sender)) return false;
    if (!o || !o.on) { ghostOff(); return true; }
    return ghostOn(o).catch((err) => { console.error('drag ghost', err); return false; });
  });
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
    const s = trusted(e), w = win32();
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
    const m = trusted(e) ? win32() : null;
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
    if (!trusted(e) || typeof text !== 'string' || text.length > 60000) return false;
    await clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('shell:dropText', async (e, id, text) => {
    if (!trusted(e) || typeof text !== 'string' || text.length > 200000) return '';
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
    if (!trusted(e)) return null;
    const g = groupDir(group);
    const file = g ? stagedPath(g, name) : path.join(stageDir(), crypto.randomBytes(6).toString('hex'), safeName(name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = crypto.randomBytes(8).toString('hex'), at = fs.existsSync(file) ? freePath(path.dirname(file), path.basename(file)) : file;
    staged.set(id, { path: at, fd: fs.openSync(at, 'wx'), done: false, group: g });
    return id;
  });
  ipcMain.handle('shell:makeDir', (e, name, group) => {
    const g = groupDir(group);
    if (!trusted(e) || !g) return false;
    fs.mkdirSync(stagedPath(g, name), { recursive: true });
    return true;
  });
  ipcMain.handle('shell:fileChunk', (e, id, bytes) => {
    const f = trusted(e) ? staged.get(id) : null;
    if (!f || f.fd == null) throw new Error('no such file');
    fs.writeSync(f.fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return true;
  });
  ipcMain.handle('shell:fileEnd', (e, id) => {
    const f = trusted(e) ? staged.get(id) : null;
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
    if (!trusted(e) || !Array.isArray(ids)) return { how: '' };
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

// host: the id of the PC of the app's list this window is for (see setList), if any. trust: a test's own page
// (the self-test's in-process windows), which no release signed.
function attach(win, { host = null, trust = false, code = '' } = {}) {
  setupIpc();
  const wc = win.webContents;
  const state = { win, children: new Set(), host, trusted: false, trustAlways: !!trust, code: String(code || '') };
  shells.set(wc.id, state);
  // Whatever the window loads next (a reload, the page fetching its new version) is checked anew by its loader.
  wc.on('did-start-navigation', (d, url, inPlace, mainFrame) => {
    const main = d && typeof d.isMainFrame === 'boolean' ? d.isMainFrame : mainFrame;
    const same = d && typeof d.isSameDocument === 'boolean' ? d.isSameDocument : inPlace;
    if (main && !same) { state.trusted = false; state.legacy = false; state.checked = false; setLiveHost(state, ''); }
  });
  win.on('closed', () => { shells.delete(wc.id); if (state.liveHost) writeLive(); if (!shells.size) ghostGone(); }); // a window left behind would keep the app from quitting
  reportShown(win);

  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  wc.session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));

  // A window the page opens with a position goes, borderless, onto the screen at that position. The
  // page opens empty windows and fills them itself; nothing else is opened, since it would get mrShell.
  wc.setWindowOpenHandler(({ url, features }) => {
    if (!blank(url)) return { action: 'deny' };
    const num = (k) => { const r = new RegExp('(?:^|,)\\s*' + k + '=(-?\\d+)').exec(features || ''); return r ? Number(r[1]) : null; };
    const left = num('left'), top = num('top');
    const opts = { autoHideMenuBar: true, backgroundColor: '#000000', icon: ICON, webPreferences: { preload: PRELOAD, backgroundThrottling: false } };
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

module.exports = { attach, setList, setTestPageKey, setLocalHost, PRELOAD, ICON, _drop: { safeName, freePath, placeFiles, explorerFolder, stagedPath, moveInto, mayClick, NO_CLICK } };
