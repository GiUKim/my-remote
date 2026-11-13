// Makes the installable app for the platform this runs on, from a release built by release/build.js:
//   node release/package.js [--release=dist/release] [--out=dist/pack] [--no-archive] [--config=<update-config.json>]
// -> dist/pack/MyRemote-<version>-<platform>-<arch>/   the app: unpack anywhere and start it
//    dist/pack/MyRemote-<version>-<platform>-<arch>.zip (Windows) or .tar.gz (Linux)
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

  const name = `MyRemote-${version}-${process.platform}-${process.arch}`, dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  say(`copying Electron ${fs.readFileSync(path.join(dist, 'version'), 'utf8').trim()} ...`);
  // Every language's menu texts but Korean and English go (Chromium falls back to English): 35 MB less.
  fs.cpSync(dist, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !/[\\/]locales[\\/](?!ko\.pak$|en-US\.pak$)[^\\/]+$/.test(src) && !/[\\/]resources[\\/]default_app\.asar$/.test(src) });
  fs.renameSync(path.join(dir, exe), path.join(dir, win ? 'My Remote.exe' : 'my-remote'));

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
  fs.writeFileSync(path.join(dir, win ? '읽어 보세요.txt' : 'README.txt'), [
    `My Remote ${version}`, '',
    win ? '"My Remote.exe"를 실행하세요. 처음에 호스트/클라이언트를 고르고, 시작 메뉴에 바로가기를 만들 수 있습니다.'
      : './my-remote.sh 를 실행하세요 (X11 세션). 처음에 호스트/클라이언트를 고르고, 앱 메뉴에 바로가기를 만들 수 있습니다.',
    '이 폴더는 옮기지 말고 그대로 두세요(바로가기가 이 위치를 가리킵니다). 지우려면 이 폴더와 바로가기를 지우면 됩니다.',
    '새 버전은 앱이 알아서 확인하고 알려 줍니다.', '',
  ].join(win ? '\r\n' : '\n'));

  let file = '';
  if (archive) {
    file = path.join(out, name + (win ? '.zip' : '.tar.gz'));
    fs.rmSync(file, { force: true });
    say(`packing ${path.basename(file)} ...`);
    // Windows' own tar (bsdtar) writes a zip when asked for one; on Linux gzip'd tar keeps the file modes.
    if (win) execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', file, '-C', out, name], { stdio: 'inherit' });
    else execFileSync('tar', ['-czf', file, '-C', out, name], { stdio: 'inherit' });
  }
  return { dir, file, version, name, sha256: file ? core.sha256(fs.readFileSync(file)) : '' };
}

if (require.main === module) {
  try {
    const r = pack({ release: arg('release'), out: arg('out'), config: arg('config'), archive: !process.argv.includes('--no-archive') });
    console.log(`${r.name}: ${r.dir}`);
    if (r.file) console.log(`${path.basename(r.file)}: ${(fs.statSync(r.file).size / 1024 / 1024).toFixed(0)} MB, sha256 ${r.sha256}`);
  } catch (e) { console.error('packaging failed: ' + e.message); process.exit(1); }
}

module.exports = { pack };
