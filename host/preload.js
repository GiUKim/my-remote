const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  getConfig: () => ipcRenderer.invoke('cfg'),
  getSources: () => ipcRenderer.invoke('sources'),
  getClientApp: () => ipcRenderer.invoke('client-app'),
  input: (text) => ipcRenderer.send('input', text),
  log: (text) => ipcRenderer.send('log', text),
  diag: (entry) => ipcRenderer.send('diag', entry),
  dragOut: (button) => ipcRenderer.invoke('drag-out', button),
  dragFileRead: (id, offset, len) => ipcRenderer.invoke('drag-file-read', id, offset, len),
  dragFileDone: (id) => ipcRenderer.send('drag-file-done', id),
  cursor: () => ipcRenderer.invoke('cursor'),
  hideCursor: (on) => ipcRenderer.invoke('cursor-hide', on),
  readClip: (lastSeq) => ipcRenderer.invoke('clip-read', lastSeq),
  writeClip: (text) => ipcRenderer.send('clip-write', text),
  session: (live) => ipcRenderer.send('session', live),
  onKick: (fn) => ipcRenderer.on('kick', () => fn()),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays-changed', () => fn()),
  copyKey: () => ipcRenderer.invoke('copy-key'),
  regenKey: () => ipcRenderer.invoke('regen-key'),
  exportClient: () => ipcRenderer.invoke('export-client'),
  nativeCapture: () => !!capturer(),
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
let lib = null;
function capturer() {
  if (lib !== null) return lib;
  lib = false;
  try {
    const file = [path.join(__dirname, 'bin', 'capture.dll'), path.join(__dirname, '..', 'tools', 'native', 'capture.dll')].find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (file) {
      const dll = require('koffi').load(file);
      lib = {
        open: dll.func('int mc_open(int px, int py)'),
        size: dll.func('int mc_size(int handle, _Out_ int *width, _Out_ int *height)'),
        next: dll.func('int mc_next(int handle, uint8_t *dst, int dstLen, int timeoutMs, double *info)'),
        close: dll.func('void mc_close(int handle)'),
        error: dll.func('const char *mc_error()'),
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
// (seen on reload). Closing waits for the wait under way, which is at most REPEAT_MS long.
const loops = new Set();
window.addEventListener('beforeunload', () => { for (const r of [...loops]) r.stop(); });
function captureLoop(port, i, handle, width, height, gap) {
  const r = { on: true, alive: true, last: null, repeats: 0, stamp: 0, closed: false };
  const buf = new Uint8Array(width * height * 4), info = new Float64Array(4);
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
      try {
        let frame = null;
        if (got === 1) {
          frame = new VideoFrame(buf, { format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: stamp() });
          if (r.last) r.last.close();
          r.last = frame.clone();
          r.repeats = 0;
        } else if (r.last && r.repeats < REPEATS) {
          r.repeats++;
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
      const handle = c ? c.open(m.x, m.y) : -1;
      if (handle < 0) return port.postMessage({ t: 'opened', i: m.i, ok: false, error: c ? c.error() : 'no native capturer' });
      c.size(handle, w, h);
      runs.set(m.i, captureLoop(port, m.i, handle, w[0], h[0], m.gap || 0));
      port.postMessage({ t: 'opened', i: m.i, ok: true, width: w[0], height: h[0] });
    } else if (m.t === 'show') {
      const r = runs.get(m.i);
      if (r) { if (m.on && !r.on) r.repeats = 0; r.on = !!m.on; } // back on screen: the picture is sent again
    } else if (m.t === 'close') {
      for (const r of runs.values()) r.stop();
      runs.clear();
    }
  };
});
