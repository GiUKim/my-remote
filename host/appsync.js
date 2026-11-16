// The installed app is one program with two faces, the host and the client app, which run the same
// installed versions (app/core.js). Two things here keep them one app:
//  - watch(): when one face installs an update, the other one, if it is running, still runs the old code.
//    It learns of the newer version from the shell's state (state.json), once that version has come up
//    in the face that installed it, and restarts into it when the moment fits (each face decides when).
//  - unifyShortcuts(): one entry, "MyRemote", which opens the start screen with its two big buttons
//    (client/launcher.html), in place of the two shortcuts (host, client) that packages up to 0.5.x made.
// Both only in the installed app (global.__mrApp); run from a source folder there is no shell.
// Electron-free, so that release/test-appsync.js can run it in plain Node.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where the installed versions are: as app/boot.js's dataRoot (the update tests name another folder in the
// shell's config).
function dataRoot() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'my-remote', 'app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'my-remote', 'app');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'my-remote', 'app');
}
// The shell that started this code: app/boot.js is the main module; its folder holds core.js, the config
// (feed, keys: what host/shellswap.js needs too) and the icons. null when there is none (a source folder).
function shellParts(mainFile = require.main && require.main.filename) {
  try {
    const dir = path.dirname(mainFile);
    const core = require(path.join(dir, 'core.js'));
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'update-config.json'), 'utf8'));
    return { dir, core, root: conf.dataRoot || dataRoot(), conf };
  } catch { return null; }
}

// Calls onNewer(version) once a newer version than `running` is the one to run and has come up: its trial
// is over (a version that does not come up is never followed; the face on trial goes back by itself).
// -> stop()
function watch({ running, onNewer, parts = shellParts(), everyMs = 30000 }) {
  if (!parts || !running) return () => {};
  let told = '';
  const look = () => {
    let st;
    try { st = parts.core.readState(parts.root); } catch { return; }
    const v = st.current;
    if (!v || v === told || st.bad[v] || (st.trial && st.trial.version === v) || parts.core.cmp(v, running) <= 0) return;
    told = v;
    try { onNewer(v); } catch {}
  };
  const t = setInterval(look, everyMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

// ---- the one entry ------------------------------------------------------------------------
// The start screen runs as the client app's first window: the entry starts the client app with
// --launcher (an app whose code is older shows its list instead).
const ARGS = ['--client', '--launcher'];
const ABOUT = '원격 데스크톱: 이 PC를 공유하거나(호스트) 다른 PC에 접속합니다(클라이언트)';
// The entry's id (Windows' AppUserModelID), which both faces take. The taskbar groups windows by the id of
// their process and pins the Start-menu shortcut that carries it, and Windows shows a desktop program's
// notifications only for an id such a shortcut carries (Electron's notes on Windows). The shell names the
// faces apart (kr.myremote.host / .client, app/boot.js); once the host's own shortcut went (0.6.0) nothing
// carried the host's: its windows stood apart from the client app's, and its notice that a remote session
// started had no entry. (A process's id may be set again before its windows exist: the faces do so first.)
const APP_ID = 'kr.myremote.client';
function places({ platform = process.platform, appData, dataHome }) {
  if (platform === 'win32') {
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), dir = path.join(programs, 'MyRemote');
    return { entry: path.join(dir, 'MyRemote.lnk'), dir,
      older: [path.join(dir, 'MyRemote-Host.lnk'), path.join(dir, 'MyRemote-Client.lnk'), path.join(programs, 'My Remote', 'My Remote 호스트.lnk'), path.join(programs, 'My Remote', 'My Remote 클라이언트.lnk')],
      olderDir: path.join(programs, 'My Remote') };
  }
  if (platform === 'linux') {
    const dir = path.join(dataHome, 'applications');
    return { entry: path.join(dir, 'my-remote.desktop'), dir, older: [path.join(dir, 'my-remote-host.desktop'), path.join(dir, 'my-remote-client.desktop')], olderDir: '' };
  }
  return null;
}
const hasEntry = (o) => { const p = places(o); return !!p && fs.existsSync(p.entry); };
// An older shortcut of the installed app. On Linux a source folder's setup.sh makes entries of the same
// names that start start-host.sh / start-client.sh: those are not the app's and stay.
function appsOwn(platform, file) {
  if (!fs.existsSync(file)) return false;
  if (platform !== 'linux') return true;
  try { return /my-remote\.sh"? --(host|client)\b/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}
// Makes the entry where the older shortcuts are (or, with `create`, where there are none: the start
// screen's "바로가기 만들기") and removes the older ones. execPath: the app's program; iconDir: the shell's
// folder; writeLink: Electron's shell.writeShortcutLink (Windows). -> { made: [files], removed: [files] }
function unifyShortcuts({ platform = process.platform, appData, dataHome, execPath, iconDir, writeLink, create = false }) {
  const made = [], removed = [], p = places({ platform, appData, dataHome });
  if (!p) return { made, removed };
  const had = p.older.filter((f) => appsOwn(platform, f));
  if (!had.length && !create) return { made, removed }; // already one entry, or the person never wanted shortcuts
  fs.mkdirSync(p.dir, { recursive: true });
  if (platform === 'win32') {
    const ok = writeLink(p.entry, fs.existsSync(p.entry) ? 'update' : 'create',
      { target: execPath, args: ARGS.join(' '), description: ABOUT, icon: path.join(iconDir, 'icon.ico'), iconIndex: 0, appUserModelId: APP_ID });
    if (ok) made.push(p.entry);
  } else {
    const P = path.posix, launcher = P.join(P.dirname(execPath), 'my-remote.sh'); // the paths inside are the Linux program's
    fs.writeFileSync(p.entry, `[Desktop Entry]\nType=Application\nName=My Remote\nComment=${ABOUT}\nExec="${launcher}" ${ARGS.join(' ')}\nIcon=${P.join(iconDir, 'icon.png')}\nTerminal=false\nCategories=Network;RemoteAccess;\n`, { mode: 0o755 });
    made.push(p.entry);
  }
  if (made.length) {
    for (const f of had) { try { fs.rmSync(f, { force: true }); removed.push(f); } catch {} }
    if (p.olderDir) { try { fs.rmdirSync(p.olderDir); } catch {} } // only when nothing else is in it
  }
  return { made, removed };
}

module.exports = { dataRoot, shellParts, watch, unifyShortcuts, hasEntry, places, ARGS, APP_ID };
