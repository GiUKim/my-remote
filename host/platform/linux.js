// Linux (X11) for input.js, through koffi: XTest injects the pointer, the buttons, the wheel and the
// keys; XFixes gives the cursor's name and picture and says when someone takes the clipboard or starts
// a drag-and-drop. One X connection of its own ($DISPLAY), opened at first use. Without one (no
// DISPLAY, a Wayland session, libXtst missing) every function returns the neutral value of input.js
// and viewOnlyReason() says why. Wayland is not supported: there, injecting input and capturing the
// screen go through the desktop's portals, which this program does not use.
//
// Xlib's default error handler ends the process. The calls that can fail at all are the ones that
// name a window of another program (it may close in between); they run inside guarded(), which
// counts the error instead. Everything runs on the main thread of the process that loads this.
const koffi = require('koffi');
const url = require('url');

const UL = koffi.sizeof('unsigned long');
const readUL = (buf, off) => (UL === 8 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off));
const CursorImage = koffi.struct('XFixesCursorImage', {
  x: 'short', y: 'short', width: 'unsigned short', height: 'unsigned short', xhot: 'unsigned short', yhot: 'unsigned short',
  cursor_serial: 'unsigned long', pixels: 'void *', atom: 'unsigned long', name: 'const char *',
});
const SelectionNotify = koffi.struct('XFixesSelectionNotifyEvent', {
  type: 'int', serial: 'unsigned long', send_event: 'int', display: 'void *', window: 'unsigned long',
  subtype: 'int', owner: 'unsigned long', selection: 'unsigned long', timestamp: 'unsigned long', selection_timestamp: 'unsigned long',
});
const SelectionEvent = koffi.struct('MrXSelectionEvent', { // XSelectionEvent: the answer to XConvertSelection
  type: 'int', serial: 'unsigned long', send_event: 'int', display: 'void *', requestor: 'unsigned long',
  selection: 'unsigned long', target: 'unsigned long', property: 'unsigned long', time: 'unsigned long',
});
const ErrorHandler = koffi.proto('int MrXErrorHandler(void *display, void *event)');

let X = null; // { dpy, f, ... } once open, false when there is no usable display
let why = '';
let errors = 0;
function open() {
  if (X !== null) return X;
  X = false;
  if (process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY)) { why = 'Wayland session (only X11 sessions are supported)'; return X; }
  if (!process.env.DISPLAY) { why = 'no X11 display (DISPLAY is not set)'; return X; }
  try {
    const x11 = koffi.load('libX11.so.6'), xtst = koffi.load('libXtst.so.6');
    const f = {
      XOpenDisplay: x11.func('void *XOpenDisplay(const char *name)'),
      XDefaultScreen: x11.func('int XDefaultScreen(void *dpy)'),
      XRootWindow: x11.func('unsigned long XRootWindow(void *dpy, int screen)'),
      XFlush: x11.func('int XFlush(void *dpy)'),
      XSync: x11.func('int XSync(void *dpy, int discard)'),
      XPending: x11.func('int XPending(void *dpy)'),
      XNextEvent: x11.func('int XNextEvent(void *dpy, void *event)'),
      XInternAtom: x11.func('unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)'),
      XGetSelectionOwner: x11.func('unsigned long XGetSelectionOwner(void *dpy, unsigned long selection)'),
      XQueryPointer: x11.func('int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)'),
      XQueryTree: x11.func('int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *count)'),
      XGetWindowProperty: x11.func('int XGetWindowProperty(void *dpy, unsigned long w, unsigned long property, long offset, long length, int del, unsigned long type, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *count, _Out_ unsigned long *bytesAfter, _Out_ void **data)'),
      XFree: x11.func('int XFree(void *data)'),
      XDisplayKeycodes: x11.func('int XDisplayKeycodes(void *dpy, _Out_ int *min, _Out_ int *max)'),
      XGetPointerMapping: x11.func('int XGetPointerMapping(void *dpy, uint8_t *map, int count)'),
      XSetErrorHandler: x11.func('MrXErrorHandler *XSetErrorHandler(MrXErrorHandler *handler)'),
      XCreateSimpleWindow: x11.func('unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int width, unsigned int height, unsigned int border, unsigned long borderColour, unsigned long background)'),
      XConvertSelection: x11.func('int XConvertSelection(void *dpy, unsigned long selection, unsigned long target, unsigned long property, unsigned long requestor, unsigned long time)'),
      XTestQueryExtension: xtst.func('int XTestQueryExtension(void *dpy, _Out_ int *event, _Out_ int *error, _Out_ int *major, _Out_ int *minor)'),
      XTestFakeMotionEvent: xtst.func('int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)'),
      XTestFakeButtonEvent: xtst.func('int XTestFakeButtonEvent(void *dpy, unsigned int button, int press, unsigned long delay)'),
      XTestFakeKeyEvent: xtst.func('int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int press, unsigned long delay)'),
    };
    const dpy = f.XOpenDisplay(null);
    if (!dpy) { why = `cannot open the X11 display ${process.env.DISPLAY}`; return X; }
    const n = [0], m = [0], k = [0], l = [0];
    if (!f.XTestQueryExtension(dpy, n, m, k, l)) { why = 'the X server has no XTEST extension'; return X; }
    const min = [8], max = [255];
    f.XDisplayKeycodes(dpy, min, max);
    const atom = (name) => f.XInternAtom(dpy, name, 0);
    X = {
      dpy, f, root: f.XRootWindow(dpy, f.XDefaultScreen(dpy)),
      keycodes: [min[0], max[0]], buttons: f.XGetPointerMapping(dpy, Buffer.alloc(256), 0),
      atoms: {
        CLIPBOARD: atom('CLIPBOARD'), XdndSelection: atom('XdndSelection'), WM_STATE: atom('WM_STATE'), WM_CLASS: 67, WM_NAME: 39, STRING: 31,
        _NET_WM_NAME: atom('_NET_WM_NAME'), _NET_WM_WINDOW_TYPE: atom('_NET_WM_WINDOW_TYPE'), _NET_WM_WINDOW_TYPE_DESKTOP: atom('_NET_WM_WINDOW_TYPE_DESKTOP'),
        TARGETS: atom('TARGETS'), INCR: atom('INCR'), URI_LIST: atom('text/uri-list'), UTF8_STRING: atom('UTF8_STRING'),
        TEXT_UTF8: atom('text/plain;charset=utf-8'), TEXT_PLAIN: atom('text/plain'), DATA: atom('MY_REMOTE_DND_DATA'),
      },
      requestor: 0, // a window of ours that selection data is sent to (made when first needed)
      event: Buffer.alloc(24 * UL), // sizeof(XEvent)
      fixes: null,
      onError: koffi.register(() => { errors++; return 0; }, koffi.pointer(ErrorHandler)),
    };
    // XFixes: the cursor, and who takes the clipboard or a drag-and-drop selection. Optional.
    try {
      const xf = koffi.load('libXfixes.so.3');
      const ff = {
        XFixesQueryExtension: xf.func('int XFixesQueryExtension(void *dpy, _Out_ int *event, _Out_ int *error)'),
        XFixesQueryVersion: xf.func('int XFixesQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)'),
        XFixesGetCursorImage: xf.func('void *XFixesGetCursorImage(void *dpy)'),
        XFixesSelectSelectionInput: xf.func('void XFixesSelectSelectionInput(void *dpy, unsigned long w, unsigned long selection, unsigned long mask)'),
      };
      const ev = [0], er = [0], maj = [5], mnr = [0];
      if (ff.XFixesQueryExtension(dpy, ev, er) && ff.XFixesQueryVersion(dpy, maj, mnr) && maj[0] >= 2) {
        X.fixes = { ...ff, event: ev[0] }; // XFixesSelectionNotify is the first XFixes event
        for (const s of [X.atoms.CLIPBOARD, X.atoms.XdndSelection]) ff.XFixesSelectSelectionInput(dpy, X.root, s, 1); // SetSelectionOwnerNotifyMask
        f.XFlush(dpy);
        setInterval(pump, 2000).unref(); // events are read when needed; this keeps them from piling up meanwhile
      }
    } catch (e) { console.error('XFixes is not available:', e.message); }
  } catch (e) {
    X = false;
    why = 'X11 libraries are not available (' + e.message + ')';
  }
  return X;
}
const viewOnlyReason = () => (open() ? '' : why);

// Calls that may name a window that is gone by now: an X error is counted, not fatal.
function guarded(fn, fallback) {
  const x = open();
  if (!x) return fallback;
  const prev = x.f.XSetErrorHandler(x.onError);
  try { return fn(x); } catch (e) { console.error('X11', e.message); return fallback; } finally { x.f.XSync(x.dpy, 0); x.f.XSetErrorHandler(prev); }
}

// ---- selections: the clipboard, and drag-and-drop -----------------------------------
// A drag-and-drop on X11 (XDND) is under way while its source owns the XdndSelection selection. A
// source may keep that selection after its drag has ended, so owning it is not enough: the owner
// must have taken it while a button pressed through here was still held. XFixes reports every
// change of owner as an event; before each first press the events so far are read and forgotten.
let held = 0;          // bit n = X button n is held through this module
let dndSincePress = false;
let clipChanges = 0;
const answers = [];    // SelectionNotify events: answers to convert()
const SEL = { owner: koffi.offsetof(SelectionNotify, 'owner'), selection: koffi.offsetof(SelectionNotify, 'selection') };
const ANS = { requestor: koffi.offsetof(SelectionEvent, 'requestor'), target: koffi.offsetof(SelectionEvent, 'target'), property: koffi.offsetof(SelectionEvent, 'property') };
function pump() {
  const x = open();
  if (!x) return;
  while (x.f.XPending(x.dpy) > 0) {
    x.f.XNextEvent(x.dpy, x.event);
    const type = x.event.readInt32LE(0);
    if (type === 31) { // SelectionNotify
      answers.push({ requestor: readUL(x.event, ANS.requestor), target: readUL(x.event, ANS.target), property: readUL(x.event, ANS.property) });
      if (answers.length > 16) answers.shift();
    }
    if (!x.fixes || type !== x.fixes.event) continue;
    const sel = readUL(x.event, SEL.selection), owner = readUL(x.event, SEL.owner);
    if (sel === x.atoms.CLIPBOARD) clipChanges++;
    else if (sel === x.atoms.XdndSelection && owner && held) dndSincePress = true;
  }
}
function dragging() {
  const x = open();
  if (!x || !x.fixes) return false;
  pump();
  return !!held && dndSincePress && x.f.XGetSelectionOwner(x.dpy, x.atoms.XdndSelection) !== 0;
}
// What the drag under way carries, asked of the program that drags it: on X11 the drag-and-drop
// selection hands that over to whoever converts it, as a drop target does on the drop. So the host
// needs neither Ctrl+C nor the clipboard, and works with programs that drop their text selection
// when a drag is cancelled (Chromium does, 3 ms after; Escape, Ctrl+C then copies nothing).
// -> { paths } (local files, from text/uri-list), { text }, or null (no answer: fall back to Ctrl+C).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function convert(x, target, ms) {
  x.f.XConvertSelection(x.dpy, x.atoms.XdndSelection, target, x.atoms.DATA, x.requestor, 0);
  x.f.XFlush(x.dpy);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    pump();
    const i = answers.findIndex((a) => a.requestor === x.requestor && a.target === target);
    if (i >= 0) {
      const a = answers.splice(i, 1)[0];
      if (!a.property) return null; // the owner said no
      const r = readProperty(x, x.requestor, a.property, 1 << 20, true);
      return r && r.type !== x.atoms.INCR ? r : null; // INCR: sent in pieces (large); not taken
    }
    await sleep(5);
  }
  return null;
}
async function dragData() {
  const x = open();
  if (!x || !dragging()) return null;
  if (!x.requestor) x.requestor = x.f.XCreateSimpleWindow(x.dpy, x.root, -10, -10, 1, 1, 0, 0, 0);
  const t = await convert(x, x.atoms.TARGETS, 800);
  const offered = new Set(t && Array.isArray(t.data) ? t.data : []);
  if (offered.has(x.atoms.URI_LIST)) {
    const r = await convert(x, x.atoms.URI_LIST, 1500), paths = r && Buffer.isBuffer(r.data) ? fileList(r.data.toString('utf8')) : [];
    if (paths.length) return { paths };
  }
  for (const target of [x.atoms.UTF8_STRING, x.atoms.TEXT_UTF8, x.atoms.TEXT_PLAIN, x.atoms.STRING]) {
    if (!offered.has(target)) continue;
    const r = await convert(x, target, 1500);
    if (r && Buffer.isBuffer(r.data)) return { text: r.data.toString(target === x.atoms.STRING ? 'latin1' : 'utf8') };
  }
  return null;
}
// Changes whenever someone takes the clipboard (as copying does). Without XFixes: always "changed".
let unknownSeq = 0;
function clipSeq() {
  const x = open();
  if (!x || !x.fixes) return ++unknownSeq;
  pump();
  return clipChanges;
}

// ---- the pointer, the buttons, the wheel, the keys ----------------------------------
// t: input.js's target(): px, py = the point in physical pixels, which are X11's root coordinates.
function move(t) {
  const x = open();
  if (!x) return;
  x.f.XTestFakeMotionEvent(x.dpy, -1, Math.round(t.px), Math.round(t.py), 0);
  x.f.XFlush(x.dpy);
}
const XBUTTON = [1, 2, 3, 8, 9]; // left, middle, right, back, forward
function button(b, isDown) {
  const x = open(), xb = XBUTTON[b];
  if (!x || !xb || xb > x.buttons) return; // a button the server does not have: it would answer BadValue, which ends the process
  if (isDown) {
    if (!held && x.fixes) { x.f.XSync(x.dpy, 0); pump(); dndSincePress = false; } // forget what happened before this press
    held |= 1 << xb;
  } else {
    held &= ~(1 << xb);
    if (!held) dndSincePress = false;
  }
  x.f.XTestFakeButtonEvent(x.dpy, xb, isDown ? 1 : 0, 0);
  x.f.XFlush(x.dpy);
}
// v: 120 per notch, positive = up / right (Windows' units). X11 has one button click per notch:
// 4 up, 5 down, 6 left, 7 right. What is left over is kept for the next event in the same direction.
const rest = { v: 0, h: 0, at: 0 };
function wheel(v, horizontal) {
  const x = open();
  if (!x) return;
  const k = horizontal ? 'h' : 'v', now = Date.now();
  if (now - rest.at > 1000 || Math.sign(rest[k]) === -Math.sign(v)) rest[k] = 0;
  rest.at = now;
  rest[k] += v;
  const n = Math.trunc(rest[k] / 120);
  rest[k] -= n * 120;
  const xb = horizontal ? (n > 0 ? 7 : 6) : (n > 0 ? 4 : 5);
  if (xb > x.buttons) return;
  for (let i = 0; i < Math.min(Math.abs(n), 20); i++) { x.f.XTestFakeButtonEvent(x.dpy, xb, 1, 0); x.f.XTestFakeButtonEvent(x.dpy, xb, 0, 0); }
  x.f.XFlush(x.dpy);
}
// KeyboardEvent.code -> Linux evdev key code. The X key code is that plus 8 on every current X server
// (Xorg with evdev or libinput, Xvfb, Xwayland), and the keyboard layout set there applies to it.
const EVDEV = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31,
  KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
  ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51,
  Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88,
  IntlRo: 89, Convert: 92, KanaMode: 93, NonConvert: 94, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98,
  PrintScreen: 99, AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107,
  ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111, AudioVolumeMute: 113, AudioVolumeDown: 114,
  AudioVolumeUp: 115, NumpadEqual: 117, Pause: 119, NumpadComma: 121, Lang1: 122, Lang2: 123, IntlYen: 124,
  MetaLeft: 125, MetaRight: 126, ContextMenu: 127, MediaTrackNext: 163, MediaPlayPause: 164, MediaTrackPrevious: 165,
  MediaStop: 166, F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188, F19: 189, F20: 190, F21: 191,
  F22: 192, F23: 193, F24: 194,
};
function keyOf(code, keyName) {
  const x = open();
  if (!x) return null;
  // The Korean keys go by what they mean, as on Windows: a Hangul key may arrive as AltRight.
  const ev = keyName === 'HangulMode' ? 122 : keyName === 'HanjaMode' ? 123 : EVDEV[code];
  const kc = ev ? ev + 8 : 0;
  return kc >= x.keycodes[0] && kc <= x.keycodes[1] ? kc : null;
}
function sendKey(kc, up) {
  const x = open();
  if (!x) return;
  x.f.XTestFakeKeyEvent(x.dpy, kc, up ? 0 : 1, 0);
  x.f.XFlush(x.dpy);
}

// ---- cursor shape -----------------------------------------------------------------
// XFixes hands over the current cursor's picture and, for cursors loaded from a theme by name (what
// GTK, Qt and libXcursor do), that name. The usual names become the CSS names the client knows;
// any other cursor is sent as its picture. The key is the cursor's serial number.
const CSS = {};
for (const [css, names] of Object.entries({
  default: ['left_ptr', 'default', 'arrow', 'top_left_arrow', 'left-arrow'],
  text: ['xterm', 'text', 'ibeam'],
  wait: ['watch', 'wait'],
  progress: ['left_ptr_watch', 'progress', 'half-busy'],
  crosshair: ['crosshair', 'cross', 'tcross', 'cross_reverse', 'diamond_cross'],
  pointer: ['hand2', 'hand1', 'hand', 'pointer', 'pointing_hand'],
  help: ['question_arrow', 'help', 'whats_this', 'left_ptr_help'],
  move: ['fleur', 'move', 'all-scroll', 'size_all'],
  'not-allowed': ['not-allowed', 'crossed_circle', 'forbidden', 'circle', 'no-drop'],
  'ew-resize': ['sb_h_double_arrow', 'h_double_arrow', 'ew-resize', 'col-resize', 'size_hor', 'split_h', 'e-resize', 'w-resize', 'left_side', 'right_side'],
  'ns-resize': ['sb_v_double_arrow', 'v_double_arrow', 'ns-resize', 'row-resize', 'size_ver', 'split_v', 'n-resize', 's-resize', 'top_side', 'bottom_side'],
  'nwse-resize': ['nwse-resize', 'size_fdiag', 'bd_double_arrow', 'top_left_corner', 'bottom_right_corner', 'nw-resize', 'se-resize'],
  'nesw-resize': ['nesw-resize', 'size_bdiag', 'fd_double_arrow', 'top_right_corner', 'bottom_left_corner', 'ne-resize', 'sw-resize'],
})) for (const n of names) CSS[n] = css;
let lastCursor = null; // { serial, name, width, height, hx, hy, bgra }
function cursorState() {
  const x = open();
  const img = x && x.fixes ? x.fixes.XFixesGetCursorImage(x.dpy) : null;
  if (!img) return { key: '0', name: 'default' };
  try {
    const c = koffi.decode(img, CursorImage), serial = Number(c.cursor_serial);
    if (!lastCursor || lastCursor.serial !== serial) {
      const w = c.width, h = c.height;
      let bgra = null;
      if (w > 0 && h > 0 && w <= 128 && h <= 128 && c.pixels) {
        // One unsigned long per pixel, of which the low 32 bits are premultiplied ARGB: in memory B, G, R, A.
        const raw = Buffer.from(koffi.decode(c.pixels, 'uint8_t', w * h * UL));
        bgra = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) raw.copy(bgra, i * 4, i * UL, i * UL + 4);
      }
      lastCursor = { serial, name: CSS[c.name] || '', width: w, height: h, hx: Math.min(c.xhot, w - 1), hy: Math.min(c.yhot, h - 1), bgra };
    }
  } finally { x.f.XFree(img); }
  const key = String(lastCursor.serial);
  return lastCursor.name ? { key, name: lastCursor.name } : { key, handle: lastCursor.serial };
}
// -> { width, height, hx, hy, bgra } (premultiplied BGRA) or null, for the cursor cursorState() last saw.
function cursorBitmap(serial) {
  const c = lastCursor;
  if (!c || c.serial !== serial || !c.bgra) return null;
  let visible = 0;
  for (let i = 3; i < c.bgra.length; i += 4) if (c.bgra[i] > 24) visible++;
  return visible ? { width: c.width, height: c.height, hx: c.hx, hy: c.hy, bgra: c.bgra } : null;
}

// ---- the clipboard's files ----------------------------------------------------------
// What file managers put on the clipboard when files are copied: x-special/gnome-copied-files (GNOME
// Files, Nemo, Caja, Thunar, PCManFM) and text/uri-list (all of them, KDE's Dolphin only that).
// Only local files (file://) count.
function fileList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('file://') || out.length >= 500) continue;
    try { out.push(url.fileURLToPath(line.trim())); } catch {}
  }
  return out;
}
function clipboardFiles() {
  const { clipboard } = require('electron');
  for (const format of ['x-special/gnome-copied-files', 'text/uri-list']) {
    let out = [];
    try { out = fileList(clipboard.readBuffer(format).toString('utf8')); } catch {}
    if (out.length) return out;
  }
  return [];
}
// Files onto the clipboard, for pasting into a file manager. Electron puts one format per write on
// the clipboard (a second write replaces the first), so it is the one the desktop's file manager
// reads: KDE's Dolphin reads text/uri-list, the GNOME family and Xfce x-special/gnome-copied-files.
function setClipboardFiles(paths) {
  const { clipboard } = require('electron');
  const uris = paths.map((p) => url.pathToFileURL(p).href);
  if (/KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '')) clipboard.writeBuffer('text/uri-list', Buffer.from(uris.join('\r\n') + '\r\n'));
  else clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(['copy', ...uris].join('\n')));
  return true;
}

// ---- for the client app (client/shell.js): where something was let go ------------------
// A window property: { type, data } with bytes (format 8) or numbers (format 32, one unsigned long
// each) as data; null when it is not there. `max` counts 32-bit units; `del` removes it after reading.
const longs = (p, n) => (n ? Array.from(koffi.decode(p, 'unsigned long', n), Number) : []);
function readProperty(x, w, prop, max = 256, del = false) {
  const type = [0], format = [0], count = [0], after = [0], data = [null];
  if (x.f.XGetWindowProperty(x.dpy, w, prop, 0, max, del ? 1 : 0, 0, type, format, count, after, data) !== 0) return null;
  try {
    if (!type[0]) return null;
    if (format[0] === 8) return { type: type[0], data: count[0] && data[0] ? Buffer.from(koffi.decode(data[0], 'uint8_t', count[0])) : Buffer.alloc(0) };
    if (format[0] === 32) return { type: type[0], data: data[0] ? longs(data[0], count[0]) : [] };
    return null;
  } finally { if (data[0]) x.f.XFree(data[0]); }
}
const property = (x, w, prop, max) => { const r = readProperty(x, w, prop, max); return r ? r.data : null; };
function children(x, w) {
  const r = [0], p = [0], list = [null], n = [0];
  if (!x.f.XQueryTree(x.dpy, w, r, p, list, n) || !list[0]) return [];
  try { return longs(list[0], n[0]); } finally { x.f.XFree(list[0]); }
}
// The program's own window inside a window manager's frame: the one that has WM_STATE.
function clientWindow(x, w, depth = 0) {
  if (property(x, w, x.atoms.WM_STATE, 2)) return w;
  if (depth >= 3) return 0;
  for (const c of children(x, w).reverse()) { const r = clientWindow(x, c, depth + 1); if (r) return r; } // topmost first
  return 0;
}
// What the pointer is over: its position (root coordinates = physical pixels), the window there (the
// program's window, as BrowserWindow.getNativeWindowHandle() gives it), that window's class
// (WM_CLASS), and whether it is the desktop: no window at all, a window of type DESKTOP (Nautilus,
// Nemo, Caja, xfdesktop, PCManFM) or GNOME's desktop icons (DING, whose window title starts "@!").
function underPointer() {
  return guarded((x) => {
    const r = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
    if (!x.f.XQueryPointer(x.dpy, x.root, r, child, rx, ry, wx, wy, mask)) return null;
    const top = child[0], w = top ? clientWindow(x, top) || top : 0;
    const types = w ? property(x, w, x.atoms._NET_WM_WINDOW_TYPE) || [] : [];
    const cls = w ? String(property(x, w, x.atoms.WM_CLASS) || '').split('\0')[1] || '' : '';
    const title = w ? String(property(x, w, x.atoms._NET_WM_NAME) || property(x, w, x.atoms.WM_NAME) || '') : '';
    const desktop = !top || (Array.isArray(types) && types.includes(x.atoms._NET_WM_WINDOW_TYPE_DESKTOP)) || /^@!\d+,\d+;/.test(title);
    return { x: rx[0], y: ry[0], hwnd: w, cls, desktop, buttons: (mask[0] >> 8) & 0x1f }; // buttons: bit 0 = button 1 held, ...
  }, null);
}

module.exports = {
  viewOnlyReason, hidesCursors: false, // X11 has no way to swap every program's cursor for a transparent one
  move, button, wheel, keyOf, sendKey,
  cursorState, cursorBitmap, dragging, dragData, clipSeq, clipboardFiles, setClipboardFiles, underPointer,
  keyCodes: Object.keys(EVDEV), // for the self-test's --input-check
};
