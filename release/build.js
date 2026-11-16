// Makes a release of the code the installed app runs: the bundle, its manifest and the manifest's
// signature (see app/core.js). Plain Node:
//   node release/build.js [--out=dist/release] [--key=<private key file>] [--critical] [--allow-dirty]
//
// What goes into the feed folder afterwards (a release of a public repository, or any https folder):
//   latest.json, latest.json.sig, my-remote-<version>.bundle
// and what release/package.js builds the installable packages from:
//   bundle/   the same files unpacked, with manifest.json and manifest.sig
//
// The files are taken from the commit that is checked out (git show HEAD:...), not from the folder:
// the same commit gives the same bundle on any machine, whatever line endings the checkout has, and
// nothing uncommitted can slip into a release. The version is host/package.json's.
//   --critical     this release must be installed: apps older than it update without asking, and
//                  release/policy.json remembers it as the oldest version still allowed (`minimum`),
//                  so that later, ordinary releases keep forcing the apps that never got it. Commit that file.
//   --allow-dirty  take the files from the folder as they are (for trying things out; never for a release)
// The signing key (release/keygen.js makes one) is never in the repository: --key, or
// MY_REMOTE_RELEASE_KEY, or ~/.my-remote-release/update-signing-key.pem.
//
//   node release/build.js --sign-packages=<folder>
// After the packages are made (release/package.js on each system): the list of them, packages.json and its
// signature, from the records package.js wrote next to each archive (<name>.package.json, copied into
// <folder> with the archives; each archive is hashed again). Installed apps read it to replace their shell
// by a newer one (host/shellswap.js). Upload both files with the release.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../app/core');

const ROOT = path.join(__dirname, '..');
// The code an installed app runs: the host, the client app and the loader page the client app shows.
// Not the bench (a developer's tool) and not what npm installs (koffi is part of the app's shell).
const INCLUDE = ['host', 'client', 'my-remote-client.html'];
const EXCLUDE = [/^host\/package-lock\.json$/, /^host\/bench[^/]*$/, /^host\/netem\.js$/, /(^|\/)node_modules\//];
const defaultKey = () => process.env.MY_REMOTE_RELEASE_KEY || path.join(os.homedir(), '.my-remote-release', 'update-signing-key.pem');

function git(args, opts = {}) { return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts }); }

// Every file under the included folders, for a folder that is no git checkout (a copy on a test machine).
function walk(rel, out = []) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return out;
  if (!fs.statSync(full).isDirectory()) { out.push(rel); return out; }
  for (const n of fs.readdirSync(full)) if (n !== 'node_modules') walk(`${rel}/${n}`, out);
  return out;
}
function collect(dirty) {
  let listed;
  try {
    listed = git(['ls-files', '-z', '--', ...INCLUDE], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0');
    // A try-out build takes new files that git does not have yet too (not ignored ones): twice a module that
    // was required but not yet added left the packaged test's app unable to start (an error box on the PC).
    if (dirty) listed = listed.concat(git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...INCLUDE], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0'));
  } catch (e) {
    if (!dirty) throw new Error('this folder is no git checkout: a release is made from a commit');
    listed = INCLUDE.flatMap((p) => walk(p));
  }
  const names = listed.filter((n) => n && !EXCLUDE.some((re) => re.test(n)));
  if (!dirty) {
    const changed = git(['status', '--porcelain', '--', ...INCLUDE, 'app', 'release']).toString('utf8').trim();
    if (changed) throw new Error('uncommitted changes (commit them first, or --allow-dirty to try things out):\n' + changed);
  }
  const files = new Map();
  for (const n of names.sort()) {
    if (!core.safePath(n)) throw new Error(`a file name the app would not take: ${n}`);
    files.set(n, dirty ? fs.readFileSync(path.join(ROOT, n)) : git(['show', `HEAD:${n}`]));
  }
  return files;
}

function build({ out = path.join(ROOT, 'dist', 'release'), key = defaultKey(), critical = false, dirty = false, version, files, notes, minimum, needsBase, date } = {}) {
  files = files || collect(dirty);
  version = version || JSON.parse(files.get('host/package.json').toString('utf8')).version;
  if (!core.validVersion(version)) throw new Error(`host/package.json: "${version}" is not a version (major.minor.patch)`);
  const policyFile = path.join(__dirname, 'policy.json');
  let policy = { minimum: '0.0.0' };
  try { policy = { ...policy, ...JSON.parse(fs.readFileSync(policyFile, 'utf8')) }; } catch {}
  if (minimum === undefined) {
    if (critical && core.cmp(version, policy.minimum) > 0) { policy.minimum = version; fs.writeFileSync(policyFile, JSON.stringify(policy, null, 2) + '\n'); }
    minimum = policy.minimum;
  }
  if (notes === undefined) { try { notes = JSON.parse(fs.readFileSync(path.join(__dirname, 'notes', version + '.json'), 'utf8')); } catch { notes = { ko: [], en: [] }; } }
  if (needsBase === undefined) needsBase = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8')).base;
  if (date === undefined) { try { date = git(['log', '-1', '--format=%cs'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim(); } catch { date = ''; } }

  const bundle = core.packBundle(files), bundleFile = `my-remote-${version}.bundle`;
  const manifest = {
    format: 1, app: core.APP, version, date, needsBase, minimum, critical: !!critical, notes,
    bundle: { file: bundleFile, size: bundle.length, sha256: core.sha256(bundle) },
    files: Object.fromEntries([...files].map(([n, b]) => [n, core.sha256(b)])),
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n');
  let pem;
  try { pem = fs.readFileSync(key, 'utf8'); } catch { throw new Error(`no signing key at ${key} (node release/keygen.js makes one)`); }
  const sig = core.signManifest(bytes, pem);

  fs.rmSync(path.join(out, 'bundle'), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(out, 'latest.json'), bytes);
  fs.writeFileSync(path.join(out, 'latest.json.sig'), sig + '\n');
  fs.writeFileSync(path.join(out, bundleFile), bundle);
  for (const [n, b] of files) {
    const to = path.join(out, 'bundle', ...n.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, b);
  }
  fs.writeFileSync(path.join(out, 'bundle', 'manifest.json'), bytes);
  fs.writeFileSync(path.join(out, 'bundle', 'manifest.sig'), sig + '\n');
  return { out, version, manifest, bundleFile, files: files.size, bytes: bundle.length, sig };
}

// packages.json(.sig) in `dir` from the package records there. -> { version, packages, bytes, sig }
function signPackages(dir, key = defaultKey()) {
  const records = fs.readdirSync(dir).filter((n) => n.endsWith('.package.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  if (!records.length) throw new Error(`no package records (*.package.json, written by release/package.js) in ${dir}`);
  const version = records[0].version, packages = {};
  for (const r of records) {
    if (r.version !== version) throw new Error(`the records are of different releases (${version}, ${r.version})`);
    if (packages[r.platform]) throw new Error(`two packages for ${r.platform}`);
    const buf = fs.readFileSync(path.join(dir, r.file));
    if (buf.length !== r.size || core.sha256(buf) !== r.sha256) throw new Error(`${r.file} is not the archive its record names`);
    packages[r.platform] = { file: r.file, sha256: r.sha256, size: r.size, shell: r.shell };
  }
  const bytes = Buffer.from(JSON.stringify({ format: 1, app: core.APP, kind: 'packages', version, packages }, null, 1) + '\n');
  let pem;
  try { pem = fs.readFileSync(key, 'utf8'); } catch { throw new Error(`no signing key at ${key} (node release/keygen.js makes one)`); }
  const sig = core.signManifest(bytes, pem);
  fs.writeFileSync(path.join(dir, 'packages.json'), bytes);
  fs.writeFileSync(path.join(dir, 'packages.json.sig'), sig + '\n');
  return { version, packages, bytes, sig };
}

// A release is made only from a commit that passed CI (.github/workflows/ci.yml) on GitHub: pushed, and
// every check run of it finished successfully, each of the CI jobs among them. -> { ok, why }
const CI_JOBS = ['checks', 'native', 'Windows', 'Linux', 'performance gate']; // the jobs' names begin so
async function ciPassed(sha) {
  const url = git(['remote', 'get-url', 'origin']).toString().trim();
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) return { ok: false, why: `origin (${url}) is not on GitHub` };
  let res;
  try { res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${sha}/check-runs?per_page=100`, { headers: { 'User-Agent': 'my-remote-release', Accept: 'application/vnd.github+json' } }); }
  catch (e) { return { ok: false, why: `GitHub could not be asked (${e.message})` }; }
  if (res.status === 404 || res.status === 422) return { ok: false, why: `GitHub does not know ${sha.slice(0, 7)}: push it and let CI run` };
  if (!res.ok) return { ok: false, why: `GitHub answered ${res.status}` };
  const runs = (await res.json()).check_runs || [];
  const pending = runs.filter((r) => r.status !== 'completed').map((r) => r.name);
  const bad = runs.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion)).map((r) => `${r.name}: ${r.conclusion}`);
  const missing = CI_JOBS.filter((j) => !runs.some((r) => r.name.startsWith(j)));
  if (bad.length) return { ok: false, why: 'CI failed: ' + bad.join('; ') };
  if (pending.length) return { ok: false, why: 'CI is still running: ' + pending.join('; ') };
  if (missing.length) return { ok: false, why: 'CI has not run these jobs for this commit: ' + missing.join(', ') };
  return { ok: true, why: `${runs.length} check runs passed` };
}

if (require.main === module) (async () => {
  const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined; };
  if (arg('sign-packages')) {
    try {
      const dir = path.resolve(arg('sign-packages')), r = signPackages(dir, arg('key'));
      // Checked the way an app will check it, with the keys the app trusts.
      const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'update-config.json'), 'utf8'));
      require('../host/shellswap').verifyList(r.bytes, r.sig, conf.keys);
      for (const [k, p] of Object.entries(r.packages)) console.log(`${k}: ${p.file} ${(p.size / 1048576).toFixed(0)} MB, shell ${require('../host/shellswap').identityOf(p.shell)}`);
      console.log(`written to ${dir}: packages.json, packages.json.sig (release ${r.version}); verifies with the keys in app/update-config.json`);
    } catch (e) { console.error('signing the packages failed: ' + e.message); process.exit(1); }
    return;
  }
  const dirty = process.argv.includes('--allow-dirty');
  // A try-out build (--allow-dirty) is no release and skips the CI gate; --skip-ci is for when GitHub
  // cannot be reached and you know the commit is good: it is said in the output.
  if (!dirty && !process.argv.includes('--skip-ci')) {
    const sha = git(['rev-parse', 'HEAD']).toString().trim();
    const ci = await ciPassed(sha);
    if (!ci.ok) { console.error(`release build refused: ${ci.why}\n(the CI gate: see .github/workflows/ci.yml; --skip-ci overrides it)`); process.exit(1); }
    console.log(`CI passed for ${sha.slice(0, 7)} (${ci.why})`);
  } else if (!dirty) console.log('WARNING: built without checking CI (--skip-ci)');
  try {
    const r = build({ out: arg('out') ? path.resolve(arg('out')) : undefined, key: arg('key'), critical: process.argv.includes('--critical'), dirty });
    // Checked the way an app will check it, with the keys the app trusts.
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'update-config.json'), 'utf8'));
    const v = core.verifyFolder(path.join(r.out, 'bundle'), conf.keys);
    console.log(`version ${r.version}${r.manifest.critical ? ' (critical)' : ''}, minimum ${r.manifest.minimum}, needs shell ${r.manifest.needsBase}: ${r.files} files, bundle ${(r.bytes / 1024).toFixed(0)} KB`);
    console.log(`written to ${r.out}: latest.json, latest.json.sig, ${r.bundleFile}, bundle/`);
    if (!v.ok) { console.error(`BUT an installed app would not take it: ${v.why}\n(is the key in app/update-config.json the one that signed? node release/keygen.js)`); process.exit(1); }
    console.log('verifies with the keys in app/update-config.json');
  } catch (e) { console.error('release build failed: ' + e.message); process.exit(1); }
})();

module.exports = { build, collect, defaultKey, ciPassed, signPackages };
