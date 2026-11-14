// The installed app's entry point (the shell's package.json names it as "main"). One program, two
// faces: the host (this PC is controlled) and the client app (this PC controls another). It
//   - decides which it is: --host or --client, as the two shortcuts say (neither: it asks);
//   - picks the code to run: the bundle that came with the installer, or a newer one the updater
//     installed (core.choose), checked against its signed manifest;
//   - keeps a version that runs for the first time on trial: when it does not say it is up (ok()),
//     ends by itself or throws while starting, it is marked bad and the one before runs again;
//   - runs the updater (updater.js) and hands it to the code as global.__mrApp.update.
// The code it starts is host/main.js or client/main.js, unchanged: run from a source folder
// (start-host.bat, ./start-host.sh) there is no shell and no global.__mrApp, and updates come by git.
'use strict';
const { app, dialog, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const pkg = require('./package.json');
const conf = require('./update-config.json');

const argv = process.argv.slice(1);
const has = (f) => argv.includes(f);
// Which face: the client app, or the host (which the host's own test and errand flags mean as well).
const HOST_FLAGS = ['--selftest', '--localtest', '--bench', '--show-key'];
const mode = has('--client') ? 'client' : (has('--host') || HOST_FLAGS.some(has)) ? 'host' : 'ask';
// Runs that are tests or errands, not the program in use: no updater, and no start counted against a
// version on trial. (--loader=: the client app as a local trial or a self-test starts it, which must
// not talk to anything but that test.)
const ERRAND = mode === 'ask' || HOST_FLAGS.some(has) || argv.some((a) => a.startsWith('--loader='));

// Where installed versions and their state are kept: the user's own data folder, so that an app
// installed where the user cannot write (Program Files, /opt) can still be updated without asking.
function dataRoot() {
  if (conf.dataRoot) return conf.dataRoot; // the update tests
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'my-remote', 'app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'my-remote', 'app');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'my-remote', 'app');
}
const root = dataRoot();
const log = (s) => console.log('[app] ' + s);

// The names the two faces have always had: their profiles (the host's holds the access key, encrypted
// under this name on Linux and macOS) stay where they are when a source folder is replaced by the app.
const NAME = { host: 'my-remote-host', client: 'my-remote-client' };
if (mode !== 'ask') {
  app.setName(NAME[mode]);
  app.setPath('userData', path.join(app.getPath('appData'), NAME[mode]));
  if (process.platform === 'win32') app.setAppUserModelId('kr.myremote.' + mode); // the taskbar and notifications go by the shortcut's id
} else {
  // Asking which face, or only making the shortcuts: a profile of its own next to the installed versions.
  // Left to itself Electron names one after the product ("My Remote" in 0.3.0-0.4.0: a folder with a
  // space in its name). Every file and folder this app makes has a plain name: no spaces, ASCII only.
  app.setName('my-remote');
  app.setPath('userData', path.join(path.dirname(root), 'launcher'));
}

function relaunch(extra) {
  try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'quit'), String(Date.now())); } catch {}
  app.relaunch({ args: extra || argv });
  app.exit(0);
}

// ---- which code runs ------------------------------------------------------------------
const builtinDir = path.join(__dirname, 'bundle');
const builtinCheck = core.verifyFolder(builtinDir, conf.keys);
// The code that came with the installer runs whatever this check says (it is as trusted as this file);
// a failed check means the package was put together wrongly, and updates could not be verified either.
let builtinVersion = builtinCheck.ok ? builtinCheck.manifest.version : '0.0.0';
if (!builtinCheck.ok) {
  log('WARNING: the built-in code does not verify: ' + builtinCheck.why);
  try { const v = JSON.parse(fs.readFileSync(path.join(builtinDir, 'manifest.json'), 'utf8')).version; if (core.validVersion(v)) builtinVersion = v; } catch {}
}
const builtin = { dir: builtinDir, version: builtinVersion };
let pick;
if (ERRAND) {
  // As the program in use would pick, but without counting a start or changing anything.
  const st = core.readState(root), v = st.current, f = v && !st.bad[v] && core.cmp(v, builtin.version) > 0 ? core.verifyFolder(core.versionDir(root, v), conf.keys) : null;
  pick = f && f.ok && f.manifest.needsBase <= pkg.base ? { dir: core.versionDir(root, v), version: v, source: 'installed', trial: false, rolledBack: [] }
    : { dir: builtin.dir, version: builtin.version, source: 'builtin', trial: false, rolledBack: [] };
} else pick = core.choose({ root, builtin, base: pkg.base, keys: conf.keys, pid: process.pid, alive: (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } } });
for (const r of pick.rolledBack) log(`version ${r.version} is not used: ${r.why}`);
log(`${mode}: version ${pick.version} (${pick.source}${pick.trial ? ', first start' : ''}), shell ${pkg.base}`);

// Modules the code needs that are part of the shell (koffi): found from a bundle in the data folder
// too. The page processes inherit the variable, as they do UV_THREADPOOL_SIZE.
process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

// ---- a version on trial ---------------------------------------------------------------
let up = !pick.trial;
const onThrow = (e) => failed('threw while starting: ' + String((e && e.message) || e).slice(0, 120));
function ok() {
  if (up) return;
  up = true;
  process.removeListener('uncaughtException', onThrow);
  try { core.markOk(root, pick.version); log(`version ${pick.version} is up`); } catch (e) { log('markOk: ' + e.message); }
}
function failed(why) {
  if (up) return;
  up = true;
  log(`version ${pick.version} failed (${why}); going back`);
  try { core.markBad(root, pick.version, why); } catch {}
  relaunch();
}
if (pick.trial) {
  try { fs.rmSync(path.join(root, 'quit'), { force: true }); } catch {}
  app.on('before-quit', () => { try { fs.writeFileSync(path.join(root, 'quit'), String(Date.now())); } catch {} }); // ended on purpose: the guard leaves it
  // Stands by in case this process ends without a word (see guard.js).
  try {
    spawn(process.execPath, [path.join(__dirname, 'guard.js'), root, pick.version, String(process.pid), process.execPath, JSON.stringify(argv)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { log('guard: ' + e.message); }
  process.on('uncaughtException', onThrow);
  setTimeout(() => failed('did not come up in time'), Number(conf.trialMs) || 120e3).unref();
} else if (!ERRAND) setTimeout(() => { try { core.sweep(root); } catch {} }, 60e3).unref();

// ---- the updater ----------------------------------------------------------------------
let update = null;
if (!ERRAND && mode !== 'ask') {
  update = require('./updater').create({
    core, root, base: pkg.base, keys: conf.keys, feed: conf.feed, running: pick, log, timing: conf.timing,
    fetch: (url, init) => net.fetch(url, init),
    // In good order (the code lets go of what it holds, as when the person quits it); at once if that hangs.
    restart: () => {
      try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'quit'), String(Date.now())); } catch {}
      app.relaunch({ args: argv });
      app.quit();
      setTimeout(() => app.exit(0), 5000).unref();
    },
  });
  app.whenReady().then(() => update.start());
}

// What the code sees of the shell. `update` is null in tests and errands.
global.__mrApp = {
  version: pick.version, source: pick.source, shell: pkg.version, base: pkg.base, mode, rolledBack: pick.rolledBack,
  downloads: typeof conf.downloads === 'string' && /^https:\/\//.test(conf.downloads) ? conf.downloads : '', // where the packages are, for a release that needs a new shell
  ok, update,
  shortcuts: () => makeShortcuts(),
};

// ---- shortcuts: the Start menu (Windows), the app menu (Linux) ------------------------------
// `into`: another folder to put them in (--shortcuts=<folder>, for a look at them or a test).
function makeShortcuts(into) {
  const made = [];
  try {
    if (process.platform === 'win32') {
      // File and folder names without spaces and in ASCII only (some tools and some systems' settings
      // trip over either); what the shortcut is for is in its description.
      const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      const dir = into || path.join(programs, 'MyRemote');
      fs.mkdirSync(dir, { recursive: true });
      const icon = path.join(__dirname, 'icon.ico');
      for (const [name, arg, about] of [['MyRemote-Host', '--host', '이 PC를 다른 PC에서 원격으로 조종합니다'], ['MyRemote-Client', '--client', '다른 PC에 원격으로 접속합니다']]) {
        const file = path.join(dir, name + '.lnk');
        if (shell.writeShortcutLink(file, fs.existsSync(file) ? 'update' : 'create', { target: process.execPath, args: arg, description: about, icon, iconIndex: 0, appUserModelId: 'kr.myremote.' + arg.slice(2) })) made.push(file);
      }
      // The shortcuts 0.3.0-0.4.0 made (a folder "My Remote", Korean in the names) go once the new ones
      // are there; their folder too, when nothing else is in it.
      if (!into && made.length === 2) {
        const old = path.join(programs, 'My Remote');
        for (const n of ['My Remote 호스트.lnk', 'My Remote 클라이언트.lnk']) { try { fs.rmSync(path.join(old, n), { force: true }); } catch {} }
        try { fs.rmdirSync(old); } catch {}
      }
    } else if (process.platform === 'linux') {
      const dir = into || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
      fs.mkdirSync(dir, { recursive: true });
      const launcher = path.join(path.dirname(process.execPath), 'my-remote.sh'), icon = path.join(__dirname, 'icon.png');
      for (const [id, name, arg, about] of [['my-remote-host', 'My Remote Host', '--host', '이 PC를 다른 PC에서 원격으로 조종합니다'], ['my-remote-client', 'My Remote Client', '--client', '다른 PC에 원격으로 접속합니다']]) {
        const file = path.join(dir, id + '.desktop');
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${name}\nComment=${about}\nExec="${launcher}" ${arg}\nIcon=${icon}\nTerminal=false\nCategories=Network;RemoteAccess;\n`, { mode: 0o755 });
        made.push(file);
      }
    }
  } catch (e) { log('shortcuts: ' + e.message); }
  return made;
}

// ---- go --------------------------------------------------------------------------------
const shortcutsArg = argv.find((a) => a === '--shortcuts' || a.startsWith('--shortcuts='));
if (shortcutsArg) {
  // --shortcuts: only makes the two shortcuts and ends (an installer's or an administrator's step).
  app.whenReady().then(() => {
    const made = makeShortcuts(shortcutsArg.includes('=') ? path.resolve(shortcutsArg.slice('--shortcuts='.length)) : '');
    console.log(made.length ? made.map((f) => '[app] shortcut: ' + f).join('\n') : '[app] no shortcuts were made');
    app.exit(made.length ? 0 : 1);
  });
} else if (mode === 'ask') {
  // Started without saying which: ask once, and offer the two shortcuts that say it from then on.
  app.whenReady().then(async () => {
    const r = await dialog.showMessageBox({
      type: 'question', title: 'My Remote', noLink: true, cancelId: 2, defaultId: 0,
      message: `My Remote ${pick.version}`,
      detail: '무엇을 시작할까요?\n\n호스트: 이 PC를 다른 PC에서 원격으로 조종합니다.\n클라이언트: 다른 PC(호스트)에 접속합니다.',
      buttons: ['호스트 시작', '클라이언트 시작', '닫기'],
      checkboxLabel: process.platform === 'darwin' ? undefined : (process.platform === 'win32' ? '시작 메뉴' : '앱 메뉴') + '에 호스트와 클라이언트 바로가기 만들기', checkboxChecked: true,
    });
    if (r.response === 2) return app.exit(0);
    if (r.checkboxChecked) makeShortcuts();
    relaunch([...argv, r.response === 0 ? '--host' : '--client']);
  });
} else {
  try {
    require(path.join(pick.dir, mode === 'client' ? 'client/main.js' : 'host/main.js'));
  } catch (e) {
    console.error('[app] starting failed:', e);
    if (pick.source === 'installed') { up = false; failed('failed to start: ' + String((e && e.message) || e).slice(0, 120)); }
    else app.whenReady().then(() => { dialog.showErrorBox('My Remote', `프로그램을 시작하지 못했습니다. 다시 설치해 주세요.\n\n${(e && e.message) || e}`); app.exit(1); });
  }
}
