const { app, shell, BrowserWindow, ipcMain, desktopCapturer, screen, safeStorage, dialog, powerSaveBlocker, clipboard, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const input = require('./input');

const SELFTEST = process.argv.includes('--selftest');
// --localtest: try it on this PC only. Host + view-only client in your browser,
// local relay, no STUN, throwaway key. Nothing is sent to the internet.
const LOCALTEST = process.argv.includes('--localtest');
const ISOLATED = SELFTEST || LOCALTEST;
const DEFAULTS = {
  server: 'https://ntfy.sh',
  // Add a TURN entry here if direct P2P is blocked, e.g.
  // { "urls": "turn:host:3478", "username": "...", "credential": "..." }
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  codec: 'H264',        // H264 | AV1 | VP9 | VP8
  maxBitrateMbps: 15,   // per monitor
  maxFps: 60,
  audio: true,          // send system sound
  clipboard: true,      // two-way text clipboard
};
const CLIP_MAX = 60000;

let win = null, tray = null, quitting = false;
let cfg = null;

if (ISOLATED) {
  // Fully local: private profile dir, local relay, no STUN. Nothing leaves this PC.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-local-')));
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function newKey() { return crypto.randomBytes(32).toString('base64url'); }

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch {}
  cfg = { ...DEFAULTS, ...saved };
  delete cfg.keyEnc;
  let key = null;
  if (saved.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { key = safeStorage.decryptString(Buffer.from(saved.keyEnc, 'base64')); } catch {}
  }
  if (!key) { key = newKey(); saveConfig(key); }
  cfg.key = key;
}
function saveConfig(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 암호화 저장소(DPAPI)를 사용할 수 없습니다');
  const out = { ...cfg, keyEnc: safeStorage.encryptString(key).toString('base64') }; // DPAPI: only this Windows user can decrypt
  delete out.key;
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(out, null, 2));
}

const buildClientHtml = (preset = '') => require('./build-client').build(cfg.server, preset);

async function getSources() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primaryId = screen.getPrimaryDisplay().id;
  const rects = [], out = [];
  displays.forEach((d, i) => {
    const src = srcs.find((s) => s.display_id === String(d.id)) || (srcs.length === displays.length ? srcs[i] : null);
    if (!src) return;
    const r = screen.dipToScreenRect(null, d.bounds); // physical pixels
    out.push({ id: src.id, idx: rects.length, width: r.width, height: r.height, primary: d.id === primaryId });
    rects.push(r);
  });
  input.setMonitors(rects);
  return out;
}

function icon(live) {
  // 16x16 BGRA: rounded square, blue when idle, red while someone is connected.
  const n = 16, buf = Buffer.alloc(n * n * 4);
  const [b, g, r] = live ? [0x5d, 0x5d, 0xff] : [0xff, 0x6c, 0x2b];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const corner = (x < 2 || x > 13) && (y < 2 || y > 13);
    const screenArea = x >= 3 && x <= 12 && y >= 4 && y <= 10;
    const o = (y * n + x) * 4;
    if (corner) continue;
    buf[o] = screenArea ? 255 : b; buf[o + 1] = screenArea ? 255 : g; buf[o + 2] = screenArea ? 255 : r; buf[o + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}
function showWindow() { if (win) { win.show(); win.focus(); } }

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 680, title: 'My Remote Host', autoHideMenuBar: true, show: !SELFTEST, icon: icon(false),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile('host.html');
  // Closing the window keeps the host running in the tray; quit from the tray menu.
  win.on('close', (e) => { if (!quitting && !ISOLATED) { e.preventDefault(); win.hide(); } });
}
function createTray() {
  tray = new Tray(icon(false));
  tray.setToolTip('My Remote Host — 대기 중');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showWindow },
    { label: '원격 연결 끊기', click: () => win && win.webContents.send('kick') },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

if (!ISOLATED && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; input.reset(); });
  app.whenReady().then(async () => {
    loadConfig();
    let selftest = null;
    if (ISOLATED) {
      selftest = require('./selftest');
      cfg.server = await selftest.startRelay();
      cfg.iceServers = [];
    }
    powerSaveBlocker.start('prevent-app-suspension');

    ipcMain.handle('cfg', () => cfg);
    ipcMain.handle('sources', getSources);
    ipcMain.on('input', (_e, text) => { try { input.handle(String(text)); } catch (e) { console.error('input', e); } });
    ipcMain.on('log', (_e, text) => console.log('[host]', text));
    ipcMain.handle('cursor', () => { try { return input.cursorName(); } catch { return 'default'; } });
    ipcMain.handle('clip-read', () => (cfg.clipboard ? clipboard.readText() : ''));
    ipcMain.on('clip-write', (_e, text) => { if (cfg.clipboard && typeof text === 'string' && text.length <= CLIP_MAX) clipboard.writeText(text); });
    ipcMain.on('session', (_e, live) => {
      if (tray) { tray.setImage(icon(!!live)); tray.setToolTip('My Remote Host — ' + (live ? '원격 접속 중' : '대기 중')); }
      if (live && !SELFTEST && Notification.isSupported()) new Notification({ title: 'My Remote Host', body: '원격 접속이 시작되었습니다.' }).show();
    });
    ipcMain.handle('copy-key', () => { clipboard.writeText(cfg.key); return true; });
    ipcMain.handle('regen-key', async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['취소', '새 키 발급'], defaultId: 0, cancelId: 0,
        message: '접속 키를 새로 발급할까요?', detail: '기존 키로는 더 이상 접속할 수 없게 됩니다.',
      });
      if (r.response !== 1) return false;
      cfg.key = newKey();
      saveConfig(cfg.key);
      win.reload();
      return true;
    });
    ipcMain.handle('export-client', async () => {
      if (ISOLATED) return null;
      const r = await dialog.showSaveDialog(win, { defaultPath: 'my-remote-client.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (r.canceled || !r.filePath) return null;
      fs.writeFileSync(r.filePath, buildClientHtml());
      return r.filePath;
    });

    createWindow();
    if (!ISOLATED) createTray();
    if (SELFTEST) selftest.run({ cfg, buildClientHtml, app });
    if (LOCALTEST) {
      const file = path.join(app.getPath('userData'), 'my-remote-localtest.html');
      fs.writeFileSync(file, buildClientHtml('k=' + cfg.key + '&auto&ro'));
      setTimeout(() => shell.openPath(file), 2500); // after the host has subscribed
    }
  });
}
