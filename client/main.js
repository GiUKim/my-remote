// My Remote client app. Its first window is the list of the PCs this one can connect to (home.html, kept
// by hosts.js); each PC opens in a window of its own, so several can be watched and used side by side,
// whatever they run. A PC's window is a thin shell around the same client page a browser uses: it loads
// the loader file, which fetches the current page from that host, so the page needs no update of this
// app. See shell.js for what the app adds to the page.
const { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, session, shell: openWith } = require('electron');
const fs = require('fs');
const path = require('path');
const shell = require('./shell');
const Hosts = require('./hosts');

const argOf = (name) => (process.argv.find((a) => a.startsWith(name)) || '').slice(name.length);
// --loader=<file>: no list; one window on that loader file, with a profile of its own in a folder next
// to it, so the app's own profile (and the keys kept there) is left alone. The host's self-test
// (--client-app-check) and the local trial on Linux run the app this way on a loader that talks only
// to their own relay. (app/boot.js takes a start with --loader= for a test: no updater, no trial.)
// --loader=<file> --list: the list as usual, but with that profile of its own, windows that use that
// loader, and - once - the PCs named in home-import.json next to it ([{ name, key, open, loader }],
// removed when read; `loader`: another loader file for that PC, when two test hosts each have a relay
// of their own). For the self-test, with its relay and its throwaway key. Never the app's own profile.
// With --home-shot=<file.png> as well, the list is not shown: a picture of it is written there and the
// app ends (a look at the list with made-up PCs; an entry of home-import.json may then say what its PC
// "said": seen: { os, name, pc, monitors }, lastAt; --home-size=<w>x<h>, --home-js=<code to run first>).
const loaderArg = argOf('--loader='), listTest = !!loaderArg && process.argv.includes('--list');
const alt = listTest ? '' : loaderArg;
const homeAlt = listTest ? loaderArg : '';
const homeShot = homeAlt ? argOf('--home-shot=') : '';
const testDir = alt || homeAlt ? path.dirname(path.resolve(alt || homeAlt)) : '';
if (testDir) app.setPath('userData', path.join(testDir, 'client-app-profile'));
const LOADER = alt || homeAlt ? path.resolve(alt || homeAlt) : path.join(__dirname, '..', 'my-remote-client.html');

// The installed app (started by app/boot.js, see host/main.js): the shell finds and installs updates of
// the app itself - these files, which the host cannot send as it does the page. Here the person is
// asked about an ordinary one; a required one is installed without asking and only the restart is
// announced. Run from a source folder there is no shell.
const APP = global.__mrApp || null;
function watchUpdates(win) {
  const u = APP.update;
  let asked = '';
  const notes = (a) => ((a.notes && a.notes.ko) || []).map((s) => '· ' + s).join('\n');
  u.onChange(async (s) => {
    const a = s.available;
    if (!a || s.state !== 'available' || asked === a.version || a.required || win.isDestroyed()) return;
    asked = a.version;
    if (a.kind === 'package') {
      const r = await dialog.showMessageBox(win, { type: 'info', noLink: true, buttons: ['내려받기 페이지 열기', '나중에'], defaultId: 0, cancelId: 1,
        message: `새 버전 ${a.version}이 있습니다`, detail: '이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요.\n\n' + notes(a) });
      if (r.response === 0 && APP.downloads) openWith.openExternal(APP.downloads).catch(() => {});
      return;
    }
    const r = await dialog.showMessageBox(win, { type: 'info', noLink: true, buttons: ['지금 업데이트', '나중에'], defaultId: 0, cancelId: 1,
      message: `새 버전 ${a.version}이 있습니다`, detail: `${notes(a)}\n\n업데이트하면 앱이 다시 시작됩니다. 원격 접속 중이면 다시 연결해야 합니다. (현재 v${APP.version})`.trim() });
    if (r.response === 0) u.install().catch((e) => dialog.showErrorBox('My Remote', '업데이트하지 못했습니다: ' + e.message));
  });
  u.setCanRestart(async (s) => {
    if (win.isDestroyed()) return true;
    const told = dialog.showMessageBox(win, { type: 'warning', noLink: true, buttons: ['다시 시작'],
      message: `중요 업데이트 ${s.available ? s.available.version : ''}을 설치했습니다`, detail: '이 버전의 심각한 문제를 고친 업데이트입니다. 확인을 누르면 앱이 다시 시작됩니다(10분 뒤에는 자동으로 다시 시작합니다).' });
    await Promise.race([told, new Promise((r) => setTimeout(r, 10 * 60e3))]);
    return true;
  });
}
function appUp(win) {
  if (!APP) return;
  // This version counts as up once its window has shown its page for a while (see app/boot.js).
  win.webContents.once('did-finish-load', () => setTimeout(() => { if (!win.isDestroyed()) APP.ok(); }, 4000));
  if (APP.update && !testDir) watchUpdates(win);
}

// ---- one window on one loader (--loader=) ------------------------------------------------
function single() {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1280, height: 800, title: 'My Remote' + (APP ? ` ${APP.version}` : ''), autoHideMenuBar: true, backgroundColor: '#14171c', icon: shell.ICON,
      webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false },
    });
    shell.attach(win);
    win.loadFile(LOADER);
    appUp(win);
  });
  app.on('window-all-closed', () => app.quit());
}

// ---- the list of PCs, and a window for each ----------------------------------------------
// The keys are encrypted with Electron's safeStorage, as the host's own key is (see host/main.js for
// the asynchronous and the older synchronous calls, and for Linux without a keyring).
const ASYNC = typeof safeStorage.decryptStringAsync === 'function';
const obscuredOnly = () => process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
const crypt = {
  async ready() {
    if (obscuredOnly() && !ASYNC) safeStorage.setUsePlainTextEncryption(true);
    return ASYNC ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  },
  encrypt: async (text) => (ASYNC ? await safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text)).toString('base64'),
  async decrypt(b64) {
    const buf = Buffer.from(b64, 'base64');
    if (!ASYNC) return safeStorage.decryptString(buf);
    const r = await safeStorage.decryptStringAsync(buf);
    return typeof r === 'string' ? r : r && r.result;
  },
};

function listMode() {
  const hosts = Hosts.create({ file: path.join(app.getPath('userData'), 'hosts.json'), crypt });
  const open = new Map();      // id -> the PC's window
  const connected = new Set(); // ids whose page says its session is up
  const loaders = new Map();   // id -> a loader file of its own (the self-test only, see --list)
  const loaderOf = (id) => loaders.get(id) || LOADER;
  let home = null;

  const changed = () => { if (home && !home.isDestroyed()) home.webContents.send('home:changed'); };
  const titleOf = (h) => `${h.name || h.pc || '이름 없는 PC'} · My Remote`;
  const retitle = (id) => { const w = open.get(id), h = hosts.get(id); if (w && !w.isDestroyed() && h) w.setTitle(titleOf(h)); };

  function showHome() {
    if (home && !home.isDestroyed()) { if (home.isMinimized()) home.restore(); home.show(); home.focus(); return home; }
    home = new BrowserWindow({
      width: 940, height: 660, minWidth: 520, minHeight: 420, show: false, title: 'My Remote', autoHideMenuBar: true, backgroundColor: '#14171c', icon: shell.ICON,
      webPreferences: { preload: path.join(__dirname, 'home-preload.js') },
    });
    home.setMenuBarVisibility(false);
    if (!homeShot) home.once('ready-to-show', () => home.show());
    // The list's own page, and nothing else, ever: it can ask for PCs to be added and opened.
    home.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    home.webContents.on('will-navigate', (e) => e.preventDefault());
    home.on('closed', () => { home = null; });
    home.loadFile(path.join(__dirname, 'home.html'));
    return home;
  }

  async function openHost(id) {
    const h = hosts.get(id);
    if (!h) return { ok: false, why: 'gone' };
    const was = open.get(id);
    if (was && !was.isDestroyed()) { if (was.isMinimized()) was.restore(); was.show(); was.focus(); return { ok: true }; }
    if (!(await hosts.key(id))) return { ok: false, why: 'nokey' }; // the stored key cannot be read here any more
    // Each further window a little down and to the right of the one before, so none hides another.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, n = open.size % 6;
    const width = Math.min(1280, area.width), height = Math.min(800, area.height);
    const win = new BrowserWindow({
      width, height, x: area.x + Math.max(0, Math.round((area.width - width) / 2)) + n * 28, y: area.y + Math.max(0, Math.round((area.height - height) / 2)) + n * 28,
      title: titleOf(h), autoHideMenuBar: true, backgroundColor: '#14171c', icon: shell.ICON,
      // Storage of its own per PC: what one host's page keeps here (its copy of the page, the layout
      // chosen for that PC) is not there for another host's page to read.
      webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false, partition: 'persist:host-' + id },
    });
    win.on('page-title-updated', (e) => e.preventDefault()); // the title names the PC, whatever the page calls itself
    shell.attach(win, { host: id });
    open.set(id, win);
    win.on('closed', () => { if (open.get(id) === win) open.delete(id); connected.delete(id); changed(); });
    // A host older than this list does not send a page that tells the app about its session (hostInfo):
    // the picture starting to play says it is connected, and when. (It then stays "connected" in the
    // list until its window is closed or starts again.)
    win.webContents.on('media-started-playing', () => { if (!connected.has(id)) { connected.add(id); hosts.seen(id, null); changed(); } });
    win.webContents.on('did-start-loading', () => { if (connected.delete(id)) changed(); });
    win.loadFile(loaderOf(id));
    changed();
    return { ok: true };
  }

  shell.setList({
    key: (id) => hosts.key(id),
    info(id, info) {
      const on = !!info.connected, was = connected.has(id);
      if (on) { connected.add(id); hosts.seen(id, { os: info.os, name: info.name, pc: info.pc, monitors: info.monitors }); retitle(id); }
      else connected.delete(id);
      if (on || was) changed();
    },
    home: () => showHome(),
  });

  // Only the list's own window may ask these.
  const fromHome = (e) => !!home && !home.isDestroyed() && e.sender === home.webContents;
  const handle = (name, f) => ipcMain.handle(name, (e, ...args) => (fromHome(e) ? f(...args) : null));
  const state = (h) => ({ ...h, open: open.has(h.id), connected: connected.has(h.id) });
  handle('home:list', () => ({ hosts: hosts.list().map(state), note: hosts.note() }));
  handle('home:info', async () => ({
    version: APP ? APP.version : require('../host/package.json').version,
    // How well the keys are kept on this PC: by the operating system, only obscured (Linux without a keyring), or not at all.
    store: !(await crypt.ready().catch(() => false)) ? 'none' : obscuredOnly() ? 'obscured' : 'os',
    rolledBack: APP ? APP.rolledBack : [],
  }));
  handle('home:add', async (o) => { const r = await hosts.add({ key: o && o.key, name: o && o.name }); if (r.ok) changed(); return r; });
  handle('home:rename', (id, name) => { const ok = hosts.rename(String(id), name); if (ok) { retitle(String(id)); changed(); } return ok; });
  handle('home:setKey', async (id, key) => {
    id = String(id);
    const r = await hosts.setKey(id, key);
    // A window that is open still tries the old key: it starts again with the new one.
    if (r.ok) { const w = open.get(id); if (w && !w.isDestroyed()) w.loadFile(loaderOf(id)); changed(); }
    return r;
  });
  handle('home:open', (id) => openHost(String(id)));
  handle('home:close', (id) => { const w = open.get(String(id)); if (w && !w.isDestroyed()) w.close(); return true; });
  handle('home:remove', async (id) => {
    id = String(id);
    const w = open.get(id);
    if (w && !w.isDestroyed()) w.destroy();
    const ok = hosts.remove(id);
    // What that PC's page kept here goes with it.
    if (ok) { try { await session.fromPartition('persist:host-' + id).clearStorageData(); } catch {} changed(); }
    return ok;
  });

  app.on('second-instance', () => showHome()); // started again: the list comes forward
  app.whenReady().then(async () => {
    const win = showHome();
    appUp(win);
    if (!homeAlt) return;
    // The self-test's PCs (see --list above).
    const file = path.join(testDir, 'home-import.json');
    let items = [];
    try { items = JSON.parse(fs.readFileSync(file, 'utf8')); fs.rmSync(file, { force: true }); } catch {}
    for (const it of Array.isArray(items) ? items : []) {
      const r = await hosts.add({ key: it && it.key, name: it && it.name });
      console.log(`[client] import: ${r.ok ? 'added' : r.why}`);
      if (r.id && it && it.loader) loaders.set(r.id, path.resolve(testDir, String(it.loader)));
      if (homeShot && r.ok && it.seen) hosts.seen(r.id, it.seen, it.lastAt);
      if (it && it.open && !homeShot && (r.ok || r.why === 'exists')) await openHost(r.id);
    }
    changed();
    if (homeShot) {
      const size = (argOf('--home-size=') || '').split('x').map(Number);
      if (size[0] > 0 && size[1] > 0) win.setContentSize(size[0], size[1]);
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
      const js = argOf('--home-js='); // what to do in the page before the picture (open a dialog, a menu)
      await new Promise((r) => setTimeout(r, 700));
      if (js) await win.webContents.executeJavaScript(js, true).catch((e) => console.log('[client] home-js: ' + e.message));
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.resolve(homeShot), (await win.webContents.capturePage()).toPNG());
      console.log('[client] wrote ' + path.resolve(homeShot));
      app.exit(0);
    }
  });
  app.on('window-all-closed', () => app.quit());
}

if (alt) single();
// One app per profile: a second start only brings the first one's list forward.
else if (!app.requestSingleInstanceLock()) app.quit();
else listMode();
