// The pictures Google Play's store listing wants, drawn from the app's own pages and art (2026-11-27):
//   icon-512.png         the app icon: the launcher's adaptive icon on its full square (Play rounds the corners itself,
//                        as Android Studio's Image Asset tool exports it)
//   feature-ko.jpg/en    the feature graphic, 1024x500, no transparency
//   list-ko.jpg/en       a screenshot of the app's list of PCs (assets/web/home.html with made-up PCs), framed 1920x1080
// and frames screenshots taken on a phone with a caption: Play wants each side within twice the other, and a Galaxy Z
// Flip's 2640x1080 is not.
//   node android/play/art.js                                   -> android/play/art/
//   node android/play/art.js frame <in.png> <out.jpg> "<caption>" ["<smaller line>"]
// Runs itself in the Electron of host/node_modules in offscreen windows: nothing is shown, nothing leaves the PC.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'art');

if (!process.versions.electron) {
  const exe = path.join(ROOT, 'host', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = require('child_process').spawnSync(exe, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', timeout: 5 * 60e3 });
  process.exit(r.status == null ? 1 : r.status);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(os.tmpdir(), 'pangmote-play-art'));

const FONT = `'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif`;
const BG = 'linear-gradient(135deg, #1b2029 0%, #0e1116 100%)';
// The launcher icon (res/drawable/ic_launcher_fg.xml on res/values/colors.xml's ic_launcher_bg), the same paths.
const MONITOR = ['M34.9,34.9h38.2a3.4,3.4 0 0 1 3.4,3.4v23.6a3.4,3.4 0 0 1 -3.4,3.4h-38.2a3.4,3.4 0 0 1 -3.4,-3.4v-23.6a3.4,3.4 0 0 1 3.4,-3.4z', 'M48.4,65.3h11.2v5.6h-11.2z', 'M42.8,70.9h22.5a2.3,2.3 0 0 1 0,4.5h-22.5a2.3,2.3 0 0 1 0,-4.5z'];
const icon = (size, round) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108"><rect width="108" height="108" rx="${round ? 24 : 0}" fill="#2B6CFF"/>${MONITOR.map((d) => `<path fill="#fff" d="${d}"/>`).join('')}</svg>`;

const TEXT = {
  ko: {
    tagline: '휴대폰으로 내 PC를,<br>그 앞에 앉은 것처럼', points: '무료 · P2P 직접 연결 · 종단간 암호화',
    list: 'QR 한 번이면<br>내 PC가 목록에', listSub: '다음부터는 누르기만 하면 접속합니다',
    pcs: [['사무실 PC', 'windows', 'Windows 11', 2 * 60e3], ['집 PC', 'linux', 'Ubuntu 24.04 LTS', 26 * 3600e3], ['작업실 노트북', 'windows', 'Windows 10', 3 * 86400e3]],
  },
  en: {
    tagline: 'Your PC from your phone,<br>as if you sat at it', points: 'Free · Direct P2P · End-to-end encrypted',
    list: 'Scan once,<br>your PC stays on the list', listSub: 'From then on, one tap connects',
    pcs: [['Office PC', 'windows', 'Windows 11', 2 * 60e3], ['Home PC', 'linux', 'Ubuntu 24.04 LTS', 26 * 3600e3], ['Studio laptop', 'windows', 'Windows 10', 3 * 86400e3]],
  },
};

// The phone of docs/img/feat-phone.svg without its panel: the host's screen with a tap and two fingers.
function phoneArt() {
  const svg = fs.readFileSync(path.join(ROOT, 'docs', 'img', 'feat-phone.svg'), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<\/title>/, '').replace(/<rect width="420" height="260"[^>]*\/>/, '').replace(/<rect x="1" y="1" width="418"[^>]*\/>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="44 30 332 200" width="560" height="337">${inner}</svg>`;
}

// The app's list page as the app shows it, with the bridge (MainActivity.HomeBridge) played by made-up answers.
function homePage(lang) {
  const file = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', lang === 'ko' ? 'values-ko' : 'values', 'strings.xml');
  const res = {};
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) res[m[1]] = m[2].replace(/\\(["'])/g, '$1');
  const keys = { empty: 'home_empty', how: 'home_how', scan: 'home_scan', key: 'home_key', last: 'home_last', never: 'home_never', rename: 'home_rename', remove: 'home_remove', removeQ: 'home_remove_q', ok: 'ok', cancel: 'cancel', licenses: 'licenses' };
  const strings = Object.fromEntries(Object.entries(keys).map(([k, r]) => [k, res[r]]));
  const version = (/versionName = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8')) || [])[1] || '';
  const now = Date.now();
  const list = TEXT[lang].pcs.map(([name, osId, osName, ago], i) => ({ id: 'pc' + i, name, os: osId, osName, lastAt: now - ago }));
  const stub = `<script>window.mrApp = { strings: () => ${JSON.stringify(JSON.stringify(strings))}, lang: () => '${lang}', version: () => '${version}', list: () => ${JSON.stringify(JSON.stringify(list))}, scan() {}, withKey() {}, open() {}, rename() {}, remove() {} };</script>`;
  return fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'web', 'home.html'), 'utf8').replace('<body>', '<body>' + stub);
}

// A phone (portrait) beside the caption, or a landscape picture under it: 1920x1080, as Play shows screenshots in a row.
function framed({ caption, sub, phoneHtml, image, imageW, imageH }) {
  const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const cap = (s) => esc(s).replace(/&lt;br&gt;/g, '<br>');
  const head = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1920px;height:1080px;overflow:hidden;background:${BG};font-family:${FONT};color:#e6e8eb;word-break:keep-all">`;
  if (phoneHtml || imageH > imageW) {
    const W = 412, H = 1000, k = 0.9;
    const screen = phoneHtml
      ? `<iframe srcdoc="${phoneHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="width:${W}px;height:${H}px;border:0;transform:scale(${k});transform-origin:0 0"></iframe>`
      : `<img src="${image}" style="width:${W * k}px;height:${H * k}px;object-fit:cover">`;
    return `${head}<div style="position:absolute;left:150px;top:0;bottom:0;width:980px;display:flex;flex-direction:column;justify-content:center"><div style="font-size:84px;font-weight:700;line-height:1.25">${cap(caption)}</div><div style="margin-top:34px;font-size:40px;color:#aeb9c6">${esc(sub)}</div></div>`
      + `<div style="position:absolute;left:1300px;top:${(1080 - H * k - 28) / 2}px;width:${W * k}px;height:${H * k}px;padding:14px;background:#07080a;border:3px solid #3a4350;border-radius:52px;overflow:hidden"><div style="width:${W * k}px;height:${H * k}px;border-radius:40px;overflow:hidden;background:#14171c">${screen}</div></div></body>`;
  }
  const maxW = 1760, maxH = 790, f = Math.min(maxW / imageW, maxH / imageH), w = Math.round(imageW * f), h = Math.round(imageH * f);
  return `${head}<div style="position:absolute;left:0;right:0;top:56px;text-align:center;font-size:64px;font-weight:700">${cap(caption)}</div>`
    + (sub ? `<div style="position:absolute;left:0;right:0;top:150px;text-align:center;font-size:34px;color:#aeb9c6">${esc(sub)}</div>` : '')
    + `<img src="${image}" style="position:absolute;left:${(1920 - w) / 2}px;top:${(sub ? 230 : 190) + (maxH - h) / 2}px;width:${w}px;height:${h}px;border-radius:28px;border:3px solid #3a4350;box-sizing:content-box"></body>`;
}

let win = null, shots = 0;
async function shoot(html, w, h, out) {
  const tmp = path.join(app.getPath('userData'), `page-${++shots}.html`);
  fs.writeFileSync(tmp, html);
  if (!win) win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true } });
  win.setContentSize(w, h);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 1200));
  const img = (await win.webContents.capturePage()).resize({ width: w, height: h });
  fs.writeFileSync(out, /\.jpe?g$/i.test(out) ? img.toJPEG(92) : img.toPNG());
  console.log(`${path.relative(process.cwd(), out)}: ${w}x${h}`);
}

app.whenReady().then(async () => {
  try {
    const args = process.argv.slice(2); // electron <this file> <args>

    if (args[0] === 'frame') {
      const [, input, out, caption, sub] = args;
      const { nativeImage } = require('electron');
      const size = nativeImage.createFromPath(path.resolve(input)).getSize();
      if (!size.width) throw new Error(`not a picture: ${input}`);
      await shoot(framed({ caption, sub, image: 'file:///' + path.resolve(input).replace(/\\/g, '/'), imageW: size.width, imageH: size.height }), 1920, 1080, path.resolve(out));
    } else {
      fs.mkdirSync(OUT, { recursive: true });
      await shoot(`<!doctype html><body style="margin:0;overflow:hidden">${icon(512).replace('<svg ', '<svg style="display:block" ')}</body>`, 512, 512, path.join(OUT, 'icon-512.png'));
      for (const lang of ['ko', 'en']) {
        const t = TEXT[lang];
        await shoot(`<!doctype html><meta charset="utf-8"><body style="margin:0;width:1024px;height:500px;overflow:hidden;background:${BG};font-family:${FONT};color:#e6e8eb;word-break:keep-all">`
          + `<div style="position:absolute;left:60px;top:0;bottom:0;width:440px;display:flex;flex-direction:column;justify-content:center"><div style="display:flex;align-items:center;gap:18px">${icon(76, true)}<span style="font-size:52px;font-weight:700">Pangmote</span></div>`
          + `<div style="margin-top:28px;font-size:32px;font-weight:600;line-height:1.35">${t.tagline}</div><div style="margin-top:16px;font-size:20px;color:#aeb9c6">${t.points}</div></div>`
          + `<div style="position:absolute;right:-6px;top:82px">${phoneArt()}</div></body>`, 1024, 500, path.join(OUT, `feature-${lang}.jpg`));
        await shoot(framed({ caption: t.list, sub: t.listSub, phoneHtml: homePage(lang) }), 1920, 1080, path.join(OUT, `list-${lang}.jpg`));
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('art: ' + ((e && e.stack) || e));
    app.exit(1);
  }
});
