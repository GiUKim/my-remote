const { app, shell, BrowserWindow, ipcMain, desktopCapturer, screen, safeStorage, dialog, powerSaveBlocker, powerMonitor, clipboard, Tray, Menu, Notification, nativeImage, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const input = require('./input');
const assist = require('./assist'); // Windows: the lock screen through the assist service (see assist.js)
const appsync = require('./appsync'); // the installed app's two faces kept one app (see appsync.js)
const shellswap = require('./shellswap'); // the installed app's shell replaced by a newer package (see shellswap.js)

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
// --show-key (./start-host.sh --show-key): prints this PC's access key in the terminal and ends. For a
// host reached over ssh, whose window with its 키 복사 button is on a screen nobody sits at. It only reads
// the key, as the host does: never makes one, writes or copies no file, opens no window, needs no display
// and takes no single-instance lock (the host may be running). Agents never run it: it prints the key.
const SHOW_KEY = !ISOLATED && process.argv.includes('--show-key');

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

// ---- started again after a crash (host/watchdog.js) ------------------------------------------
// A small process of its own, started once the host has been up for a while (8 s after its page loaded, the
// moment a new version also says it is up), that starts the host again when it ends without quitting. A
// quit on purpose writes this process's pid into the quit marker first (before-quit; also when Windows
// ends the session or the system shuts down). Not in the isolated runs.
// --localtest --watchdog: in a local trial too (its throwaway profile, the local relay), to check it end to end.
let watchdog = null;
const WATCHDOG_TRIAL = LOCALTEST && process.argv.includes('--watchdog');
const quitMark = () => path.join(app.getPath('userData'), 'quit-on-purpose');
function markQuit() {
  if (ISOLATED && !WATCHDOG_TRIAL) return;
  try { fs.writeFileSync(quitMark(), String(process.pid)); } catch {}
}
function startWatchdog() {
  if ((ISOLATED && !WATCHDOG_TRIAL) || watchdog) return;
  try {
    const { spawn } = require('child_process');
    watchdog = spawn(process.execPath, [path.join(__dirname, 'watchdog.js'), String(process.pid), quitMark(), path.join(app.getPath('userData'), 'watchdog.json'),
      process.execPath, JSON.stringify(process.argv.slice(1)), process.cwd()],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    watchdog.stdin.on('error', () => {}); // its end closes when this process ends: that is how it knows
    watchdog.unref();
  } catch (e) { console.error('[host] watchdog: ' + e.message); }
}

let cursorGuard = null;
function setCursorsHidden(on) {
  if (on === cursorsHidden) return;
  if (on && !input.hidesCursors) return; // only Windows can swap the system cursors; elsewhere the engine's video keeps the pointer
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
// The IPC handlers and the client's input all run on this process's main thread: one call that
// blocks holds up every click behind it. Calls that took long, and pauses of the thread itself,
// are counted (names and milliseconds only) and written with the next diagnostics entry, so that a
// stall can be traced to its cause afterwards.
const slow = {};
const note = (what, ms) => { const e = slow[what] || (slow[what] = { n: 0, ms: 0, max: 0 }); e.n++; e.ms += ms; e.max = Math.max(e.max, ms); };
const timed = (what, fn) => { const t0 = performance.now(); try { return fn(); } finally { const ms = performance.now() - t0; if (ms > 50) note(what, ms); } };
// The same for calls that may return a promise: Electron's clipboard reads and writes do since
// Electron 44, and so do the Linux clipboard helpers in platform/linux.js.
const timedAsync = async (what, fn) => { const t0 = performance.now(); try { return await fn(); } finally { const ms = performance.now() - t0; if (ms > 50) note(what, ms); } };
// Something dragged out of the remote picture and let go over the client PC. The drag is ended
// here without a drop (Escape), what was being dragged is still selected and gets copied
// (Ctrl+C), and the result is handed over: text, or the names and sizes of files the client may
// then fetch. Only files that this very step found on the clipboard can be fetched. On X11 the
// dragging program hands over what it drags when asked (input.dragData()), so there the drag is
// only ended and the clipboard is left alone; Ctrl+C is the fallback when it does not answer.
// Files are looked at and read asynchronously: one on a network share, or one that OneDrive has yet
// to download, can take seconds, and the client's input waits on this thread meanwhile.
const DRAG_MAX_BYTES = 2 * 1024 * 1024 * 1024, DRAG_MAX_FILES = 5000;
// id -> { path, size, open, xfer }. `open`: the file's handle once it is read (a promise). `xfer`: shared
// by the files of one drag-out, { last }: when one of them was last read. Each transfer releases its
// own files (drag-file-done); a second drag-out leaves those of one still running alone.
const dragFiles = new Map();
const DRAG_IDLE_MS = 10 * 60e3; // offers nobody has read for this long are dropped (their session ended first)
// `rel`: the name the client gets, with the folders it sits in when a folder was dragged ('a/b/c.txt').
async function offerFile(file, rel, xfer = { last: Date.now() }) {
  const st = await fs.promises.stat(file);
  if (!st.isFile()) return null;
  const id = crypto.randomBytes(8).toString('hex');
  dragFiles.set(id, { path: file, size: st.size, open: null, xfer });
  return { id, name: rel || path.basename(file), size: st.size };
}
// Everything inside a dragged folder: its files with their path in it, and its empty folders.
// Links and junctions are not followed (one pointing at a parent would never end).
async function listFolder(dir, rel, out, room) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (!entries.length) out.push({ dir: true, rel });
  for (const e of entries) {
    if (out.length >= room.left) { room.cut = true; return; }
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name), r = rel + '/' + e.name;
    if (e.isDirectory()) await listFolder(p, r, out, room);
    else if (e.isFile()) out.push({ path: p, rel: r });
  }
}
async function readDragFile(id, offset, len) {
  const f = dragFiles.get(String(id));
  if (!f || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(len) || len <= 0 || len > 1 << 20) return null;
  f.xfer.last = Date.now();
  if (!f.open) f.open = fs.promises.open(f.path, 'r');
  const fh = await f.open, buf = Buffer.alloc(len), { bytesRead } = await fh.read(buf, 0, len, offset);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}
// One file (id), or every one (null).
function closeDragFiles(id) {
  for (const k of id == null ? [...dragFiles.keys()] : [id]) {
    const f = dragFiles.get(k);
    if (!f) continue;
    dragFiles.delete(k);
    if (f.open) f.open.then((fh) => fh.close()).catch(() => {}); // a read under way finishes first
  }
}
let dragCopySeq = null; // the clipboard's change count after the last drag-out's Ctrl+C
async function dragOut(button) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!input.dragging()) {
    const cls = input.captureClass();
    input.buttonUp(button); console.log('drag out: no drag in progress' + (cls ? ' (mouse held by ' + cls + ')' : '')); return { kind: 'none', why: 'nodrag' };
  }
  let paths = [], text = '';
  const direct = await input.dragData(); // null on Windows
  if (direct) {
    input.tap(['Escape']);
    await sleep(90);
    input.buttonUp(button);
    paths = direct.paths || [];
    text = direct.text || '';
  } else {
    // Escape and Ctrl+C go to the program in front, and that must be the one dragging. A drag is followed
    // in its own thread (input.dragging), so another window may have come to the front meanwhile (a
    // dialog, a notification): the keys would close that dialog and copy that program's selection, which
    // would then be sent as what was dragged. The drag is ended in its own thread instead, and nothing
    // is brought over.
    if (process.platform === 'win32' && input.captureClass() !== 'CLIPBRDWNDCLASS') {
      const ended = input.cancelDrag();
      await sleep(90);
      input.buttonUp(button);
      console.log('drag out: the dragging program is not in front' + (ended ? '' : '; its drag could not be ended'));
      return { kind: 'none', why: 'nofront' };
    }
    const before = input.clipSeq();
    input.tap(['Escape']);
    await sleep(90);
    input.tap(['ControlLeft', 'KeyC']);
    let changed = false;
    for (let i = 0; i < 40 && !changed; i++) { await sleep(25); changed = input.clipSeq() !== before; }
    input.buttonUp(button);
    if (!changed) return { kind: 'none', why: 'nocopy' };
    await sleep(80); // the program may still be adding formats
    // What this copy put on the clipboard goes to the client with the drag; the clipboard poll must
    // not offer it again (the client app would fetch the same files a second time).
    dragCopySeq = input.clipSeq();
    // Reading the clipboard waits for its owner to hand the data over.
    paths = await timedAsync('drag clipboard', () => input.clipboardFiles());
    if (!paths.length) text = await timedAsync('drag clipboard', () => clipboard.readText());
  }
  if (paths.length) return offerPaths(paths);
  return text ? { kind: 'text', s: text.slice(0, CLIP_MAX), cut: text.length > CLIP_MAX } : { kind: 'none', why: 'empty' };
}
// The files and folders `paths` names, offered for the client to fetch (drag-file-read): a folder as
// its files with their path in it, plus its empty folders. At most DRAG_MAX_FILES files and
// DRAG_MAX_BYTES; what does not fit or cannot be read is counted in `skipped`.
async function offerPaths(paths) {
  for (const [id, f] of [...dragFiles]) if (Date.now() - f.xfer.last > DRAG_IDLE_MS) closeDragFiles(id); // earlier transfers stay unless idle
  const xfer = { last: Date.now() };
  const files = [], room = { left: DRAG_MAX_FILES, cut: false };
  let skipped = 0, total = 0;
  const add = async (file, rel) => {
    let o = null;
    try { o = files.length < DRAG_MAX_FILES ? await offerFile(file, rel, xfer) : null; } catch {}
    if (o && total + o.size <= DRAG_MAX_BYTES) { files.push(o); total += o.size; } else { skipped++; if (o) dragFiles.delete(o.id); }
  };
  for (const f of paths) {
    let st = null;
    try { st = await fs.promises.stat(f); } catch { skipped++; continue; }
    if (!st.isDirectory()) { await add(f, path.basename(f)); continue; }
    const list = [];
    room.left = DRAG_MAX_FILES - files.length;
    await listFolder(f, path.basename(f), list, room);
    for (const e of list) if (e.dir) files.push({ id: '', name: e.rel, size: 0, dir: true }); else await add(e.path, e.rel);
  }
  if (room.cut) skipped++;
  return files.length ? { kind: 'files', files, skipped } : { kind: 'none', why: 'toobig' };
}

// ---- files copied here (Ctrl+C) for pasting on the client ------------------------------------
// When this PC's clipboard gets files, the client is told what they are (how many, how large the
// plain files are, whether there are folders, a few names - never paths); the client app fetches
// them when the person leaves the remote picture for the client's own programs, and puts them on
// the client's clipboard, so Ctrl+C here and Ctrl+V there work as between two folders of one PC.
// Only the files that are on the clipboard right now (same change count) can be fetched.
let clipFiles = null; // { seq, paths }
// The sizes are looked at asynchronously: files on a network share can take seconds to answer, and the
// client's input waits on this thread meanwhile. Reading the list itself waits for the clipboard's owner.
// Files the client sent (its paste, or a drop nothing took, which putDone puts on this clipboard) are
// not announced back: it has them already, and fetching them would replace its own clipboard with
// copies of them from a staging folder.
const fromClient = (p) => { const r = path.relative(inbox(), p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
async function clipFilesNow(seq) {
  const paths = await timedAsync('clip-files', () => input.clipboardFiles());
  if (paths.length && paths.every(fromClient)) { clipFiles = null; return { own: true }; }
  clipFiles = paths.length ? { seq, paths } : null;
  if (!clipFiles) return null;
  let bytes = 0, dirs = 0;
  for (const p of paths) { try { const st = await fs.promises.stat(p); if (st.isDirectory()) dirs++; else bytes += st.size; } catch {} }
  return { n: paths.length, dirs, bytes, names: paths.slice(0, 3).map((p) => path.basename(p)) };
}
async function clipGet(seq) {
  if (!clipFiles || clipFiles.seq !== seq || clipFiles.seq !== input.clipSeq()) return { kind: 'none', why: 'changed' };
  return offerPaths(clipFiles.paths);
}

// ---- files dragged or pasted in from the client ------------------------------------------
// They come over a data channel of their own (receiveUpload in host.js) and are written here under
// a staging folder, one per transfer, with names made safe part by part (files.js). Complete, they
// go to the program under the host's pointer by a real drag-and-drop (so_drop in shellops.dll: a
// folder window, a folder icon in it, the desktop, a mail or chat window each do what they do with
// a local drop), or onto the clipboard: for a paste (then Ctrl+V is pressed), or when nothing under
// the pointer took them. Writing is asynchronous: the client's input shares this thread.
// Local trials never drop or paste, except the opt-in --dropin-check.
const fileNames = require('./files');
const PUT_MAX_BYTES = 2 * 1024 * 1024 * 1024, PUT_MAX_FILES = 5000;
const inbox = () => path.join(os.tmpdir(), 'my-remote-in');
const puts = new Map();    // gid -> { dir, files, bytes }
const putOpen = new Map(); // fid -> { gid, fh, left }
let shellops; // undefined: not looked for yet; null: not there
function shellOps() {
  if (shellops !== undefined) return shellops;
  shellops = null;
  try {
    const file = path.join(__dirname, 'bin', 'shellops.dll');
    if (process.platform === 'win32' && fs.existsSync(file)) {
      const lib = require('koffi').load(file);
      shellops = { drop: lib.func('int so_drop(const char16_t *paths, int effects, int timeoutMs)'), error: lib.func('const char *so_error()'), debug: lib.func('const char *so_debug()') };
    }
  } catch (e) { console.error('shell operations are not available:', e.message); }
  return shellops;
}
function putBegin() {
  fileNames.sweep(inbox(), 24 * 3600e3);
  const gid = crypto.randomBytes(8).toString('hex'), dir = path.join(inbox(), gid);
  fs.mkdirSync(dir, { recursive: true });
  puts.set(gid, { dir, files: 0, bytes: 0 });
  return gid;
}
function putDir(gid, name) {
  const p = puts.get(String(gid));
  if (!p) return false;
  fs.mkdirSync(fileNames.stagedPath(p.dir, name), { recursive: true });
  return true;
}
async function putFile(gid, name, size) {
  const p = puts.get(String(gid));
  size = Number(size);
  if (!p || !Number.isSafeInteger(size) || size < 0 || p.files >= PUT_MAX_FILES || p.bytes + size > PUT_MAX_BYTES) return null;
  let file = fileNames.stagedPath(p.dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) file = fileNames.freePath(path.dirname(file), path.basename(file));
  const fid = crypto.randomBytes(8).toString('hex');
  putOpen.set(fid, { gid: String(gid), fh: await fs.promises.open(file, 'wx'), left: size });
  p.files++;
  p.bytes += size;
  return fid;
}
async function putChunk(fid, bytes) {
  const f = putOpen.get(String(fid));
  if (!f || !bytes || bytes.byteLength > f.left) return false;
  await f.fh.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  f.left -= bytes.byteLength;
  return true;
}
async function putEnd(fid) {
  const f = putOpen.get(String(fid));
  if (!f) return false;
  putOpen.delete(String(fid));
  await f.fh.close();
  return f.left === 0;
}
async function putClose(gid) {
  for (const [fid, f] of [...putOpen]) if (f.gid === String(gid)) { putOpen.delete(fid); try { await f.fh.close(); } catch {} }
}
async function putAbort(gid) {
  const p = puts.get(String(gid));
  puts.delete(String(gid));
  await putClose(gid);
  if (p) fs.rm(p.dir, { recursive: true, force: true }, () => {});
  return true;
}
// `at`: where to drop ({d, x, y} as in 'mm'), or null: onto the clipboard. `mode`: 'drop' or 'paste'.
async function putDone(gid, at, mode) {
  const p = puts.get(String(gid));
  if (!p) return { how: 'none', why: 'unknown' };
  puts.delete(String(gid));
  await putClose(gid);
  const items = fs.readdirSync(p.dir).map((n) => path.join(p.dir, n)), n = p.files;
  if (!items.length) return { how: 'none', why: 'empty' };
  if (ISOLATED && !process.argv.includes('--dropin-check')) return { how: 'staged', n };
  const later = () => setTimeout(() => fs.rm(p.dir, { recursive: true, force: true }, () => {}), 10 * 60e3); // the target may still be reading
  const so = shellOps();
  if (mode === 'drop' && at && (so || process.platform === 'linux')) {
    // Text still being typed (X11 types over time) holds later input back, this move too: the drop would
    // then go wherever the pointer was. It waits for the typing (a few seconds at most).
    await Promise.race([input.idle(), new Promise((r) => setTimeout(r, 8000))]);
    input.handle(JSON.stringify({ t: 'mm', d: at.d | 0, x: +at.x, y: +at.y }));
    await new Promise((r) => setTimeout(r, 60));
    // Windows: an OLE drag of the shell's own data object (shellops.dll); X11: an XDND drag (platform/linux.js).
    const effect = so ? await new Promise((res) => so.drop.async(items.join('\n'), 1, 4000, (err, r) => res(err ? -3 : r))) : await input.dropFiles(items);
    if (effect > 0) { later(); return { how: 'dropped', n }; }
    console.log(`drop not taken (${effect})` + (so ? `: ${so.error()} ${so.debug()}` : ''));
  }
  // A test run (--dropin-check) never puts them on this PC's clipboard: it belongs to the person (once a
  // drop that was not taken there replaced what they had copied).
  if (ISOLATED) return { how: 'none', why: 'nottaken' };
  // A paste, or nothing under the pointer took them: onto the clipboard, and for a paste Ctrl+V.
  if (!(await input.setClipboardFiles(items))) return { how: 'none', why: 'clipboard' };
  if (mode === 'paste') { input.tap(input.isDown('ControlLeft') || input.isDown('ControlRight') ? ['KeyV'] : ['ControlLeft', 'KeyV']); return { how: 'pasted', n }; }
  return { how: 'clipboard', n };
}

// The client's input, injected here (on this thread, as the client sends it). Text from the client goes
// onto the clipboard just before the paste shortcut that uses it (the page holds the key back until the
// browser's paste event has given it the text), and since Electron 44 a clipboard write completes
// asynchronously: input that arrives meanwhile waits for it, or Ctrl+V could paste what was there before.
let clipWriting = 0, clipWrites = 0; // the write the input waits for (0: none)
let inputWaiting = [];
function injectInput(text) {
  timed('input ' + ((/"t":"(\w{1,8})"/.exec(String(text)) || [])[1] || '?'), () => { try { input.handle(String(text)); } catch (e) { console.error('input', e); } });
}
function releaseInput(id) {
  if (clipWriting !== id) return; // a later write: the input waits for that one
  clipWriting = 0;
  const q = inputWaiting;
  inputWaiting = [];
  for (const t of q) injectInput(t);
}

// What this process did for the host page's session, undone. The page does this itself when a
// session ends (teardown in host.js), but not when it goes away instead: its process crashed (it runs
// the native capturer), or it reloads (after a new key). Without this, keys and buttons held for the
// client stay down, the cursors stay hidden and the tray keeps saying someone is connected.
function pageGone() {
  clipWriting = 0; // input of the page that went away is not injected after the reset below
  inputWaiting = [];
  try { assist.stop(); } catch (e) { console.error('assist stop', e); } // before the reset: it lets go of input's sink
  try { input.reset(); } catch (e) { console.error('input reset', e); }
  try { setCursorsHidden(false); } catch (e) { console.error('cursor restore', e); }
  closeDragFiles(null);
  for (const gid of [...puts.keys()]) putAbort(gid).catch(() => {});
  setTray(false);
}

let cfg = null;
let savedCfg = {}; // only what the user set; defaults are not frozen into the file
// config.json holds the access key, and every client that has the key loses access when it changes.
// So a key is made by itself only when there is no file at all (the first start). A file that is there
// but cannot be used as it is - unreadable, not valid JSON (it is edited by hand: a trailing comma), no
// key in it, or a key that cannot be decrypted (Windows: the profile was restored on another PC or the
// password reset by an administrator; Linux: the keyring is locked) - is never replaced without asking,
// and a copy of it (config.json.bad-<time>) is kept before it is.
let cfgIssue = '';  // why the file cannot be used as it is, for the person at this PC; '' = it can
let cfgBackup = ''; // that copy

if (ISOLATED) {
  // Fully local: private profile dir, local relay, no STUN. Nothing leaves this PC.
  // The profile is removed once this run has ended (profile-cleanup.js).
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-local-'));
  app.setPath('userData', profile);
  require('./profile-cleanup').watch(profile);
  app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', ...((benchCfg && benchCfg.disableFeatures) || [])].join(','));
  // A bench run can try other engine switches before they are made the default.
  if (benchCfg) for (const [k, v] of Object.entries(benchCfg.switches || {})) app.commandLine.appendSwitch(k, String(v));
}
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function newKey() { return crypto.randomBytes(32).toString('base64url'); }

// What this PC runs and what it is called, for the client: a logo and a name next to "호스트 PC" in the
// arrangement panel, and the entry of this PC in the client app's list (`pc`, the computer's name).
function hostOs() {
  let pc = '';
  try { pc = String(os.hostname() || '').slice(0, 60); } catch {}
  if (process.platform === 'win32') return { os: 'windows', name: Number(os.release().split('.')[2]) >= 22000 ? 'Windows 11' : 'Windows 10', pc };
  if (process.platform === 'darwin') return { os: 'mac', name: 'macOS', pc };
  let name = 'Linux';
  try { const m = /^PRETTY_NAME="?([^"\n]*)"?\s*$/m.exec(fs.readFileSync('/etc/os-release', 'utf8')); if (m && m[1]) name = m[1].slice(0, 60); } catch {}
  return { os: 'linux', name, pc };
}

// The key is encrypted with Electron's asynchronous safeStorage calls (the synchronous ones are
// deprecated in Electron 45 and gone in 46). Each reads what the other wrote, and Electron 45 reads what
// Electron 33 wrote and the reverse: checked on Windows, and on Linux with a keyring (gnome-libsecret,
// 'v11') and without one ('v10', only obscured), where the asynchronous calls need no
// setUsePlainTextEncryption. `again`: Electron asks for the key to be encrypted anew (its key changed).
// An Electron before 45 (the code updated, setup.ps1 not run yet) has only the synchronous calls: the key
// must still be read then, or the host would ask for a new one and every client would lose access.
const ASYNC_SAFE_STORAGE = typeof safeStorage.decryptStringAsync === 'function';
async function decryptKey(keyEnc) {
  if (!ASYNC_SAFE_STORAGE) return { text: safeStorage.decryptString(Buffer.from(keyEnc, 'base64')), again: false };
  const r = await safeStorage.decryptStringAsync(Buffer.from(keyEnc, 'base64'));
  return typeof r === 'string' ? { text: r, again: false } : { text: r && r.result, again: !!(r && r.shouldReEncrypt) };
}
const validKey = (k) => /^[A-Za-z0-9_-]{43}$/.test(k || ''); // 32 bytes, base64url, as newKey() makes them
// Notepad and PowerShell 5.1 (Set-Content -Encoding UTF8) start a file with a byte order mark. By its
// number: written as a character in a pattern it is invisible, and an editor may drop it unnoticed.
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
// The encrypted key in the config file's text; also found in a file that is not valid JSON.
const keyEncIn = (body) => (/"keyEnc"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(body) || [])[1] || '';
// Linux without a keyring: true. The synchronous calls (an Electron before 45) need to be told then.
function obscuredOnly() {
  if (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text') return false;
  if (!ASYNC_SAFE_STORAGE) safeStorage.setUsePlainTextEncryption(true);
  return true;
}
const encryptionReady = async () => (ASYNC_SAFE_STORAGE ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable());
const encryptKey = async (key) => (ASYNC_SAFE_STORAGE ? safeStorage.encryptStringAsync(key) : safeStorage.encryptString(key));
async function loadConfig() {
  cfgIssue = '';
  cfgBackup = '';
  const problem = (ko, en) => { cfgIssue = cfgIssue || ko; console.warn(`[host] WARNING: ${cfgPath()} ${en}`); };
  let text = null, saved = {}, keyEnc = '';
  try { text = fs.readFileSync(cfgPath(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') problem(`설정 파일을 읽을 수 없습니다 (${e.code || e.message}).`, `cannot be read (${e.code || e.message})`); }
  if (text !== null) {
    const body = stripBom(text);
    try {
      saved = JSON.parse(body);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object');
      keyEnc = typeof saved.keyEnc === 'string' ? saved.keyEnc : '';
      if (!keyEnc) problem('설정 파일에 접속 키가 없습니다.', 'has no access key');
    } catch (e) {
      saved = {};
      // Only where the mistake is: the parser's message can quote the file, and the file holds the key.
      const at = /position (\d+)/.exec(e.message), line = at ? body.slice(0, Number(at[1])).split('\n').length : 0;
      problem(`설정 파일이 올바른 JSON 형식이 아닙니다${line ? ` (${line}번째 줄 근처)` : ''}.`, `is not valid JSON${line ? ` (near line ${line})` : ''}`);
      // The key alone can usually still be found, and remote access then goes on as before.
      keyEnc = keyEncIn(body);
    }
  }
  cfg = { ...DEFAULTS, ...saved };
  delete cfg.keyEnc;
  savedCfg = { ...saved };
  delete savedCfg.keyEnc;
  // Linux without a keyring (no GNOME Keyring or KWallet running): Electron can then only obscure
  // the key with a fixed password. The host keeps working that way, says so, and the file is
  // readable by this user only.
  if (obscuredOnly()) console.warn(`[host] WARNING: no OS keyring (basic_text): the access key in ${cfgPath()} is not encrypted, only obscured; the file is readable by this user only`);
  let key = null, again = false;
  if (keyEnc) {
    try { ({ text: key, again } = await decryptKey(keyEnc)); } catch {}
    if (!validKey(key)) {
      key = null;
      problem(process.platform === 'win32'
        ? '설정 파일의 접속 키를 이 Windows 계정으로 풀 수 없습니다 (다른 PC에서 옮겨 온 프로필이거나, 관리자가 계정 암호를 초기화한 경우 등).'
        : '설정 파일의 접속 키를 풀 수 없습니다 (키링이 잠겨 있으면 잠금을 푼 뒤 호스트를 다시 시작하세요).', 'holds an access key that cannot be decrypted');
    }
  }
  if (!key && text === null && !cfgIssue) { // the first start: no file yet
    try { const k = newKey(); await saveConfig(k); key = k; } catch (e) { problem(`새 접속 키를 저장하지 못했습니다 (${e.code || e.message}).`, `could not be written (${e.code || e.message})`); }
  }
  // Only a file that is fine otherwise is rewritten for that; the key stays the same.
  if (key && again && !cfgIssue) { try { await saveConfig(key); } catch (e) { console.error('[host] encrypting the key anew failed:', e.code || e.message); } }
  if (cfgIssue && text !== null) { try { cfgBackup = backupConfig(); } catch (e) { console.error('config backup', e.message); } }
  cfg.key = key; // null: there is no usable key (askForKey)
}
// A copy of the config file as it is now, unless one with the same content is there already. Throws
// when the file is there but cannot be read: then it must not be replaced either.
function backupConfig() {
  let bytes;
  try { bytes = fs.readFileSync(cfgPath()); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  const dir = path.dirname(cfgPath());
  for (const n of fs.readdirSync(dir)) {
    if (!n.startsWith('config.json.bad-')) continue;
    try { if (fs.readFileSync(path.join(dir, n)).equals(bytes)) return path.join(dir, n); } catch {}
  }
  const file = `${cfgPath()}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); // it holds the key just as the file does
  return file;
}
// Written to a new file that then takes the old one's place: a crash, a full disk or a power cut
// midway leaves the old file as it was, never half of one (which would cost the key).
function writeConfigFile(text) {
  const file = cfgPath(), tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(tmp); } catch {}
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows refuses while another program (a virus scanner) has the old file open for a moment.
      if (i >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
// The encrypted key is decrypted again before it is written: a file whose key cannot be read back would
// cost every client its access.
async function saveConfig(key) {
  if (!(await encryptionReady())) throw new Error('OS 암호화 저장소(DPAPI)를 사용할 수 없습니다');
  const enc = await encryptKey(key); // Windows: DPAPI, only this Windows user can decrypt
  if ((await decryptKey(enc.toString('base64'))).text !== key) throw new Error('암호화한 키를 다시 풀 수 없습니다');
  if (cfgIssue) cfgBackup = backupConfig(); // the file as it was, before it is replaced
  writeConfigFile(JSON.stringify({ ...savedCfg, keyEnc: enc.toString('base64') }, null, 2));
  cfgIssue = '';
}
// There is no usable key (cfgIssue says why): ask the person at this PC. A new key is made only when
// they ask for one, since every client that has the old key then loses access.
async function askForKey() {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error', title: 'My Remote Host', noLink: true, buttons: ['다시 시도', '새 키 발급', '종료'], defaultId: 0, cancelId: 2,
      message: '접속 키를 불러오지 못했습니다',
      detail: `${cfgIssue}\n\n${cfgPath()}${cfgBackup ? `\n원래 파일의 사본: ${path.basename(cfgBackup)}` : ''}\n\n` +
        "원인을 고쳤으면 '다시 시도'를 누르세요. '새 키 발급'은 새 접속 키를 만들어 저장합니다. 기존 키로는 더 이상 접속할 수 없으므로 새 키를 클라이언트에 다시 알려 주어야 합니다.",
    });
    if (response === 0) { await loadConfig(); if (cfg.key) return true; continue; }
    if (response !== 1) return false;
    try {
      const key = newKey();
      await saveConfig(key);
      cfg.key = key;
      return true;
    } catch (e) {
      cfgIssue = `새 키를 저장하지 못했습니다 (${e.code || e.message}).`;
      console.error('[host] saving a new key failed:', e.code || e.message);
    }
  }
}
// --show-key: the key on stdout, nothing else there; what went wrong on stderr, marked for the launcher
// (which shows only those lines of the engine's output). Exit code 0 only with a key.
async function showKey() {
  const done = (code, out, err) => {
    const end = () => app.exit(code); // at once: nothing of the profile (which the host may be using) is written
    if (out) process.stdout.write(out + '\n', end);
    else process.stderr.write(`[show-key] ${err}\n`, end);
  };
  let body;
  try { body = stripBom(fs.readFileSync(cfgPath(), 'utf8')); } catch (e) {
    return done(1, '', e.code === 'ENOENT' ? `No access key yet (${cfgPath()} is not there): start the host once to make one.`
      : `${cfgPath()} cannot be read (${e.code || e.message}).`);
  }
  let keyEnc = '';
  try { keyEnc = JSON.parse(body).keyEnc; } catch {}
  if (typeof keyEnc !== 'string' || !keyEnc) keyEnc = keyEncIn(body);
  if (!keyEnc) return done(1, '', `${cfgPath()} holds no access key.`);
  obscuredOnly();
  // A keyring that would have to ask for its password cannot do so without a display: do not wait forever.
  const key = await Promise.race([decryptKey(keyEnc).then((r) => r.text, () => null), new Promise((r) => setTimeout(() => r(null), 20000))]);
  if (!validKey(key)) {
    return done(1, '', process.platform === 'linux'
      ? 'The access key cannot be decrypted here. The host keeps it in the desktop\'s keyring when there is one: run this while you are logged in at this PC\'s desktop (the keyring is unlocked then), from a terminal of the same user.'
      : 'The access key cannot be decrypted with this user account.');
  }
  done(0, key);
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

// A display's rectangle in physical pixels. Electron converts only on Windows; on X11 every display
// has the same scale factor, and physical pixels are the X server's root window coordinates.
function physicalRect(d) {
  if (process.platform === 'win32') return screen.dipToScreenRect(null, d.bounds);
  const s = d.scaleFactor || 1, b = d.bounds;
  return { x: Math.round(b.x * s), y: Math.round(b.y * s), width: Math.round(b.width * s), height: Math.round(b.height * s) };
}
// desktopCapturer.getSources sets up DXGI desktop duplication twice on this thread (the one that
// injects the client's input) and starts a thread, at every session start. The list it gives only
// changes with the displays, so it is kept until they change (or a session could not use it).
let screenSrcs = null; // { key, list: [{ id, display_id }] }
function forgetSources() { screenSrcs = null; }
async function getSources() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const key = JSON.stringify(displays.map((d) => [d.id, d.bounds, d.scaleFactor, d.rotation]));
  if (!screenSrcs || screenSrcs.key !== key) {
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    screenSrcs = { key, list: list.map((s) => ({ id: s.id, display_id: s.display_id })) };
  }
  const srcs = screenSrcs.list;
  const primaryId = screen.getPrimaryDisplay().id;
  const rects = [], out = [];
  const color = input.displayColor(); // which displays Windows has in HDR mode (they are captured too bright)
  displays.forEach((d, i) => {
    const src = srcs.find((s) => s.display_id === String(d.id)) || (srcs.length === displays.length ? srcs[i] : null);
    if (!src) return;
    const r = physicalRect(d);
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
function setTray(live) {
  if (tray) { tray.setImage(icon(live)); tray.setToolTip('My Remote Host — ' + (live ? '원격 접속 중' : '대기 중')); }
}
function showWindow() { if (win) { win.show(); win.focus(); } }
// 키 복사 puts the key on the clipboard. A minute later it is taken off again if it is still there, so
// that it does not go along with whatever is pasted next. "Still there" is the clipboard's change count
// being the one right after the key was put on it: nothing is read back (Electron's clipboard reads
// are promises since 44, and this must also work in before-quit, which cannot wait).
// Where the count cannot say (X11 without XFixes counts every look as a change; an owner change may also
// be counted after the count was taken), the text is read after all and the clipboard cleared when it
// is the key: that takes a moment, so it may not finish when the host is quitting.
let keyOnClip = null; // { seq, timer }
function clearKeyClip() {
  if (!keyOnClip) return;
  clearTimeout(keyOnClip.timer);
  const key = cfg && cfg.key;
  try {
    if (input.clipSeq() === keyOnClip.seq) clipboard.clear();
    else if (process.platform !== 'win32' && key) Promise.resolve(clipboard.readText()).then((t) => { if (t === key) clipboard.clear(); }, () => {});
  } catch {}
  keyOnClip = null;
}

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

// ---- the installed app -----------------------------------------------------------------
// Started by the app's shell (app/boot.js) this code is one version of an installed app: the shell
// says which (global.__mrApp), finds and installs updates (app/updater.js), and wants to hear that this
// version came up (ok()), or it goes back to the one before. Run from a source folder there is no
// shell: the version is package.json's and updates come by git.
const APP = global.__mrApp || null;
// One app on Windows: the host takes the id of the one "MyRemote" entry, as the client app does (see
// appsync.APP_ID): its window sits with the client app's under that entry, and its notice of a remote
// session has an entry to be shown by. Before any window; the shell set the host's own id.
if (APP && process.platform === 'win32') { app.setAppUserModelId(appsync.APP_ID); console.log('[host] app id ' + appsync.APP_ID); }
let sessionLive = false;
const appVersion = () => (APP ? APP.version : require('./package.json').version);
const updateInfo = () => ({ version: appVersion(), installed: !!APP, rolledBack: APP ? APP.rolledBack : [], ...(APP && APP.update ? APP.update.status() : { state: 'none' }) });
// Packages up to 0.5.x made two shortcuts (host, client): the one entry takes their place, at the start and
// whenever another start reaches this running host. The first-start dialog of those packages' shells (their
// exe started without --host/--client) makes the two again when its box is ticked, its default, and then
// starts a face that only brings this one forward (seen 2026-11-16: three shortcuts after such a start).
function oneEntry() {
  if (ISOLATED || !APP) return;
  try {
    const r = appsync.unifyShortcuts({ appData: app.getPath('appData'), dataHome: process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      execPath: process.execPath, iconDir: path.dirname(require.main.filename), writeLink: (f, op, o) => shell.writeShortcutLink(f, op, o) });
    if (r.made.length) console.log('[host] shortcuts: one entry ' + r.made.join(', '));
  } catch (e) { console.error('[host] shortcuts', e.message); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 680, title: 'My Remote Host', autoHideMenuBar: true, show: !SELFTEST && !BENCH, icon: icon(false),
    // sandbox off: the preload script loads the native capturer (it still runs apart from the page's own scripts).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'host.html')); // by this file's place: in the installed app the app's own folder is the shell's
  // The installed app: this version counts as up once its page has loaded and stayed for a while (a
  // page that keeps crashing never gets there, and the shell goes back to the version before).
  // The watchdog from the same moment on (a host that crashes while it starts is not started over and over).
  if (!ISOLATED || WATCHDOG_TRIAL) win.webContents.once('did-finish-load', () => setTimeout(startWatchdog, 8000));
  win.on('session-end', markQuit); // Windows ends the session (log off, shut down): not a crash
  // A shell swap waits for the same moment (shellswap.confirm: the new shell's code is up).
  if (APP && (!ISOLATED || SHELL_SWAP_TRIAL)) win.webContents.on('did-finish-load', () => setTimeout(() => {
    if (win.isDestroyed() || win.webContents.isCrashed()) return;
    if (!ISOLATED) APP.ok();
    if (shellCtx) shellswap.confirm(shellCtx.root, shellCtx.me.identity);
  }, 8000));
  // The host's first start on Windows: the lock screen support is offered at once (assist.offer).
  // --offer-assist: in a local trial too (its throwaway profile has never been asked), to try the offer.
  if (assist.supported && (!ISOLATED || (LOCALTEST && process.argv.includes('--offer-assist')))) win.webContents.once('did-finish-load', () => setTimeout(offerAssist, 1500));
  // Closing the window keeps the host running in the tray; quit from the tray menu.
  win.on('close', (e) => { if (!quitting && !ISOLATED) { e.preventDefault(); win.hide(); } });
  // The page goes away without its own teardown when it reloads or its process ends (see pageGone).
  // The signaling channel lives in the page, so after a crash the page is loaded again, or the host
  // could not be reached until someone at this PC restarted it; when it keeps crashing, after a pause
  // that doubles each time (1 s, 2 s, 4 s, ... at most a minute; crashes counted over ten minutes).
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) pageGone(); });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`[host] the host page's process ended (${d.reason}, exit code ${d.exitCode})`);
    pageGone();
    if (quitting || win.isDestroyed()) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 10 * 60e3).concat(now);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadCrashedPage, Math.min(60e3, 1000 * 2 ** (crashes.length - 1)));
  });
}
// "업데이트 확인" found an ordinary update: "지금 업데이트할까요?" (the window's card offers the same, for
// whoever answers later). A required one installs by itself; one that needs a new package opens the
// downloads page on yes.
// While this host runs, running.json in its profile says so (pid and version), for the start screen of the
// client app (client/launcher.html: "켜져 있음"). Never in the isolated runs (their profile is a throwaway one).
function runningMark(on) {
  if (ISOLATED) return;
  const file = path.join(app.getPath('userData'), 'running.json');
  try {
    if (on) fs.writeFileSync(file, JSON.stringify({ pid: process.pid, version: appVersion() }));
    else if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
  } catch {}
}
// The client face installed a newer version (host/appsync.js): the host starts again into it once no remote
// session is on (followNewer is asked again when a session ends). A restart by the shell keeps --host.
let newerVersion = '';
function followNewer() {
  if (!newerVersion || quitting || sessionLive) return;
  console.log(`[host] restarting into version ${newerVersion}`);
  if (win && !win.isDestroyed()) win.webContents.send('update-changed', { ...updateInfo(), state: 'ready', available: { version: newerVersion, required: false, kind: 'bundle', notes: { ko: [], en: [] }, size: 0 } });
  setTimeout(restart, 1500);
}
async function installUpdate() {
  try { if (APP && APP.update) { quitting = true; await APP.update.install(); return true; } } catch (e) { quitting = false; console.error('[host] update:', e.message); }
  return false;
}

// ---- the shell replaced by a newer package (host/shellswap.js) -----------------------------
// Looked for 3 minutes after the start and every 6 hours, fetched only while no remote session is on (it
// would take the session's bandwidth; a session starting stops it), swapped when no session is on and
// the client app does not run (Windows keeps a running program's files): this host starts the swap
// script and quits, the script starts it again from the new folder, or from the old one when the new
// shell does not come up.
let shellCtx = null, shellLook = null;
// --localtest --shell-swap: the swap in a local trial too (its throwaway profile, the local relay: no host
// reachable from outside), started again the same way; how the test VM checks it from end to end.
const SHELL_SWAP_TRIAL = LOCALTEST && process.argv.includes('--shell-swap');
function clientAppRunning() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'my-remote-client', 'running.json'), 'utf8'));
    process.kill(Number(r.pid), 0);
    return true;
  } catch (e) { return !!e && e.code === 'EPERM'; }
}
function shellSetup() {
  if (!APP || (ISOLATED && !SHELL_SWAP_TRIAL) || !shellswap.EXE[process.platform]) return;
  const parts = appsync.shellParts();
  if (!parts || !parts.conf) return;
  shellCtx = { root: parts.root, conf: parts.conf, appDir: path.dirname(process.execPath), me: shellswap.readShell(parts.dir) };
  shellswap.sweep(shellCtx.appDir, shellCtx.root).then((g) => { if (g.length) console.log('[host] shell: removed ' + g.join(', ')); }, () => {});
  const lookNow = async () => {
    if (!shellCtx || sessionLive || quitting || shellLook) return;
    const ctl = new AbortController();
    shellLook = ctl;
    try {
      const r = await shellswap.look({ feed: shellCtx.conf.feed, keys: shellCtx.conf.keys, root: shellCtx.root, appDir: shellCtx.appDir, current: shellCtx.me,
        fetchFn: (u, o) => net.fetch(u, o), signal: ctl.signal, log: (s) => console.log('[host] ' + s) });
      console.log(`[host] shell ${shellCtx.me.version}: ${r.state}${r.version ? ' ' + r.version : ''}${r.why ? ' (' + r.why + ')' : ''}`);
    } finally { shellLook = null; }
    shellSwapIfFits();
  };
  // shellTiming in the shell's config: shorter waits for a test package (as the updater's `timing`).
  const T = { firstLookMs: 3 * 60e3, everyMs: 6 * 3600e3, swapCheckMs: 10 * 60e3, ...(shellCtx.conf.shellTiming || {}) };
  setTimeout(lookNow, T.firstLookMs);
  setInterval(lookNow, T.everyMs);
  setInterval(shellSwapIfFits, T.swapCheckMs);
}
let shellBeginning = false;
function shellSwapIfFits() {
  if (!shellCtx || sessionLive || quitting || shellBeginning) return;
  const next = shellswap.readNext(shellCtx.root, shellCtx.appDir);
  if (!next || clientAppRunning() || shellswap.heldRecently(shellCtx.root)) return;
  const face = shellswap.hostFace();
  if (SHELL_SWAP_TRIAL) face.args = ['--host', '--localtest', '--no-client', '--shell-swap'];
  shellBeginning = true;
  // Quits only once the script runs (begin resolves). A session that began meanwhile keeps the host: the
  // script then finds it running, starts nothing new and holds the swap back for a while.
  shellswap.begin({ root: shellCtx.root, appDir: shellCtx.appDir, next, restart: [face], log: (s) => console.log('[host] ' + s) }).then(() => {
    if (sessionLive) { console.log('[host] shell swap: a session began meanwhile; not now'); return; }
    quitting = true;
    app.quit();
  }, (e) => console.error('[host] shell swap: ' + e.message)).finally(() => { shellBeginning = false; });
}
function downloadsPage() { if (APP && APP.downloads) shell.openExternal(APP.downloads).catch(() => {}); return true; }
let askingUpdate = false;
async function askUpdate() {
  const s = APP.update.status(), a = s.available;
  if (askingUpdate || !a || s.state !== 'available' || a.required || !win || win.isDestroyed()) return;
  askingUpdate = true;
  try {
    const pack = a.kind === 'package', notes = ((a.notes && a.notes.ko) || []).map((x) => '· ' + x).join('\n');
    const r = await dialog.showMessageBox(win, {
      type: 'question', title: 'My Remote Host', noLink: true, defaultId: 0, cancelId: 1,
      buttons: [pack ? '내려받기 페이지 열기' : '지금 업데이트', '나중에'],
      message: pack ? `새 버전 ${a.version}이 있습니다` : `새 버전 ${a.version}이 있습니다. 지금 업데이트할까요?`,
      detail: [pack ? '이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요(접속 키와 설정은 그대로 남습니다).' : '', notes,
        pack ? '' : `업데이트하면 호스트가 다시 시작됩니다${sessionLive ? '. 접속 중인 클라이언트는 잠시 뒤 다시 연결됩니다' : ''}. (현재 v${APP.version})`].filter(Boolean).join('\n\n'),
    });
    if (r.response === 0) await (pack ? downloadsPage() : installUpdate());
  } finally { askingUpdate = false; }
}
// Asked once per profile (the mark file); with yes Windows asks for an administrator's consent at once,
// as Chrome Remote Desktop's installer does for its service. Never during a remote session.
function offerAssist() {
  if (!win || win.isDestroyed()) return;
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('assist-changed', m); };
  assist.offer({
    mark: path.join(app.getPath('userData'), 'assist-offered.json'),
    remote: () => sessionLive,
    notify: send,
    ask: async () => (await dialog.showMessageBox(win, {
      type: 'question', title: 'My Remote Host', noLink: true, defaultId: 0, cancelId: 1,
      message: '잠금 화면에서도 원격 조종을 켤까요? (권장)',
      detail: '켜 두면 이 PC가 잠겨 있을 때도 다른 PC에서 잠금 화면을 보고 비밀번호를 입력해 잠금을 풀 수 있습니다. Chrome 원격 데스크톱과 같은 방식이고, 비밀번호는 그대로 필요합니다.\n\n' +
        '"켜기"를 누르면 Windows가 관리자 승인(UAC)을 한 번 묻습니다. 나중에 이 창의 "잠금 화면에서도 원격 조종"에서 켜거나 끌 수 있습니다.',
      buttons: ['켜기 (권장)', '나중에'],
    })).response === 0,
  }).then((r) => console.log('[assist] offered at the first start: ' + r), (e) => console.error('[assist] offer', e));
}
let crashes = [], reloadTimer = null;
function reloadCrashedPage() {
  clearTimeout(reloadTimer);
  if (win && !win.isDestroyed() && win.webContents.isCrashed()) win.loadFile(path.join(__dirname, 'host.html'));
}
function createTray() {
  tray = new Tray(icon(false));
  tray.setToolTip('My Remote Host — 대기 중');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showWindow },
    { label: '원격 연결 끊기', click: () => win && win.webContents.send('kick') },
    // From a source folder: the code on disk (git pull). The installed app: a look at the update feed.
    APP && APP.update ? { label: '업데이트 확인', click: () => { showWindow(); APP.update.check().then(askUpdate); } } : { label: '다시 시작 (업데이트 적용)', click: restart },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

if (SHOW_KEY) app.whenReady().then(showKey);
else if (!ISOLATED && !app.requestSingleInstanceLock()) app.quit();
else {
  // Started again: after an update restart; while the page waits to be loaded again after a crash, at once.
  app.on('second-instance', () => { oneEntry(); if (codeStamp() !== startedStamp) restart(); else { reloadCrashedPage(); showWindow(); } });
  app.on('before-quit', () => { quitting = true; markQuit(); assist.stop(); input.reset(); setCursorsHidden(false); clearKeyClip(); runningMark(false); });
  process.on('exit', () => { if (cursorsHidden) input.restoreCursors(); });
  app.whenReady().then(async () => {
    // The code is newer than the Electron it runs on: it was updated (git pull) without setup.ps1/setup.sh.
    const pkg = require('./package.json'), wanted = Number((/(\d+)/.exec((pkg.devDependencies || {}).electron || (pkg.dependencies || {}).electron || '') || [])[1]) || 0;
    // (Not in the installed app: there a version only runs on a shell it was made for.)
    const oldElectron = !APP && wanted && Number(process.versions.electron.split('.')[0]) < wanted ? process.versions.electron : '';
    if (oldElectron) console.warn(`[host] WARNING: this code expects Electron ${wanted}, but runs on ${oldElectron}: run setup.ps1 (Linux: ./setup.sh) to finish the update`);
    await loadConfig();
    // Waiting for the person's answer about a key that cannot be read is this PC's trouble, not this
    // version's: the installed app's shell must not take the wait for a version that does not come up.
    if (!cfg.key && APP && !ISOLATED) APP.ok();
    if (!cfg.key && !(await askForKey())) { quitting = true; app.quit(); return; }
    cfg.hostOs = hostOs();
    cfg.updateNote = oldElectron ? `업데이트가 덜 끝났습니다: 코드는 Electron ${wanted}용인데 ${oldElectron}에서 돌고 있습니다. 호스트를 끄고 ${process.platform === 'win32' ? 'setup.ps1' : './setup.sh'}을 실행한 뒤 다시 시작하세요.` : '';
    cfg.viewOnly = input.viewOnlyReason(); // '' = input from the client is injected here
    if (cfg.viewOnly) console.warn(`[host] WARNING: the host is view-only, input from the client is not injected: ${cfg.viewOnly}`);
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
    ipcMain.handle('client-hash', () => getClientApp().hash); // a session needs only this, not the 250 KB page
    ipcMain.on('sources-failed', () => forgetSources()); // a capture could not use the list: ask Windows again next time
    // Measurements of each session (numbers only), for finding out why something felt slow.
    const diagFile = path.join(app.getPath('userData'), 'diag.log');
    const diagWrite = (entry) => {
      try {
        if (fs.existsSync(diagFile) && fs.statSync(diagFile).size > 3 * 1024 * 1024) fs.renameSync(diagFile, diagFile.replace(/\.log$/, '.old.log'));
        fs.appendFileSync(diagFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
      } catch {}
    };
    // Pauses of the main thread itself (see timed() above).
    let tick = performance.now();
    setInterval(() => { const now = performance.now(), late = now - tick - 500; tick = now; if (late > 1000) note('paused', late); }, 500);
    const takeSlow = () => {
      const keys = Object.keys(slow);
      if (!keys.length) return null;
      const o = {};
      for (const k of keys) { o[k] = { n: slow[k].n, ms: Math.round(slow[k].ms), max: Math.round(slow[k].max) }; delete slow[k]; }
      return o;
    };
    ipcMain.on('input', (_e, text) => { if (clipWriting) inputWaiting.push(text); else injectInput(text); });
    ipcMain.on('log', (_e, text) => console.log('[host]', text));
    ipcMain.on('diag', (_e, entry) => {
      const s = takeSlow(), r = input.takeReleased();
      diagWrite({ ...entry, ...(s ? { slow: s } : {}), ...(r ? { released: r } : {}) });
    });
    // Another remote-control program connected to this PC at the same time: Chrome Remote Desktop runs
    // remoting_desktop.exe only while one of its sessions is connected. Stalls of this process's input
    // were seen to end exactly when such a session (re)connected, so the client is told. Also whether
    // windows are dragged as an outline only, which does not look like dragging at the real desk.
    // Asked every 10 s of a session; a snapshot of the process list, taken off this thread (Windows
    // only; elsewhere false).
    ipcMain.handle('others', async () => {
      let crd = false, outline = false;
      try { outline = !input.dragFullWindows(); crd = (await input.processRunning('remoting_desktop.exe')) === true; } catch (e) { console.error('others', e.message); }
      return { crd, outline };
    });
    // The lock screen is on a desktop this program cannot see or control; the client is told
    // ('lock' in host.js). Windows and macOS report locking; elsewhere it is never reported.
    let screenLocked = false;
    const lockChanged = (on) => { screenLocked = on; if (win && !win.isDestroyed()) win.webContents.send('host-lock', on); };
    powerMonitor.on('lock-screen', () => lockChanged(true));
    powerMonitor.on('unlock-screen', () => lockChanged(false));
    powerMonitor.on('shutdown', markQuit); // Linux and macOS: the system goes down, not a crash (the watchdog leaves it)
    ipcMain.handle('host-locked', () => { try { return powerMonitor.getSystemIdleState(1) === 'locked'; } catch { return screenLocked; } });
    // `nudge`: the pointer a pixel aside and back first (see input.nudge), while the client waits to learn
    // whether its drag became a drag-and-drop here.
    ipcMain.handle('dragging', (_e, nudge) => timed('dragging', () => { try { if (nudge) input.nudge(); return input.dragging(); } catch { return false; } }));
    // Asked about 30 times a second while a client is connected. `last`: the cursor the page already
    // has; then its picture (a data URL of up to tens of KB) is not copied over again.
    ipcMain.handle('cursor', (_e, last) => timed('cursor', () => {
      try {
        const c = currentCursor(), drag = input.dragging();
        if (last != null && c.k === last) { const { img, ...same } = c; return { ...same, drag }; }
        return { ...c, drag };
      } catch { return { k: '0', c: 'default', drag: false }; }
    }));
    // What the drag under way carries, for the client app to show beside the pointer while it is carried
    // out: files as their number and the first one's name (never a path), or that it is text. Only where
    // the dragging program can be asked without ending its drag (X11, as a drop target asks); else null.
    ipcMain.handle('drag-what', async () => {
      try {
        const d = await input.dragData();
        if (d && d.paths && d.paths.length) return { kind: 'files', n: d.paths.length, name: path.basename(d.paths[0]).slice(0, 80) };
        if (d && d.text) return { kind: 'text' };
      } catch {}
      return null;
    });
    ipcMain.handle('drag-out', async (_e, button) => {
      // Local trials never press keys on this PC, except the opt-in drag-out check (dragcheck.js).
      if (ISOLATED && !process.argv.includes('--dragout-check')) return { kind: 'none', why: 'not in a local trial' };
      try { return await dragOut(button | 0); } catch (e) { console.error('drag out', e); try { input.buttonUp(button | 0); } catch {} return { kind: 'none', why: 'error' }; }
    });
    ipcMain.handle('drag-file-read', async (_e, id, offset, len) => {
      try { return await readDragFile(id, offset, len); } catch (e) { console.error('drag file read', e.message); return null; }
    });
    ipcMain.on('drag-file-done', (_e, id) => closeDragFiles(id == null ? null : String(id)));
    const guard = (what, fn, none) => async (...a) => { try { return await fn(...a); } catch (e) { console.error(what, e.message); return none; } };
    ipcMain.handle('put-begin', guard('put begin', () => putBegin(), null));
    ipcMain.handle('put-dir', guard('put dir', (_e, gid, name) => putDir(gid, name), false));
    ipcMain.handle('put-file', guard('put file', (_e, gid, name, size) => putFile(gid, name, size), null));
    ipcMain.handle('put-chunk', guard('put chunk', (_e, fid, bytes) => putChunk(fid, bytes), false));
    ipcMain.handle('put-end', guard('put end', (_e, fid) => putEnd(fid), false));
    ipcMain.handle('put-done', guard('put done', (_e, gid, at, mode) => putDone(gid, at, mode), { how: 'none', why: 'error' }));
    ipcMain.handle('put-abort', guard('put abort', (_e, gid) => putAbort(gid), false));
    ipcMain.handle('cursor-hide', (_e, on) => timed('cursor-hide', () => { try { setCursorsHidden(!!on && !!cfg.hideHostCursor); } catch (e) { console.error('cursor hide', e); } return cursorsHidden; }));
    // Only touch the clipboard when its content actually changed.
    ipcMain.handle('clip-read', async (_e, lastSeq) => {
      if (!cfg.clipboard) return { seq: 0 };
      const seq = input.clipSeq();
      if (seq === lastSeq) return { seq };
      // Never passed on: the access key put there by 키 복사 (it must not end up on the client, nor in
      // its clipboard history), and what a drag-out copied (the drag hands it over already).
      if ((keyOnClip && seq === keyOnClip.seq) || seq === dragCopySeq) return { seq };
      const files = await clipFilesNow(seq);
      if (files) return files.own ? { seq } : { seq, files };
      if (await input.clipboardPrivate()) return { seq }; // a password manager's: not passed on to the client
      const text = String((await timedAsync('clip-read', () => clipboard.readText())) || '');
      if (cfg.key && text.trim() === cfg.key) return { seq }; // the key however it got there (Linux counts changes late)
      return { seq, text: text.length <= CLIP_MAX ? text : '' }; // longer text is not sent to the client: not copied to the page either
    });
    ipcMain.handle('clip-get', async (_e, seq) => { try { return await clipGet(Number(seq)); } catch (e) { console.error('clip get', e.message); return { kind: 'none', why: 'error' }; } });
    ipcMain.on('clip-write', (_e, text) => {
      if (!cfg.clipboard || typeof text !== 'string' || text.length > CLIP_MAX) return;
      const id = (clipWriting = ++clipWrites);
      setTimeout(() => releaseInput(id), 500); // the input never waits longer than that
      timedAsync('clip-write', () => clipboard.writeText(text)).catch((e) => console.error('clip write', e.message)).finally(() => releaseInput(id));
    });
    ipcMain.on('session', (_e, live) => {
      sessionLive = !!live;
      setTray(!!live);
      if (!live) setTimeout(followNewer, 3000); // a version the client app installed meanwhile: now (the client may reconnect first)
      if (live && shellLook) shellLook.abort(); // a new shell is fetched another time, not over the session's bandwidth
      if (!live) setTimeout(shellSwapIfFits, 60e3); // a new shell staged: swapped once the client has not reconnected for a minute
      if (live && !SELFTEST && !BENCH && Notification.isSupported()) new Notification({ title: 'My Remote Host', body: '원격 접속이 시작되었습니다.' }).show();
      // The assist service, when installed: the lock screen for the session's client. Not in the
      // automated runs (the self-test and the bench must not depend on what this PC has installed).
      if (assist.supported && !SELFTEST && !BENCH) {
        if (live) assist.start((m) => { if (win && !win.isDestroyed()) win.webContents.send('assist', m); });
        else assist.stop();
      }
    });
    ipcMain.handle('assist-status', () => assist.status());
    // Never during a remote session: Windows' consent prompt cannot be answered from the client (assist.install).
    ipcMain.handle('assist-install', () => assist.install({ remote: sessionLive }));
    ipcMain.handle('assist-uninstall', () => assist.uninstall({ remote: sessionLive }));
    ipcMain.on('assist-sas', () => assist.sas());
    // Updates of the installed app (see updateInfo above). A required update restarts the host by
    // itself: not in the middle of a remote session (the shell waits for it to end, half an hour at most).
    ipcMain.handle('update-status', updateInfo);
    // ask: the person pressed "업데이트 확인", so an update found is asked about at once (askUpdate), as
    // the client app does; not waited for, so that the window can say what the check found meanwhile.
    ipcMain.handle('update-check', async (_e, ask) => { if (APP && APP.update) { await APP.update.check(); if (ask) askUpdate(); } return updateInfo(); });
    ipcMain.handle('update-install', installUpdate);
    ipcMain.handle('update-page', downloadsPage);
    if (APP && APP.update) {
      APP.update.setCanRestart(() => { if (sessionLive) return false; quitting = true; return true; });
      APP.update.onChange(() => { if (win && !win.isDestroyed()) win.webContents.send('update-changed', updateInfo()); });
    }
    ipcMain.handle('copy-key', async () => {
      if (keyOnClip) clearTimeout(keyOnClip.timer);
      keyOnClip = null;
      const before = input.clipSeq();
      await clipboard.writeText(cfg.key);
      // X11 counts a change when the X server's event about it has been read, which may be a moment after
      // the write: the count is taken once it has moved (Windows' has by now).
      let seq = input.clipSeq();
      for (let i = 0; i < 20 && seq === before && process.platform !== 'win32'; i++) { await new Promise((r) => setTimeout(r, 25)); seq = input.clipSeq(); }
      keyOnClip = { seq, timer: setTimeout(clearKeyClip, 60e3) }; // see clearKeyClip
      return true;
    });
    ipcMain.handle('regen-key', async () => {
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['취소', '새 키 발급'], defaultId: 0, cancelId: 0,
        message: '접속 키를 새로 발급할까요?',
        detail: '기존 키로는 더 이상 접속할 수 없게 됩니다.' + (cfgIssue ? '\n\n설정 파일을 읽지 못한 상태라 새 파일에는 접속 키만 저장됩니다. 원래 파일은 사본으로 남겨 둡니다.' : ''),
      });
      if (r.response !== 1) return false;
      const key = newKey();
      try { await saveConfig(key); } catch (e) {
        console.error('[host] saving a new key failed:', e.code || e.message);
        dialog.showMessageBox(win, { type: 'error', message: '새 키를 저장하지 못했습니다', detail: `${e.code || e.message}\n\n기존 키를 그대로 씁니다.` }).catch(() => {});
        return false;
      }
      cfg.key = key; // only once it is saved
      // The session under way ends first, and its client is told not to come back (its key no longer
      // works); then the page starts over with the new key.
      win.webContents.send('kick');
      setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 400);
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
    // A config file with a mistake in it that still held a usable key: this host runs on the default
    // settings until it is fixed, and says so. (Without a usable key it asked before starting.)
    if (cfgIssue) {
      dialog.showMessageBox({
        type: 'warning', title: 'My Remote Host', noLink: true, message: '설정 파일을 읽지 못해 기본 설정으로 실행합니다',
        detail: `${cfgIssue}\n\n접속 키는 파일에서 찾아 그대로 쓰므로 원격 접속은 계속 됩니다. 파일은 바꾸지 않았습니다. 고친 뒤 트레이 메뉴의 '다시 시작'을 누르면 설정이 적용됩니다.\n\n${cfgPath()}`,
      }).catch(() => {});
    }
    // Monitor plugged/unplugged or resolution changed: the renderer renegotiates the session.
    let displayTimer = null;
    const displaysChanged = () => {
      forgetSources();
      clearTimeout(displayTimer);
      displayTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('displays-changed'); }, 1500);
    };
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', (_e, _d, changed) => { if (changed.some((c) => c !== 'workArea')) displaysChanged(); });
    if (!ISOLATED) createTray();
    if (!ISOLATED) {
      runningMark(true);
      if (APP) {
        // The client face installed a newer version: this host follows when no remote session is on (see 'session').
        appsync.watch({ running: APP.version, onNewer: (v) => { newerVersion = v; console.log(`[host] version ${v} was installed by the client app: restarting into it when no session is on`); followNewer(); } });
        oneEntry();
        shellSetup();
      }
    }
    if (SHELL_SWAP_TRIAL) shellSetup(); // the test VM's end-to-end check of the swap (see SHELL_SWAP_TRIAL)
    if (SELFTEST) selftest.run({ cfg, buildClientHtml, buildLoaderHtml, app, offerFile, dragOut, closeDragFiles, listFolder });
    if (BENCH) require('./bench').run({ cfg, bench: benchCfg, buildClientHtml, app });
    if (LOCALTEST) {
      const file = path.join(app.getPath('userData'), 'my-remote-localtest.html');
      fs.writeFileSync(file, buildLoaderHtml('k=' + cfg.key + '&auto&ro'));
      // Windows: the default browser (Edge or Chrome). Elsewhere that is often Firefox, which the client
      // page is not made for, so the client app (client/main.js) shows it, with a profile of its own.
      const open = () => {
        if (process.platform === 'win32') return shell.openPath(file);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        // (The installed app is one program with two faces: it is told which, not given a folder.)
        require('child_process').spawn(process.execPath, [APP ? '--client' : path.join(__dirname, '..', 'client'), '--loader=' + file, ...process.argv.filter((a) => a === '--no-sandbox')],
          { env, detached: true, stdio: 'ignore' }).unref();
      };
      // --no-client: a client elsewhere (a test harness on another machine) uses this trial instead; one
      // opened here would take the session over (a new hello replaces the current session) and back.
      if (!process.argv.includes('--no-client')) setTimeout(open, 2500); // after the host has subscribed
    }
  });
}
