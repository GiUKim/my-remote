// The app's shell in real Electron, end to end, against a made-up feed on this machine:
//   node release/test-app.js [--packaged | --only-packaged]
// The shell is app/ as it is (boot.js, updater.js, guard.js); the code it runs is made up: tiny
// "versions" that behave well, throw while starting, end without a word, or never say they are up.
// Checked: an ordinary update is installed only when chosen, a required one by itself; a version that
// does not come up is given up and the one before runs again, whichever way it fails; files changed
// after installing are noticed. Nothing here talks to the internet or starts the real host.
//   --packaged  also builds the real package of this folder's code (release/package.js, test key) and
//               runs its self-test: the real host under the shell, isolated as every self-test is.
// MR_TEST_ELECTRON_ARGS: extra arguments for Electron (--no-sandbox where its sandbox cannot run).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const core = require('../app/core');
const { build } = require('./build');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'host', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const EXTRA = (process.env.MR_TEST_ELECTRON_ARGS || '').split(' ').filter(Boolean);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-app-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  - ' + detail}`); };

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const keyFile = path.join(tmp, 'test-key.pem');
fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
const PUB = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');

// ---- made-up versions ----
const HEAD = `const { app } = require('electron'); const fs = require('fs'); const A = global.__mrApp;
const say = (s) => fs.appendFileSync(process.env.MR_TEST_LOG, s + '\\n');
say('RUN ' + A.version + ' ' + A.source + ' ' + A.mode + (process.argv.includes('--launcher') ? ' launcher' : '') + (A.rolledBack.length ? ' back-from ' + A.rolledBack.map((r) => r.version).join(',') : ''));
`;
const GOOD = HEAD + `app.whenReady().then(() => {
  setTimeout(() => { A.ok(); say('UP ' + A.version); }, 300);
  if (A.update) A.update.onChange((s) => {
    say('STATUS ' + s.state + (s.available ? ' ' + s.available.version + (s.available.required ? ' required' : ' optional') + ' ' + s.available.kind : '') + (s.skipped ? ' skipped ' + s.skipped.version : '') + (s.error ? ' error ' + s.error : ''));
    if (s.state === 'available' && !s.available.required && s.available.kind === 'bundle' && process.env.MR_TEST_ACCEPT && !global.asked) { global.asked = true; A.update.install().catch((e) => say('INSTALL-FAILED ' + e.message)); }
  });
  app.on('before-quit', () => say('BYE ' + A.version));
  setTimeout(() => app.quit(), Number(process.env.MR_TEST_LIFE || 5000));
});
app.on('window-all-closed', () => {});
`;
const KINDS = {
  good: GOOD,
  throws: HEAD + `throw new Error('broken on purpose');\n`,
  dies: HEAD + `process.exit(3);\n`,
  silent: HEAD + `require('electron').app.whenReady().then(() => setTimeout(() => require('electron').app.quit(), 20000));\n`, // never says it is up
};
function release(version, kind, opts = {}) {
  const files = new Map([['host/main.js', Buffer.from(`// ${version} ${kind}\n` + KINDS[kind])], ['client/main.js', Buffer.from(`// ${version} ${kind}\n` + KINDS[kind])], ['host/package.json', Buffer.from(JSON.stringify({ version }))]]);
  if (opts.launcher) files.set('client/launcher.html', Buffer.from('<!doctype html><title>start</title>\n')); // code with the start screen
  const out = path.join(tmp, `rel-${version}`);
  const r = build({ out, key: keyFile, version, files, notes: { ko: ['시험'], en: ['test'] }, minimum: opts.minimum || '0.0.0', critical: !!opts.critical, needsBase: opts.needsBase || 1, date: '2026-01-01' });
  return { ...r, dir: path.join(out, 'bundle') };
}

// ---- a feed on this machine ----
let serving = null; // the release folder whose files are served as the newest
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
  const file = serving && /^[A-Za-z0-9._-]+$/.test(name) ? path.join(serving, name) : '';
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});

// ---- one installed app: the shell with a built-in version, a data folder of its own ----
function makeApp(name, builtin, port) {
  const dir = path.join(tmp, name), stage = path.join(dir, 'app'), data = path.join(dir, 'data'), logFile = path.join(dir, 'log.txt');
  fs.mkdirSync(stage, { recursive: true });
  for (const f of ['boot.js', 'core.js', 'updater.js', 'guard.js', 'package.json']) fs.copyFileSync(path.join(ROOT, 'app', f), path.join(stage, f));
  fs.writeFileSync(path.join(stage, 'update-config.json'), JSON.stringify({ feed: `http://127.0.0.1:${port}/`, keys: [PUB], dataRoot: data, trialMs: 4000,
    timing: { firstCheckMs: 700, everyMs: 2500, retryMs: 2000, restartWaitMs: 3000, restartPollMs: 200 } }));
  fs.cpSync(builtin.dir, path.join(stage, 'bundle'), { recursive: true });
  fs.writeFileSync(logFile, '');
  const env = { ...process.env, MR_TEST_LOG: logFile };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    data, logFile,
    start(args = ['--host'], more = {}) {
      // MR_TEST_DEBUG: what each start prints goes to a file next to the log (the shell's own "[app]" lines).
      const out = process.env.MR_TEST_DEBUG ? fs.openSync(path.join(dir, 'output.txt'), 'a') : 'ignore';
      spawn(ELECTRON, [...EXTRA, stage, ...args], { env: { ...env, ...more }, stdio: ['ignore', out, out], detached: true }).unref();
    },
    output: () => { try { return fs.readFileSync(path.join(dir, 'output.txt'), 'utf8').split('\n').filter((l) => /\[app\]|Error/.test(l)).join(' | '); } catch { return ''; } },
    log: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    count(re) { return this.log().filter((l) => re.test(l)).length; },
    state: () => core.readState(data),
    // Waits until the log has a line matching `re` (after the first `skip` matches), or `ms` have passed.
    async until(re, ms = 25000, skip = 0) { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (this.log().filter((l) => re.test(l)).length > skip) return true; return false; },
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const v100 = release('1.0.0', 'good');
  const ONLY_PACKAGED = process.argv.includes('--only-packaged'); // the made-up versions were run before
  if (!ONLY_PACKAGED) {

  // 1. An ordinary update: offered; installed only when chosen; then that version runs and says it is up.
  {
    serving = path.dirname(release('1.0.1', 'good').dir);
    const a = makeApp('ordinary', v100, port);
    a.start(['--host'], { MR_TEST_LIFE: '4000' });
    const offered = await a.until(/^STATUS available 1\.0\.1 optional bundle/), ended = await a.until(/^BYE 1\.0\.0/);
    check('an ordinary update is offered and not installed by itself', offered && ended && a.state().current === null && !a.log().some((l) => /^RUN 1\.0\.1/.test(l)), a.log().join(' | '));
    a.start(['--host'], { MR_TEST_ACCEPT: '1', MR_TEST_LIFE: '6000' });
    const up = await a.until(/^UP 1\.0\.1/);
    check('chosen, it is installed, the app restarts into it, and it comes up', up && a.log().some((l) => /^RUN 1\.0\.1 installed host/.test(l)) && a.state().current === '1.0.1' && a.state().trial === null, a.log().join(' | '));
    await a.until(/^BYE 1\.0\.1/);
    // 2. Files of the installed version changed afterwards: not run.
    fs.appendFileSync(path.join(core.versionDir(a.data, '1.0.1'), 'host', 'main.js'), '\n// changed');
    serving = null;
    const before = a.log().length, byes = a.count(/^BYE /);
    a.start(['--host'], { MR_TEST_LIFE: '1500' });
    await a.until(/^BYE /, 20000, byes); // this start's own end (the restart for the update left one before)
    const after = a.log().slice(before);
    check('an installed version whose files were changed is not run; the built-in one is', after.some((l) => /^RUN 1\.0\.0 builtin host back-from 1\.0\.1/.test(l)) && !after.some((l) => /^RUN 1\.0\.1/.test(l)), after.join(' | ') + ' // ' + a.output());
  }
  // 3. A required update: installed and restarted into without anyone choosing. As the client app, too.
  {
    serving = path.dirname(release('1.0.2', 'good', { critical: true }).dir);
    const a = makeApp('required', v100, port);
    a.start(['--client'], { MR_TEST_LIFE: '8000' });
    const up = await a.until(/^UP 1\.0\.2/);
    check('a required update installs by itself and the app restarts into it (client app)', up && a.log().some((l) => /^STATUS available 1\.0\.2 required bundle/.test(l)) && a.log().some((l) => /^RUN 1\.0\.2 installed client/.test(l)) && a.state().current === '1.0.2', a.log().join(' | '));
    await a.until(/^BYE 1\.0\.2/);
  }
  // 4. A version that throws while starting: given up at once, the one before runs, and it is not offered again.
  {
    serving = path.dirname(release('1.0.3', 'throws', { critical: true }).dir);
    const a = makeApp('throws', v100, port);
    a.start(['--host'], { MR_TEST_LIFE: '9000' });
    const back = await a.until(/^RUN 1\.0\.0 builtin host back-from|^RUN 1\.0\.0 builtin host/, 30000, 1);
    const skipped = await a.until(/^STATUS idle skipped 1\.0\.3/);
    check('a version that throws while starting is given up; the one before runs again', back && a.log().some((l) => /^RUN 1\.0\.3/.test(l)) && !!a.state().bad['1.0.3'] && a.state().current === null, a.log().join(' | '));
    check('and is not installed a second time', skipped && a.log().filter((l) => /^RUN 1\.0\.3/.test(l)).length === 1, a.log().join(' | '));
    await a.until(/^BYE 1\.0\.0/, 20000, 0);
  }
  // 5. A version that ends without a word (a crash): started once more by the guard, then given up.
  {
    serving = path.dirname(release('1.0.4', 'dies', { critical: true }).dir);
    const a = makeApp('dies', v100, port);
    a.start(['--host'], { MR_TEST_LIFE: '9000' });
    const back = await a.until(/^RUN 1\.0\.0 builtin host back-from 1\.0\.4/, 40000);
    check('a version that ends without a word gets a second start from the guard, then the one before runs', back && a.log().filter((l) => /^RUN 1\.0\.4/.test(l)).length === 2 && !!a.state().bad['1.0.4'], a.log().join(' | '));
    await a.until(/^BYE 1\.0\.0/, 20000, 0);
  }
  // 6. A version that starts but never says it is up: given up after its time.
  {
    serving = path.dirname(release('1.0.5', 'silent', { critical: true }).dir);
    const a = makeApp('silent', v100, port);
    a.start(['--host'], { MR_TEST_LIFE: '12000' });
    const back = await a.until(/^RUN 1\.0\.0 builtin host/, 40000, 1);
    check('a version that never says it is up is given up after its time', back && a.log().some((l) => /^RUN 1\.0\.5/.test(l)) && /in time/.test(a.state().bad['1.0.5'] || ''), a.log().join(' | ') + ' ' + JSON.stringify(a.state()));
    await a.until(/^BYE 1\.0\.0/, 20000, 0);
  }
  // 7. A release for a newer shell: announced, never installed. And a release signed by somebody else: nothing.
  {
    serving = path.dirname(release('2.0.0', 'good', { critical: true, needsBase: 2 }).dir);
    const a = makeApp('newshell', v100, port);
    a.start(['--host'], { MR_TEST_LIFE: '3000' });
    const told = await a.until(/^STATUS available 2\.0\.0 required package/);
    await a.until(/^BYE 1\.0\.0/);
    check('a release that needs a newer shell is announced, not installed', told && a.state().current === null && !a.log().some((l) => /^RUN 2\./.test(l)), a.log().join(' | '));
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const forged = path.dirname(release('1.0.6', 'good', { critical: true }).dir);
    fs.writeFileSync(path.join(forged, 'latest.json.sig'), core.signManifest(fs.readFileSync(path.join(forged, 'latest.json')), other));
    serving = forged;
    const b = makeApp('forged', v100, port);
    b.start(['--host'], { MR_TEST_LIFE: '3000' });
    const refused = await b.until(/^STATUS idle error .*signature/);
    await b.until(/^BYE 1\.0\.0/);
    check('a release signed with another key is refused by the running app', refused && b.state().current === null && !b.log().some((l) => /^RUN 1\.0\.6/.test(l)), b.log().join(' | '));
  }
  // 8. Started without saying which, with code that has the start screen (client/launcher.html): no dialog;
  // the app starts again as the client app with --launcher, whose first window is the start screen.
  {
    serving = null;
    const a = makeApp('ask', release('1.1.0', 'good', { launcher: true }), port);
    a.start([], { MR_TEST_LIFE: '2500' });
    const ran = await a.until(/^RUN 1\.1\.0 builtin client launcher/);
    check('started without saying which, the app opens the start screen (the client app with --launcher), no dialog', ran, a.log().join(' | ') + ' // ' + a.output());
    await a.until(/^BYE 1\.1\.0/);
  }
  }
  server.close();

  // 8. The real thing: this folder's code as a package, its self-test run through the shell.
  if (process.argv.includes('--packaged') || ONLY_PACKAGED) {
    const rel = path.join(tmp, 'real-release'), conf = path.join(tmp, 'real-config.json');
    build({ out: rel, key: keyFile, dirty: true });
    fs.writeFileSync(conf, JSON.stringify({ feed: '', keys: [PUB], dataRoot: path.join(tmp, 'real-data') }));
    const p = require('./package').pack({ release: rel, out: path.join(tmp, 'pack'), archive: false, config: conf, quiet: true });
    const exe = path.join(p.dir, process.platform === 'win32' ? 'MyRemote.exe' : 'my-remote');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(exe, [...EXTRA, '--selftest'], { env, encoding: 'utf8', timeout: 6 * 60e3, maxBuffer: 64 * 1024 * 1024 });
    const outText = String(r.stdout || '') + String(r.stderr || ''), fails = outText.split('\n').filter((l) => /\[selftest\] FAIL/.test(l));
    check(`the packaged app (${p.name}) passes the self-test through the shell`, r.status === 0 && /\[selftest\] ALL PASS/.test(outText) && /\[app\] host: version /.test(outText),
      `exit ${r.status}; ${fails.slice(0, 3).join(' ; ') || outText.split('\n').filter((l) => /\[app\]|Error|error/.test(l)).slice(0, 5).join(' ; ')}`);
    const cap = (/\[selftest\] INFO {2}screen capture: (.*)/.exec(outText) || [])[1];
    console.log(`      screen capture in the package: ${cap || '?'} (native needs koffi, which the shell brings); ${(outText.match(/\[selftest\] PASS/g) || []).length} checks`);
    // Windows: the host takes the one entry's id (its window with the client app's on the taskbar, its
    // notice of a remote session shown by that entry), although the shell gave it an id of its own.
    if (process.platform === 'win32') {
      const id = (/\[host\] app id (\S+)/.exec(outText) || [])[1];
      check('the host takes the id of the one entry (Windows), not the one the shell gave it', id === require('../host/appsync').APP_ID, id || 'no app id said');
    }
    // The one entry (the start screen), into a folder of the test's (not the Start menu or the app menu).
    const lnk = path.join(tmp, 'shortcuts');
    const sc = spawnSync(exe, [...EXTRA, '--shortcuts=' + lnk], { env, encoding: 'utf8', timeout: 60e3 });
    const made = fs.existsSync(lnk) ? fs.readdirSync(lnk) : [];
    const entry = process.platform === 'win32' ? 'MyRemote.lnk' : 'my-remote.desktop';
    check('--shortcuts makes the one entry, which opens the start screen', sc.status === 0 && made.length === 1 && made[0] === entry && fs.statSync(path.join(lnk, entry)).size > 100
      && (process.platform === 'win32' || /--client --launcher/.test(fs.readFileSync(path.join(lnk, entry), 'utf8'))), `exit ${sc.status}: ${made.join(', ')}`);
    // Every file is dated when the package was made: Electron's own come dated 1980-01-01, and Windows keeps
    // a copied file's date (the unpacked folder showed 1980 for most files).
    const dated = [];
    const walkDates = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walkDates(f); else if (e.isFile() && fs.statSync(f).mtimeMs < Date.UTC(2020, 0, 1)) dated.push(e.name); } };
    walkDates(p.dir);
    check('every file in the package is dated when the package was made (none from 1980)', dated.length === 0, `${dated.length} old: ${dated.slice(0, 5).join(', ')}`);
    // No file or folder the package holds or the app makes has a space or anything but ASCII in its name
    // (a path with either trips some tools and some systems), and a start that only asks or makes the
    // shortcuts keeps its profile next to the installed versions, not in a folder named after the product.
    const plain = (n) => /^[\x21-\x7e]+$/.test(n), odd = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (!plain(e.name)) odd.push(e.name); if (e.isDirectory()) walk(path.join(d, e.name)); } };
    walk(p.dir);
    for (const n of [path.basename(p.dir), p.name, ...made]) if (!plain(n)) odd.push(n);
    check('names in the package and of the shortcuts: no spaces, ASCII only; the asking start has a profile of its own', odd.length === 0 && fs.existsSync(path.join(tmp, 'launcher')),
      odd.length ? 'not plain: ' + odd.slice(0, 5).join(', ') : `shortcuts ${made.join(', ')}; profile ${fs.existsSync(path.join(tmp, 'launcher')) ? 'next to the data folder' : 'not where expected'}`);
    // Windows shows the program by its version resource (the firewall's prompt, Task Manager): as
    // MyRemote, not as Electron by GitHub (release/package.js rewrites it; the self-test above ran it).
    if (process.platform === 'win32') {
      const vi = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$v = (Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo; "$($v.FileDescription)|$($v.ProductName)|$($v.CompanyName)"`], { encoding: 'utf8', timeout: 30e3 });
      const shown = String(vi.stdout || '').trim();
      check('Windows names the program MyRemote (its version resource), not Electron by GitHub', shown === 'MyRemote|MyRemote|MyRemote', shown || String(vi.stderr || '').trim());
    }
  }

  await sleep(1500); // what the guards and restarts left running ends by itself
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
