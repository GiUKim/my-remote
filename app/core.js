// The installed app's shell, part 1: what it trusts and what it starts. Plain Node, no Electron, so
// that it can be tested on its own (release/test-update.js).
//
// An installed app is two layers. The shell (this folder: Electron, boot.js, the updater) changes
// rarely. The code it runs - the host and the client app, a megabyte or two of JavaScript and two
// DLLs - is a "bundle": the one that came with the installer (bundle/ next to this file), or a newer
// one the updater fetched into the user's data folder (versions/<version>/). boot.js picks one at
// every start.
//
// Trust: a bundle is described by a manifest (version, the SHA-256 of every file) signed with
// Ed25519 by whoever makes the releases. The public keys are in update-config.json, which is part of
// the shell. Where the files are downloaded from therefore does not matter: a manifest that does not
// verify, or a file that is not the one the manifest names, is never installed and never started.
// The installed files are checked against their signed manifest again at every start.
//
// Safety net: a version started for the first time is on trial until the code it runs says it is up
// (ok()). One that does not get there in two starts is marked bad and the one before it runs again -
// a remote host that came back broken from an update could not be reached to be repaired.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP = 'my-remote';
const MAX_FILES = 2000, MAX_BYTES = 64 * 1024 * 1024, MAX_MANIFEST = 512 * 1024;
const TRIAL_STARTS = 2; // a new version gets this many starts to say it is up

// ---- versions: major.minor.patch, compared as numbers -----------------------------------
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const validVersion = (v) => typeof v === 'string' && VERSION.test(v);
function cmp(a, b) {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// ---- the manifest ----------------------------------------------------------------------
// A file's path inside a bundle: forward slashes, plain names, nothing that could leave the folder.
const SAFE_PART = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;
const safePath = (p) => typeof p === 'string' && p.length <= 240 && p.split('/').every((s) => SAFE_PART.test(s) && !s.endsWith('.') && !s.endsWith(' '));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

function publicKey(b64) { return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }); }
// The manifest as an object, when `sig` (base64) is a signature of exactly these bytes by one of `keys`
// (base64 SPKI) and the content is what this shell understands. Throws otherwise, saying why.
function verifyManifest(bytes, sig, keys) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MANIFEST) throw new Error('manifest: missing or too large');
  let signature;
  try { signature = Buffer.from(String(sig).trim(), 'base64'); } catch { signature = Buffer.alloc(0); }
  if (signature.length !== 64) throw new Error('manifest: no signature');
  const signed = (keys || []).some((k) => { try { return crypto.verify(null, bytes, publicKey(k), signature); } catch { return false; } });
  if (!signed) throw new Error('manifest: the signature is not by a key this app trusts');
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('manifest: not JSON'); }
  if (!m || typeof m !== 'object' || m.format !== 1 || m.app !== APP) throw new Error('manifest: not a manifest of this app (format 1)');
  if (!validVersion(m.version)) throw new Error('manifest: bad version');
  if (!Number.isInteger(m.needsBase) || m.needsBase < 1) throw new Error('manifest: bad needsBase');
  if (m.minimum !== undefined && !validVersion(m.minimum)) throw new Error('manifest: bad minimum');
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('manifest: no files');
  const names = Object.keys(m.files);
  if (!names.length || names.length > MAX_FILES) throw new Error('manifest: bad number of files');
  for (const n of names) if (!safePath(n) || !HEX64.test(m.files[n])) throw new Error(`manifest: bad file entry ${JSON.stringify(n).slice(0, 80)}`);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  if (lower.size !== names.length) throw new Error('manifest: two files differ only in case'); // one file on Windows
  if (!m.bundle || !safePath(m.bundle.file) || m.bundle.file.includes('/') || !HEX64.test(m.bundle.sha256) || !(m.bundle.size > 0 && m.bundle.size <= MAX_BYTES)) throw new Error('manifest: bad bundle entry');
  return m;
}

// ---- the bundle file: every file of one version in one download ---------------------------
// gzip of JSON { format: 1, files: [[path, base64], ...] }. What is in it is only taken when it is what
// the signed manifest lists, so the container itself needs no protection.
function packBundle(files) { // files: Map or object, path -> Buffer
  const list = (files instanceof Map ? [...files] : Object.entries(files)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return zlib.gzipSync(Buffer.from(JSON.stringify({ format: 1, files: list.map(([p, b]) => [p, Buffer.from(b).toString('base64')]) })), { level: 9 });
}
function unpackBundle(buf) {
  let raw;
  try { raw = zlib.gunzipSync(buf, { maxOutputLength: MAX_BYTES * 2 }); } catch (e) { throw new Error('bundle: cannot be unpacked (' + e.code + ')'); }
  let o;
  try { o = JSON.parse(raw.toString('utf8')); } catch { throw new Error('bundle: not JSON'); }
  if (!o || o.format !== 1 || !Array.isArray(o.files) || o.files.length > MAX_FILES) throw new Error('bundle: not a bundle (format 1)');
  const out = new Map();
  let total = 0;
  for (const e of o.files) {
    if (!Array.isArray(e) || !safePath(e[0]) || typeof e[1] !== 'string' || out.has(e[0])) throw new Error('bundle: bad entry');
    const b = Buffer.from(e[1], 'base64');
    total += b.length;
    if (total > MAX_BYTES) throw new Error('bundle: too large');
    out.set(e[0], b);
  }
  return out;
}

// ---- installed versions ----------------------------------------------------------------
const versionsDir = (root) => path.join(root, 'versions');
const versionDir = (root, v) => path.join(versionsDir(root), v);

// Writes one version's files into <root>/versions/<version>: only when the bundle is exactly what the
// (already verified) manifest lists. Built beside its place and renamed into it, so a crash midway
// leaves either the old folder or none, never half of one.
function installVersion(root, manifest, manifestBytes, sig, bundleBuf) {
  if (bundleBuf.length !== manifest.bundle.size || sha256(bundleBuf) !== manifest.bundle.sha256) throw new Error('bundle: not the file the manifest names');
  const files = unpackBundle(bundleBuf), names = Object.keys(manifest.files);
  if (files.size !== names.length) throw new Error('bundle: its files are not the manifest\'s');
  for (const n of names) { const b = files.get(n); if (!b || sha256(b) !== manifest.files[n]) throw new Error(`bundle: ${n} is not the file the manifest names`); }
  const dir = versionDir(root, manifest.version), tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const n of names) {
      const to = path.join(tmp, ...n.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, files.get(n));
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(tmp, 'manifest.sig'), String(sig).trim());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  return dir;
}

// A folder holding one version (an installed one, or the one that came with the installer): its
// manifest is signed by a trusted key and every file it lists is there unchanged. -> { ok, manifest, why }
function verifyFolder(dir, keys) {
  try {
    const manifest = verifyManifest(fs.readFileSync(path.join(dir, 'manifest.json')), fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8'), keys);
    for (const [n, h] of Object.entries(manifest.files)) {
      let b;
      try { b = fs.readFileSync(path.join(dir, ...n.split('/'))); } catch { return { ok: false, why: `${n} is missing` }; }
      if (sha256(b) !== h) return { ok: false, why: `${n} was changed` };
    }
    return { ok: true, manifest };
  } catch (e) { return { ok: false, why: e.message }; }
}

// ---- which version runs: state.json ---------------------------------------------------
// { current, previous, trial: { version, starts, pid }, bad: { version: why } }
//   current:  the installed version to run (null: the one that came with the installer)
//   previous: the installed version that ran before it, to go back to
//   trial:    `current` has not said it is up yet; `starts` = how often it was started, `pid` = by which process last
//   bad:      versions that did not start here, or whose files were not right: never run again
const stateFile = (root) => path.join(root, 'state.json');
function readState(root) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch {}
  if (!s || typeof s !== 'object') s = {};
  return {
    current: validVersion(s.current) ? s.current : null,
    previous: validVersion(s.previous) ? s.previous : null,
    trial: s.trial && validVersion(s.trial.version) ? { version: s.trial.version, starts: Number(s.trial.starts) || 0, pid: Number(s.trial.pid) || 0 } : null,
    bad: s.bad && typeof s.bad === 'object' && !Array.isArray(s.bad) ? Object.fromEntries(Object.entries(s.bad).filter(([v]) => validVersion(v)).map(([v, w]) => [v, String(w).slice(0, 200)])) : {},
  };
}
function writeState(root, s) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = stateFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, stateFile(root));
}

// Picks what to run, at a start of the app. `builtin`: { dir, version } of the bundle that came with
// the installer, `base`: this shell's generation. An installed version runs when it is newer than the
// built-in one, made for this shell, intact, not marked bad, and has not used up its trial; else the
// one before it, else the built-in one. Counts this start against a version on trial.
// A start while the program that is on trial is still running (a second click on the shortcut; a second
// client window) is no failed start: it runs the same version, uncounted (`pid`, `alive`).
// -> { dir, version, source: 'installed' | 'builtin', trial, rolledBack: [{ version, why }] }
function choose({ root, builtin, base, keys, pid = 0, alive = () => false }) {
  const st = readState(root), rolledBack = [];
  let pick = null;
  const beside = !!(st.trial && st.trial.pid && st.trial.pid !== pid && alive(st.trial.pid)); // the one on trial is running
  for (let guard = 0; guard < 8 && st.current; guard++) {
    const v = st.current;
    let why = '';
    if (cmp(v, builtin.version) <= 0) why = 'superseded'; // the installer brought this version or a newer one
    else if (st.bad[v]) why = st.bad[v];
    else if (!beside && st.trial && st.trial.version === v && st.trial.starts >= TRIAL_STARTS) why = `did not come up in ${TRIAL_STARTS} starts`;
    else {
      const f = verifyFolder(versionDir(root, v), keys);
      if (!f.ok) why = f.why;
      else if (f.manifest.version !== v) why = 'the folder holds another version';
      else if (f.manifest.needsBase > base) why = `needs a newer app shell (${f.manifest.needsBase})`;
    }
    if (!why) { pick = { dir: versionDir(root, v), version: v }; break; }
    if (why !== 'superseded') { st.bad[v] = why; rolledBack.push({ version: v, why }); }
    st.current = st.previous && st.previous !== v ? st.previous : null;
    st.previous = null;
    if (st.trial && st.trial.version === v) st.trial = null;
  }
  if (!pick) { st.current = null; st.previous = null; st.trial = null; }
  const trial = !!(pick && st.trial && st.trial.version === pick.version) && !beside;
  if (trial) { st.trial.starts++; st.trial.pid = pid; }
  try { writeState(root, st); } catch {} // a data folder that cannot be written: the choice still stands for this start
  return pick ? { ...pick, source: 'installed', trial, rolledBack } : { dir: builtin.dir, version: builtin.version, source: 'builtin', trial: false, rolledBack };
}
// The running version says it is up: its trial is over. Older versions' folders go, but for the one before.
function markOk(root, version) {
  const st = readState(root);
  if (st.trial && st.trial.version === version) { st.trial = null; writeState(root, st); }
  sweep(root, st);
}
function markBad(root, version, why) {
  const st = readState(root);
  st.bad[version] = String(why || 'failed').slice(0, 200);
  writeState(root, st);
}
// A freshly installed version becomes the one to run, on trial; the one running now is kept to go back to.
function activate(root, version, running) {
  const st = readState(root);
  st.previous = running && running.source === 'installed' && running.version !== version ? running.version : null;
  st.current = version;
  st.trial = { version, starts: 0 };
  writeState(root, st);
}
// Folders of versions that are neither run nor kept to go back to, and leftovers of an install cut short.
function sweep(root, st = readState(root)) {
  let names = [];
  try { names = fs.readdirSync(versionsDir(root)); } catch { return; }
  for (const n of names) {
    if (n === st.current || n === st.previous) continue;
    if (st.trial && n === st.trial.version) continue;
    try { fs.rmSync(path.join(versionsDir(root), n), { recursive: true, force: true }); } catch {}
  }
}

// ---- for the release tools ---------------------------------------------------------------
function signManifest(bytes, privateKeyPem) { return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64'); }

module.exports = {
  APP, TRIAL_STARTS, cmp, validVersion, safePath, sha256,
  verifyManifest, packBundle, unpackBundle, installVersion, verifyFolder,
  readState, writeState, choose, markOk, markBad, activate, sweep, versionDir, signManifest,
};
