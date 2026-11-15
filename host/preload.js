const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  getConfig: () => ipcRenderer.invoke('cfg'),
  getSources: () => ipcRenderer.invoke('sources'),
  getClientApp: () => ipcRenderer.invoke('client-app'),
  getClientHash: () => ipcRenderer.invoke('client-hash'),
  sourcesFailed: () => ipcRenderer.send('sources-failed'),
  input: (text) => ipcRenderer.send('input', text),
  log: (text) => ipcRenderer.send('log', text),
  diag: (entry) => ipcRenderer.send('diag', entry),
  dragOut: (button) => ipcRenderer.invoke('drag-out', button),
  dragFileRead: (id, offset, len) => ipcRenderer.invoke('drag-file-read', id, offset, len),
  dragFileDone: (id) => ipcRenderer.send('drag-file-done', id),
  cursor: (last) => ipcRenderer.invoke('cursor', last),
  dragging: (nudge) => ipcRenderer.invoke('dragging', !!nudge),
  dragWhat: () => ipcRenderer.invoke('drag-what'),
  putBegin: () => ipcRenderer.invoke('put-begin'),
  putDir: (gid, name) => ipcRenderer.invoke('put-dir', gid, name),
  putFile: (gid, name, size) => ipcRenderer.invoke('put-file', gid, name, size),
  putChunk: (fid, bytes) => ipcRenderer.invoke('put-chunk', fid, bytes),
  putEnd: (fid) => ipcRenderer.invoke('put-end', fid),
  putDone: (gid, at, mode) => ipcRenderer.invoke('put-done', gid, at, mode),
  putAbort: (gid) => ipcRenderer.invoke('put-abort', gid),
  hideCursor: (on) => ipcRenderer.invoke('cursor-hide', on),
  readClip: (lastSeq) => ipcRenderer.invoke('clip-read', lastSeq),
  clipGet: (seq) => ipcRenderer.invoke('clip-get', seq),
  writeClip: (text) => ipcRenderer.send('clip-write', text),
  session: (live) => ipcRenderer.send('session', live),
  onKick: (fn) => ipcRenderer.on('kick', () => fn()),
  onHostLock: (fn) => ipcRenderer.on('host-lock', (_e, on) => fn(!!on)),
  hostLocked: () => ipcRenderer.invoke('host-locked'),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays-changed', () => fn()),
  copyKey: () => ipcRenderer.invoke('copy-key'),
  regenKey: () => ipcRenderer.invoke('regen-key'),
  exportClient: () => ipcRenderer.invoke('export-client'),
  // The installed app's version and updates (main.js: updateInfo). `state` is 'none' when run from a source folder.
  update: {
    status: () => ipcRenderer.invoke('update-status'),
    check: (ask) => ipcRenderer.invoke('update-check', !!ask), // ask: the person pressed "업데이트 확인" (an update found is asked about)
    install: () => ipcRenderer.invoke('update-install'),
    page: () => ipcRenderer.invoke('update-page'),
    onChange: (fn) => ipcRenderer.on('update-changed', (_e, s) => fn(s)),
  },
  // The Windows assist service (host/assist.js): the lock screen and UAC prompts during a session, and
  // installing it (elevated: Windows asks the person at this PC).
  assist: {
    status: () => ipcRenderer.invoke('assist-status'),
    install: () => ipcRenderer.invoke('assist-install'),
    uninstall: () => ipcRenderer.invoke('assist-uninstall'),
    sas: () => ipcRenderer.send('assist-sas'),
    onMessage: (fn) => ipcRenderer.on('assist', (_e, m) => fn(m)),
    onChanged: (fn) => ipcRenderer.on('assist-changed', (_e, m) => fn(m)), // the offer at the first start: { busy } | { result }
  },
  nativeCapture: () => !!capturer(),
  nativeOpen: () => { const c = capturer(); return c && c.openCount ? c.openCount() : -1; }, // X11: capturers not let go yet (the self-test)
  // The self-test: new captures act as while the lock screen has the screen (Windows' DLL only; false elsewhere).
  nativeTestElsewhere: (on) => { const c = capturer(); if (!c || !c.testElsewhere) return false; c.testElsewhere(on ? 1 : 0); return true; },
  others: () => ipcRenderer.invoke('others'),
});

// ---- native screen capture (optional; native/capture.cpp) ---------------------------
// The capturer is a DLL reached through koffi. For every monitor a loop asks it for the next
// desktop image (the wait happens on a worker thread), wraps the pixels in a VideoFrame and hands
// that to the page over a message port; the page feeds the frames to the engine's encoder through
// a MediaStreamTrackGenerator (see host.js). When the screen stops changing, the last image is
// sent a number of times more, so the encoder can bring the still picture to full quality, and
// then nothing is sent at all.
const fs = require('fs');
const path = require('path');
const REPEATS = 45, REPEAT_MS = 20; // for about a second
// After a small change (under SMALL of the picture: a blinking caret, a typed character, a button
// that lights up) only FEW repeats: the rest of the picture is sharp already and that spot gets
// sharp within a few frames. With the full count, a caret blinking every half second kept a still
// monitor at about 50 frames a second for as long as it blinked.
const FEW = 6, SMALL = 0.01;
let lib = null;
function capturer() {
  if (lib !== null) return lib;
  lib = false;
  if (process.platform === 'linux') {
    // X11: the same calls, made in JavaScript (platform/x11capture.js): XDamage and MIT-SHM, no pointer in the picture
    try { const x = require('./platform/x11capture'); if (x.available()) lib = x; else console.warn('native capture is not available:', x.error()); } catch (e) { console.error('native capture is not available:', e.message); }
    return lib;
  }
  if (process.platform !== 'win32') return lib; // a Windows DLL (DXGI Desktop Duplication); elsewhere the engine's capturer is used
  try {
    const file = path.join(__dirname, 'bin', 'capture.dll'); // built by native/build.js, committed
    if (fs.existsSync(file)) {
      const dll = require('koffi').load(file);
      lib = {
        open: dll.func('int mc_open(int px, int py)'),
        size: dll.func('int mc_size(int handle, _Out_ int *width, _Out_ int *height)'),
        next: dll.func('int mc_next(int handle, uint8_t *dst, int dstLen, int timeoutMs, double *info)'),
        close: dll.func('void mc_close(int handle)'),
        error: dll.func('const char *mc_error()'),
        testElsewhere: dll.func('void mc_test_elsewhere(int on)'), // the self-test: act as on the lock screen
      };
      // A page that was here before in this process may have left capturers open (a monitor can only
      // be captured once per process): close whatever is left.
      for (let i = 0; i < 8; i++) lib.close(i);
    }
  } catch (e) { console.error('native capture is not available:', e.message); }
  return lib;
}
// Every loop that is running. They must all be closed before this page goes away: a wait that is
// still under way when the page's script environment is torn down takes the whole process with it
// (seen on reload). Closing waits for the wait under way, which is at most REPEAT_MS long (plus one
// try to start the capture again while the screen cannot be read).
const loops = new Set();
window.addEventListener('beforeunload', () => { for (const r of [...loops]) r.stop(); });
function captureLoop(port, i, handle, width, height, gap) {
  // left: repeats of the last image still to send. paused: the screen cannot be read right now.
  const r = { on: true, alive: true, last: null, left: 0, paused: false, stamp: 0, closed: false };
  const buf = new Uint8Array(width * height * 4), info = new Float64Array(5);
  const stamp = () => (r.stamp = Math.max(r.stamp + 1, Math.round(performance.now() * 1000)));
  const end = () => {
    if (r.closed) return;
    r.closed = true;
    loops.delete(r);
    try { lib.close(handle); } catch {}
    if (r.last) { r.last.close(); r.last = null; }
  };
  r.stop = () => { r.alive = false; end(); };
  loops.add(r);
  const step = () => {
    if (!r.alive) return end();
    if (!r.on) return void setTimeout(step, 100); // not on screen at the client: no capture at all
    lib.next.async(handle, buf, buf.length, REPEAT_MS, info, (err, got) => {
      if (!r.alive) return end();
      if (err || got < 0) {
        r.alive = false;
        end();
        port.postMessage({ t: 'failed', i, error: err ? String(err.message || err) : got === -2 ? 'hdr' : got === -3 ? 'size' : lib.error() });
        return;
      }
      // 2: the lock screen or a permission prompt has the screen, or the capturer is starting again
      // after a mode change or a reset of the graphics card. It goes on trying by itself (and gives up
      // with -4 only when that does not come back), so the session stays and the picture waits.
      if ((got === 2) !== r.paused) {
        r.paused = got === 2;
        port.postMessage({ t: 'paused', i, on: r.paused, error: r.paused ? lib.error() : '' });
      }
      try {
        let frame = null;
        if (got === 1) {
          frame = new VideoFrame(buf, { format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: stamp() });
          if (r.last) r.last.close();
          r.last = frame.clone();
          r.left = Math.max(r.left, info[4] < SMALL ? FEW : REPEATS); // a series under way is not cut short
        } else if (r.last && r.left > 0) {
          r.left--;
          frame = new VideoFrame(r.last, { timestamp: stamp() });
        }
        if (frame) port.postMessage({ t: 'frame', i, frame, presented: got === 1 ? info[0] : 0 }, [frame]);
      } catch (e) { console.error('native capture frame', e); }
      if (gap > 0 && got === 1) setTimeout(step, gap); else step();
    });
  };
  step();
  return r;
}
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== 'mr-native-capture' || !e.ports[0]) return;
  const port = e.ports[0], runs = new Map();
  port.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.t === 'open') {
      const c = capturer(), w = [0], h = [0];
      // The DLL finds the monitor from a point inside it; X11 is told its rectangle on the root window.
      const handle = !c ? -1 : c.openRect ? (m.rect ? c.openRect(m.rect) : -1) : c.open(m.x, m.y);
      if (handle < 0) return port.postMessage({ t: 'opened', i: m.i, ok: false, error: c ? c.error() : 'no native capturer' });
      // waiting: the lock screen or a permission prompt has the screen; the loop reports 'paused' until it can read it.
      const waiting = c.size(handle, w, h) === 2;
      runs.set(m.i, captureLoop(port, m.i, handle, w[0], h[0], m.gap || 0));
      port.postMessage({ t: 'opened', i: m.i, ok: true, width: w[0], height: h[0], waiting });
    } else if (m.t === 'show') {
      // Sent whenever the encoding was set (the connection is up, the monitor came on screen, its
      // size changed): the last image goes again with a full series of repeats. The encoder drops
      // what comes before it runs, works at a new size only from the next frame on, and cannot ask
      // the page for a frame, so a monitor whose picture does not change would otherwise stay black
      // or blurred on the client until something on it changed.
      const r = runs.get(m.i);
      if (r) { if (m.on) r.left = REPEATS; r.on = !!m.on; }
    } else if (m.t === 'close') {
      for (const r of runs.values()) r.stop();
      runs.clear();
    }
  };
});
