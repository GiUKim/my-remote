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
  mbpsPer1080p: 10,     // bitrate for a 1080p-sized picture; scales with the pixels actually sent
  maxTotalMbps: 60,     // cap across all monitors being viewed
  maxFps: 60,
  audio: true,          // send system sound
  clipboard: true,      // two-way text clipboard
  hideHostCursor: true, // while connected, hide the cursor on this PC so the video has no trailing cursor
};
const CLIP_MAX = 60000;

let win = null, tray = null, quitting = false;
let cursorsHidden = false;
const cursorMark = () => path.join(app.getPath('userData'), 'cursor-hidden');
const cursorCache = new Map(); // handle -> { img, hx, hy } | null

function setCursorsHidden(on) {
  if (on === cursorsHidden) return;
  if (on) {
    // If this process dies without restoring, the guard process puts the cursors back.
    try {
      const { spawn } = require('child_process');
      spawn(process.execPath, [path.join(__dirname, 'cursor-guard.js'), String(process.pid)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { console.error('cursor guard', e); }
    try { fs.writeFileSync(cursorMark(), String(process.pid)); } catch {}
    input.hideCursors();
  } else {
    input.restoreCursors();
    try { fs.unlinkSync(cursorMark()); } catch {}
  }
  cursorsHidden = on;
}
function currentCursor() {
  const st = input.cursorState();
  if (st.name) return { k: st.key, c: st.name };
  if (!cursorCache.has(st.key)) {
    let entry = null;
    try {
      const b = input.cursorBitmap(st.handle);
      if (b) entry = { img: nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL(), hx: b.hx, hy: b.hy };
    } catch (e) { console.error('cursor bitmap', e); }
    if (cursorCache.size > 300) cursorCache.clear();
    cursorCache.set(st.key, entry);
  }
  const e = cursorCache.get(st.key);
  return e ? { k: st.key, img: e.img, hx: e.hx, hy: e.hy } : { k: st.key, c: 'default' };
}
let cfg = null;
let savedCfg = {}; // only what the user set; defaults are not frozen into the file

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
  savedCfg = { ...saved };
  delete savedCfg.keyEnc;
  let key = null;
  if (saved.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { key = safeStorage.decryptString(Buffer.from(saved.keyEnc, 'base64')); } catch {}
  }
  if (!key) { key = newKey(); saveConfig(key); }
  cfg.key = key;
}
function saveConfig(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS 암호화 저장소(DPAPI)를 사용할 수 없습니다');
  const out = { ...savedCfg, keyEnc: safeStorage.encryptString(key).toString('base64') }; // DPAPI: only this Windows user can decrypt
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(out, null, 2));
}

const builder = require('./build-client');
const buildClientHtml = (preset = '') => builder.build(cfg.server, preset);       // the full client page
const buildLoaderHtml = (preset = '') => builder.buildLoader(cfg.server, preset); // the small file a client PC keeps
// The client page this host serves to loaders. Built once, so it always matches the code this host is running.
let clientApp = null;
function getClientApp() {
  if (!clientApp) {
    const html = buildClientHtml();
    clientApp = { html, hash: crypto.createHash('sha256').update(html).digest('hex').slice(0, 20) };
  }
  return clientApp;
}

async function getSources() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const primaryId = screen.getPrimaryDisplay().id;
  const rects = [], out = [];
  displays.forEach((d, i) => {
    const src = srcs.find((s) => s.display_id === String(d.id)) || (srcs.length === displays.length ? srcs[i] : null);
    if (!src) return;
    const r = screen.dipToScreenRect(null, d.bounds); // physical pixels
    out.push({ id: src.id, idx: rects.length, x: r.x, y: r.y, width: r.width, height: r.height, primary: d.id === primaryId });
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

// A running host keeps the code it started with. Launching it again while it is
// running only reaches the old process, so compare the code on disk with what
// was loaded and restart when it changed (e.g. after an update).
function codeStamp() {
  let latest = 0;
  try {
    for (const f of fs.readdirSync(__dirname)) if (/\.(js|html|json)$/.test(f)) latest = Math.max(latest, fs.statSync(path.join(__dirname, f)).mtimeMs);
  } catch {}
  return latest;
}
const startedStamp = codeStamp();
function restart() { quitting = true; app.relaunch(); app.quit(); }

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
    { label: '다시 시작 (업데이트 적용)', click: restart },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

if (!ISOLATED && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (codeStamp() !== startedStamp) restart(); else showWindow(); });
  app.on('before-quit', () => { quitting = true; input.reset(); setCursorsHidden(false); });
  process.on('exit', () => { if (cursorsHidden) input.restoreCursors(); });
  app.whenReady().then(async () => {
    loadConfig();
    if (ISOLATED) cfg.hideHostCursor = false; // local trials share this PC's cursor with the person using it
    // A previous run that crashed while connected may have left the cursors hidden.
    if (fs.existsSync(cursorMark())) { input.restoreCursors(); try { fs.unlinkSync(cursorMark()); } catch {} }
    let selftest = null;
    if (ISOLATED) {
      selftest = require('./selftest');
      cfg.server = await selftest.startRelay();
      cfg.iceServers = [];
    }
    powerSaveBlocker.start('prevent-app-suspension');

    ipcMain.handle('cfg', () => cfg);
    ipcMain.handle('sources', getSources);
    ipcMain.handle('client-app', getClientApp);
    ipcMain.on('input', (_e, text) => { try { input.handle(String(text)); } catch (e) { console.error('input', e); } });
    ipcMain.on('log', (_e, text) => console.log('[host]', text));
    ipcMain.handle('cursor', () => { try { return currentCursor(); } catch { return { k: '0', c: 'default' }; } });
    ipcMain.handle('cursor-hide', (_e, on) => { try { setCursorsHidden(!!on && !!cfg.hideHostCursor); } catch (e) { console.error('cursor hide', e); } return cursorsHidden; });
    // Only touch the clipboard when its content actually changed.
    ipcMain.handle('clip-read', (_e, lastSeq) => {
      if (!cfg.clipboard) return { seq: 0 };
      const seq = input.clipSeq();
      return seq === lastSeq ? { seq } : { seq, text: clipboard.readText() };
    });
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
      fs.writeFileSync(r.filePath, buildLoaderHtml());
      return r.filePath;
    });

    createWindow();
    // Monitor plugged/unplugged or resolution changed: the renderer renegotiates the session.
    let displayTimer = null;
    const displaysChanged = () => {
      clearTimeout(displayTimer);
      displayTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('displays-changed'); }, 1500);
    };
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', (_e, _d, changed) => { if (changed.some((c) => c !== 'workArea')) displaysChanged(); });
    if (!ISOLATED) createTray();
    if (SELFTEST) selftest.run({ cfg, buildClientHtml, buildLoaderHtml, app });
    if (LOCALTEST) {
      const file = path.join(app.getPath('userData'), 'my-remote-localtest.html');
      fs.writeFileSync(file, buildLoaderHtml('k=' + cfg.key + '&auto&ro'));
      setTimeout(() => shell.openPath(file), 2500); // after the host has subscribed
    }
  });
}
