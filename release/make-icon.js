// Draws the app's icon files from host/icon.svg, with Electron itself (nothing else is needed):
//   <electron> release/make-icon.js
// -> app/icon.png (256 px: the Linux app menu, window icons) and app/icon.ico (16, 32, 48 and 256 px,
// each a PNG inside the .ico container: the Windows shortcuts). Run again when the drawing changes,
// and commit the two files.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mr-icon-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'host', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;background:transparent;overflow:hidden"><img id="i" style="display:block;width:256px;height:256px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`));
  await win.webContents.executeJavaScript('document.getElementById("i").decode().then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
  await new Promise((r) => setTimeout(r, 300));
  const big = (await win.webContents.capturePage()).resize({ width: 256, height: 256, quality: 'best' });
  const pngs = [16, 32, 48, 256].map((n) => [n, (n === 256 ? big : big.resize({ width: n, height: n, quality: 'best' })).toPNG()]);
  fs.writeFileSync(path.join(__dirname, '..', 'app', 'icon.png'), pngs[3][1]);
  // ICONDIR, one ICONDIRENTRY per picture, then the pictures (PNG data as it is).
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let at = head.length;
  pngs.forEach(([n, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(n === 256 ? 0 : n, e); head.writeUInt8(n === 256 ? 0 : n, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(at, e + 12);
    at += png.length;
  });
  fs.writeFileSync(path.join(__dirname, '..', 'app', 'icon.ico'), Buffer.concat([head, ...pngs.map((p) => p[1])]));
  console.log(`icon.png ${pngs[3][1].length} bytes, icon.ico ${at} bytes`);
  app.exit(0);
});
