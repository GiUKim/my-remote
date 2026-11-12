// Injects the client's mouse and keyboard input on this PC. This part is the same everywhere: the
// client's messages are mapped to the virtual desktop here, held keys and buttons are tracked, and
// the self-test's dry run records what would be injected. The operating system's side is a module
// of its own: platform/win32.js (Win32 through koffi) or platform/linux.js (X11 through koffi).
// Anywhere else (macOS), or when that module cannot work (Linux without an X11 display), nothing is
// injected and every function returns a neutral value: the host is view-only (viewOnlyReason()).
const NEUTRAL = {
  viewOnlyReason: () => `input injection is not implemented for ${process.platform}`,
  hidesCursors: false, // whether hideCursors() can keep the pointer out of the engine's captured video
  virtualDesktop: () => null, // null: the area the monitors cover
  move() {}, button() {}, wheel() {}, keyOf: () => null, sendKey() {},
  cursorState: () => ({ key: '0', name: 'default' }),
  cursorBitmap: () => null,
  hideCursors: () => 0,
  restoreCursors: () => false,
  dragFullWindows: () => true,
  displayColor: () => [],
  captureClass: () => '',
  dragging: () => false,
  dragData: async () => null, // what the drag under way carries, where the platform can ask the dragging program
  clipboardFiles: () => [],
  underPointer: () => null,
  clickAt: () => false,
  dropFilesBuffer: () => null,
  setClipboardFiles: () => false,
  clipSeq: (() => { let n = 0; return () => ++n; })(), // unknown: always "changed", so the clipboard is simply read
};
const platformModule = { win32: './platform/win32', linux: './platform/linux' }[process.platform];
const backend = { ...NEUTRAL, ...(platformModule ? require(platformModule) : {}) };

// The dry run's vocabulary for mouse events (the values of Win32's MOUSEEVENTF flags).
const MF = { MOVE: 0x1, LD: 0x2, LU: 0x4, RD: 0x8, RU: 0x10, MD: 0x20, MU: 0x40, XD: 0x80, XU: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VDESK: 0x4000, ABS: 0x8000 };
const BTN = [[MF.LD, MF.LU, 0], [MF.MD, MF.MU, 0], [MF.RD, MF.RU, 0], [MF.XD, MF.XU, 1], [MF.XD, MF.XU, 2]]; // left, middle, right, back, forward

let monitors = []; // physical-pixel rects, index = monitor idx sent to the client
const down = new Map(); // code -> the key as it was pressed: released the same way, and all on disconnect
let buttonsDown = 0; // bit b = BTN[b] is held down here
let released = 0;    // buttons let go here because the client said it no longer held them (diagnostics)
let dry = null;      // when set (self-test only), input is recorded here instead of being injected

function setMonitors(rects) { monitors = rects; }

function move(t) {
  if (dry) { dry.push({ mouse: MF.MOVE | MF.ABS | MF.VDESK, data: 0 }); return; }
  backend.move(t);
}
function button(b, isDown) {
  if (dry) { dry.push({ mouse: BTN[b][isDown ? 0 : 1], data: BTN[b][2] }); return; }
  backend.button(b, isDown);
}
function wheel(v, horizontal) {
  if (dry) { dry.push({ mouse: horizontal ? MF.HWHEEL : MF.WHEEL, data: v }); return; }
  backend.wheel(v, horizontal);
}
// The area the monitors cover (where the platform does not say how large its desktop is).
function coverage() {
  if (!monitors.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...monitors.map((r) => r.x)), y = Math.min(...monitors.map((r) => r.y));
  return { x, y, width: Math.max(...monitors.map((r) => r.x + r.width)) - x, height: Math.max(...monitors.map((r) => r.y + r.height)) - y };
}
// Maps (monitor, 0..1 position) to the virtual desktop. Positions outside 0..1
// continue onto the neighbouring monitor, which is what lets a drag that leaves
// one monitor's view carry on to the next monitor, as it would at the real desk.
// px, py: physical pixels (X11 root coordinates); nx, ny: the same point in SendInput's 0..65535 range.
function target(d, x, y, virt) {
  const r = monitors[d];
  if (!r || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16 || Math.abs(y) > 16) return null;
  const v = virt || backend.virtualDesktop() || coverage();
  const px = Math.min(v.x + v.width - 1, Math.max(v.x, r.x + x * (r.width - 1)));
  const py = Math.min(v.y + v.height - 1, Math.max(v.y, r.y + y * (r.height - 1)));
  return {
    px, py,
    nx: Math.round(((px - v.x) * 65535) / Math.max(1, v.width - 1)),
    ny: Math.round(((py - v.y) * 65535) / Math.max(1, v.height - 1)),
  };
}
function moveTo(d, x, y) {
  const t = target(d, x, y);
  if (!t) return false;
  move(t);
  return true;
}
// A key goes up the way it went down (what the client's NumLock made of a numpad key can differ
// between its press and its release; a key pressed as a shortcut is released as one).
// shortcut: pressed by the host itself (tap), see keyOf in platform/win32.js.
function key(code, keyName, up, shortcut) {
  const k = up && down.has(code) ? down.get(code) : backend.keyOf(code, keyName, shortcut);
  if (k == null) return;
  if (up) down.delete(code); else down.set(code, k);
  if (dry) { dry.push({ key: code, up }); return; }
  backend.sendKey(k, up);
}

function reset() {
  for (const code of [...down.keys()]) key(code, '', true);
  down.clear();
  for (let b = 0; b < BTN.length; b++) if (buttonsDown & (1 << b)) button(b, false);
  buttonsDown = 0;
}

function handle(text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'mm': {
      moveTo(m.d | 0, +m.x, +m.y);
      // `h`: the buttons the client's pointer holds right now (same bits as buttonsDown). One held
      // here that the client no longer holds lost its release on the way (the browser cancelled the
      // pointer, the window changed under it, ...): let it go now, where the pointer is. Otherwise
      // every later move would drag whatever is under the pointer. Never presses anything.
      const lost = Number.isInteger(m.h) ? buttonsDown & ~m.h : 0;
      for (let b = 0; b < BTN.length; b++) if (lost & (1 << b)) { button(b, false); released++; }
      buttonsDown &= ~lost;
      break;
    }
    case 'md':
    case 'mu': {
      const b = m.b | 0;
      if (!BTN[b] || !moveTo(m.d | 0, +m.x, +m.y)) break;
      if (m.t === 'md') buttonsDown |= 1 << b; else buttonsDown &= ~(1 << b);
      button(b, m.t === 'md');
      break;
    }
    case 'mw': {
      // 120 per notch, positive = away from the user (up) and to the right, as Windows counts.
      const clamp = (v) => Math.max(-2400, Math.min(2400, Math.round(+v || 0)));
      const dy = clamp(-m.dy * 1.2), dx = clamp(m.dx * 1.2);
      if (dy) wheel(dy, false);
      if (dx) wheel(dx, true);
      break;
    }
    case 'kd': key(String(m.c), String(m.k || ''), false); break;
    case 'ku': key(String(m.c), String(m.k || ''), true); break;
    case 'reset': reset(); break;
  }
}

// A mouse button released where the pointer is, and keys pressed and released in order.
function buttonUp(b) {
  if (!BTN[b | 0]) return;
  buttonsDown &= ~(1 << (b | 0));
  button(b | 0, false);
}
// The host pressing a shortcut itself (Escape, Ctrl+C, Ctrl+V). Keys of it the person already holds
// stay as they are; other modifiers they hold (Shift while letting go of a drag, ...) are lifted for
// the moment and pressed again afterwards, so Ctrl+C does not become Ctrl+Shift+C.
const MODIFIERS = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
function tap(codes) {
  const own = codes.filter((c) => !down.has(c));
  const lifted = MODIFIERS.filter((c) => down.has(c) && !codes.includes(c) && !(codes.includes('ControlLeft') && c === 'ControlRight'));
  const held = lifted.map((c) => [c, down.get(c)]);
  for (const c of lifted) key(c, '', true);
  for (const c of own) key(c, '', false, true);
  for (const c of [...own].reverse()) key(c, '', true);
  for (const [c, k] of held) { down.set(c, k); if (dry) dry.push({ key: c, up: false }); else backend.sendKey(k, false); }
}

// Self-test: runs input messages through handle() against the given monitor rectangles and returns
// what would have been injected, without injecting anything; then `then()` if given, in the same dry
// run (to see what tap() and buttonUp() would do). The real state is put back afterwards.
function simulate(rects, msgs, then) {
  const saved = { monitors, buttonsDown, released, down: [...down] };
  dry = [];
  monitors = rects; buttonsDown = 0; released = 0; down.clear();
  try {
    for (const m of msgs) handle(JSON.stringify(m));
    if (then) then();
    return { log: dry, held: buttonsDown, released };
  } finally {
    dry = null;
    monitors = saved.monitors; buttonsDown = saved.buttonsDown; released = saved.released;
    down.clear(); for (const [c, k] of saved.down) down.set(c, k);
  }
}
function takeReleased() { const n = released; released = 0; return n; }
// Whether the client holds this key down here right now (KeyboardEvent.code).
const isDown = (code) => down.has(code);

module.exports = {
  handle, reset, setMonitors, target, simulate, takeReleased, isDown, MF, buttonUp, tap,
  // From the platform module, or the neutral value. See platform/win32.js and platform/linux.js.
  viewOnlyReason: backend.viewOnlyReason, // '' when input can be injected here, else why not
  hidesCursors: backend.hidesCursors,
  dragFullWindows: backend.dragFullWindows,
  cursorState: backend.cursorState,
  cursorBitmap: backend.cursorBitmap,
  hideCursors: backend.hideCursors,
  restoreCursors: backend.restoreCursors,
  displayColor: backend.displayColor,
  captureClass: backend.captureClass,
  dragging: backend.dragging,
  dragData: backend.dragData,
  clipboardFiles: backend.clipboardFiles,
  underPointer: backend.underPointer,
  clickAt: backend.clickAt,
  dropFilesBuffer: backend.dropFilesBuffer,
  setClipboardFiles: backend.setClipboardFiles,
  clipSeq: backend.clipSeq,
};
