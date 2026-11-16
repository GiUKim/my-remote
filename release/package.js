// Makes the installable app for the platform this runs on, from a release built by release/build.js:
//   node release/package.js [--release=dist/release] [--out=dist/pack] [--no-archive] [--config=<update-config.json>]
// -> dist/pack/MyRemote/                       the app: unpack anywhere and start it
//    dist/pack/MyRemote-Windows-x64.zip        (on Windows), MyRemote-Linux-x64.tar.gz (on Linux)
// The names carry no version: the download links point at "the latest release's MyRemote-Windows-x64.zip"
// (https://github.com/<owner>/<repo>/releases/latest/download/<name>), and the app updates itself, so a
// version in the folder's name would soon be the wrong one. The version is in the folder's read-me.
//
// The app is Electron as npm installed it for this platform (host/node_modules/electron/dist, the very
// program the self-test ran on; nothing else is downloaded), renamed, with resources/app holding the
// shell (app/), the modules the code needs from npm (koffi, with this platform's binary only), and the
// release's code as the built-in bundle. So a package is made on the platform it is for: Windows here,
// Linux on a Linux machine (file modes and links survive there), macOS on a Mac (where it must also be
// signed to run at all; not done).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../app/core');

const ROOT = path.join(__dirname, '..');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? path.resolve(a.slice(name.length + 3)) : undefined; };

// The name Windows shows for the program (the firewall's prompt says "Electron" by "GitHub, Inc.", so do
// Task Manager and a notification with no shortcut behind it; the person saw it on 2026-11-15): Electron's
// version resource, rewritten in place. Every value keeps its length in UTF-16 (a shorter one ends early
// with NULs, which every reader stops at), so nothing in the resource section moves and no outside tool
// touches the release. Only the .rsrc section is searched. The copyright of Electron stays as it is.
const BRAND = { FileDescription: 'MyRemote', ProductName: 'MyRemote', CompanyName: 'MyRemote', InternalName: 'MyRemote', OriginalFilename: 'MyRemote.exe' };
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

function pack({ release = path.join(ROOT, 'dist', 'release'), out = path.join(ROOT, 'dist', 'pack'), archive = true, config, quiet = false } = {}) {
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
  const folder = 'MyRemote', name = `MyRemote-${OS}-${process.arch}`, dir = path.join(out, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  say(`copying Electron ${fs.readFileSync(path.join(dist, 'version'), 'utf8').trim()} ...`);
  // Every language's menu texts but Korean and English go (Chromium falls back to English): 35 MB less.
  fs.cpSync(dist, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !/[\\/]locales[\\/](?!ko\.pak$|en-US\.pak$)[^\\/]+$/.test(src) && !/[\\/]resources[\\/]default_app\.asar$/.test(src) });
  // Names without spaces and in ASCII only, here and for everything else the package holds or the app
  // makes (shortcuts, profile folders): a space or Korean in a path trips some tools and some systems.
  fs.renameSync(path.join(dir, exe), path.join(dir, win ? 'MyRemote.exe' : 'my-remote'));
  if (win) brandExe(path.join(dir, 'MyRemote.exe'));

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
  if (!win) {
    fs.copyFileSync(path.join(ROOT, 'app', 'my-remote.sh'), path.join(dir, 'my-remote.sh'));
    fs.chmodSync(path.join(dir, 'my-remote.sh'), 0o755);
  }
  // On Windows the text starts with a byte order mark, so that every Notepad reads its Korean as UTF-8.
  fs.writeFileSync(path.join(dir, 'README.txt'), (win ? '\uFEFF' : '') + [
    `My Remote ${version}`, '',
    win ? 'MyRemote.exe를 실행하면 시작 화면에서 "이 PC 공유"(호스트) 또는 "다른 PC에 접속"(클라이언트)을 고릅니다. 시작 메뉴에 MyRemote 바로가기를 만들 수 있습니다.'
      : './my-remote.sh 를 실행하면 (X11 세션) 시작 화면에서 "이 PC 공유"(호스트) 또는 "다른 PC에 접속"(클라이언트)을 고릅니다. 앱 메뉴에 My Remote를 만들 수 있습니다.',
    '한글이나 띄어쓰기가 없는 경로에 풀어 두기를 권합니다 (예: ' + (win ? 'C:\\MyRemote' : '~/MyRemote') + ').',
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
  return { dir, file, version, name, sha256: file ? core.sha256(fs.readFileSync(file)) : '' };
}

if (require.main === module) {
  try {
    const r = pack({ release: arg('release'), out: arg('out'), config: arg('config'), archive: !process.argv.includes('--no-archive') });
    console.log(`${r.name} ${r.version}: ${r.dir}`);
    if (r.file) console.log(`${path.basename(r.file)}: ${(fs.statSync(r.file).size / 1024 / 1024).toFixed(0)} MB, sha256 ${r.sha256}`);
  } catch (e) { console.error('packaging failed: ' + e.message); process.exit(1); }
}

module.exports = { pack, brandExe };
