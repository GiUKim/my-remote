const { app, shell, BrowserWindow, ipcMain, desktopCapturer, screen, safeStorage, dialog, powerSaveBlocker, clipboard, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const input = require('./input');

// The native capturer waits for each monitor's next image on a worker thread of the host page's
// process; the default of four threads would be used up by three monitors. (Inherited by that process.)
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '12';

const SELFTEST = process.argv.includes('--selftest');
// --localtest: try it on this PC only. Host + view-only client in your browser,
// local relay, no STUN, throwaway key. Nothing is sent to the internet.
const LOCALTEST = process.argv.includes('--localtest');
// --bench --bench-config=<file>: measure smoothness and delay on this PC only (see bench.js).
const BENCH = process.argv.includes('--bench');
const benchCfg = (() => {
  if (!BENCH) return null;
  const arg = process.argv.find((a) => a.startsWith('--bench-config='));
  return arg ? JSON.parse(fs.readFileSync(arg.slice('--bench-config='.length), 'utf8')) : {};
})();
const ISOLATED = SELFTEST || LOCALTEST || BENCH;

// Settings of the browser engine's video transport ("field trials"). The engine's defaults for
// screen content suit slide sharing, not working on a remote PC; these were chosen by measuring
// with the bench (bench.js) and each one is visible there when it is taken out again.
//  - ProbingScreenshareBwe 1.5,250: by default screen video is sent at exactly the estimated
//    bandwidth and up to 2.9 s of it may wait in the send queue, so one scroll puts the picture
//    seconds behind. Sending at up to 1.5x with at most 250 ms queued keeps it interactive.
//  - ForceSendPlayoutDelay 0/0: asks the receiver to show every frame as soon as it is decoded
//    instead of holding it in a buffer.
//  - Bwe-ProbingConfiguration alr_interval:1s: after a quiet moment the bandwidth estimate is
//    probed again within a second (default: five), so it has recovered before the next scroll.
const ENGINE_TRIALS = 'WebRTC-ProbingScreenshareBwe/1.5,250,80,40,-60,3/WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/WebRTC-Bwe-ProbingConfiguration/alr_interval:1s/';
{
  // A bench run may replace them ("" = the engine's own defaults) to compare.
  const trials = benchCfg && typeof benchCfg.trials === 'string' ? benchCfg.trials : ENGINE_TRIALS;
  if (trials) app.commandLine.appendSwitch('force-fieldtrials', trials);
}
const DEFAULTS = {
  server: 'https://ntfy.sh',
  // Add a TURN entry here if direct P2P is blocked, e.g.
  // { "urls": "turn:host:3478", "username": "...", "credential": "..." }
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  codec: 'auto',        // auto | AV1 | H264 | VP9 | VP8  (auto: AV1 on a PC with 8+ logical processors, else H264)
  mbpsPer1080p: 10,     // bitrate for a 1080p-sized picture; scales with the pixels actually sent
  maxTotalMbps: 60,     // cap across all monitors being viewed
  startBitrateMbps: 8,  // where the bandwidth estimate starts (it adapts from there)
  minBitrateMbps: 1,    // it never goes below this
  maxFps: 60,
  capture: 'auto',      // auto: the native capturer (native/capture.cpp) when its DLL is there, else the browser engine's | engine: always the engine's
  captureGap: 8,        // ms the native capturer rests after each image. Without a rest it has every image at once, but reading
                        // the screen back that often made the host's own screen stutter under full-screen motion (measured)
  refine: true,         // true: send a still screen until it is fully sharp (AV1 only; adds about 15 ms of delay) | 'always': no added delay, but a still screen is sent continuously | false
  audio: true,          // send system sound
  clipboard: true,      // two-way text clipboard
  hideHostCursor: true, // while connected, hide the cursor on this PC so the video has no trailing cursor
};
const CLIP_MAX = 60000;

let win = null, tray = null, quitting = false;
let cursorsHidden = false;
const cursorMark = () => path.join(app.getPath('userData'), 'cursor-hidden');
const cursorCache = new Map(); // handle -> { img, hx, hy } | null

let cursorGuard = null;
function setCursorsHidden(on) {
  if (on === cursorsHidden) return;
  if (on) {
    // If this process dies without restoring, the guard process puts the cursors back.
    // One guard serves every session; it lives until this process ends.
    try {
      if (!cursorGuard || cursorGuard.exitCode !== null) {
        const { spawn } = require('child_process');
        cursorGuard = spawn(process.execPath, [path.join(__dirname, 'cursor-guard.js'), String(process.pid)],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true });
        cursorGuard.unref();
      }
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
// Something dragged out of the remote picture and let go over the client PC. The drag is ended
// here without a drop (Escape), what was being dragged is still selected and gets copied
// (Ctrl+C), and the result is handed over: text, or the names and sizes of files the client may
// then fetch. Only files that this very step found on the clipboard can be fetched.
const DRAG_MAX_BYTES = 2 * 1024 * 1024 * 1024, DRAG_MAX_FILES = 200;
const dragFiles = new Map(); // id -> { path, size, fd }
function offerFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  const id = crypto.randomBytes(8).toString('hex');
  dragFiles.set(id, { path: file, size: st.size, fd: null });
  return { id, name: path.basename(file), size: st.size };
}
function closeDragFiles(id) {
  for (const [k, f] of [...dragFiles]) if (id == null || k === id) { try { if (f.fd != null) fs.closeSync(f.fd); } catch {} dragFiles.delete(k); }
}
async function dragOut(button) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cls = input.captureClass();
  if (cls !== 'CLIPBRDWNDCLASS') { input.buttonUp(button); return { kind: 'none', why: 'no drag in progress' + (cls ? ' (mouse held by ' + cls + ')' : '') }; }
  const before = input.clipSeq();
  input.tap(['Escape']);
  await sleep(90);
  input.tap(['ControlLeft', 'KeyC']);
  let changed = false;
  for (let i = 0; i < 40 && !changed; i++) { await sleep(25); changed = input.clipSeq() !== before; }
  input.buttonUp(button);
  if (!changed) return { kind: 'none', why: 'nothing was copied' };
  await sleep(80); // the program may still be adding formats
  const paths = input.clipboardFiles();
  if (paths.length) {
    closeDragFiles();
    const files = [];
    let skipped = 0, total = 0;
    for (const f of paths) {
      let o = null;
      try { o = files.length < DRAG_MAX_FILES ? offerFile(f) : null; } catch {}
      if (o && total + o.size <= DRAG_MAX_BYTES) { files.push(o); total += o.size; } else { skipped++; if (o) dragFiles.delete(o.id); }
    }
    return files.length ? { kind: 'files', files, skipped } : { kind: 'none', why: 'only folders, or more than 2 GB' };
  }
  const text = clipboard.readText();
  return text ? { kind: 'text', s: text.slice(0, CLIP_MAX), cut: text.length > CLIP_MAX } : { kind: 'none', why: 'neither text nor files' };
}
let cfg = null;
let savedCfg = {}; // only what the user set; defaults are not frozen into the file

if (ISOLATED) {
  // Fully local: private profile dir, local relay, no STUN. Nothing leaves this PC.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-local-')));
  app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', ...((benchCfg && benchCfg.disableFeatures) || [])].join(','));
  // A bench run can try other engine switches before they are made the default.
  if (benchCfg) for (const [k, v] of Object.entries(benchCfg.switches || {})) app.commandLine.appendSwitch(k, String(v));
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
  const color = input.displayColor(); // which displays Windows has in HDR mode (they are captured too bright)
  displays.forEach((d, i) => {
    const src = srcs.find((s) => s.display_id === String(d.id)) || (srcs.length === displays.length ? srcs[i] : null);
    if (!src) return;
    const r = screen.dipToScreenRect(null, d.bounds); // physical pixels
    const c = color.find((e) => e.x === r.x && e.y === r.y);
    out.push({ id: src.id, idx: rects.length, x: r.x, y: r.y, width: r.width, height: r.height, primary: d.id === primaryId, hdr: !!(c && c.hdr) });
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
    width: 560, height: 680, title: 'My Remote Host', autoHideMenuBar: true, show: !SELFTEST && !BENCH, icon: icon(false),
    // sandbox off: the preload script loads the native capturer (it still runs apart from the page's own scripts).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, sandbox: false },
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
    if (BENCH) Object.assign(cfg, benchCfg.cfg || {});
    if (process.argv.includes('--cursor-check')) cfg.capture = 'engine'; // that check is about the engine's capturer; the native one never has the pointer in its images
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
    getClientApp(); // build the client page now, from the same code this process loaded

    ipcMain.handle('cfg', () => cfg);
    ipcMain.handle('sources', getSources);
    ipcMain.handle('client-app', getClientApp);
    ipcMain.on('input', (_e, text) => { try { input.handle(String(text)); } catch (e) { console.error('input', e); } });
    ipcMain.on('log', (_e, text) => console.log('[host]', text));
    // Measurements of each session (numbers only), for finding out why something felt slow.
    const diagFile = path.join(app.getPath('userData'), 'diag.log');
    ipcMain.on('diag', (_e, entry) => {
      try {
        if (fs.existsSync(diagFile) && fs.statSync(diagFile).size > 3 * 1024 * 1024) fs.renameSync(diagFile, diagFile.replace(/\.log$/, '.old.log'));
        fs.appendFileSync(diagFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
      } catch {}
    });
    ipcMain.handle('cursor', () => { try { return { ...currentCursor(), drag: input.dragging() }; } catch { return { k: '0', c: 'default', drag: false }; } });
    ipcMain.handle('drag-out', async (_e, button) => {
      if (ISOLATED) return { kind: 'none', why: 'not in a local trial' }; // those never send input to this PC
      try { return await dragOut(button | 0); } catch (e) { console.error('drag out', e); try { input.buttonUp(button | 0); } catch {} return { kind: 'none', why: 'error' }; }
    });
    ipcMain.handle('drag-file-read', (_e, id, offset, len) => {
      const f = dragFiles.get(String(id));
      if (!f || !(offset >= 0) || !(len > 0) || len > 1 << 20) return null;
      try {
        if (f.fd == null) f.fd = fs.openSync(f.path, 'r');
        const buf = Buffer.alloc(len), n = fs.readSync(f.fd, buf, 0, len, offset);
        return n === len ? buf : buf.subarray(0, n);
      } catch (e) { console.error('drag file read', e); return null; }
    });
    ipcMain.on('drag-file-done', (_e, id) => closeDragFiles(id == null ? null : String(id)));
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
      if (live && !SELFTEST && !BENCH && Notification.isSupported()) new Notification({ title: 'My Remote Host', body: '원격 접속이 시작되었습니다.' }).show();
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
    if (SELFTEST) selftest.run({ cfg, buildClientHtml, buildLoaderHtml, app, offerFile });
    if (BENCH) require('./bench').run({ cfg, bench: benchCfg, buildClientHtml, app });
    if (LOCALTEST) {
      const file = path.join(app.getPath('userData'), 'my-remote-localtest.html');
      fs.writeFileSync(file, buildLoaderHtml('k=' + cfg.key + '&auto&ro'));
      setTimeout(() => shell.openPath(file), 2500); // after the host has subscribed
    }
  });
}
