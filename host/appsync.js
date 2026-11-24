// The installed app is one program with two faces, the host and the client app, which run the same
// installed versions (app/core.js). Two things here keep them one app:
//  - watch(): when one face installs an update, the other one, if it is running, still runs the old code.
//    It learns of the newer version from the shell's state (state.json), once that version has come up
//    in the face that installed it, and restarts into it when the moment fits (each face decides when).
//  - unifyShortcuts(): one entry, "Pangmote", which opens the start screen with its two big buttons
//    (client/launcher.html), in place of the two shortcuts (host, client) that packages up to 0.5.x made and
//    of the entry "MyRemote" of 0.6.0-0.9.x (the program's name before 0.10.0).
//  - retarget(): the person's own shortcuts to the program by its old name (MyRemote.exe), once a package of
//    the new name has taken that folder's place (host/shellswap.js).
// Both only in the installed app (global.__mrApp); run from a source folder there is no shell.
// Electron-free, so that release/test-appsync.js can run it in plain Node.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where the installed versions are: as app/boot.js's dataRoot (the update tests name another folder in the
// shell's config). It keeps the program's old name, as the profiles do (see app/boot.js).
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
// It keeps the program's old name (My Remote, up to 0.9.x): the taskbar's pins and Windows' notification
// settings go by it.
const APP_ID = 'kr.myremote.client';
function places({ platform = process.platform, appData, dataHome }) {
  if (platform === 'win32') {
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), dir = path.join(programs, 'Pangmote');
    const old = path.join(programs, 'MyRemote'), oldest = path.join(programs, 'My Remote');
    return { entry: path.join(dir, 'Pangmote.lnk'), dir,
      older: [path.join(old, 'MyRemote.lnk'), path.join(old, 'MyRemote-Host.lnk'), path.join(old, 'MyRemote-Client.lnk'), path.join(oldest, 'My Remote 호스트.lnk'), path.join(oldest, 'My Remote 클라이언트.lnk')],
      olderDirs: [old, oldest] };
  }
  if (platform === 'linux') {
    const dir = path.join(dataHome, 'applications');
    return { entry: path.join(dir, 'pangmote.desktop'), dir, older: [path.join(dir, 'my-remote.desktop'), path.join(dir, 'my-remote-host.desktop'), path.join(dir, 'my-remote-client.desktop')], olderDirs: [] };
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
// The program's start script on Linux, beside it: pangmote.sh, or my-remote.sh in a folder unpacked from a
// package of the program's old name (up to 0.9.x). '' when there is none (a source folder; Windows).
function launcherOf(execPath, platform = process.platform, exists = fs.existsSync) {
  if (platform === 'win32') return '';
  const P = path.posix, dir = P.dirname(execPath);
  for (const n of ['pangmote.sh', 'my-remote.sh']) if (exists(P.join(dir, n))) return P.join(dir, n);
  return '';
}
const sameFile = (a, b) => typeof a === 'string' && typeof b === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
// The program the entry starts now: its target (Windows), its launcher (Linux); '' when it cannot be read.
function entryProgram(platform, file, readLink) {
  try {
    if (platform === 'win32') return readLink ? String(readLink(file).target || '') : '';
    const m = /^Exec="([^"]+)"/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}
// Makes the entry where the older shortcuts are (or, with `create`, where there are none: the start
// screen's "바로가기 만들기") and removes the older ones; makes it anew where it starts a program that is gone or
// this folder's program by its old name (a package of the new name took the place of one of the old: the entry
// made before still names MyRemote.exe, or my-remote.sh, which then only starts pangmote.sh). An entry of another
// folder's program that is there stays (a second copy of the app does not take it over). execPath: the app's
// program; iconDir: the shell's folder; writeLink, readLink: Electron's shell.writeShortcutLink,
// shell.readShortcutLink (Windows). -> { made: [files], removed: [files] }
function unifyShortcuts({ platform = process.platform, appData, dataHome, execPath, iconDir, writeLink, readLink, create = false }) {
  const made = [], removed = [], p = places({ platform, appData, dataHome });
  if (!p) return { made, removed };
  const had = p.older.filter((f) => appsOwn(platform, f));
  const P = path.posix, launcher = platform === 'win32' ? '' : (launcherOf(execPath, platform) || P.join(P.dirname(execPath), 'pangmote.sh')); // the paths inside are the Linux program's
  const now = platform === 'win32' ? execPath : launcher;
  const target = fs.existsSync(p.entry) && (platform !== 'win32' || readLink) ? entryProgram(platform, p.entry, readLink) : '';
  const X = platform === 'win32' ? path.win32 : P;
  const oldHere = (t) => sameFile(X.dirname(t), X.dirname(now)) && /^(myremote\.exe|my-remote\.sh)$/i.test(X.basename(t));
  const stale = !!target && !sameFile(target, now) && (!fs.existsSync(target) || oldHere(target));
  if (!had.length && !create && !stale) return { made, removed }; // already one entry, or the person never wanted shortcuts
  fs.mkdirSync(p.dir, { recursive: true });
  if (platform === 'win32') {
    const ok = writeLink(p.entry, fs.existsSync(p.entry) ? 'update' : 'create',
      { target: execPath, args: ARGS.join(' '), description: ABOUT, icon: path.join(iconDir, 'icon.ico'), iconIndex: 0, appUserModelId: APP_ID });
    if (ok) made.push(p.entry);
  } else {
    fs.writeFileSync(p.entry, `[Desktop Entry]\nType=Application\nName=Pangmote\nComment=${ABOUT}\nExec="${launcher}" ${ARGS.join(' ')}\nIcon=${P.join(iconDir, 'icon.png')}\nTerminal=false\nCategories=Network;RemoteAccess;\n`, { mode: 0o755 });
    made.push(p.entry);
  }
  if (made.length) {
    for (const f of had) { try { fs.rmSync(f, { force: true }); removed.push(f); } catch {} }
    for (const d of p.olderDirs) { try { fs.rmdirSync(d); } catch {} } // only when nothing else is in it
  }
  return { made, removed };
}

// After a swap to a package of the new name (host/shellswap.js) the program of this folder is Pangmote.exe and
// MyRemote.exe is gone: the person's own shortcuts to it - on the desktop, in the Startup folder (a host started
// at sign-in), pinned to the taskbar or to Start - would say the item has been moved, and a host started at
// sign-in would not start. They get the new program. Only shortcuts whose target is exactly this folder's old
// program, only once that is gone, and only on Windows (on Linux the folder keeps a my-remote.sh that starts
// pangmote.sh). desktop: the person's desktop folder; mark: a file that says this program was done (read at
// every start, the folders only once per program). -> the shortcuts changed
function retarget({ platform = process.platform, appData, desktop, execPath, readLink, writeLink, mark }) {
  const done = [];
  if (platform !== 'win32' || !readLink || !writeLink || !execPath || /^myremote\.exe$/i.test(path.basename(execPath))) return done;
  const old = path.join(path.dirname(execPath), 'MyRemote.exe');
  if (fs.existsSync(old)) return done;
  if (mark) {
    try { if (JSON.parse(fs.readFileSync(mark, 'utf8')).exe === execPath) return done; } catch {}
    try { fs.writeFileSync(mark, JSON.stringify({ exe: execPath, at: Date.now() })); } catch {}
  }
  const ql = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch');
  const folders = [desktop, path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), path.join(ql, 'User Pinned', 'TaskBar'), path.join(ql, 'User Pinned', 'StartMenu'), ql];
  for (const folder of folders.filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(folder).filter((n) => /\.lnk$/i.test(n)); } catch { continue; }
    for (const n of names) {
      const f = path.join(folder, n);
      let t = null;
      try { t = readLink(f); } catch {}
      if (!t || !sameFile(t.target, old)) continue;
      const o = { target: execPath };
      if (sameFile(t.icon, old)) { o.icon = execPath; o.iconIndex = t.iconIndex || 0; }
      try { if (writeLink(f, 'update', o)) done.push(f); } catch {}
    }
  }
  return done;
}

module.exports = { dataRoot, shellParts, watch, unifyShortcuts, retarget, launcherOf, hasEntry, places, ARGS, APP_ID };
