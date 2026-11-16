// My Remote client app. Its first window is the list of the PCs this one can connect to (home.html, kept
// by hosts.js); each PC opens in a window of its own, so several can be watched and used side by side,
// whatever they run. A PC's window is a thin shell around the same client page a browser uses: it loads
// the loader file, which fetches the current page from that host, so the page needs no update of this
// app. See shell.js for what the app adds to the page.
const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, screen, session, shell: openWith } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const shell = require('./shell');
const Hosts = require('./hosts');
const appsync = require('../host/appsync');
const shellswap = require('../host/shellswap');

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
// --launcher: the start screen first (launcher.html: two big buttons, this PC shared as the host or
// another PC reached as the client), which the one "MyRemote" entry opens (host/appsync.js).
const LAUNCHER = process.argv.includes('--launcher');
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
// The one entry's id, which the host takes too (appsync.APP_ID): the shell gives this face the same one.
if (APP && process.platform === 'win32') app.setAppUserModelId(appsync.APP_ID);
// Asks about an update on offer (set by watchUpdates); `again`: the person pressed "업데이트 확인", so one
// they put off before is asked about once more.
let offerUpdate = null;
// win: the window the questions belong to, or a function that names it (the list: whichever list window is open).
function watchUpdates(win) {
  const u = APP.update;
  let asked = '', showing = ''; // showing: a question about that version is open (a check that finds it asks at once, see onChange)
  const notes = (a) => ((a.notes && a.notes.ko) || []).map((s) => '· ' + s).join('\n');
  const parentOf = () => { const w = typeof win === 'function' ? win() : win; return w && !w.isDestroyed() ? w : null; };
  offerUpdate = async (a, again) => {
    const parent = parentOf();
    if (!a || a.required || !parent || showing === a.version || (asked === a.version && !again)) return;
    asked = showing = a.version;
    try { await ask(parent, a); } finally { showing = ''; }
  };
  const ask = async (parent, a) => {
    if (a.kind === 'package') {
      const r = await dialog.showMessageBox(parent, { type: 'info', noLink: true, buttons: ['내려받기 페이지 열기', '나중에'], defaultId: 0, cancelId: 1,
        message: `새 버전 ${a.version}이 있습니다`, detail: '이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요.\n\n' + notes(a) });
      if (r.response === 0 && APP.downloads) openWith.openExternal(APP.downloads).catch(() => {});
      return;
    }
    const r = await dialog.showMessageBox(parent, { type: 'question', noLink: true, buttons: ['지금 업데이트', '나중에'], defaultId: 0, cancelId: 1,
      message: `새 버전 ${a.version}이 있습니다. 지금 업데이트할까요?`, detail: `${notes(a)}\n\n업데이트하면 앱이 다시 시작됩니다. 원격 접속 중이면 다시 연결해야 합니다. 이 PC의 호스트도 같은 버전이 됩니다(켜져 있으면 원격 접속이 없을 때 다시 시작합니다). (현재 v${APP.version})`.trim() });
    if (r.response === 0) u.install().catch((e) => dialog.showErrorBox('My Remote', '업데이트하지 못했습니다: ' + e.message));
  };
  u.onChange((s) => { if (s.state === 'available') offerUpdate(s.available, false); });
  u.setCanRestart(async (s) => {
    const parent = parentOf();
    if (!parent) return true;
    const told = dialog.showMessageBox(parent, { type: 'warning', noLink: true, buttons: ['다시 시작'],
      message: `중요 업데이트 ${s.available ? s.available.version : ''}을 설치했습니다`, detail: '이 버전의 심각한 문제를 고친 업데이트입니다. 확인을 누르면 앱이 다시 시작됩니다(10분 뒤에는 자동으로 다시 시작합니다).' });
    await Promise.race([told, new Promise((r) => setTimeout(r, 10 * 60e3))]);
    return true;
  });
}
// parent: the window update questions belong to (default: win), or a function naming it.
function appUp(win, parent) {
  if (!APP) return;
  // This version counts as up once its window has shown its page for a while (see app/boot.js).
  win.webContents.once('did-finish-load', () => setTimeout(() => { if (!win.isDestroyed()) APP.ok(); }, 4000));
  if (APP.update && !testDir) watchUpdates(parent || win);
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

  // ---- the start screen (--launcher) ----
  let launcher = null;
  function showLauncher() {
    if (launcher && !launcher.isDestroyed()) { if (launcher.isMinimized()) launcher.restore(); launcher.show(); launcher.focus(); return launcher; }
    launcher = new BrowserWindow({
      width: 760, height: 470, minWidth: 640, minHeight: 440, show: false, title: 'My Remote', autoHideMenuBar: true, backgroundColor: '#14171c', icon: shell.ICON,
      webPreferences: { preload: path.join(__dirname, 'launcher-preload.js') },
    });
    launcher.setMenuBarVisibility(false);
    if (!homeShot) launcher.once('ready-to-show', () => launcher.show());
    launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    launcher.webContents.on('will-navigate', (e) => e.preventDefault());
    launcher.on('closed', () => { launcher = null; });
    launcher.loadFile(path.join(__dirname, 'launcher.html'));
    return launcher;
  }
  const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const entryOpts = () => ({ appData: app.getPath('appData'), dataHome: dataHome(), execPath: process.execPath, iconDir: APP ? path.dirname(require.main.filename) : path.join(__dirname, '..', 'app'),
    writeLink: (f, op, o) => openWith.writeShortcutLink(f, op, o) });
  // The host, as a program of its own (its window, tray and profile; a second start only brings it forward).
  // The installed app is told --host; on Linux through its launcher script, which brings the checks and the
  // sandbox switch. From a source folder Electron is given the host folder. Not in a test (--loader).
  let hostStarted = false; // the start screen's "이 PC 공유": the host swaps the shell then, not this app's quit
  let relaunching = false; // this app starts again at once (a version the host installed): no swap at this quit
  function startHost() {
    if (testDir) { console.log('[client] start screen: the host would start now'); return; }
    hostStarted = true;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const o = { env, detached: true, stdio: 'ignore' };
    const sh = path.join(path.dirname(process.execPath), 'my-remote.sh');
    if (!APP) spawn(process.execPath, [path.join(__dirname, '..', 'host')], o).unref();
    else if (process.platform === 'linux' && fs.existsSync(sh)) spawn(sh, ['--host'], o).unref();
    else spawn(process.execPath, ['--host', ...process.argv.filter((a) => a === '--no-sandbox')], o).unref();
  }
  // Versions are x.y.z (release/build.js); anything else counts as not older.
  const olderThan = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0; } return false; };
  // Whether the host runs on this PC now (host/main.js keeps running.json in its profile while it runs), and
  // whether it runs an older version than this app: it follows a newer one once no remote session is on
  // (appsync.watch), which the start screen says after an update.
  function hostRunning() {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'my-remote-host', 'running.json'), 'utf8'));
      try { process.kill(Number(r.pid), 0); } catch (e) { if (e.code !== 'EPERM') return { running: false }; }
      const version = String(r.version || '').slice(0, 20);
      return { running: true, version, behind: !!APP && !!version && olderThan(version, APP.version) };
    } catch { return { running: false }; }
  }
  const fromLauncher = (e) => !!launcher && !launcher.isDestroyed() && e.sender === launcher.webContents;
  ipcMain.handle('start:info', (e) => (!fromLauncher(e) ? null : {
    version: APP ? APP.version : require('../host/package.json').version,
    updates: !!(APP && APP.update), // the installed app: "업데이트 확인", which updates both faces (one installed version)
    host: hostRunning(),
    // The entry for this app in the Start menu (the app menu on Linux): offered where there is none yet.
    // Never in a test (--loader): the Start menu is the person's (a harness that pressed a button with the
    // box ticked once replaced this PC's real shortcuts with one to the development folder; put back).
    shortcut: { can: !!APP && !testDir && (process.platform === 'win32' || process.platform === 'linux'), has: appsync.hasEntry(entryOpts()), where: process.platform === 'linux' ? '앱 메뉴' : '시작 메뉴' },
  }));
  ipcMain.handle('start:choose', (e, what, o) => {
    if (!fromLauncher(e) || (what !== 'host' && what !== 'client')) return false;
    if (APP) APP.ok(); // the start screen came up and answered: this version is up (the face chosen may end it at once)
    if (o && o.shortcut && APP && !testDir) { try { appsync.unifyShortcuts({ ...entryOpts(), create: true }); } catch (err) { console.error('[client] shortcut', err.message); } }
    if (what === 'host') startHost(); else showHome();
    // Closing it ends this program when nothing else of the client app is open (the host runs on its own).
    setTimeout(() => { if (launcher && !launcher.isDestroyed()) launcher.close(); }, what === 'host' ? 400 : 0);
    return true;
  });

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
    if (shellLook) shellLook.abort(); // a new shell is fetched another time, not over this session's bandwidth
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
    updates: !!(APP && APP.update), // the installed app: the list has "업데이트 확인"
    startScreen: true, // "나가기" (the start screen is the client app's own window: client/launcher.html)
  }));
  // "나가기" (the user's wish, 2026-11-16: both faces lead back to the start screen): the start screen comes,
  // this list closes after it, so the app does not end in between; the PCs' windows stay open.
  handle('home:exit', () => {
    showLauncher();
    setTimeout(() => { if (home && !home.isDestroyed()) home.close(); }, 0);
    return true;
  });
  // "업데이트 확인", in the list and on the start screen: the feed now instead of at the next look (20 s after
  // the start, then every 6 h). An update found is asked about as usual (offerUpdate, over whichever of the
  // two windows is open), also one put off before; the page says the rest. The host and the client app run
  // the same installed versions, so one update is both (a running host follows: appsync.watch).
  async function checkNow() {
    if (!APP || !APP.update) return { state: 'none' };
    const s = await APP.update.check();
    const a = s.available;
    if (a && s.state === 'available' && offerUpdate) offerUpdate(a, true);
    return { state: s.state, version: APP.version, error: s.error || '', available: a ? { version: a.version, required: !!a.required, kind: a.kind } : null };
  }
  handle('home:checkUpdate', checkNow);
  ipcMain.handle('start:checkUpdate', (e) => (fromLauncher(e) ? checkNow() : null));
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

  // Packages up to 0.5.x made two shortcuts (host, client): the one entry takes their place, at the start
  // and when another start reaches this running app (an older shell's first-start dialog makes the two
  // again when its box is ticked, then starts this face: see oneEntry in host/main.js). Never in a test.
  function oneEntry() {
    if (!APP || testDir) return;
    try { const r = appsync.unifyShortcuts(entryOpts()); if (r.made.length) console.log('[client] shortcuts: one entry ' + r.made.join(', ')); } catch (e) { console.error('[client] shortcuts', e.message); }
  }
  // Started again: the list comes forward, or the start screen when that is what was started (the entry).
  app.on('second-instance', (_e, argv) => { oneEntry(); return Array.isArray(argv) && argv.includes('--launcher') ? showLauncher() : showHome(); });

  // The host face installed a newer version (one app, see host/appsync.js): with no PC window open the app
  // starts again at once, else it asks first, since the remote windows reconnect. What comes back is what
  // was open: the start screen when only it was, else the list.
  function newerInstalled(v) {
    const onlyStart = !!launcher && !launcher.isDestroyed() && !(home && !home.isDestroyed());
    const args = process.argv.slice(1).filter((a) => a !== '--launcher');
    const again = () => { relaunching = true; app.relaunch({ args: onlyStart ? [...args, '--launcher'] : args }); app.quit(); };
    console.log(`[client] version ${v} was installed by the host: restarting into it${open.size ? ' when the person says so' : ''}`);
    if (!open.size) return again();
    const parent = (home && !home.isDestroyed() && home) || [...open.values()].find((w) => !w.isDestroyed());
    dialog.showMessageBox(parent, { type: 'question', noLink: true, buttons: ['다시 시작', '나중에'], defaultId: 0, cancelId: 1,
      message: `새 버전 ${v}이 설치되었습니다. 지금 다시 시작할까요?`, detail: '호스트에서 업데이트했습니다. 다시 시작하면 클라이언트 앱도 새 버전이 됩니다. 열려 있는 원격 창은 다시 연결해야 합니다.' })
      .then((r) => { if (r.response === 0) again(); }, () => {});
  }

  // ---- the shell replaced by a newer package (host/shellswap.js) ----
  // The host does it when it runs (host/main.js), and does not while this app runs (running.json in this
  // profile: Windows keeps a running program's files). Without a host this app fetches the package (not
  // while a PC's window is open: that session's bandwidth) and swaps when the person quits it: nothing is
  // started again, the next start is the new shell's.
  let shellCtx = null, shellLook = null;
  const runningFile = () => path.join(app.getPath('userData'), 'running.json');
  function clientShell() {
    if (!shellswap.EXE[process.platform]) return;
    const parts = appsync.shellParts();
    if (!parts || !parts.conf) return;
    shellCtx = { root: parts.root, conf: parts.conf, appDir: path.dirname(process.execPath), me: shellswap.readShell(parts.dir) };
    try { fs.writeFileSync(runningFile(), JSON.stringify({ pid: process.pid, version: APP.version })); } catch {}
    if (!hostRunning().running) shellswap.sweep(shellCtx.appDir, shellCtx.root).then((g) => { if (g.length) console.log('[client] shell: removed ' + g.join(', ')); }, () => {});
    const lookNow = async () => {
      if (!shellCtx || shellLook || open.size || hostRunning().running) return;
      const ctl = new AbortController();
      shellLook = ctl;
      try {
        const r = await shellswap.look({ feed: shellCtx.conf.feed, keys: shellCtx.conf.keys, root: shellCtx.root, appDir: shellCtx.appDir, current: shellCtx.me,
          fetchFn: (u, o) => net.fetch(u, o), signal: ctl.signal, log: (s) => console.log('[client] ' + s) });
        console.log(`[client] shell ${shellCtx.me.version}: ${r.state}${r.version ? ' ' + r.version : ''}${r.why ? ' (' + r.why + ')' : ''}`);
      } finally { shellLook = null; }
    };
    const T = { firstLookMs: 3 * 60e3, everyMs: 6 * 3600e3, ...(shellCtx.conf.shellTiming || {}) }; // see host/main.js
    setTimeout(lookNow, T.firstLookMs);
    setInterval(lookNow, T.everyMs);
  }
  let shellSwapping = false;
  app.on('will-quit', (e) => {
    if (!shellCtx || shellSwapping) return;
    try { if (JSON.parse(fs.readFileSync(runningFile(), 'utf8')).pid === process.pid) fs.rmSync(runningFile(), { force: true }); } catch {}
    if (shellLook) shellLook.abort();
    const next = shellswap.readNext(shellCtx.root, shellCtx.appDir);
    // Not when this app just started the host (it ends right after, and the host, still starting, has
    // no running.json yet): the script would find the host running and hold the host's own swap back.
    // Nor when it starts again at once (its own update installed, or the host's followed): the new start
    // would be found running.
    const updating = !!(APP.update && APP.update.status && APP.update.status().state === 'ready');
    if (!next || hostStarted || relaunching || updating || hostRunning().running || shellswap.heldRecently(shellCtx.root)) return;
    // The quit waits until the script runs (it then waits for this app to end).
    e.preventDefault();
    shellSwapping = true;
    shellswap.begin({ root: shellCtx.root, appDir: shellCtx.appDir, next, restart: [], log: (s) => console.log('[client] ' + s) })
      .catch((err) => console.error('[client] shell swap: ' + err.message)).finally(() => app.exit(0));
  });

  app.whenReady().then(async () => {
    const win = LAUNCHER ? showLauncher() : showHome();
    appUp(win, () => home || launcher); // questions about updates go to whichever list window is open (it can be closed and opened again)
    if (APP && !testDir) {
      appsync.watch({ running: APP.version, onNewer: newerInstalled });
      oneEntry();
      clientShell();
    }
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
