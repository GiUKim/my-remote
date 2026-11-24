// The installed app replaces its own shell: the folder the person unpacked (Electron, koffi, app/*.js:
// what an update of the code cannot replace, see app/core.js) with the package of a newer release. Without
// it every PC needs its package unpacked again by hand for a new Electron (security fixes) or a new shell
// (0.6.0's start screen), and a PC reached only through this app cannot be done at all: quitting its host
// ends the connection. (The user's go-ahead, 2026-11-16.)
//
//  1. What the newest packages are: packages.json in the feed, signed with the release key like
//     latest.json (release/build.js --sign-packages). Per system: the archive, its SHA-256 and size, and
//     the shell it holds (identity: Electron, koffi, the shell's own files, base, rev; release/package.js
//     writes the same into the package as resources/app/shell.json).
//  2. A shell is replaced only by a newer release's package that holds another shell: a release that
//     changed only the code costs no download. Shells from before shell.json have no identity: a newer
//     package replaces them once.
//  3. Staged next to the app's folder (<folder>.next: the same disk, so the swap is two renames), from the
//     archive whose SHA-256 the signed list gives; what it holds is checked once more (its shell.json).
//  4. Swapped by a small script of its own (PowerShell / sh) once every process of the folder has ended
//     (Windows keeps a running program's files): the host starts it and quits when no remote session is
//     on and the client app does not run; the client app when it quits and no host runs. The script renames
//     the folders, starts what was running (the host) and waits for the new shell's code to say it is up
//     (up.json with the new identity, written by confirm()). If it does not in time, the new folder is put
//     aside, the old one comes back and is started again, and that release is never staged again. With
//     nothing to start, the new program runs once as Node (ELECTRON_RUN_AS_NODE) and must load the
//     shell's core.js.
//  5. The program's name: Pangmote.exe / pangmote (pangmote.sh) since 0.10.0, MyRemote.exe / my-remote
//     (my-remote.sh) before, when the program was called My Remote. A swap goes from either to either: what
//     to start is read from the folders (programIn), never assumed. packages.json lists packages of the new
//     name as format 2, which code from before takes for no list at all: its stage() wants MyRemote.exe (it
//     would fetch the package every 6 hours and throw it away) and its script would start MyRemote.exe after
//     the swap. Such an app keeps its shell until its code is updated; then this code swaps it. A Linux folder
//     that had my-remote.sh keeps one that starts pangmote.sh (a menu entry or a script of the person's may
//     name it); on Windows the code points the shortcuts that named MyRemote.exe at the new program
//     (host/appsync.js retarget).
// Electron-free (fetch is given), so release/test-shellswap.js runs all of it in plain Node.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP = 'my-remote'; // the id in what a release signs: the program's old name, kept (see app/core.js)
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_LIST = 64 * 1024;
const LIMITS = { minSize: 10 * 1024 * 1024, maxSize: 1024 * 1024 * 1024 };
const EXE = { win32: 'Pangmote.exe', linux: 'pangmote' }, LAUNCHER = 'pangmote.sh';
const OLD_EXE = { win32: 'MyRemote.exe', linux: 'my-remote' }, OLD_LAUNCHER = 'my-remote.sh'; // up to 0.9.x
// The program a folder holds, by its new name or else its old one: { exe, launcher } (the launcher, Linux's
// start script, is '' on Windows), or null when it holds neither.
function programIn(dir, platform = process.platform) {
  for (const [exe, launcher] of [[EXE[platform], LAUNCHER], [OLD_EXE[platform], OLD_LAUNCHER]]) {
    if (exe && fs.existsSync(path.join(dir, exe))) return { exe, launcher: platform === 'win32' ? '' : launcher };
  }
  return null;
}
// A folder that had my-remote.sh keeps one after a swap to a package of the new name: whatever starts the app
// by that name (a menu entry, a script of the person's, a desktop file) still does.
const FORWARD_SH = `#!/bin/sh
# The program is called Pangmote since 0.10.0 (My Remote before). This name stays for whatever still starts it
# by its old one; it starts pangmote.sh beside it.
exec "$(dirname "$(readlink -f "$0")")/pangmote.sh" "$@"
`;

function cmp(a, b) {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
const platformKey = (p = process.platform, a = process.arch) => `${p}-${a}`;
const shellRoot = (root) => path.join(root, 'shell');
// PowerShell 5.1 writes UTF-8 with a byte order mark, which JSON.parse does not take.
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(v));
  fs.renameSync(t, f);
}
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---- what a shell is -------------------------------------------------------------------
// Packages of the same identity hold the same shell, whatever release they came with.
function identityOf(s) {
  if (!s || typeof s !== 'object') return '';
  const parts = [s.electron, s.koffi, s.app, s.base, s.rev].map((v) => (v === undefined || v === null ? '' : String(v)));
  return parts.every((p) => p && p.length <= 100 && !/["\\\s']/.test(p)) ? parts.join('|') : '';
}
// The shell this code runs on (shellDir: resources/app, where boot.js is). identity '' = from before shell.json.
function readShell(shellDir) {
  const pkg = readJson(path.join(shellDir, 'package.json'), {}), s = readJson(path.join(shellDir, 'shell.json'), null);
  return { version: typeof pkg.version === 'string' ? pkg.version : '', identity: identityOf(s) };
}

// ---- packages.json ------------------------------------------------------------------------
function publicKey(b64) { return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }); }
// The list as an object when `sig` (base64) signs exactly these bytes with one of `keys` (base64 SPKI, the
// shell's update-config.json) and the content is a list of this app's packages. Throws otherwise.
function verifyList(bytes, sig, keys, limits = LIMITS) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_LIST) throw new Error('packages.json: missing or too large');
  let signature;
  try { signature = Buffer.from(String(sig).trim(), 'base64'); } catch { signature = Buffer.alloc(0); }
  if (signature.length !== 64) throw new Error('packages.json: no signature');
  if (!(keys || []).some((k) => { try { return crypto.verify(null, bytes, publicKey(k), signature); } catch { return false; } })) throw new Error('packages.json: the signature is not by a key this app trusts');
  let l;
  try { l = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('packages.json: not JSON'); }
  // kind: a signed manifest (latest.json) is not a list of packages, nor the other way round (core.js wants files and a bundle).
  // format 2: packages whose program has the new name (see the top), which code from before takes for no list.
  if (!l || typeof l !== 'object' || (l.format !== 1 && l.format !== 2) || l.app !== APP || l.kind !== 'packages' || !VERSION.test(l.version) || !l.packages || typeof l.packages !== 'object' || Array.isArray(l.packages)) throw new Error('packages.json: not a list of packages of this app');
  for (const [k, p] of Object.entries(l.packages)) {
    if (!/^[a-z0-9]{1,20}-[a-z0-9]{1,20}$/.test(k) || !p || typeof p !== 'object' || !SAFE_FILE.test(p.file) || !HEX64.test(p.sha256) || !(Number.isInteger(p.size) && p.size >= limits.minSize && p.size <= limits.maxSize) || !identityOf(p.shell)) throw new Error(`packages.json: bad entry ${JSON.stringify(k).slice(0, 40)}`);
  }
  return l;
}

const badList = (root) => {
  const out = { ...readJson(path.join(shellRoot(root), 'bad.json'), {}) };
  try { for (const n of fs.readdirSync(shellRoot(root))) { const m = /^bad-(\d+\.\d+\.\d+)$/.exec(n); if (m) out[m[1]] = fs.readFileSync(path.join(shellRoot(root), n), 'utf8').trim().slice(0, 200) || 'failed'; } } catch {}
  return out;
};

// Which package, if any, should replace the shell this runs on. -> { entry } or { why }
function decide({ list, current, bad = {}, key = platformKey() }) {
  const p = list.packages[key];
  if (!p) return { why: `no package for ${key}` };
  if (bad[list.version]) return { why: `${list.version} failed before: ${bad[list.version]}` };
  if (!VERSION.test(current.version || '')) return { why: 'this shell says no version' };
  if (cmp(list.version, current.version) <= 0) return { why: 'not newer than this shell' };
  const identity = identityOf(p.shell);
  if (identity === current.identity) return { why: 'the same shell' };
  return { entry: { file: p.file, sha256: p.sha256, size: p.size, version: list.version, identity } };
}

// Whether the folder can be swapped at all: the folder above it writable (Program Files is not), room on the disk.
function cannotSwap(appDir, need) {
  const parent = path.dirname(appDir);
  try { const t = path.join(parent, `.pangmote-write-test-${process.pid}`); fs.writeFileSync(t, ''); fs.rmSync(t, { force: true }); } catch { return 'the folder above the app cannot be written'; }
  try { const s = fs.statfsSync(parent); if (Number(s.bavail) * Number(s.bsize) < need) return 'not enough room on the disk'; } catch {}
  return '';
}

// ---- staging --------------------------------------------------------------------------------
async function fetchSmall(fetchFn, url, maxBytes, timeoutMs, signal) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  const off = () => ctl.abort();
  if (signal) signal.addEventListener('abort', off);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: 'follow', cache: 'no-store' });
    if (!res.ok) throw new Error(`${path.basename(url)}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`${path.basename(url)}: too large`);
    return buf;
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', off); }
}
// The archive into `file`, checked against the list's size and SHA-256 as it comes; written piece by piece.
async function download({ fetchFn, url, file, size, sha256, timeoutMs = 60 * 60e3, signal, onProgress }) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  const off = () => ctl.abort();
  if (signal) { if (signal.aborted) throw new Error('stopped'); signal.addEventListener('abort', off); }
  const part = file + '.part', h = crypto.createHash('sha256');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fh = await fs.promises.open(part, 'w');
  let n = 0;
  try {
    const res = await fetchFn(url, { signal: ctl.signal, redirect: 'follow', cache: 'no-store' });
    if (!res.ok) throw new Error(`${path.basename(file)}: HTTP ${res.status}`);
    for (const reader = res.body.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > size) throw new Error('larger than the list says');
      h.update(value);
      await fh.write(value);
      if (onProgress) onProgress(n / size);
    }
  } catch (e) {
    throw new Error(ctl.signal.aborted ? (signal && signal.aborted ? 'stopped' : 'timed out') : String((e && e.message) || e));
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', off); await fh.close(); }
  if (n !== size) throw new Error('shorter than the list says');
  if (h.digest('hex') !== sha256) throw new Error('not the archive the list names (SHA-256)');
  fs.renameSync(part, file);
}
// Runs a program to its end without holding the event loop (the host's main thread injects input).
function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...opts });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, opts.timeout || 10 * 60e3);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${path.basename(file)} ended with ${code}`)); });
  });
}
// Windows' own tar (bsdtar) made the zip and takes it back; gzip'd tar on Linux keeps the file modes.
function extract(archive, into, platform) {
  if (platform === 'win32') return run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-x', '-f', archive, '-C', into]);
  return run('tar', ['-x', '-z', '-f', archive, '-C', into]);
}

// The staged shell, when there is one for this app folder and it is still where it was put.
function readNext(root, appDir) {
  const n = readJson(path.join(shellRoot(root), 'next.json'), null);
  if (!n || n.appDir !== appDir || typeof n.dir !== 'string' || !VERSION.test(n.version || '') || typeof n.identity !== 'string' || !n.identity) return null;
  return fs.existsSync(n.dir) && readShell(path.join(n.dir, 'resources', 'app')).identity === n.identity ? n : null;
}

// Fetches, checks and unpacks `entry` next to appDir. -> the staged shell (next.json)
async function stage({ entry, feed, appDir, root, fetchFn, platform = process.platform, signal, log = () => {}, onProgress }) {
  if (!EXE[platform]) throw new Error('no package for this system');
  const dir = path.join(shellRoot(root), entry.version), archive = path.join(dir, entry.file);
  const next = appDir + '.next', tmp = appDir + '.next-tmp';
  log(`shell ${entry.version}: fetching ${entry.file} (${(entry.size / 1048576).toFixed(0)} MB)`);
  try {
    await download({ fetchFn, url: feed + entry.file, file: archive, size: entry.size, sha256: entry.sha256, signal, onProgress });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await extract(archive, tmp, platform);
    const top = fs.readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (top.length !== 1) throw new Error('the archive does not hold one folder');
    const got = path.join(tmp, top[0].name);
    const s = readShell(path.join(got, 'resources', 'app'));
    const prog = programIn(got, platform);
    if (!prog || (prog.launcher && !fs.existsSync(path.join(got, prog.launcher)))) throw new Error(`the archive has no ${EXE[platform]}`);
    if (s.identity !== entry.identity || s.version !== entry.version) throw new Error('the archive holds another shell than the list says');
    if (platform !== 'win32' && prog.launcher !== OLD_LAUNCHER && fs.existsSync(path.join(appDir, OLD_LAUNCHER)) && !fs.existsSync(path.join(got, OLD_LAUNCHER))) {
      fs.writeFileSync(path.join(got, OLD_LAUNCHER), FORWARD_SH, { mode: 0o755 });
    }
    fs.rmSync(path.join(shellRoot(root), 'next.json'), { force: true });
    fs.rmSync(next, { recursive: true, force: true });
    fs.renameSync(got, next);
    const n = { version: entry.version, identity: entry.identity, dir: next, appDir, at: Date.now(), exe: prog.exe, launcher: prog.launcher };
    writeJson(path.join(shellRoot(root), 'next.json'), n);
    log(`shell ${entry.version}: staged at ${next}`);
    return n;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One look: the feed's list, and the package staged when it should replace this shell. Never throws.
// -> { state: 'off' | 'none' | 'cannot' | 'busy' | 'staged' | 'error', why, version }
async function look({ feed, keys, root, appDir, current, fetchFn, platform = process.platform, arch = process.arch, signal, log = () => {}, limits = LIMITS, onProgress }) {
  try {
    if (!EXE[platform] || typeof feed !== 'string' || !/^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(feed)) return { state: 'off', why: 'no feed or no package for this system' };
    feed = feed.replace(/\/*$/, '/');
    const [bytes, sig] = await Promise.all([fetchSmall(fetchFn, feed + 'packages.json', MAX_LIST, 30e3, signal), fetchSmall(fetchFn, feed + 'packages.json.sig', 4096, 30e3, signal)]);
    const list = verifyList(bytes, sig.toString('utf8'), keys, limits);
    const d = decide({ list, current, bad: badList(root), key: platformKey(platform, arch) });
    if (!d.entry) return { state: 'none', why: d.why };
    const staged = readNext(root, appDir);
    if (staged && staged.version === d.entry.version) return { state: 'staged', version: staged.version, why: 'staged before' };
    const no = cannotSwap(appDir, 3 * d.entry.size);
    if (no) return { state: 'cannot', why: no };
    // One stager at a time (the host and the client app may both look).
    const lock = path.join(shellRoot(root), 'stage.lock');
    const held = readJson(lock, null);
    if (held && held.pid !== process.pid && alive(held.pid) && Date.now() - held.at < 3 * 3600e3) return { state: 'busy', why: 'being fetched by the other face' };
    writeJson(lock, { pid: process.pid, at: Date.now() });
    try {
      const n = await stage({ entry: d.entry, feed, appDir, root, fetchFn, platform, signal, log, onProgress });
      return { state: 'staged', version: n.version };
    } finally { fs.rmSync(lock, { force: true }); }
  } catch (e) {
    return { state: 'error', why: String((e && e.message) || e).slice(0, 200) };
  }
}

// ---- the swap ---------------------------------------------------------------------------
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// An argument of a program to start: '@APP@/x/y' is x/y inside the app folder as it is after the swap.
const psArg = (a) => (a.startsWith('@APP@/') ? `('"' + (Join-Path $App ${psq(a.slice(6).replace(/\//g, '\\'))}) + '"')` : psq(/\s/.test(a) ? `"${a}"` : a));
const shArg = (a) => (a.startsWith('@APP@/') ? `"$APP/${a.slice(6).replace(/["$`\\]/g, '\\$&')}"` : shq(a));

// restart: [{ file, args }] relative to the app folder (the faces that were running); waitSecs: how long the
// processes of the folder may take to end; upSecs: how long the new code may take to say it is up; exe: the
// new shell's program (run once as Node when nothing is to be started).
function scriptWin({ appDir, next, root, version, identity, restart, waitSecs, upSecs, exe = EXE.win32 }) {
  const starts = restart.map((r) => `  Start-Process -FilePath (Join-Path $App ${psq(r.file)}) -WorkingDirectory $App${r.args.length ? ' -ArgumentList (@(' + r.args.map(psArg).join(', ') + ') -join \' \')' : ''}`).join('\n');
  return `# The installed app's shell swap (host/shellswap.js). Written for this one swap.
$ErrorActionPreference = 'Continue'
$App = ${psq(appDir)}; $Next = ${psq(next)}; $Old = $App + '.old'; $Failed = $App + '.failed'
$Dir = ${psq(shellRoot(root))}; $Log = Join-Path $Dir 'swap.log'; $Up = Join-Path $Dir 'up.json'
$Version = ${psq(version)}; $Identity = ${psq(identity)}; $Exe = ${psq(exe)}
function Log([string]$m) { try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }
# The processes started from the app folder. Windows lets a folder be renamed while a program in it runs
# (measured), so this wait is what keeps a running app's folder in place. Counted inside the function: a
# function's one result comes back as itself, not as an array of one, and a CIM object has no Count.
function RunningProcs {
  $p = ($App.TrimEnd('\\') + '\\').ToLower()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($p) }
}
function Running { return @(RunningProcs).Count }
function StartAll {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
${starts || '  # nothing was running'}
}
# Cmdlets, not .NET calls, throughout: they also run where PowerShell is held to its constrained language.
# Move-Item would move into a folder that is there: never onto one.
function MoveDir([string]$from, [string]$to) {
  if (Test-Path -LiteralPath $to) { Log ('could not move ' + $from + ': ' + $to + ' is there'); return $false }
  for ($i = 0; $i -lt 20; $i++) { try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return $true } catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds 500 } }
  Log ('could not move ' + $from + ' to ' + $to + ': ' + $err); return $false
}
# keep: the staged shell stays staged for another time (nothing was swapped).
function Finish([bool]$keep) { Remove-Item -LiteralPath (Join-Path $Dir 'swap.json') -Force -ErrorAction SilentlyContinue; if (-not $keep) { Remove-Item -LiteralPath (Join-Path $Dir 'next.json') -Force -ErrorAction SilentlyContinue } }
# Not swapped: what ran starts again, and the app does not try again for a while (heldRecently).
function Held([string]$why) { Log $why; try { Set-Content -LiteralPath (Join-Path $Dir 'held') -Value $why -Encoding ASCII } catch {}; StartAll; Finish $true; exit 1 }
# The app quits only once it sees this (begin): a script that never ran must not leave the PC without its host.
Set-Content -LiteralPath (Join-Path $Dir 'swap.started') -Value $PID -Encoding ASCII
Log ('swap to ' + $Version + ' begins')
$until = (Get-Date).AddSeconds(${Number(waitSecs) || 120})
while ((Running) -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
if ((Running) -gt 0) { Held 'the app still runs: not swapped' }
if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath $Old) { Held 'an old copy is in the way: not swapped' }
if (-not (MoveDir $App $Old)) { Held 'not swapped' }
if (-not (MoveDir $Next $App)) { MoveDir $Old $App | Out-Null; Held 'not swapped' }
Log 'folders swapped'
Remove-Item -LiteralPath $Up -Force -ErrorAction SilentlyContinue
$ok = $false
${restart.length ? `StartAll
$until = (Get-Date).AddSeconds(${Number(upSecs) || 180})
while ((Get-Date) -lt $until) {
  try { $u = Get-Content -LiteralPath $Up -Raw -ErrorAction Stop | ConvertFrom-Json; if ($u.identity -eq $Identity) { $ok = $true; break } } catch {}
  Start-Sleep -Seconds 1
}` : `# Nothing to start: the new program runs once as Node and must load the shell's core.js.
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  $p = Start-Process -FilePath (Join-Path $App $Exe) -ArgumentList ('-e "require(process.argv[1])" "' + (Join-Path $App 'resources\\app\\core.js') + '"') -PassThru -Wait -WindowStyle Hidden
  $ok = ($p.ExitCode -eq 0)
} catch { Log ('the new program did not run: ' + $_.Exception.Message) }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`}
if ($ok) {
  Log ('the new shell (' + $Version + ') is up'); Finish $false; Remove-Item -LiteralPath (Join-Path $Dir 'held') -Force -ErrorAction SilentlyContinue
  # A virus scanner may still have a file of it open: a few tries, and what is left goes at a later start (sweep).
  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $Old); $i++) { Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $Old) { Start-Sleep -Seconds 2 } }
  exit 0
}
Log 'the new shell did not come up: going back'
foreach ($p in @(RunningProcs)) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 2
if (Test-Path -LiteralPath $Failed) { Remove-Item -LiteralPath $Failed -Recurse -Force -ErrorAction SilentlyContinue }
if ((MoveDir $App $Failed) -and (MoveDir $Old $App)) { Log 'the old shell is back' } else { Log 'GOING BACK FAILED' }
try { Set-Content -LiteralPath (Join-Path $Dir ('bad-' + $Version)) -Value 'did not come up' -Encoding ASCII } catch {}
StartAll
Finish $false
exit 1
`;
}

function scriptSh({ appDir, next, root, version, identity, restart, waitSecs, upSecs, exe = EXE.linux }) {
  const starts = restart.map((r) => `  (cd "$APP" && setsid "$APP/${r.file}"${r.args.map((a) => ' ' + shArg(a)).join('')} </dev/null >/dev/null 2>&1 &)`).join('\n');
  return `#!/bin/sh
# The installed app's shell swap (host/shellswap.js). Written for this one swap.
APP=${shq(appDir)}; NEXT=${shq(next)}; OLD="$APP.old"; FAILED="$APP.failed"
DIR=${shq(shellRoot(root))}; LOG="$DIR/swap.log"; UP="$DIR/up.json"
VERSION=${shq(version)}; IDENTITY=${shq(identity)}; EXE=${shq(exe)}
log() { printf '%s %s\\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$*" >> "$LOG"; }
running() { for p in /proc/[0-9]*; do e=$(readlink "$p/exe" 2>/dev/null) || continue; case "$e" in "$APP"/*) return 0;; esac; done; return 1; }
start_all() {
  unset ELECTRON_RUN_AS_NODE
${starts || '  :'}
}
# keep: the staged shell stays staged for another time (nothing was swapped).
finish() { rm -f "$DIR/swap.json"; [ "$1" = keep ] || rm -f "$DIR/next.json"; }
# Not swapped: what ran starts again, and the app does not try again for a while (heldRecently).
held() { log "$1"; printf '%s\\n' "$1" > "$DIR/held"; start_all; finish keep; exit 1; }
# The app quits only once it sees this (begin): a script that never ran must not leave the PC without its host.
printf '%s\\n' "$$" > "$DIR/swap.started"
log "swap to $VERSION begins"
i=0; while running && [ $i -lt ${Number(waitSecs) || 120} ]; do sleep 1; i=$((i+1)); done
if running; then held "the app still runs: not swapped"; fi
rm -rf "$OLD"
if [ -e "$OLD" ]; then held "an old copy is in the way: not swapped"; fi
if ! mv "$APP" "$OLD"; then held "could not move the app aside: not swapped"; fi
if ! mv "$NEXT" "$APP"; then mv "$OLD" "$APP"; held "could not move the new shell in: not swapped"; fi
log "folders swapped"
rm -f "$UP"
ok=0
${restart.length ? `start_all
i=0; while [ $i -lt ${Number(upSecs) || 180} ]; do
  if grep -qF "\\"identity\\":\\"$IDENTITY\\"" "$UP" 2>/dev/null; then ok=1; break; fi
  sleep 1; i=$((i+1))
done` : `# Nothing to start: the new program runs once as Node and must load the shell's core.js.
if ELECTRON_RUN_AS_NODE=1 timeout 60 "$APP/$EXE" -e 'require(process.argv[1])' "$APP/resources/app/core.js" >/dev/null 2>&1; then ok=1; fi`}
if [ $ok = 1 ]; then log "the new shell ($VERSION) is up"; finish; rm -f "$DIR/held"; rm -rf "$OLD"; exit 0; fi
log "the new shell did not come up: going back"
for p in /proc/[0-9]*; do e=$(readlink "$p/exe" 2>/dev/null) || continue; case "$e" in "$APP"/*) kill -9 "\${p#/proc/}" 2>/dev/null;; esac; done
sleep 2
rm -rf "$FAILED"
if mv "$APP" "$FAILED" && mv "$OLD" "$APP"; then log "the old shell is back"; else log "GOING BACK FAILED"; fi
printf 'did not come up\\n' > "$DIR/bad-$VERSION"
start_all
finish
exit 1
`;
}

// The faces to start again after the swap (relative to the app folder): the program of the staged shell `next`
// (which may have another name than this one's: see the top).
function hostFace(platform = process.platform, next = null) {
  const p = (next && next.dir && programIn(next.dir, platform)) || { exe: EXE[platform] || EXE.win32, launcher: LAUNCHER };
  return { file: platform === 'win32' ? p.exe : p.launcher, args: ['--host'] };
}

// Writes swap.json and the script, starts the script on its own and resolves once the script has said it
// runs (swap.started): only then may the caller quit. A script that does not start in startSecs (a policy,
// a virus scanner) rejects, and the app keeps running: a remote host must never quit for a swap that will
// not bring it back.
// Windows: a PowerShell that Node starts detached gets no console and ends at once without running its
// script (measured), and one started attached is in the job object Node puts its children in, which ends
// them with this process. So a short-lived PowerShell starts the script's (Start-Process, a hidden window
// of its own: Node's job lets children of its children go); about half a second. The script is read and
// run as a command (Invoke-Expression), not as a script file, which an execution policy could forbid.
// Linux: sh in a session of its own.
async function begin({ root, appDir, next, restart = [], platform = process.platform, waitSecs = 120, upSecs = 180, startSecs = 20, spawnFn = spawn, spawnSyncFn = spawnSync, log = () => {} }) {
  if (!EXE[platform]) throw new Error('no swap on this system');
  for (const r of restart) if (!SAFE_FILE.test(r.file) || !r.args.every((a) => typeof a === 'string' && a.length < 300 && !/["'`$\r\n]/.test(a))) throw new Error('a program to start that the script cannot name');
  const dir = shellRoot(root), started = path.join(dir, 'swap.started');
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(started, { force: true });
  const prog = programIn(next.dir, platform);
  if (!prog) throw new Error(`the staged shell has no ${EXE[platform]}`);
  const o = { appDir, next: next.dir, root, version: next.version, identity: next.identity, restart, waitSecs, upSecs, exe: prog.exe };
  const file = path.join(dir, platform === 'win32' ? 'swap.ps1' : 'swap.sh');
  fs.writeFileSync(file, platform === 'win32' ? '\uFEFF' + scriptWin(o) : scriptSh(o), { mode: 0o755 }); // the BOM: PowerShell 5.1 reads the paths as UTF-8
  writeJson(path.join(dir, 'swap.json'), { version: next.version, identity: next.identity, appDir, next: next.dir, restart, by: process.pid, at: Date.now() });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const fail = (why) => { fs.rmSync(path.join(dir, 'swap.json'), { force: true }); return new Error(why); };
  if (platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // The script's PowerShell gets its command line as one text: -Command "Get-Content ... | Invoke-Expression".
    const child = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Content -LiteralPath ${psq(file)} -Raw -Encoding UTF8 | Invoke-Expression"`;
    const cmd = `Start-Process -FilePath ${psq(ps)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden -ArgumentList ${psq(child)}`;
    const r = spawnSyncFn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { cwd: dir, env, windowsHide: true, stdio: 'ignore', timeout: 30e3 });
    if (!r || r.status !== 0) throw fail(`the swap script did not start (${r && r.error ? r.error.message : 'exit ' + (r && r.status)})`);
  } else {
    const p = spawnFn('/bin/sh', [file], { cwd: dir, env, detached: true, stdio: 'ignore' });
    if (p && p.unref) p.unref();
  }
  for (const until = Date.now() + startSecs * 1000; !fs.existsSync(started); ) {
    if (Date.now() > until) throw fail(`the swap script did not start in ${startSecs} s`);
    await new Promise((res) => setTimeout(res, 200));
  }
  log(`shell ${next.version}: swap started (${restart.length ? 'then ' + restart.map((r) => r.file + ' ' + r.args.join(' ')).join(', ') : 'nothing to start'})`);
  return file;
}
// A swap that found the app still running (or could not move a folder) a short while ago: not tried again
// before `ms` (a host that quits for it every few minutes would be a host that keeps restarting).
function heldRecently(root, ms = 6 * 3600e3) {
  try { return Date.now() - fs.statSync(path.join(shellRoot(root), 'held')).mtimeMs < ms; } catch { return false; }
}
// What swaps left next to the app folder: the old shell when its removal failed, and a shell that did not
// come up (kept a week for a look at what went wrong). Not while a swap is under way. -> the names removed
async function sweep(appDir, root) {
  if (pending(root)) return [];
  const gone = [];
  for (const [p, keepMs] of [[appDir + '.old', 0], [appDir + '.failed', 7 * 86400e3]]) {
    try {
      // The old shell at once, whatever its time says: a folder just made can look a few ms younger than
      // "now" on Windows (its time from the precise clock, Date.now() from the coarse 15.6 ms one), and a
      // comparison with 0 then skipped it - on GitHub's runner, every time (2026-11-17), not on a PC where
      // some program had raised the timer's resolution.
      const st = fs.statSync(p);
      if (keepMs > 0 && Date.now() - st.mtimeMs < keepMs) continue;
      // Tried again for a moment: on Windows a virus scanner or the indexer may hold a folder just made or
      // just moved. (What was seen on GitHub's runner, the old shell not removed at all by two sweeps, was
      // the time comparison above.)
      await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      gone.push(path.basename(p));
    } catch {}
  }
  return gone;
}
// A swap that was begun and whose script still waits: none when it is over.
function pending(root) {
  const s = readJson(path.join(shellRoot(root), 'swap.json'), null);
  return s && Date.now() - Number(s.at) < 15 * 60e3 ? s : null;
}
// The code says it is up on the shell it runs on: the swap script waits for this (only while one is under way).
function confirm(root, identity) {
  if (!pending(root)) return false;
  try { writeJson(path.join(shellRoot(root), 'up.json'), { identity, pid: process.pid, at: Date.now() }); return true; } catch { return false; }
}

module.exports = { identityOf, readShell, verifyList, decide, badList, cannotSwap, look, stage, readNext, begin, pending, confirm, heldRecently, sweep, hostFace, programIn, platformKey, shellRoot, scriptWin, scriptSh, cmp, EXE, LAUNCHER, OLD_EXE, OLD_LAUNCHER, FORWARD_SH, LIMITS };
