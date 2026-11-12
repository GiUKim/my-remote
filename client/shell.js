// What the client app adds over a plain browser tab. The page itself is the same
// one a browser gets (it is fetched from the host by the loader); a browser only
// allows one new window and one fullscreen request per click and limits where
// windows may go. Here the page's windows are put on the screen they ask for and
// made fullscreen without further clicks, and nothing asks for permission.
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

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

let ipcReady = false;
function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
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

module.exports = { attach, PRELOAD };
