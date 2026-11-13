// Tests of the app shell's update logic (app/core.js, app/updater.js) in plain Node, with made-up
// releases, a made-up feed and temporary folders:   node release/test-update.js
// Every check is about something that must not happen to an installed app: taking a release nobody
// signed, a file that is not the release's, a version older than the one it runs; staying on a version
// that does not start; missing a required update, or installing an optional one unasked.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../app/core');
const updater = require('../app/updater');
const { build } = require('./build');

let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  - ' + detail}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message || 'threw'; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-update-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two key pairs: the app trusts the first, the second stands for anybody else.
const keyFile = (name) => { const { privateKey } = crypto.generateKeyPairSync('ed25519'); const f = path.join(tmp, name + '.pem'); fs.writeFileSync(f, privateKey.export({ type: 'pkcs8', format: 'pem' })); return { file: f, pub: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') }; };
const ours = keyFile('ours'), theirs = keyFile('theirs');
const KEYS = [ours.pub];

// A made-up release: files that say which version they are.
function release(version, opts = {}) {
  const files = new Map([['host/main.js', Buffer.from(`module.exports = '${version}';\n`)], ['host/package.json', Buffer.from(JSON.stringify({ version }))], ['client/main.js', Buffer.from(`// ${version}\n`)]]);
  const out = path.join(tmp, `rel-${version}-${Math.random().toString(36).slice(2, 8)}`);
  const r = build({ out, key: (opts.key || ours).file, version, files, notes: { ko: ['시험 ' + version], en: ['test ' + version] }, minimum: opts.minimum || '0.0.0', critical: !!opts.critical, needsBase: opts.needsBase || 1, date: '2026-01-01' });
  return { ...r, bytes: fs.readFileSync(path.join(out, 'latest.json')), sig: fs.readFileSync(path.join(out, 'latest.json.sig'), 'utf8'), bundle: fs.readFileSync(path.join(out, r.bundleFile)), dir: path.join(out, 'bundle') };
}
const newRoot = () => fs.mkdtempSync(path.join(tmp, 'root-'));

(async () => {
  // ---- versions ----
  check('versions compare as numbers', core.cmp('0.10.0', '0.9.9') > 0 && core.cmp('1.0.0', '1.0.0') === 0 && core.cmp('0.2.9', '0.3.0') < 0 && !!throws(() => core.cmp('1.0', '1.0.0')));

  // ---- the manifest ----
  const r1 = release('1.0.1');
  check('a manifest signed by a trusted key is taken', core.verifyManifest(r1.bytes, r1.sig, KEYS).version === '1.0.1');
  const flipped = Buffer.from(r1.bytes); flipped[flipped.indexOf('1.0.1')] = 0x32; // "2.0.1": one byte changed
  check('one changed byte is refused', /signature/.test(throws(() => core.verifyManifest(flipped, r1.sig, KEYS))));
  const foreign = release('9.9.9', { key: theirs });
  check('a manifest signed by another key is refused', /signature/.test(throws(() => core.verifyManifest(foreign.bytes, foreign.sig, KEYS))));
  check('a signature is needed', /signature/.test(throws(() => core.verifyManifest(r1.bytes, '', KEYS))) && /signature/.test(throws(() => core.verifyManifest(r1.bytes, r1.sig, []))));
  const signedAs = (o) => { const b = Buffer.from(JSON.stringify(o)); return [b, core.signManifest(b, fs.readFileSync(ours.file, 'utf8'))]; };
  const bad = (change) => { const m = JSON.parse(r1.bytes.toString('utf8')); change(m); const [b, s] = signedAs(m); return throws(() => core.verifyManifest(b, s, KEYS)); };
  const H = 'a'.repeat(64);
  check('file names that could leave the folder are refused, even signed', ['../x.js', '/etc/x', 'C:/x.js', 'a\\b.js', 'a//b.js', '.hidden', 'a/../b', 'x.', 'con:x', 'a/b '].every((n) => /bad file entry/.test(bad((m) => { m.files[n] = H; }))),
    ['../x.js', '/etc/x', 'C:/x.js', 'a\\b.js', 'a//b.js', '.hidden', 'a/../b', 'x.', 'con:x', 'a/b '].filter((n) => !/bad file entry/.test(bad((m) => { m.files[n] = H; }))).join(' '));
  check('two names that are one file on Windows are refused', /case/.test(bad((m) => { m.files['host/MAIN.js'] = H; })));
  check('a manifest of something else, or of a format not known, is refused', !!bad((m) => { m.app = 'other'; }) && !!bad((m) => { m.format = 2; }) && !!bad((m) => { m.version = '1.0'; }) && !!bad((m) => { m.bundle.file = '../b'; }));

  // ---- installing ----
  const root = newRoot(), m1 = core.verifyManifest(r1.bytes, r1.sig, KEYS);
  const dir = core.installVersion(root, m1, r1.bytes, r1.sig, r1.bundle);
  check('a release is installed as the files its manifest lists', fs.readFileSync(path.join(dir, 'host', 'main.js'), 'utf8').includes('1.0.1') && core.verifyFolder(dir, KEYS).ok);
  const other = release('1.0.1'); // same version, same key, but not this manifest's bundle
  const evil = core.packBundle(new Map([['host/main.js', Buffer.from('evil')], ['host/package.json', Buffer.from('{}')], ['client/main.js', Buffer.from('x')]]));
  check('a bundle that is not the manifest\'s is refused', /not the file/.test(throws(() => core.installVersion(newRoot(), m1, r1.bytes, r1.sig, evil))) && other.bundle.length > 0);
  const m1b = { ...m1, bundle: { ...m1.bundle, size: evil.length, sha256: core.sha256(evil) } }; // even if the bundle's own hash were right
  check('a file in the bundle that is not the manifest\'s file is refused', /not the file/.test(throws(() => core.installVersion(newRoot(), m1b, r1.bytes, r1.sig, evil))));
  const extra = core.packBundle(new Map([...core.unpackBundle(r1.bundle), ['host/extra.js', Buffer.from('more')]]));
  check('a bundle with a file the manifest does not list is refused', /not the manifest/.test(throws(() => core.installVersion(newRoot(), { ...m1, bundle: { ...m1.bundle, size: extra.length, sha256: core.sha256(extra) } }, r1.bytes, r1.sig, extra))));
  fs.appendFileSync(path.join(dir, 'host', 'main.js'), '// changed');
  check('an installed file changed afterwards is noticed', !core.verifyFolder(dir, KEYS).ok && /changed/.test(core.verifyFolder(dir, KEYS).why));

  // ---- which version runs ----
  {
    const root = newRoot(), builtin = { dir: release('1.0.0').dir, version: '1.0.0' }, env = { root, builtin, base: 1, keys: KEYS };
    check('with nothing installed the built-in code runs', core.choose(env).source === 'builtin');
    const a = release('1.0.1'), b = release('1.0.2');
    core.installVersion(root, core.verifyManifest(a.bytes, a.sig, KEYS), a.bytes, a.sig, a.bundle);
    core.activate(root, '1.0.1', { version: '1.0.0', source: 'builtin' });
    let p = core.choose(env);
    check('a newly installed version runs, on trial', p.version === '1.0.1' && p.source === 'installed' && p.trial === true);
    core.markOk(root, '1.0.1');
    p = core.choose(env);
    check('once it said it is up, its trial is over', p.version === '1.0.1' && p.trial === false && core.readState(root).trial === null);
    core.installVersion(root, core.verifyManifest(b.bytes, b.sig, KEYS), b.bytes, b.sig, b.bundle);
    core.activate(root, '1.0.2', p);
    const s1 = core.choose(env), s2 = core.choose(env), s3 = core.choose(env);
    check('a version that does not come up in two starts is given up, and the one before runs again',
      s1.version === '1.0.2' && s1.trial && s2.version === '1.0.2' && s2.trial && s3.version === '1.0.1' && !s3.trial && s3.rolledBack.length === 1 && !!core.readState(root).bad['1.0.2'],
      JSON.stringify([s1.version, s2.version, s3.version, core.readState(root)]));
    check('and it is never run again', core.choose(env).version === '1.0.1');
    {
      // Starts while the one on trial is still running do not count against it.
      const root = newRoot(), envP = { root, builtin, base: 1, keys: KEYS, alive: (p) => p === 111 };
      core.installVersion(root, core.verifyManifest(a.bytes, a.sig, KEYS), a.bytes, a.sig, a.bundle);
      core.activate(root, '1.0.1', { version: '1.0.0', source: 'builtin' });
      const first = core.choose({ ...envP, pid: 111 }), beside = [222, 333, 444].map((pid) => core.choose({ ...envP, pid }));
      check('more starts beside a version on trial that is still running do not count as failed starts',
        first.trial && beside.every((b) => b.version === '1.0.1' && !b.trial) && core.readState(root).trial.starts === 1 && !core.readState(root).bad['1.0.1'], JSON.stringify(core.readState(root)));
      const gone = { ...envP, alive: () => false };
      const second = core.choose({ ...gone, pid: 555 }), third = core.choose({ ...gone, pid: 666 });
      check('but once it has ended, the next ones do', second.trial && second.version === '1.0.1' && third.version === '1.0.0' && !!core.readState(root).bad['1.0.1']);
    }
    fs.writeFileSync(path.join(core.versionDir(root, '1.0.1'), 'client', 'main.js'), 'tampered');
    p = core.choose(env);
    check('an installed version whose files were changed is not run: the built-in code is', p.source === 'builtin' && p.rolledBack.some((r) => /changed/.test(r.why)));
    // A reinstalled app that brings a newer version than what was installed by updates
    const root2 = newRoot();
    core.installVersion(root2, core.verifyManifest(a.bytes, a.sig, KEYS), a.bytes, a.sig, a.bundle);
    core.activate(root2, '1.0.1', { version: '1.0.0', source: 'builtin' }); core.markOk(root2, '1.0.1');
    check('built-in code as new as the installed version wins (the app was installed anew)', core.choose({ root: root2, builtin: { dir: b.dir, version: '1.0.2' }, base: 1, keys: KEYS }).source === 'builtin');
    const c = release('1.0.3', { needsBase: 2 }), root3 = newRoot();
    core.installVersion(root3, core.verifyManifest(c.bytes, c.sig, KEYS), c.bytes, c.sig, c.bundle);
    core.activate(root3, '1.0.3', { version: '1.0.0', source: 'builtin' });
    check('a version made for a newer shell is not run on this one', core.choose({ root: root3, builtin, base: 1, keys: KEYS }).source === 'builtin');
    const root4 = newRoot();
    fs.mkdirSync(root4, { recursive: true }); fs.writeFileSync(path.join(root4, 'state.json'), '{ not json');
    check('a broken state file means the built-in code, not a crash', core.choose({ root: root4, builtin, base: 1, keys: KEYS }).source === 'builtin');
  }

  // ---- the updater against a feed ----
  const feedOf = (rel, change = {}) => {
    const served = { 'latest.json': rel.bytes, 'latest.json.sig': Buffer.from(rel.sig), [rel.bundleFile]: rel.bundle, ...change };
    const fetch = async (url) => {
      const name = url.replace('https://feed.test/', '');
      const body = served[name];
      if (!body) return { ok: false, status: 404, headers: { get: () => null } };
      let sent = false;
      return { ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(body.length) : null) }, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(body) })) }) } };
    };
    return fetch;
  };
  const make = (rel, running, opts = {}) => {
    const root = opts.root || newRoot(), restarts = [];
    const u = updater.create({ core, root, base: 1, keys: KEYS, feed: 'https://feed.test/', running: { version: running, source: 'builtin' }, fetch: feedOf(rel, opts.change), restart: () => restarts.push(Date.now()),
      timing: { restartWaitMs: opts.waitMs || 400, restartPollMs: 20 } });
    return { u, root, restarts };
  };
  {
    const { u, root, restarts } = make(release('1.0.1'), '1.0.0');
    const s = await u.check();
    check('an ordinary update is offered, not installed', s.state === 'available' && s.available.version === '1.0.1' && s.available.required === false && s.available.kind === 'bundle' && s.available.notes.ko[0] === '시험 1.0.1' && core.readState(root).current === null && restarts.length === 0);
    await u.install();
    check('chosen, it is installed and the app restarted at once', core.readState(root).current === '1.0.1' && core.readState(root).trial.starts === 0 && restarts.length === 1 && core.verifyFolder(core.versionDir(root, '1.0.1'), KEYS).ok);
  }
  {
    const { u, restarts } = make(release('1.0.0'), '1.0.0');
    const s = await u.check();
    check('the same version is no update', s.state === 'idle' && !s.available);
    const older = make(release('0.9.0'), '1.0.0');
    const s2 = await older.u.check();
    check('an older release is never taken (no way back to a version with known faults)', s2.state === 'idle' && !s2.available && older.restarts.length === 0 && restarts.length === 0);
  }
  {
    const { u, root, restarts } = make(release('1.0.1', { critical: true }), '1.0.0');
    let may = false;
    u.setCanRestart(() => may);
    const s = await u.check();
    await sleep(120);
    check('a critical update is installed without asking, and waits for a moment that fits to restart', s.available.required === true && core.readState(root).current === '1.0.1' && restarts.length === 0 && u.status().state === 'ready');
    may = true;
    await sleep(120);
    check('then restarts', restarts.length === 1);
  }
  {
    const { u, restarts } = make(release('1.0.1', { critical: true }), '1.0.0', { waitMs: 150 });
    u.setCanRestart(() => false);
    await u.check();
    await sleep(400);
    check('and does not wait for ever', restarts.length === 1);
  }
  {
    const { u, root } = make(release('1.0.5', { minimum: '1.0.3' }), '1.0.2');
    const s = await u.check();
    await sleep(100);
    check('an app older than the release\'s minimum must update, though the release itself is ordinary', s.available.required === true && core.readState(root).current === '1.0.5');
    const fine = make(release('1.0.5', { minimum: '1.0.3' }), '1.0.3');
    check('one that is not, may choose', (await fine.u.check()).available.required === false && core.readState(fine.root).current === null);
  }
  {
    const { u, root, restarts } = make(release('2.0.0', { needsBase: 2, critical: true }), '1.0.0');
    const s = await u.check();
    await sleep(80);
    const refused = await u.install().then(() => false, () => true);
    check('a release for a newer shell is announced, not installed', s.available.kind === 'package' && s.available.required === true && refused && core.readState(root).current === null && restarts.length === 0);
  }
  {
    const rel = release('1.0.1'), forged = release('1.0.1', { key: theirs });
    const a = make(rel, '1.0.0', { change: { 'latest.json.sig': Buffer.from(forged.sig) } });
    const s = await a.u.check();
    check('a feed whose manifest is not signed by us offers nothing', s.state === 'idle' && !s.available && /signature/.test(s.error));
    const b = make(rel, '1.0.0', { change: { [rel.bundleFile]: forged.bundle.length === rel.bundle.length ? Buffer.concat([forged.bundle.subarray(1), Buffer.from([0])]) : Buffer.alloc(rel.bundle.length, 7) } });
    await b.u.check();
    const err = await b.u.install().then(() => '', (e) => e.message);
    check('a feed whose bundle is not the manifest\'s installs nothing', /not the file|unpacked|too large/.test(err) && core.readState(b.root).current === null && b.restarts.length === 0 && b.u.status().state === 'available', err);
    const c = make(rel, '1.0.0', { change: { [rel.bundleFile]: Buffer.alloc(rel.bundle.length + 5000, 1) } });
    await c.u.check();
    check('a bundle larger than the manifest says is cut off', /too large/.test(await c.u.install().then(() => '', (e) => e.message)));
    const gone = make(rel, '1.0.0', { change: { 'latest.json': null } });
    const s4 = await gone.u.check();
    check('a feed that is not there is an error to show, not a crash', s4.state === 'idle' && /404/.test(s4.error));
  }
  {
    const rel = release('1.0.1'), root = newRoot();
    core.markBad(root, '1.0.1', 'did not come up');
    const { u } = make(rel, '1.0.0', { root });
    const s = await u.check();
    check('a version that did not start here is not offered again', s.state === 'idle' && !s.available && s.skipped && s.skipped.version === '1.0.1');
  }
  {
    const off = updater.create({ core, root: newRoot(), base: 1, keys: KEYS, feed: 'http://example.com/', running: { version: '1.0.0', source: 'builtin' }, fetch: async () => { throw new Error('must not be asked'); }, restart() {} });
    check('a feed that is not https is not asked at all', off.status().state === 'off' && (await off.check()).state === 'off');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
