// Makes the installable app for the platform this runs on, from a release built by release/build.js:
//   node release/package.js [--release=dist/release] [--out=dist/pack] [--no-archive] [--config=<update-config.json>]
//                           [--signed-exe=<file>] [--require-signed]
//   node release/package.js --exe-only=<folder>   only the Windows program, unsigned (what sign.yml has signed)
// -> dist/pack/Pangmote/                       the app: unpack anywhere and start it
//    dist/pack/Pangmote-Windows-x64.zip        (on Windows), Pangmote-Linux-x64.tar.gz (on Linux)
//    dist/pack/Pangmote-<OS>-x64.package.json  what release/build.js --sign-packages lists in packages.json
//                                              (the archive's SHA-256 and the shell it holds: shell.json)
// (Up to 0.9.x, when the program was called My Remote: MyRemote/, MyRemote.exe, my-remote, my-remote.sh and
// MyRemote-<OS>-x64.*. Installed apps of those packages take one of these by the shell swap: see
// host/shellswap.js.)
// The names carry no version: the download links point at "the latest release's Pangmote-Windows-x64.zip"
// (https://github.com/<owner>/<repo>/releases/latest/download/<name>), and the app updates itself, so a
// version in the folder's name would soon be the wrong one. The version is in the folder's read-me.
//
// The app is Electron as npm installed it for this platform (host/node_modules/electron/dist, the very
// program the self-test ran on; nothing else is downloaded), renamed, with resources/app holding the
// shell (app/), the modules the code needs from npm (koffi, with this platform's binary only), and the
// release's code as the built-in bundle. So a package is made on the platform it is for: Windows here,
// Linux on a Linux machine (file modes and links survive there), macOS on a Mac (where it must also be
// signed to run at all; not done).
//
// On Windows Pangmote.exe is the one file SmartScreen judges ("Windows protected your PC" on a first start
// from a downloaded zip). Signed, it is taken from dist/signed/<Electron version>/Pangmote.exe (or
// --signed-exe): .github/workflows/sign.yml has SignPath sign the program this script makes with
// --exe-only, and release/signed-exe.js checks that the signed file is exactly that program with a valid,
// timestamped signature of the SignPath Foundation before it goes in (a file that fails stops the package).
// Without one the package is made unsigned and says so; --require-signed makes that an error. The signed
// program is the same program, so the shell's identity (shell.json) does not change with it: installed apps
// do not fetch a package for a signature (an app's own downloads carry no mark of the web, so SmartScreen
// never looks at them).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../app/core');
const shellswap = require('../host/shellswap');
const signedExe = require('./signed-exe');

// What the package's shell is (host/shellswap.js, release/build.js --sign-packages): installed apps replace
// their shell only by a newer release's package whose shell differs from theirs, so a release that changed
// only the code costs them no download. The shell's own files are hashed with their line ends made plain
// (a Windows checkout has CRLF), with the config and package.json without the release's version. Raise
// SHELL_REV when this file changes what a package holds in another way (the exe's resources, what it copies).
// 2: the program's new name (0.10.0: Pangmote.exe, pangmote, pangmote.sh, the exe's version strings).
const SHELL_REV = 2;
function shellInfo({ shell, conf, electron, koffi }) {
  const h = crypto.createHash('sha256');
  for (const f of ['boot.js', 'core.js', 'updater.js', 'guard.js', 'pangmote.sh', 'icon.png', 'icon.ico']) {
    const p = path.join(ROOT, 'app', f);
    if (!fs.existsSync(p)) continue;
    let b = fs.readFileSync(p);
    if (/\.(js|sh)$/.test(f)) b = Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
    h.update(`${f}\0${core.sha256(b)}\n`);
  }
  const { version, ...rest } = shell; // eslint-disable-line no-unused-vars
  h.update(`update-config\0${JSON.stringify(conf)}\npackage\0${JSON.stringify(rest)}\n`);
  return { format: 1, electron, koffi, app: h.digest('hex').slice(0, 32), base: shell.base, rev: SHELL_REV };
}

const ROOT = path.join(__dirname, '..');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? path.resolve(a.slice(name.length + 3)) : undefined; };

// The name Windows shows for the program (the firewall's prompt says "Electron" by "GitHub, Inc.", so do
// Task Manager and a notification with no shortcut behind it; the person saw it on 2026-11-15): Electron's
// version resource, rewritten in place. Every value keeps its length in UTF-16 (a shorter one ends early
// with NULs, which every reader stops at), so nothing in the resource section moves and no outside tool
// touches the release. Only the .rsrc section is searched. The copyright of Electron stays as it is.
// (Pangmote, like MyRemote before it, is as long as Electron: 8 characters, 12 with .exe.)
const BRAND = { FileDescription: 'Pangmote', ProductName: 'Pangmote', CompanyName: 'Pangmote', InternalName: 'Pangmote', OriginalFilename: 'Pangmote.exe' };
function rsrcRange(b) {
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const sections = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20);
  for (let i = 0, s = pe + 24 + optSize; i < sections; i++, s += 40) {
    if (b.toString('latin1', s, s + 8).replace(/\0+$/, '') === '.rsrc') { const raw = b.readUInt32LE(s + 20), size = b.readUInt32LE(s + 16); return [raw, raw + size]; }
  }
  throw new Error('no .rsrc section');
}
// Each key's value in the version resource's StringFileInfo: { key: [[offset, length in chars], ...] }.
function versionStrings(b) {
  const [lo, hi] = rsrcRange(b), found = {};
  for (const key of Object.keys(BRAND)) {
    const k = Buffer.from(key + '\0', 'utf16le');
    for (let at = b.indexOf(k, lo); at >= 0 && at < hi; at = b.indexOf(k, at + 2)) {
      if ((at - lo) % 2) continue; // UTF-16 text starts at an even offset
      let v = at + k.length;
      while (v < hi && b.readUInt16LE(v) === 0) v += 2; // the padding to the next 32-bit boundary
      let end = v;
      while (end < hi && b.readUInt16LE(end) !== 0) end += 2;
      (found[key] = found[key] || []).push([v, (end - v) / 2]);
    }
  }
  return found;
}
function brandExe(file) {
  const b = fs.readFileSync(file);
  const found = versionStrings(b);
  for (const [key, value] of Object.entries(BRAND)) {
    if (!found[key]) throw new Error(`${path.basename(file)}: no ${key} in its version resource`);
    for (const [at, len] of found[key]) {
      if (value.length > len) throw new Error(`${key}: "${value}" is longer than the ${len} characters there`);
      Buffer.from(value.padEnd(len, '\0'), 'utf16le').copy(b, at);
    }
  }
  // Read back what Windows will show before writing anything.
  for (const [key, value] of Object.entries(BRAND)) for (const [at] of found[key]) {
    const shown = b.toString('utf16le', at, at + value.length * 2 + 2).replace(/\0[\s\S]*$/, '');
    if (shown !== value) throw new Error(`${key} would read "${shown}"`);
  }
  fs.writeFileSync(file, b);
}

const ELECTRON_DIST = path.join(ROOT, 'host', 'node_modules', 'electron', 'dist');
const electronVersion = () => fs.readFileSync(path.join(ELECTRON_DIST, 'version'), 'utf8').trim();
const signedDefault = () => path.join(ROOT, 'dist', 'signed', electronVersion(), 'Pangmote.exe');

// The Windows program alone, as a package holds it before signing (sign.yml uploads it to be signed).
// -> { file, electron, sha256 }
function exeOnly(out) {
  if (process.platform !== 'win32') throw new Error('the Windows program is made on Windows (Electron for Windows is installed there)');
  const src = path.join(ELECTRON_DIST, 'electron.exe');
  if (!fs.existsSync(src)) throw new Error('Electron is not installed under host/node_modules (run setup first)');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'Pangmote.exe');
  fs.copyFileSync(src, file);
  brandExe(file);
  return { file, electron: electronVersion(), sha256: core.sha256(fs.readFileSync(file)) };
}

// Puts the signed program in place of the unsigned one just made at `exe`, when there is one. -> the signer, or ''
function takeSigned(exe, { signedFile, requireSigned, say }) {
  const file = signedFile || signedDefault();
  if (!fs.existsSync(file)) {
    if (requireSigned || signedFile) throw new Error(`no signed Pangmote.exe at ${file} (have .github/workflows/sign.yml sign Electron ${electronVersion()}, then fetch its artifact there)`);
    say(`Pangmote.exe is NOT signed (no ${path.relative(ROOT, file)}): Windows SmartScreen warns at its first start`);
    return '';
  }
  const r = signedExe.check(file, exe);
  if (!r.ok) throw new Error(`${file} is not this program signed: ${r.why}`);
  fs.copyFileSync(file, exe);
  say(`Pangmote.exe signed by ${r.signer}`);
  return r.signer;
}

function pack({ release = path.join(ROOT, 'dist', 'release'), out = path.join(ROOT, 'dist', 'pack'), archive = true, config, quiet = false, signedFile, requireSigned = false } = {}) {
  const say = (s) => { if (!quiet) console.log(s); };
  const confFile = config || path.join(ROOT, 'app', 'update-config.json'), conf = JSON.parse(fs.readFileSync(confFile, 'utf8'));
  const bundle = path.join(release, 'bundle'), check = core.verifyFolder(bundle, conf.keys);
  if (!check.ok) throw new Error(`${bundle} is not a release this app would trust: ${check.why}`);
  const version = check.manifest.version, shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  if (check.manifest.needsBase > shell.base) throw new Error(`the release needs shell ${check.manifest.needsBase}, app/package.json says ${shell.base}`);
  const dist = path.join(ROOT, 'host', 'node_modules', 'electron', 'dist');
  const win = process.platform === 'win32', exe = win ? 'electron.exe' : 'electron';
  if (!fs.existsSync(path.join(dist, exe))) throw new Error('Electron is not installed under host/node_modules (run setup first)');
  if (process.platform === 'darwin') throw new Error('macOS packages are not made yet (they must be signed on a Mac)');

  const OS = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform] || process.platform;
  const folder = 'Pangmote', name = `Pangmote-${OS}-${process.arch}`, dir = path.join(out, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  say(`copying Electron ${fs.readFileSync(path.join(dist, 'version'), 'utf8').trim()} ...`);
  // Every language's menu texts but Korean and English go (Chromium falls back to English): 35 MB less.
  fs.cpSync(dist, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !/[\\/]locales[\\/](?!ko\.pak$|en-US\.pak$)[^\\/]+$/.test(src) && !/[\\/]resources[\\/]default_app\.asar$/.test(src) });
  // Names without spaces and in ASCII only, here and for everything else the package holds or the app
  // makes (shortcuts, profile folders): a space or Korean in a path trips some tools and some systems.
  fs.renameSync(path.join(dir, exe), path.join(dir, win ? 'Pangmote.exe' : 'pangmote'));
  let signed = '';
  if (win) {
    brandExe(path.join(dir, 'Pangmote.exe'));
    signed = takeSigned(path.join(dir, 'Pangmote.exe'), { signedFile, requireSigned, say });
  }

  const app = path.join(dir, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['boot.js', 'core.js', 'updater.js', 'guard.js', 'icon.png', 'icon.ico']) if (fs.existsSync(path.join(ROOT, 'app', f))) fs.copyFileSync(path.join(ROOT, 'app', f), path.join(app, f));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ ...shell, version }, null, 2) + '\n');
  fs.writeFileSync(path.join(app, 'update-config.json'), JSON.stringify(conf, null, 2) + '\n');
  fs.cpSync(bundle, path.join(app, 'bundle'), { recursive: true });
  // koffi: its JavaScript and the one native binary this platform loads.
  const koffi = path.join(ROOT, 'host', 'node_modules', 'koffi'), triplet = `${process.platform}_${process.arch}`;
  const native = path.join(koffi, 'build', 'koffi', triplet);
  if (!fs.existsSync(native)) throw new Error(`koffi has no binary for ${triplet}`);
  for (const f of ['package.json', 'index.js', 'indirect.js', 'LICENSE.txt']) if (fs.existsSync(path.join(koffi, f))) { fs.mkdirSync(path.join(app, 'node_modules', 'koffi'), { recursive: true }); fs.copyFileSync(path.join(koffi, f), path.join(app, 'node_modules', 'koffi', f)); }
  fs.cpSync(native, path.join(app, 'node_modules', 'koffi', 'build', 'koffi', triplet), { recursive: true });
  const info = shellInfo({ shell, conf, electron: fs.readFileSync(path.join(dist, 'version'), 'utf8').trim(), koffi: JSON.parse(fs.readFileSync(path.join(koffi, 'package.json'), 'utf8')).version });
  fs.writeFileSync(path.join(app, 'shell.json'), JSON.stringify(info, null, 1) + '\n');
  if (!win) {
    fs.copyFileSync(path.join(ROOT, 'app', 'pangmote.sh'), path.join(dir, 'pangmote.sh'));
    fs.chmodSync(path.join(dir, 'pangmote.sh'), 0o755);
  }
  // On Windows the text starts with a byte order mark, so that every Notepad reads its Korean as UTF-8.
  fs.writeFileSync(path.join(dir, 'README.txt'), (win ? '\uFEFF' : '') + [
    `Pangmote ${version}`, '',
    win ? 'Pangmote.exe를 실행하면 시작 화면에서 "이 PC 공유"(호스트) 또는 "다른 PC에 접속"(클라이언트)을 고릅니다. 시작 메뉴에 Pangmote 바로가기를 만들 수 있습니다.'
      : './pangmote.sh 를 실행하면 (X11 세션) 시작 화면에서 "이 PC 공유"(호스트) 또는 "다른 PC에 접속"(클라이언트)을 고릅니다. 앱 메뉴에 Pangmote를 만들 수 있습니다.',
    '한글이나 띄어쓰기가 없는 경로에 풀어 두기를 권합니다 (예: ' + (win ? 'C:\\Pangmote' : '~/Pangmote') + ').',
    '이 폴더는 옮기지 말고 그대로 두세요(바로가기가 이 위치를 가리킵니다). 지우려면 이 폴더와 바로가기를 지우면 됩니다.',
    '새 버전은 앱이 알아서 확인하고 알려 줍니다.', '',
  ].join(win ? '\r\n' : '\n'));

  // Electron's own files come dated 1980-01-01 (its release zips carry no dates) and Windows keeps a copied
  // file's date, so the unpacked folder showed 1980 for most files (the user saw it, 2026-11-16): everything
  // the package holds is dated when the package was made.
  const now = new Date();
  const touch = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) touch(f);
      fs.utimesSync(f, now, now);
    }
  };
  touch(dir);
  fs.utimesSync(dir, now, now);

  let file = '';
  if (archive) {
    file = path.join(out, name + (win ? '.zip' : '.tar.gz'));
    fs.rmSync(file, { force: true });
    say(`packing ${path.basename(file)} ...`);
    // Windows' own tar (bsdtar) writes a zip when asked for one; on Linux gzip'd tar keeps the file modes.
    if (win) execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', file, '-C', out, folder], { stdio: 'inherit' });
    else execFileSync('tar', ['-czf', file, '-C', out, folder], { stdio: 'inherit' });
  }
  const sha256 = file ? core.sha256(fs.readFileSync(file)) : '';
  // The record release/build.js --sign-packages makes packages.json of (copy it next to the archive).
  let record = '';
  if (file) {
    record = path.join(out, name + '.package.json');
    fs.writeFileSync(record, JSON.stringify({ platform: shellswap.platformKey(), file: path.basename(file), sha256, size: fs.statSync(file).size, version, shell: info, ...(win ? { signed } : {}) }, null, 1) + '\n');
  }
  return { dir, file, version, name, sha256, shell: info, record, signed };
}

if (require.main === module) {
  try {
    if (arg('exe-only')) {
      const r = exeOnly(arg('exe-only'));
      console.log(`Pangmote.exe of Electron ${r.electron}, unsigned: ${r.file}, sha256 ${r.sha256}`);
      return;
    }
    const r = pack({ release: arg('release'), out: arg('out'), config: arg('config'), archive: !process.argv.includes('--no-archive'), signedFile: arg('signed-exe'), requireSigned: process.argv.includes('--require-signed') });
    console.log(`${r.name} ${r.version}: ${r.dir}`);
    if (r.file) console.log(`${path.basename(r.file)}: ${(fs.statSync(r.file).size / 1024 / 1024).toFixed(0)} MB, sha256 ${r.sha256}`);
    console.log(`shell ${shellswap.identityOf(r.shell)}${r.record ? '; record ' + path.basename(r.record) + ' (for release/build.js --sign-packages)' : ''}`);
  } catch (e) { console.error('packaging failed: ' + e.message); process.exit(1); }
}

module.exports = { pack, brandExe, exeOnly, shellInfo, SHELL_REV };
