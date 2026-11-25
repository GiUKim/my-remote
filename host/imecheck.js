// Whether the Korean keys (한/영, 한자) can do anything on this host, and if not why and what fixes it: the client shows
// that next to where the person types (the user's wish, 2026-11-25, after 한/영 did nothing on a Linux host that had no
// Korean input method). Asked only when one of those keys comes from the client, after it was injected: nothing is
// looked at otherwise, and the key is never held back for it.
//  - Linux (X11): the keys reach the program in front (keycode 130/131 are Hangul/Hangul_Hanja in the default map), and
//    what switches is an input method: ibus with ibus-hangul, fcitx5 with fcitx5-hangul, fcitx with fcitx-hangul, or a
//    Korean-only one (nabi, kime). Looked at: the input method programs running for this user (/proc), the Korean
//    engines installed (their files), and whether the engine is among those enabled (ibus: GNOME's input sources or
//    ibus' preloaded engines, read with gsettings; fcitx: its profile).
//  - Windows: a Korean keyboard among this session's, and chosen for the program in front (platform/win32.js).
// -> { ok: true } or { ok: false, os, why: 'missing' | 'stopped' | 'disabled' | 'notcurrent' | 'nokey' | 'inactive', im,
// fix }: `fix` a command to type at the host (installing needs the administrator's password: it is shown, never run).
// Only the 한/영 key asks (the texts are about it; 한자 is used after it).
// Electron-free; the system is reached through `io`, so release/test-imecheck.js runs every case in plain Node.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// The input method frameworks a Korean engine plugs into: the program that runs, where engines are found (a file whose
// name has "hangul"), the package with the Korean engine, how to start it, its settings.
const FRAMEWORKS = {
  fcitx5: { daemon: 'fcitx5', dirs: ['/usr/share/fcitx5/addon', '/usr/share/fcitx5/inputmethod'], pkg: 'fcitx5-hangul', start: 'fcitx5 -d', setup: 'fcitx5-configtool' },
  fcitx: { daemon: 'fcitx', dirs: ['/usr/share/fcitx/addon', '/usr/share/fcitx/inputmethod'], pkg: 'fcitx-hangul', start: 'fcitx -d', setup: 'fcitx-configtool' },
  ibus: { daemon: 'ibus-daemon', dirs: ['/usr/share/ibus/component'], pkg: 'ibus-hangul', start: 'ibus-daemon -drx', setup: 'ibus-setup' },
};
const KOREAN_ONLY = new Set(['nabi', 'kime']); // input methods for Korean alone: running is enough
// The distribution's package manager, the first one there.
const INSTALL = [['/usr/bin/apt', 'sudo apt install'], ['/usr/bin/dnf', 'sudo dnf install'], ['/usr/bin/zypper', 'sudo zypper install'], ['/usr/bin/pacman', 'sudo pacman -S']];

// The system as this module sees it (a test gives its own).
function realIo() {
  return {
    readdir: (p) => fs.promises.readdir(p),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    uidOf: async (p) => (await fs.promises.stat(p)).uid,
    exists: (p) => fs.existsSync(p),
    // A read-only command's output, or null when it failed or took too long.
    run: (file, args) => new Promise((res) => { execFile(file, args, { timeout: 2000, windowsHide: true }, (err, out) => res(err ? null : String(out))); }),
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    configHome: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    koreanKeyboard: () => require('./input').koreanKeyboard(),
  };
}

// The input method programs of this user that run now (their names, as in FRAMEWORKS and KOREAN_ONLY).
async function running(io) {
  const want = new Set([...Object.values(FRAMEWORKS).map((f) => f.daemon), ...KOREAN_ONLY]), found = new Set();
  let pids = [];
  try { pids = (await io.readdir('/proc')).filter((n) => /^\d+$/.test(n)); } catch { return found; }
  await Promise.all(pids.map(async (pid) => {
    let name;
    try { name = (await io.readFile(`/proc/${pid}/comm`)).trim(); } catch { return; } // ended meanwhile
    if (!want.has(name) || found.has(name)) return;
    try { if ((await io.uidOf(`/proc/${pid}`)) === io.uid) found.add(name); } catch {} // another user's (a login screen's ibus) does not count
  }));
  return found;
}
// Whether a framework's Korean engine is installed: a file of it in the framework's folders.
async function installed(io, f) {
  for (const d of f.dirs) { try { if ((await io.readdir(d)).some((n) => /hangul/i.test(n))) return true; } catch {} }
  return false;
}
// Whether the Korean engine is among those the framework offers: true, false, or null when that cannot be told (it is
// then taken as enabled: the note is for what is certain).
async function enabled(io, name) {
  if (name === 'ibus') {
    const [gnome, ibus] = await Promise.all([io.run('gsettings', ['get', 'org.gnome.desktop.input-sources', 'sources']), io.run('gsettings', ['get', 'org.freedesktop.ibus.general', 'preload-engines'])]);
    if (gnome == null && ibus == null) return null;
    return /hangul/i.test(`${gnome || ''} ${ibus || ''}`);
  }
  const file = path.posix.join(io.configHome, name, 'profile');
  try { return name === 'fcitx5' ? /^Name=hangul\s*$/mi.test(await io.readFile(file)) : /hangul:True/i.test(await io.readFile(file)); } catch (e) { return e && e.code === 'ENOENT' ? false : null; }
}
const install = (io, pkg) => { const m = INSTALL.find(([bin]) => io.exists(bin)); return m ? `${m[1]} ${pkg}` : pkg; };

async function linux(io) {
  const run = await running(io);
  if ([...KOREAN_ONLY].some((n) => run.has(n))) return { ok: true };
  const names = Object.keys(FRAMEWORKS), on = names.filter((n) => run.has(FRAMEWORKS[n].daemon));
  const has = {};
  await Promise.all(names.map(async (n) => { has[n] = await installed(io, FRAMEWORKS[n]); }));
  const ready = on.find((n) => has[n]);
  if (ready) {
    if ((await enabled(io, ready)) !== false) return ready === 'ibus' ? { ok: true, live: 'ibus' } : { ok: true };
    const gnome = ready === 'ibus' && (await io.run('gsettings', ['get', 'org.gnome.desktop.input-sources', 'sources'])) != null;
    return { ok: false, os: 'linux', why: 'disabled', im: ready, fix: gnome ? 'gnome-control-center keyboard' : FRAMEWORKS[ready].setup };
  }
  if (on.length) return { ok: false, os: 'linux', why: 'missing', im: on[0], fix: install(io, FRAMEWORKS[on[0]].pkg) };
  const off = names.find((n) => has[n]);
  if (off) return { ok: false, os: 'linux', why: 'stopped', im: off, fix: FRAMEWORKS[off].start };
  return { ok: false, os: 'linux', why: 'missing', im: 'ibus', fix: install(io, FRAMEWORKS.ibus.pkg) };
}
// What can change at any moment with ibus, asked at every 한/영 key (the rest above is kept): found on GNOME on
// 2026-11-25, both with the key doing nothing and no note.
//  - The engine in use is not the Korean one: with English and Korean sources the key switches only inside the Korean
//    engine, and the sources change with Super+Space (GNOME's and ibus' own default) -> 'notcurrent'.
//  - ibus-hangul's keys that switch (or turn on) Korean do not have Hangul (someone kept only Shift+Space, or Alt_R)
//    -> 'nokey', with the command that adds it and keeps theirs.
// A value that cannot be read says nothing (ok).
const HANGUL_SCHEMA = 'org.freedesktop.ibus.engine.hangul';
async function ibusLive(io) {
  const [engine, sw, on] = await Promise.all([io.run('ibus', ['engine']),
    io.run('gsettings', ['get', HANGUL_SCHEMA, 'switch-keys']), io.run('gsettings', ['get', HANGUL_SCHEMA, 'on-keys'])]);
  const now = engine == null ? '' : engine.trim();
  if (now && !/hangul/i.test(now)) return { ok: false, os: 'linux', why: 'notcurrent', im: 'ibus', fix: '' };
  const keys = (v) => (v == null ? null : v.trim().replace(/^'(.*)'$/, '$1'));
  const s = keys(sw), o = keys(on), has = (v) => v != null && v.split(',').some((k) => k.trim() === 'Hangul');
  if (s == null || has(s) || has(o)) return { ok: true };
  // The command keeps what is there (only plain key names are put into it; anything else: the settings program).
  const fix = /^[A-Za-z0-9_+,-]*$/.test(s) ? `gsettings set ${HANGUL_SCHEMA} switch-keys '${s ? s + ',' : ''}Hangul'` : 'ibus-setup-hangul';
  return { ok: false, os: 'linux', why: 'nokey', im: 'ibus', fix };
}
function windows(io) {
  const k = io.koreanKeyboard();
  if (!k) return { ok: true };
  // The language settings open with this in Win+R (or the Start menu's search): add Korean there.
  if (!k.any) return { ok: false, os: 'windows', why: 'missing', im: '', fix: 'ms-settings:regionlanguage' };
  if (!k.active) return { ok: false, os: 'windows', why: 'inactive', im: '', fix: '' };
  return { ok: true };
}
async function check(platform, io) {
  if (platform === 'linux') return linux(io);
  if (platform === 'win32') return windows(io);
  return { ok: true };
}

// The answer, kept: a good one for 10 minutes, a bad one for 3 s (so that a key pressed again after installing what was
// missing finds it at once). One look at a time; a look that fails says nothing (ok). A good answer with a live part
// (ibus) has that part asked again after liveMs (the engine in use changes with a key).
function create({ platform = process.platform, io = null, now = Date.now, okMs = 10 * 60e3, badMs = 3e3, liveMs = 2e3 } = {}) {
  const kept = (good, bad, look) => {
    let last = null, busy = null;
    return () => {
      const t = now();
      if (last && t - last.at < (last.r.ok ? good : bad)) return Promise.resolve(last.r);
      if (!busy) {
        busy = Promise.resolve().then(look).catch(() => ({ ok: true }))
          .then((r) => { last = { r, at: now() }; busy = null; return r; });
      }
      return busy;
    };
  };
  const base = kept(okMs, badMs, () => check(platform, io || (io = realIo())));
  const live = kept(liveMs, liveMs, () => ibusLive(io));
  return () => base().then((r) => (r.ok && r.live === 'ibus' ? live() : r));
}

// A made-up Linux for the self-test (whatever the PC it runs on has): ibus runs for this user, no Korean engine, apt.
function madeUp() {
  const no = () => Object.assign(new Error('none'), { code: 'ENOENT' });
  const dirs = { '/proc': ['1', '42'], '/usr/share/ibus/component': ['simple.xml'] }, files = { '/proc/1/comm': 'systemd\n', '/proc/42/comm': 'ibus-daemon\n' };
  return {
    readdir: async (p) => { if (dirs[p]) return dirs[p]; throw no(); },
    readFile: async (p) => { if (files[p] != null) return files[p]; throw no(); },
    uidOf: async () => 1000, uid: 1000, exists: (p) => p === '/usr/bin/apt', run: async () => null, configHome: '/nowhere', koreanKeyboard: () => undefined,
  };
}

module.exports = { create, check, madeUp, FRAMEWORKS };
