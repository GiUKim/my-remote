// Whether the Korean keys can work on a host (host/imecheck.js), in plain Node with made-up systems: Linux with and
// without an input method running (this user's only), with and without its Korean engine, enabled or not, other
// package managers and frameworks, a Korean-only input method; Windows' Korean keyboard; the answer kept and asked once.
//   node release/test-imecheck.js
'use strict';
const ime = require('../host/imecheck');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const ME = 1000;
// A made-up Linux. procs: [[comm, uid]]; engines: { dir: [file names] }; bins: paths that exist; gs: gsettings outputs by
// key (null: the command failed); files: other readable files.
function linux({ procs = [], engines = {}, bins = ['/usr/bin/apt'], gs = {}, files = {} } = {}) {
  const no = () => Object.assign(new Error('none'), { code: 'ENOENT' });
  const pids = procs.map((_, i) => String(100 + i));
  return {
    readdir: async (p) => { if (p === '/proc') return [...pids, 'self', 'cpuinfo']; if (engines[p]) return engines[p]; throw no(); },
    readFile: async (p) => {
      const m = /^\/proc\/(\d+)\/comm$/.exec(p);
      if (m) { const pr = procs[Number(m[1]) - 100]; if (pr) return pr[0] + '\n'; throw no(); }
      if (files[p] != null) return files[p];
      throw no();
    },
    uidOf: async (p) => { const pr = procs[Number(p.split('/')[2]) - 100]; if (!pr) throw no(); return pr[1]; },
    exists: (p) => bins.includes(p),
    run: async (file, args) => { const v = gs[args[1]]; return v === undefined ? null : v; },
    uid: ME, configHome: '/home/u/.config',
  };
}
const IBUS = { '/usr/share/ibus/component': ['simple.xml', 'hangul.xml'] }, NOHANGUL = { '/usr/share/ibus/component': ['simple.xml'] };
const check = (io) => ime.check('linux', io);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const none = await check(linux());
  const noEngine = await check(linux({ procs: [['ibus-daemon', ME]], engines: NOHANGUL }));
  const othersOnly = await check(linux({ procs: [['ibus-daemon', 0]], engines: NOHANGUL }));
  ok('no Korean input method: missing, with the install command of the distribution (apt) for ibus; an input method another user runs (a login screen\'s) does not count',
    same(none, { ok: false, os: 'linux', why: 'missing', im: 'ibus', fix: 'sudo apt install ibus-hangul' }) && same(noEngine, none) && same(othersOnly, none),
    JSON.stringify({ none, noEngine, othersOnly }));

  const fcitx5 = await check(linux({ procs: [['fcitx5', ME]], bins: ['/usr/bin/dnf'] }));
  const fcitx5ok = await check(linux({ procs: [['fcitx5', ME]], engines: { '/usr/share/fcitx5/addon': ['hangul.conf'] }, files: { '/home/u/.config/fcitx5/profile': '[Groups/0/Items/1]\nName=hangul\nLayout=\n' } }));
  const fcitx5off = await check(linux({ procs: [['fcitx5', ME]], engines: { '/usr/share/fcitx5/inputmethod': ['hangul.conf'] } }));
  ok('fcitx5: its own Korean package (with dnf), ok when the profile has hangul, else disabled with its settings program',
    same(fcitx5, { ok: false, os: 'linux', why: 'missing', im: 'fcitx5', fix: 'sudo dnf install fcitx5-hangul' }) && fcitx5ok.ok
      && same(fcitx5off, { ok: false, os: 'linux', why: 'disabled', im: 'fcitx5', fix: 'fcitx5-configtool' }), JSON.stringify({ fcitx5, fcitx5ok, fcitx5off }));

  const gnomeOn = await check(linux({ procs: [['ibus-daemon', ME]], engines: IBUS, gs: { 'org.gnome.desktop.input-sources': "[('xkb', 'us'), ('ibus', 'hangul')]", 'org.freedesktop.ibus.general': '@as []' } }));
  const gnomeOff = await check(linux({ procs: [['ibus-daemon', ME]], engines: IBUS, gs: { 'org.gnome.desktop.input-sources': "[('xkb', 'us')]", 'org.freedesktop.ibus.general': '@as []' } }));
  const kdeOn = await check(linux({ procs: [['ibus-daemon', ME]], engines: IBUS, gs: { 'org.freedesktop.ibus.general': "['hangul']" } }));
  const kdeOff = await check(linux({ procs: [['ibus-daemon', ME]], engines: IBUS, gs: { 'org.freedesktop.ibus.general': '@as []' } }));
  const unknown = await check(linux({ procs: [['ibus-daemon', ME]], engines: IBUS }));
  ok('ibus with ibus-hangul: ok when GNOME\'s input sources or ibus\' engines have hangul; else disabled (GNOME\'s keyboard settings, or ibus-setup); ok when that cannot be read',
    gnomeOn.ok && kdeOn.ok && unknown.ok && same(gnomeOff, { ok: false, os: 'linux', why: 'disabled', im: 'ibus', fix: 'gnome-control-center keyboard' })
      && same(kdeOff, { ok: false, os: 'linux', why: 'disabled', im: 'ibus', fix: 'ibus-setup' }), JSON.stringify({ gnomeOff, kdeOff }));

  const stopped = await check(linux({ engines: IBUS }));
  const stoppedOthers = await check(linux({ procs: [['ibus-daemon', 0]], engines: IBUS }));
  const korean = await check(linux({ procs: [['kime', ME]] }));
  const nabi = await check(linux({ procs: [['nabi', ME]], engines: NOHANGUL }));
  const noManager = await check(linux({ bins: [] }));
  ok('installed but not running: stopped, with how to start it; a Korean-only input method (kime, nabi) is enough; without a known package manager the package\'s name',
    same(stopped, { ok: false, os: 'linux', why: 'stopped', im: 'ibus', fix: 'ibus-daemon -drx' }) && same(stoppedOthers, stopped) && korean.ok && nabi.ok && noManager.fix === 'ibus-hangul',
    JSON.stringify({ stopped, noManager }));

  const win = (k) => ime.check('win32', { koreanKeyboard: () => k });
  const [w0, w1, w2, w3] = await Promise.all([win(undefined), win({ any: false, active: false }), win({ any: true, active: false }), win({ any: true, active: true })]);
  ok('Windows: no Korean keyboard (the language settings to open), one not chosen for the program in front, one in use; nothing known: ok',
    w0.ok && same(w1, { ok: false, os: 'windows', why: 'missing', im: '', fix: 'ms-settings:regionlanguage' }) && same(w2, { ok: false, os: 'windows', why: 'inactive', im: '', fix: '' }) && w3.ok,
    JSON.stringify({ w1, w2 }));

  // The answer kept: a bad one 3 s (a key after installing finds it), a good one 10 minutes; one look at a time.
  let t = 0, looks = 0, state = 'bad';
  const io = { readdir: async (p) => { if (p === '/proc') { looks++; return state === 'good' ? ['7'] : []; } throw new Error('none'); },
    readFile: async (p) => { if (p === '/proc/7/comm') return 'kime\n'; throw new Error('none'); }, uidOf: async () => ME, uid: ME, exists: () => true, run: async () => null, configHome: '/x' };
  const status = ime.create({ platform: 'linux', io, now: () => t });
  const [a, b] = await Promise.all([status(), status()]);
  t = 1000; const c = await status();
  state = 'good'; t = 3500; const d = await status();
  t = 60e3; const e = await status();
  const thrown = await ime.create({ platform: 'linux', io: { readdir: () => { throw new Error('boom'); } } })();
  ok('kept: two looks at once are one, a bad answer is asked again after 3 s, a good one kept; a look that fails says ok',
    a === b && !a.ok && c === a && looks === 2 && d.ok && e === d && thrown.ok, JSON.stringify({ looks, d }));

  // ibus with its Korean engine enabled is fine for now, and asked at each key what can change (found on GNOME,
  // 2026-11-25): the engine in use, and whether ibus-hangul's switch (or on) keys have Hangul.
  const ibusIo = ({ engine = 'hangul', sw = "'Hangul,Shift+space'", on, runs } = {}) => {
    const io = linux({ procs: [['ibus-daemon', ME]], engines: IBUS });
    const answers = { 'ibus engine': engine, 'gsettings get org.gnome.desktop.input-sources sources': "[('xkb', 'us'), ('ibus', 'hangul')]",
      'gsettings get org.freedesktop.ibus.general preload-engines': '@as []', 'gsettings get org.freedesktop.ibus.engine.hangul switch-keys': sw,
      'gsettings get org.freedesktop.ibus.engine.hangul on-keys': on };
    io.run = async (file, args) => { const k = [file, ...args].join(' '); if (runs) runs.push(k); const v = answers[k]; return v === undefined ? null : typeof v === 'function' ? v() : v; };
    return io;
  };
  const live = (o) => ime.create({ platform: 'linux', io: ibusIo(o) })();
  const plain = await check(ibusIo());
  const [fine, english, keyless, onKey, emptyKeys, oddKeys, unread, engineUnread] = await Promise.all([live(), live({ engine: 'xkb:us::eng\n' }),
    live({ sw: "'Shift+space'" }), live({ sw: "'Shift+space'", on: "'Hangul'" }), live({ sw: "''" }), live({ sw: "'Shift+space;rm'" }), live({ sw: undefined }), live({ engine: undefined })]);
  ok('ibus: the engine in use not the Korean one is notcurrent (Super+Space); switch keys without Hangul is nokey, with the command that adds it and keeps theirs; Hangul among the on keys, or what cannot be read, is fine',
    same(plain, { ok: true, live: 'ibus' }) && same(fine, { ok: true }) && same(english, { ok: false, os: 'linux', why: 'notcurrent', im: 'ibus', fix: '' })
      && same(keyless, { ok: false, os: 'linux', why: 'nokey', im: 'ibus', fix: "gsettings set org.freedesktop.ibus.engine.hangul switch-keys 'Shift+space,Hangul'" })
      && onKey.ok && emptyKeys.fix === "gsettings set org.freedesktop.ibus.engine.hangul switch-keys 'Hangul'" && oddKeys.fix === 'ibus-setup-hangul' && unread.ok && engineUnread.ok,
    JSON.stringify({ english, keyless, emptyKeys, oddKeys }));

  // The live part is asked again after 2 s (the base answer kept), and once at a time.
  let lt = 0, engineNow = 'xkb:us::eng';
  const runs = [];
  const ls = ime.create({ platform: 'linux', io: ibusIo({ engine: () => engineNow, runs }), now: () => lt });
  const [l1, l2] = await Promise.all([ls(), ls()]);
  engineNow = 'hangul'; lt = 1000; const l3 = await ls();
  lt = 2500; const l4 = await ls();
  engineNow = 'xkb:us::eng'; lt = 60e3; const l5 = await ls();
  const engineAsked = runs.filter((r) => r === 'ibus engine').length, procsAsked = runs.filter((r) => r.includes('input-sources')).length;
  ok('ibus: the engine in use is asked again after 2 s, once at a time; the rest is kept',
    l1 === l2 && l1.why === 'notcurrent' && l3 === l1 && l4.ok && l5.why === 'notcurrent' && engineAsked === 3 && procsAsked === 1, JSON.stringify({ engineAsked, procsAsked, l4, l5 }));

  const made = await check(ime.madeUp());
  ok('the self-test\'s made-up Linux: ibus without its Korean engine, apt', same(made, { ok: false, os: 'linux', why: 'missing', im: 'ibus', fix: 'sudo apt install ibus-hangul' }), JSON.stringify(made));

  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
