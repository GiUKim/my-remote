// Native screen capture on X11 (Linux) for preload.js: the counterpart of native/capture.cpp, with the
// same calls (open, size, next, close, error), so the capture loops in preload.js, their repeats and
// host.js work as they do on Windows. Its point: the pictures have no pointer in them. The engine's
// capturer paints the pointer into every frame (Chromium's DesktopAndCursorComposer), so the client saw
// its own pointer and, a little later, the host's in the video trailing behind it. The X server leaves
// the pointer out of what is read here: a hardware cursor is never in the screen's memory, and a
// software cursor (Xvfb, some virtual machines) is taken out for the read (misprite).
//
// How: XDamage on the root window says that something was drawn and where (a connection of Xlib's);
// the monitor's part of the root window is then read with MIT-SHM into a shared memory segment
// (ShmGetImage, a connection of XCB's) and copied into the loop's buffer with memcpy (Electron's V8 does
// not allow an ArrayBuffer over memory it did not allocate: koffi.view ends the process). Nothing here
// blocks or runs on another thread: the screen read is sent, and its answer looked for on timers. A
// call that is still under way on another thread when the page goes away (a reload) would take the
// whole process with it, and a read of the screen takes a few milliseconds (the X server copies the
// picture, from the graphics card's memory with glamor).
//
// Libraries: libX11, libXdamage, libXfixes and libxcb-shm are all linked by Electron itself, so they
// are there wherever it runs; libxcb-damage, which would allow one connection, often is not.
'use strict';
const koffi = require('koffi');

const MAX = 8;         // capturers at once, one per monitor (as in capture.cpp)
const POLL_MS = 4;     // how often a capturer looks for news of a change (timers are clamped to 4 ms anyway)
const MIN_GAP_MS = 15; // between two reads of the same monitor: at most about 66 a second
const REPLY_MS = 2000; // a read the X server has not answered by then has failed

let L = null;          // the libraries' functions; false: not available here
let lastError = '';
const caps = new Array(MAX).fill(null);
let live = 0;          // capturers that hold their X connections and shared memory (opened, not yet let go)

function libs() {
  if (L !== null) return L;
  L = false;
  if (process.platform !== 'linux') return L;
  if (!process.env.DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') { lastError = 'no X11 display'; return L; }
  try {
    const x11 = koffi.load('libX11.so.6'), xd = koffi.load('libXdamage.so.1'), xf = koffi.load('libXfixes.so.3');
    const xcb = koffi.load('libxcb.so.1'), shm = koffi.load('libxcb-shm.so.0'), c = koffi.load('libc.so.6');
    // Types without names: this file may be loaded again in the same process (the page reloads).
    const Cookie = koffi.struct({ sequence: 'unsigned int' });
    const handler = koffi.proto(`int MrCapXError${process.hrtime.bigint()}(void *display, void *event)`);
    L = {
      XOpenDisplay: x11.func('void *XOpenDisplay(const char *name)'),
      XCloseDisplay: x11.func('int XCloseDisplay(void *dpy)'),
      XDefaultScreen: x11.func('int XDefaultScreen(void *dpy)'),
      XRootWindow: x11.func('unsigned long XRootWindow(void *dpy, int screen)'),
      XDefaultDepth: x11.func('int XDefaultDepth(void *dpy, int screen)'),
      XDisplayWidth: x11.func('int XDisplayWidth(void *dpy, int screen)'),
      XDisplayHeight: x11.func('int XDisplayHeight(void *dpy, int screen)'),
      XImageByteOrder: x11.func('int XImageByteOrder(void *dpy)'),
      XPending: x11.func('int XPending(void *dpy)'),
      XNextEvent: x11.func('int XNextEvent(void *dpy, void *event)'),
      XSelectInput: x11.func('int XSelectInput(void *dpy, unsigned long w, long mask)'),
      XFlush: x11.func('int XFlush(void *dpy)'),
      XSync: x11.func('int XSync(void *dpy, int discard)'),
      XFree: x11.func('int XFree(void *data)'),
      XSetErrorHandler: x11.func('XSetErrorHandler', 'void *', [koffi.pointer(handler)]),
      XDamageQueryExtension: xd.func('int XDamageQueryExtension(void *dpy, _Out_ int *event, _Out_ int *error)'),
      XDamageQueryVersion: xd.func('int XDamageQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)'),
      XDamageCreate: xd.func('unsigned long XDamageCreate(void *dpy, unsigned long drawable, int level)'),
      XDamageDestroy: xd.func('void XDamageDestroy(void *dpy, unsigned long damage)'),
      XDamageSubtract: xd.func('void XDamageSubtract(void *dpy, unsigned long damage, unsigned long repair, unsigned long parts)'),
      XFixesQueryExtension: xf.func('int XFixesQueryExtension(void *dpy, _Out_ int *event, _Out_ int *error)'),
      XFixesQueryVersion: xf.func('int XFixesQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)'),
      XFixesCreateRegion: xf.func('unsigned long XFixesCreateRegion(void *dpy, void *rects, int count)'),
      XFixesDestroyRegion: xf.func('void XFixesDestroyRegion(void *dpy, unsigned long region)'),
      XFixesFetchRegion: xf.func('void *XFixesFetchRegion(void *dpy, unsigned long region, _Out_ int *count)'),
      xcb_connect: xcb.func('void *xcb_connect(const char *display, _Out_ int *screen)'),
      xcb_disconnect: xcb.func('void xcb_disconnect(void *c)'),
      xcb_connection_has_error: xcb.func('int xcb_connection_has_error(void *c)'),
      xcb_generate_id: xcb.func('uint32_t xcb_generate_id(void *c)'),
      xcb_flush: xcb.func('int xcb_flush(void *c)'),
      xcb_poll_for_reply: xcb.func('int xcb_poll_for_reply(void *c, unsigned int request, _Out_ void **reply, _Out_ void **error)'),
      xcb_poll_for_event: xcb.func('void *xcb_poll_for_event(void *c)'),
      xcb_request_check: xcb.func('xcb_request_check', 'void *', ['void *', Cookie]),
      xcb_shm_attach_checked: shm.func('xcb_shm_attach_checked', Cookie, ['void *', 'uint32_t', 'uint32_t', 'uint8_t']),
      xcb_shm_detach: shm.func('xcb_shm_detach', Cookie, ['void *', 'uint32_t']),
      xcb_shm_get_image: shm.func('xcb_shm_get_image', Cookie, ['void *', 'uint32_t', 'int16_t', 'int16_t', 'uint16_t', 'uint16_t', 'uint32_t', 'uint8_t', 'uint32_t', 'uint32_t']),
      shmget: c.func('int shmget(int key, size_t size, int flags)'),
      shmat: c.func('void *shmat(int id, void *addr, int flags)'),
      shmdt: c.func('int shmdt(void *addr)'),
      shmctl: c.func('int shmctl(int id, int cmd, void *buf)'),
      memcpy: c.func('void *memcpy(void *dst, void *src, size_t n)'),
      // XCB's answers are let go of with XFree, never with libc's free looked up here: Chromium replaces
      // malloc in its processes (PartitionAlloc), XCB's malloc is that one, and libc's own free on such a
      // block ends the process. XFree is free() called from inside a library, so it finds the same one.
      release: (p) => L.XFree(p),
    };
    // Xlib's own error handler ends the process. Only this file uses Xlib in the page's process, and its
    // requests name nothing of other programs, so none is expected; one is noted, not fatal.
    L.onError = koffi.register(() => { lastError = 'X error'; return 0; }, koffi.pointer(handler));
    L.XSetErrorHandler(L.onError);
  } catch (e) { L = false; lastError = 'X11 capture libraries are not available: ' + e.message; }
  return L;
}

const UL = koffi.sizeof('unsigned long');
const XEVENT = 24 * UL; // sizeof(XEvent)
const CONFIGURE_NOTIFY = 22, STRUCTURE_NOTIFY_MASK = 1 << 17;
const REPORT_NON_EMPTY = 3; // XDamageReportNonEmpty: one event each time the damage stops being empty
const Z_PIXMAP = 2, ALL_PLANES = 0xffffffff, IPC_PRIVATE = 0, IPC_CREAT = 0o1000, IPC_RMID = 0;
const address = (p) => (p ? koffi.address(p) : 0n);

function fail(why) { lastError = why; return -1; }

// A capturer of the monitor at `rect` ({x, y, w, h} on the root window, as host.js knows it); its
// handle, or -1 (error() says why).
function openRect(rect) {
  const f = libs();
  if (!f) return -1;
  const h = caps.indexOf(null);
  if (h < 0) return fail('too many capturers');
  const c = { x: rect.x | 0, y: rect.y | 0, w: rect.w | 0, h: rect.h | 0, dpy: null, xc: null, addr: null, shmid: -1, seg: 0, damage: 0, region: 0,
    damageEvent: 0, ev: Buffer.alloc(XEVENT), rects: Buffer.alloc(64 * 8), dirty: 0, grabbedAt: -1e9, replyMs: 4, busy: false, closed: false };
  try {
    if (c.w <= 0 || c.h <= 0 || c.x < 0 || c.y < 0 || c.x + c.w > 32767 || c.y + c.h > 32767) { close1(c); return fail(`bad monitor rectangle ${JSON.stringify(rect)}`); }
    c.dpy = f.XOpenDisplay(null);
    if (!c.dpy) { close1(c); return fail(`cannot open the X display ${process.env.DISPLAY}`); }
    const scr = f.XDefaultScreen(c.dpy);
    c.root = f.XRootWindow(c.dpy, scr);
    const depth = f.XDefaultDepth(c.dpy, scr);
    // 8 bits per colour in 32-bit pixels, blue first in memory (VideoFrame 'BGRX'): depth 24 or 32 on a
    // little-endian X server. Deep colour (30) or 16-bit modes are left to the engine's capturer.
    if ((depth !== 24 && depth !== 32) || f.XImageByteOrder(c.dpy) !== 0) { close1(c); return fail(`unsupported pixel format (depth ${depth})`); }
    if (c.x + c.w > f.XDisplayWidth(c.dpy, scr) || c.y + c.h > f.XDisplayHeight(c.dpy, scr)) { close1(c); return fail('the monitor is not inside the X screen'); }
    const ev = [0], er = [0], maj = [1], min = [1];
    if (!f.XDamageQueryExtension(c.dpy, ev, er) || !f.XDamageQueryVersion(c.dpy, maj, min)) { close1(c); return fail('the X server has no DAMAGE extension'); }
    c.damageEvent = ev[0]; // XDamageNotify is DAMAGE's first event
    const fe = [0], fr = [0], fmaj = [2], fmin = [0];
    if (!f.XFixesQueryExtension(c.dpy, fe, fr) || !f.XFixesQueryVersion(c.dpy, fmaj, fmin) || fmaj[0] < 2) { close1(c); return fail('the X server has no XFIXES 2 extension'); }
    c.region = f.XFixesCreateRegion(c.dpy, null, 0);
    c.damage = f.XDamageCreate(c.dpy, c.root, REPORT_NON_EMPTY);
    f.XSelectInput(c.dpy, c.root, STRUCTURE_NOTIFY_MASK); // a changed screen size (ConfigureNotify)
    f.XSync(c.dpy, 0);
    // The shared memory the X server writes the picture into: this user only, removed once both sides
    // have let go of it (also when this process dies).
    const bytes = c.w * c.h * 4;
    c.shmid = f.shmget(IPC_PRIVATE, bytes, IPC_CREAT | 0o600);
    if (c.shmid < 0) { close1(c); return fail('shmget failed'); }
    c.addr = f.shmat(c.shmid, null, 0);
    if (!c.addr || address(c.addr) === 0xffffffffffffffffn) { c.addr = null; close1(c); return fail('shmat failed'); }
    const scrOut = [0];
    c.xc = f.xcb_connect(null, scrOut);
    if (!c.xc || f.xcb_connection_has_error(c.xc)) { close1(c); return fail('cannot open an XCB connection'); }
    c.seg = f.xcb_generate_id(c.xc);
    const err = f.xcb_request_check(c.xc, f.xcb_shm_attach_checked(c.xc, c.seg, c.shmid, 0)); // read-write: the server writes into it
    if (err || f.xcb_connection_has_error(c.xc)) { if (err) f.release(err); c.seg = 0; close1(c); return fail('the X server cannot use shared memory (MIT-SHM) from here'); }
    f.shmctl(c.shmid, IPC_RMID, null);
    c.dirty = c.w * c.h; // the first call reads the whole picture at once, as DXGI's first frame does
    caps[h] = c;
    c.counted = true; live++;
    return h;
  } catch (e) { close1(c); return fail('opening the X11 capturer: ' + e.message); }
}

// Lets go of everything a capturer holds, once. `closed` (no more reads) may have been set before by
// close() for a capturer whose read was still under way; `freed` says that this has run.
function close1(c) {
  const f = L;
  if (!f || c.freed) return;
  c.freed = true;
  if (c.counted) live--;
  c.closed = true;
  try {
    if (c.xc) { if (c.seg) f.xcb_shm_detach(c.xc, c.seg); f.xcb_flush(c.xc); f.xcb_disconnect(c.xc); }
    if (c.addr) f.shmdt(c.addr);
    if (c.shmid >= 0) f.shmctl(c.shmid, IPC_RMID, null); // when the attach above did not get that far
    if (c.dpy) { if (c.damage) f.XDamageDestroy(c.dpy, c.damage); if (c.region) f.XFixesDestroyRegion(c.dpy, c.region); f.XCloseDisplay(c.dpy); }
  } catch (e) { console.error('closing the X11 capturer', e.message); }
  c.xc = null; c.addr = null; c.dpy = null;
}

// Reads what the X server has said since the last look: drawing (DAMAGE) and a changed screen size.
// Adds the changed area inside the monitor to c.dirty. -3: the monitor no longer fits on the screen.
function look(c) {
  const f = L;
  let damaged = false, result = 0;
  while (f.XPending(c.dpy) > 0) {
    f.XNextEvent(c.dpy, c.ev);
    const type = c.ev.readInt32LE(0) & 0x7f;
    if (type === c.damageEvent) damaged = true;
    else if (type === CONFIGURE_NOTIFY) {
      // XConfigureEvent: type, serial, send_event, display, event, window, x, y, width, height
      const off = UL === 8 ? 56 : 32, w = c.ev.readInt32LE(off), h = c.ev.readInt32LE(off + 4);
      if (c.x + c.w > w || c.y + c.h > h) result = -3;
    }
  }
  // An XCB connection queues errors of requests nobody waits for as events: let go of them.
  for (let e; (e = f.xcb_poll_for_event(c.xc)); ) f.release(e);
  if (damaged) {
    f.XDamageSubtract(c.dpy, c.damage, 0, c.region); // takes all of it, and the next drawing reports again
    const n = [0], rects = f.XFixesFetchRegion(c.dpy, c.region, n);
    if (rects) {
      if (n[0] > 0) {
        if (c.rects.length < n[0] * 8) c.rects = Buffer.alloc(n[0] * 8 * 2);
        const v = c.rects;
        f.memcpy(v, rects, n[0] * 8);
        for (let i = 0; i < n[0]; i++) { // XRectangle: short x, y; unsigned short width, height
          const x = v.readInt16LE(i * 8), y = v.readInt16LE(i * 8 + 2), w = v.readUInt16LE(i * 8 + 4), h = v.readUInt16LE(i * 8 + 6);
          const ix = Math.max(0, Math.min(x + w, c.x + c.w) - Math.max(x, c.x)), iy = Math.max(0, Math.min(y + h, c.y + c.h) - Math.max(y, c.y));
          c.dirty += ix * iy;
        }
      }
      f.XFree(rects);
    }
  }
  if (f.xcb_connection_has_error(c.xc)) { lastError = 'the XCB connection broke'; return -4; }
  return result;
}

// The monitor's picture, read into the shared memory and copied to buf; then done(1). The changed share
// of the picture goes to info[4], as capture.cpp gives it.
function grab(c, buf, info, done) {
  const f = L;
  const share = Math.min(1, c.dirty / (c.w * c.h));
  c.dirty = 0;
  const t0 = performance.now();
  c.grabbedAt = t0;
  const cookie = f.xcb_shm_get_image(c.xc, c.root, c.x, c.y, c.w, c.h, ALL_PLANES, Z_PIXMAP, c.seg, 0);
  f.xcb_flush(c.xc);
  const check = () => {
    if (c.closed) return done(-1);
    const reply = [null], error = [null];
    if (!f.xcb_poll_for_reply(c.xc, cookie.sequence, reply, error)) {
      if (performance.now() - t0 > REPLY_MS) { lastError = 'the X server did not answer a screen read'; return done(-4); }
      return void setTimeout(check, POLL_MS);
    }
    if (reply[0]) f.release(reply[0]);
    if (error[0]) f.release(error[0]);
    if (!reply[0]) {
      // BadMatch: the area is not on the screen any more (its size changed before the event came).
      const r = look(c);
      lastError = 'reading the screen failed';
      return done(r === -3 ? -3 : -4);
    }
    const ms = performance.now() - t0;
    c.replyMs = c.replyMs * 0.8 + ms * 0.2;
    f.memcpy(buf, c.addr, c.w * c.h * 4);
    const now = Date.now();
    info[0] = now - ms; info[1] = now - ms; info[2] = now; info[3] = 1; info[4] = share;
    done(1);
  };
  // The answer comes when the X server has copied the picture: look first when it usually has.
  setTimeout(check, Math.max(0, Math.round(c.replyMs) - 1));
}

// preload.js calls lib.next.async(handle, buf, len, timeoutMs, info, callback) as for the DLL. Waits up
// to timeoutMs for a change, then reads the picture into buf: 1 with a new picture, 0 when nothing
// changed, -1 closed, -3 the screen's size changed, -4 the capture failed (error() says why).
function nextAsync(h, buf, len, timeoutMs, info, cb) {
  const c = caps[h];
  if (!c || c.closed) return void cb(null, -1);
  if (c.busy) return void cb(null, 0);
  if (len < c.w * c.h * 4 || buf.length < c.w * c.h * 4) return void cb(null, -3);
  c.busy = true;
  const deadline = performance.now() + timeoutMs;
  const done = (r) => { c.busy = false; if (c.closeLater) { caps[h] = null; close1(c); } cb(null, c.closed ? -1 : r); };
  const tick = () => {
    if (c.closed) return done(-1);
    let r;
    try { r = look(c); } catch (e) { lastError = e.message; r = -4; }
    if (r < 0) return done(r);
    const now = performance.now(), since = now - c.grabbedAt;
    if (c.dirty > 0 && since >= MIN_GAP_MS) {
      try { return grab(c, buf, info, done); } catch (e) { lastError = e.message; return done(-4); }
    }
    if (now >= deadline) return done(0);
    setTimeout(tick, Math.min(c.dirty > 0 ? MIN_GAP_MS - since : POLL_MS, deadline - now));
  };
  tick();
}

function close(h) {
  const c = caps[h];
  if (!c) return;
  if (c.busy) { c.closeLater = true; c.closed = true; return; } // the call under way answers -1 and lets go
  caps[h] = null;
  close1(c);
}

module.exports = {
  available: () => !!libs(),
  openCount: () => live, // capturers that still hold their connections and memory (the self-test)
  openRect,
  size: (h, w, hh) => { const c = caps[h]; if (!c) return -1; w[0] = c.w; hh[0] = c.h; return 0; },
  next: { async: nextAsync },
  close,
  error: () => lastError,
};
