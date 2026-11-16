// The installed app's shell swap (host/shellswap.js) in plain Node, with keys, a feed and app folders of
// its own: the signed list, which package replaces which shell, staging from a feed on this machine (and an
// archive that is not the listed one), and the swap script itself (PowerShell on Windows, sh on Linux) on
// fake app folders whose program is a copy of this Node (in a folder whose name has Korean, a space and an
// apostrophe): swapped and confirmed; not confirmed (put back, never again); the app still running (not
// swapped); nothing to start (the new program runs once as Node; and a broken one, put back).
//   node release/test-shellswap.js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const core = require('../app/core');
const S = require('../host/shellswap');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === 'win32', EXE = S.EXE[process.platform];
if (!EXE) { console.log('SKIP  no shell swap on this system'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-shellswap-'));

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' });
const PEM_OTHER = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
const signed = (obj, pem = PEM) => { const bytes = Buffer.from(JSON.stringify(obj)); return { bytes, sig: core.signManifest(bytes, pem) }; };
const SHELL_A = { format: 1, electron: '45.3.1', koffi: '2.16.3', app: 'a'.repeat(32), base: 1, rev: 1 };
const SHELL_B = { ...SHELL_A, app: 'b'.repeat(32) };
const ID_B = S.identityOf(SHELL_B);
const KEY = S.platformKey();
const L0 = { minSize: 1, maxSize: 1 << 30 };
const listOf = (version, packages) => ({ format: 1, app: 'my-remote', kind: 'packages', version, packages });
const entry = (file, buf, shell) => ({ file, sha256: core.sha256(buf), size: buf.length, shell });

(async () => {
  // 1. The signed list
  {
    const good = signed(listOf('0.7.0', { [KEY]: { file: 'a.zip', sha256: 'c'.repeat(64), size: 20 << 20, shell: SHELL_B } }));
    let l = null, e1 = '', e2 = '', e3 = '', e4 = '', e5 = '';
    try { l = S.verifyList(good.bytes, good.sig, [PUB]); } catch (e) { e1 = e.message; }
    try { S.verifyList(good.bytes, signed(JSON.parse(good.bytes)).sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), [PUB]); } catch (e) { e2 = e.message; }
    try { const o = signed(JSON.parse(good.bytes), PEM_OTHER); S.verifyList(o.bytes, o.sig, [PUB]); } catch (e) { e3 = e.message; }
    try { const m = signed({ format: 1, app: 'my-remote', version: '0.7.0', needsBase: 1, files: {}, bundle: {} }); S.verifyList(m.bytes, m.sig, [PUB]); } catch (e) { e4 = e.message; }
    try { const b = signed(listOf('0.7.0', { [KEY]: { file: '../x.zip', sha256: 'c'.repeat(64), size: 20 << 20, shell: SHELL_B } })); S.verifyList(b.bytes, b.sig, [PUB]); } catch (e) { e5 = e.message; }
    ok('a list signed by a trusted key is taken; a changed signature, another key, a manifest that is no list, a file name with a path are not',
      !!l && !e1 && /signature/.test(e2) && /not by a key/.test(e3) && /not a list/.test(e4) && /bad entry/.test(e5), JSON.stringify({ e1, e2, e3, e4, e5 }));
  }

  // 2. Which package replaces which shell
  {
    const list = listOf('0.7.0', { [KEY]: { file: 'a.zip', sha256: 'c'.repeat(64), size: 20 << 20, shell: SHELL_B } });
    const old = S.decide({ list, current: { version: '0.6.1', identity: '' } });
    const same = S.decide({ list, current: { version: '0.6.1', identity: ID_B } });
    const notNewer = S.decide({ list, current: { version: '0.7.0', identity: S.identityOf(SHELL_A) } });
    const bad = S.decide({ list, current: { version: '0.6.1', identity: '' }, bad: { '0.7.0': 'did not come up' } });
    const other = S.decide({ list, current: { version: '0.6.1', identity: '' }, key: 'sunos-sparc' });
    ok('a shell from before shell.json is replaced by a newer release; not by the same shell, not by an equal release, not by one that failed, not without a package for the system',
      !!old.entry && old.entry.identity === ID_B && /same shell/.test(same.why) && /not newer/.test(notNewer.why) && /failed before/.test(bad.why) && /no package/.test(other.why),
      JSON.stringify({ old: old.entry && old.entry.version, same: same.why, notNewer: notNewer.why, bad: bad.why, other: other.why }));
  }

  // 3. Staging from a feed on this machine
  const files = new Map();
  const server = http.createServer((req, res) => { const b = files.get(decodeURIComponent(req.url.slice(1))); if (!b) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-length': b.length }); res.end(b); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${server.address().port}/`;
  const archiveOf = (version, shell) => {
    const src = fs.mkdtempSync(path.join(tmp, 'pkg-')), app = path.join(src, 'MyRemote', 'resources', 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(src, 'MyRemote', EXE), 'program');
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'my-remote', version, base: 1 }));
    fs.writeFileSync(path.join(app, 'shell.json'), JSON.stringify(shell));
    const out = path.join(src, win ? 'p.zip' : 'p.tar.gz');
    if (win) execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', out, '-C', src, 'MyRemote']);
    else execFileSync('tar', ['-czf', out, '-C', src, 'MyRemote']);
    return fs.readFileSync(out);
  };
  const FILE = win ? 'MyRemote-Windows-x64.zip' : 'MyRemote-Linux-x64.tar.gz';
  const publish = (version, buf, listed, pem) => { const l = signed(listOf(version, { [KEY]: listed }), pem); files.set('packages.json', l.bytes); files.set('packages.json.sig', Buffer.from(l.sig)); files.set(FILE, buf); };
  const appFolder = (name) => { const d = path.join(tmp, name, 'MyRemote'); fs.mkdirSync(path.join(d, 'resources', 'app'), { recursive: true }); return d; };
  const looks = (root, appDir, current = { version: '0.6.1', identity: '' }) => S.look({ feed, keys: [PUB], root, appDir, current, fetchFn: fetch, limits: L0 });
  {
    const pkgB = archiveOf('0.7.0', SHELL_B);
    publish('0.7.0', pkgB, entry(FILE, pkgB, SHELL_B));
    const root = path.join(tmp, 'data-stage'), appDir = appFolder('stage');
    const r = await looks(root, appDir);
    const n = S.readNext(root, appDir);
    const again = await looks(root, appDir);
    ok('a newer shell is fetched, checked and staged next to the app folder; looked at again, it is not fetched twice',
      r.state === 'staged' && !!n && n.version === '0.7.0' && n.dir === appDir + '.next' && S.readShell(path.join(appDir + '.next', 'resources', 'app')).identity === ID_B
        && fs.existsSync(path.join(appDir + '.next', EXE)) && !fs.existsSync(path.join(S.shellRoot(root), '0.7.0')) && again.state === 'staged' && /before/.test(again.why),
      JSON.stringify({ r, again, next: n && n.dir }));
    const same = await looks(path.join(tmp, 'data-same'), appFolder('same'), { version: '0.6.1', identity: ID_B });
    ok('the same shell in a newer release is not fetched', same.state === 'none' && /same shell/.test(same.why), JSON.stringify(same));

    const root2 = path.join(tmp, 'data-tampered'), app2 = appFolder('tampered');
    publish('0.7.0', archiveOf('0.7.0', SHELL_A), entry(FILE, pkgB, SHELL_B)); // the list names pkgB, the feed serves another archive of the same size? (not even that)
    const t = await looks(root2, app2);
    publish('0.7.0', pkgB, entry(FILE, pkgB, SHELL_A)); // the list says shell A, the archive holds B
    const w = await looks(root2, app2);
    publish('0.7.0', pkgB, entry(FILE, pkgB, SHELL_B), PEM_OTHER); // signed by someone else
    const k = await looks(root2, app2);
    ok('not staged: an archive that is not the listed one, an archive holding another shell than listed, a list not signed by a trusted key',
      t.state === 'error' && /SHA-256|list says/.test(t.why) && w.state === 'error' && /another shell/.test(w.why) && k.state === 'error' && /not by a key/.test(k.why)
        && !S.readNext(root2, app2) && !fs.existsSync(app2 + '.next') && !fs.existsSync(app2 + '.next-tmp'),
      JSON.stringify({ t: t.why, w: w.why, k: k.why }));
  }
  server.close();

  // 4. The swap script, for real, on fake app folders. The program is this Node: one copy for the old
  // folders and one for the new ones, hard-linked from there (Windows refuses to delete any name of a file
  // that runs, so old and new must be different files, as they are in real packages).
  const nodes = {};
  for (const k of ['old', 'new']) {
    nodes[k] = path.join(tmp, `node-${k}${win ? '.exe' : ''}`);
    fs.copyFileSync(process.execPath, nodes[k]);
    if (!win) fs.chmodSync(nodes[k], 0o755);
  }
  const shellswapJs = path.join(__dirname, '..', 'host', 'shellswap.js');
  const parent = path.join(tmp, "앱 폴더's");
  // An app folder: the program, the shell's package.json (and shell.json), a core.js, a "face" that says it
  // is up when told to (face.json: confirm, life) and lives a while.
  function makeApp(dir, { version, shell, confirm, life, coreThrows, root }) {
    const app = path.join(dir, 'resources', 'app'), node = shell ? nodes.new : nodes.old;
    fs.mkdirSync(app, { recursive: true });
    try { fs.linkSync(node, path.join(dir, EXE)); } catch { fs.copyFileSync(node, path.join(dir, EXE)); }
    if (!win) {
      fs.chmodSync(path.join(dir, EXE), 0o755);
      fs.writeFileSync(path.join(dir, 'my-remote.sh'), '#!/bin/sh\nd=$(cd "$(dirname "$0")" && pwd)\nexec "$d/my-remote" "$d/resources/app/face.js"\n', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'my-remote', version, base: 1 }));
    if (shell) fs.writeFileSync(path.join(app, 'shell.json'), JSON.stringify(shell));
    fs.writeFileSync(path.join(app, 'core.js'), coreThrows ? 'throw new Error("broken");\n' : 'module.exports = {};\n');
    fs.writeFileSync(path.join(app, 'face.json'), JSON.stringify({ confirm: !!confirm, life, root }));
    fs.writeFileSync(path.join(app, 'face.js'), `const fs = require('fs'), path = require('path');
const S = require(${JSON.stringify(shellswapJs)});
const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'face.json'), 'utf8'));
fs.appendFileSync(path.join(f.root, 'faces.log'), process.pid + ' ' + __dirname + '\\n');
if (f.confirm) { const me = S.readShell(__dirname); const t = setInterval(() => { if (S.confirm(f.root, me.identity)) clearInterval(t); }, 300); }
setTimeout(() => process.exit(0), f.life);
`);
  }
  const restart = win ? [{ file: 'MyRemote.exe', args: ['@APP@/resources/app/face.js'] }] : [{ file: 'my-remote.sh', args: [] }];
  const startFace = (dir) => spawn(win ? path.join(dir, EXE) : path.join(dir, 'my-remote.sh'), win ? [path.join(dir, 'resources', 'app', 'face.js')] : [], { stdio: 'ignore', windowsHide: true });
  const killFaces = (root) => { try { for (const l of fs.readFileSync(path.join(root, 'faces.log'), 'utf8').split('\n')) { const pid = Number(l.split(' ')[0]); if (pid) try { process.kill(pid); } catch {} } } catch {} };
  const logOf = (root) => { try { return fs.readFileSync(path.join(S.shellRoot(root), 'swap.log'), 'utf8').replace(/^﻿/, '').replace(/\r/g, ''); } catch { return ''; } }; // PowerShell 5.1 starts the file with a BOM
  // Runs one swap to its end (swap.json gone) and returns the log.
  async function swap(name, { oldFace, newFace, restartFaces = restart, waitSecs = 20, upSecs = 20, coreThrows = false }) {
    const root = path.join(tmp, 'data-' + name), dir = path.join(parent, name, 'MyRemote');
    fs.mkdirSync(root, { recursive: true });
    makeApp(dir, { version: '0.6.1', shell: null, root, ...oldFace });
    makeApp(dir + '.next', { version: '0.7.0', shell: SHELL_B, root, coreThrows, ...newFace });
    // As stage() leaves it.
    fs.mkdirSync(S.shellRoot(root), { recursive: true });
    fs.writeFileSync(path.join(S.shellRoot(root), 'next.json'), JSON.stringify({ version: '0.7.0', identity: ID_B, dir: dir + '.next', appDir: dir, at: Date.now() }));
    let face = null;
    if (oldFace.run) { face = startFace(dir); await sleep(1500); }
    await S.begin({ root, appDir: dir, next: { dir: dir + '.next', version: '0.7.0', identity: ID_B }, restart: restartFaces, waitSecs, upSecs });
    const until = Date.now() + 120e3;
    while (fs.existsSync(path.join(S.shellRoot(root), 'swap.json')) && Date.now() < until) await sleep(500);
    killFaces(root);
    if (face) try { face.kill(); } catch {}
    await sleep(500);
    return { root, dir, log: logOf(root), now: S.readShell(path.join(dir, 'resources', 'app')).identity };
  }
  {
    const a = await swap('swapped', { oldFace: { run: true, life: 2500 }, newFace: { confirm: true, life: 6000 } });
    const waited = /begins/.test(a.log) && (Date.parse(a.log.split('\n').find((l) => /folders swapped/.test(l)).slice(0, 19)) - Date.parse(a.log.split('\n')[0].slice(0, 19))) >= 0;
    ok('the swap waits for the app to end, swaps the folders, starts it from the new one, which says it is up; the old folder goes',
      a.now === ID_B && !fs.existsSync(a.dir + '.old') && !fs.existsSync(a.dir + '.next') && !S.readNext(a.root, a.dir) && waited && /folders swapped/.test(a.log) && /is up/.test(a.log),
      JSON.stringify({ now: a.now === ID_B, old: fs.existsSync(a.dir + '.old'), next: fs.existsSync(a.dir + '.next'), staged: !!S.readNext(a.root, a.dir) }) + ' ' + a.log.trim().split('\n').map((l) => l.slice(11)).join(' | '));
    const b = await swap('notup', { oldFace: { run: false, life: 4000 }, newFace: { confirm: false, life: 4000 }, upSecs: 6 });
    const bad = S.badList(b.root);
    ok('a new shell that does not say it is up in time is put aside, the old one comes back and is started again, and that release is never staged again',
      b.now === '' && S.readShell(path.join(b.dir + '.failed', 'resources', 'app')).identity === ID_B && /going back/.test(b.log) && /old shell is back/.test(b.log)
        && !!bad['0.7.0'] && /failed before/.test(S.decide({ list: listOf('0.7.0', { [KEY]: { file: 'a.zip', sha256: 'c'.repeat(64), size: 20 << 20, shell: SHELL_B } }), current: { version: '0.6.1', identity: '' }, bad }).why),
      b.log.trim().split('\n').map((l) => l.slice(20)).join(' | '));
    const c = await swap('running', { oldFace: { run: true, life: 30000 }, newFace: { confirm: true, life: 3000 }, waitSecs: 3 });
    ok('while the app still runs nothing is swapped: the staged shell stays staged, and the app does not try again for a while',
      c.now === '' && fs.existsSync(c.dir + '.next') && !!S.readNext(c.root, c.dir) && S.heldRecently(c.root) && /still runs/.test(c.log), c.log.trim().split('\n').map((l) => l.slice(20)).join(' | '));
    const d = await swap('nostart', { oldFace: { run: false, life: 1000 }, newFace: { confirm: false, life: 1000 }, restartFaces: [] });
    const e = await swap('broken', { oldFace: { run: false, life: 1000 }, newFace: { confirm: false, life: 1000 }, restartFaces: [], coreThrows: true });
    ok('with nothing to start, the new program runs once as Node: a working one stays, a broken one is put back',
      d.now === ID_B && /is up/.test(d.log) && e.now === '' && /going back/.test(e.log) && !!S.badList(e.root)['0.7.0'],
      `${d.log.trim().split('\n').pop().slice(20)} / ${e.log.trim().split('\n').pop().slice(20)}`);
  }

  // 4b. A script that never starts (a policy, a virus scanner): begin rejects, so the app does not quit.
  {
    const root = path.join(tmp, 'data-nostart'), dir = path.join(tmp, 'nostart', 'MyRemote');
    fs.mkdirSync(dir, { recursive: true });
    let err = '';
    try { await S.begin({ root, appDir: dir, next: { dir: dir + '.next', version: '0.7.0', identity: ID_B }, restart, startSecs: 2, spawnFn: () => ({ unref() {} }), spawnSyncFn: () => ({ status: 0 }) }); } catch (e) { err = e.message; }
    ok('a swap script that never starts makes begin fail (the app keeps running) and leaves no swap marked as under way',
      /did not start/.test(err) && !S.pending(root), err);
  }

  // 5. What swaps leave next to the folder goes at a later start: the old shell at once, a failed one after a week.
  {
    const root = path.join(tmp, 'data-sweep'), dir = path.join(tmp, 'sweep', 'MyRemote');
    for (const s of ['.old', '.failed']) fs.mkdirSync(path.join(dir + s, 'x'), { recursive: true });
    fs.mkdirSync(S.shellRoot(root), { recursive: true });
    fs.writeFileSync(path.join(S.shellRoot(root), 'swap.json'), JSON.stringify({ at: Date.now() }));
    const during = await S.sweep(dir, root);
    fs.rmSync(path.join(S.shellRoot(root), 'swap.json'));
    const first = await S.sweep(dir, root);
    const weekAgo = new Date(Date.now() - 8 * 86400e3);
    fs.utimesSync(dir + '.failed', weekAgo, weekAgo);
    const later = await S.sweep(dir, root);
    ok('a later start removes the old shell a swap left, a failed one after a week, nothing while a swap is under way',
      during.length === 0 && first.join() === 'MyRemote.old' && later.join() === 'MyRemote.failed' && !fs.existsSync(dir + '.old') && !fs.existsSync(dir + '.failed'),
      JSON.stringify({ during, first, later }));
  }

  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
