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
  typeText() {}, // characters as such (a phone's keyboard): Windows (KEYEVENTF_UNICODE) and X11 (keycodes lent to keysyms)
  maskKey() {}, // a key that keeps a lone Alt or Windows key release from opening a menu (Windows, X11)
  // Whether a password manager marked the clipboard's content as private (Windows: its own formats;
  // elsewhere, the macOS client app: NSPasteboard's concealed or transient types, KDE's hint). May be a promise.
  clipboardPrivate: async () => { try { return (await require('electron').clipboard.read()).some((i) => i.types.some((t) => /ConcealedType|TransientType|passwordManagerHint/i.test(t))); } catch { return false; } },
  cursorState: () => ({ key: '0', name: 'default' }),
  cursorBitmap: () => null,
  hideCursors: () => 0,
  restoreCursors: () => false,
  dragFullWindows: () => true,
  displayColor: () => [],
  captureClass: () => '',
  dragging: () => false,
  cancelDrag: () => false, // ends the drag under way without a drop when its program is not in front (Windows)
  // The pointer a pixel aside and back while a button is held, so that a program that starts its drag only
  // on motion (GTK 4) can, while the client holds the pointer still (dragq). X11 only; Explorer needs none.
  nudge() {},
  dragData: async () => null, // what the drag under way carries, where the platform can ask the dragging program
  dropFiles: async () => -1, // files dropped on what is under the pointer (X11; Windows does this in shellops.dll): 1 taken, 0 not, -1 cannot
  clipboardFiles: () => [],
  underPointer: () => null,
  buttonsHeld: () => null, // the mouse buttons held right now (bit b = button b of md/mu); null: cannot tell here
  modifiersHeld: () => null, // whether the system holds Ctrl, Alt or a Windows key (Windows); null: cannot tell here
  clickAt: () => false,
  dropFilesBuffer: () => null,
  setClipboardFiles: () => false,
  processRunning: async () => null, // whether a program with this file name runs (a promise); null: cannot tell here
  clipSeq: (() => { let n = 0; return () => ++n; })(), // unknown: always "changed", so the clipboard is simply read
  setSink() {}, // Windows: injected input goes to the assist service while a secure desktop has the screen (host/assist.js)
  // The frame of this host's own windows (Windows: see framePress below). Elsewhere a window manager of its
  // own draws and runs the frames, so presses there are injected as any other.
  ownFrame: () => null, windowPos: () => null, moveWindow: () => false, frameAction: () => false, mainThreadId: () => 0,
};
const platformModule = { win32: './platform/win32', linux: './platform/linux' }[process.platform];
const backend = { ...NEUTRAL, ...(platformModule ? require(platformModule) : {}) };

// The dry run's vocabulary for mouse events (the values of Win32's MOUSEEVENTF flags).
const MF = { MOVE: 0x1, LD: 0x2, LU: 0x4, RD: 0x8, RU: 0x10, MD: 0x20, MU: 0x40, XD: 0x80, XU: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VDESK: 0x4000, ABS: 0x8000 };
const BTN = [[MF.LD, MF.LU, 0], [MF.MD, MF.MU, 0], [MF.RD, MF.RU, 0], [MF.XD, MF.XU, 1], [MF.XD, MF.XU, 2]]; // left, middle, right, back, forward

let monitors = []; // physical-pixel rects, index = monitor idx sent to the client
const KOREAN_KEYS = new Set(['HangulMode', 'HanjaMode']); // 한/영, 한자: by their meaning (see handle)
const down = new Map(); // code -> the key as it was pressed: released the same way, and all on disconnect
let buttonsDown = 0; // bit b = BTN[b] is held down here
let released = 0;    // buttons let go here because the client said it no longer held them (diagnostics)
let dry = null;      // when set (self-test only), input is recorded here instead of being injected
let ownFrame = (px, py) => backend.ownFrame(px, py); // the self-test's dry run puts a stand-in here

// A press on the frame of this host's own window (its title bar and buttons, its borders) is never injected
// (Windows only; see ownFrame in platform/win32.js): Windows would hold the thread that injects input in a
// loop until the button went up, and the release that ends it could then never be injected - remote
// control stopped until someone at the PC clicked (the user's report of 2026-11-16: the host window's
// minimize button pressed from the client). What the press means is done here instead: the window comes to
// the front; min, max and close act on their release over them; the title bar moves the window with the
// pointer, twice in a row it maximizes or restores; the borders and the window menu do nothing.
let framePress = null; // { b, hwnd, hit, x, y, wx, wy } while such a press is held
let frameButtons = 0; // the buttons pressed on the frame (not injected): their releases are not injected either
let lastCaption = null; // { hwnd, x, y, at } the last left press on a title bar, for the second of a double click
const DOUBLE_MS = 500;
function frameDown(b, t) {
  if (frameButtons & (1 << b)) return true;
  const f = ownFrame(t.px, t.py);
  if (!f) return false;
  frameButtons |= 1 << b;
  if (framePress) return true; // another button while one is held there: nothing more
  const w = (dry ? null : backend.windowPos(f.hwnd)) || { x: 0, y: 0 };
  framePress = { b, hwnd: f.hwnd, hit: f.hit, x: t.px, y: t.py, wx: w.x, wy: w.y, double: false };
  if (b === 0) {
    record({ frame: 'activate', hit: f.hit }, () => backend.frameAction(f.hwnd, 'activate'));
    const now = Date.now(), l = lastCaption;
    if (f.hit === 'caption') {
      framePress.double = !!(l && l.hwnd === f.hwnd && now - l.at < DOUBLE_MS && Math.abs(l.x - t.px) <= 4 && Math.abs(l.y - t.py) <= 4);
      lastCaption = framePress.double ? null : { hwnd: f.hwnd, x: t.px, y: t.py, at: now };
    }
  }
  return true;
}
function frameMove(t) {
  const f = framePress;
  if (!f || f.b !== 0 || f.hit !== 'caption' || f.double) return;
  record({ frame: 'move', dx: t.px - f.x, dy: t.py - f.y }, () => backend.moveWindow(f.hwnd, f.wx + t.px - f.x, f.wy + t.py - f.y));
}
function frameUp(b, t) {
  if (!(frameButtons & (1 << b))) return false;
  frameButtons &= ~(1 << b);
  const f = framePress;
  if (!f || f.b !== b) return true;
  framePress = null;
  if (b !== 0) return true;
  if (f.double) { record({ frame: 'max' }, () => backend.frameAction(f.hwnd, 'max')); return true; }
  if (!['min', 'max', 'close'].includes(f.hit)) return true;
  // As a button does: only when let go over the same button.
  const g = t ? ownFrame(t.px, t.py) : null;
  if (g && g.hwnd === f.hwnd && g.hit === f.hit) record({ frame: f.hit }, () => backend.frameAction(f.hwnd, f.hit));
  return true;
}
// What the dry run notes instead of doing it.
function record(entry, act) { if (dry) dry.push(entry); else act(); }

function setMonitors(rects) { monitors = rects; }
// Where a point of the desktop (physical pixels) is on the monitors the client knows: { d, x, y } with x, y 0..1, or null.
function whereIs(px, py) {
  for (let d = 0; d < monitors.length; d++) {
    const r = monitors[d];
    if (r && px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) return { d, x: (px - r.x) / r.width, y: (py - r.y) / r.height };
  }
  return null;
}

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
  // A dry run (the self-test's simulate) maps onto the monitors it was given, never this PC's own desktop: a
  // check of where things land failed on GitHub's runner, whose 1024x768 desktop clipped a 1920-wide stand-in.
  const v = virt || (dry ? coverage() : backend.virtualDesktop() || coverage());
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
  queued.length = 0; // input that waited for typing to end is not injected after this
  framePress = null; frameButtons = 0; lastCaption = null; // presses on the host's own frame were never injected: nothing to let go
  // Alt or the Windows key let go with nothing pressed in between opens the program's menu bar or the
  // Start menu (a client that left with Alt+Tab, say, held Alt here): a key that means nothing in between.
  if ([...down.keys()].some((c) => /^(Alt|Meta)/.test(c))) { if (dry) dry.push({ key: 'mask', up: false }); else backend.maskKey(); }
  for (const code of [...down.keys()]) key(code, '', true);
  down.clear();
  for (let b = 0; b < BTN.length; b++) if (buttonsDown & (1 << b)) button(b, false);
  buttonsDown = 0;
}

// While the backend is still typing text it was given (X11 types it over some time, see typeText in
// platform/linux.js), later input waits for it, so a key pressed after the text arrives after it.
let typing = null;
const queued = [];
function typed(p) {
  const mine = (typing = p.catch(() => {}).then(() => {
    if (typing !== mine) return;
    typing = null;
    const q = queued.splice(0);
    for (let i = 0; i < q.length; i++) {
      handle(q[i]);
      if (typing) { queued.push(...q.slice(i + 1)); break; } // more text: the rest waits for that too
    }
  }));
}

// Resolves once nothing is being typed and nothing waits behind it: what the host does by itself at a
// place (a drop where the client let go) must not run ahead of the move that takes the pointer there.
const idle = () => (typing ? typing.then(idle) : Promise.resolve());

// ---- input that runs away (a connection that comes back on itself) ------------------------------
// A client app on this very PC, or the client app of a PC that this PC's own client app controls, is refused
// at its hello (host/cycle.js). A browser cannot say where it runs, nor can apps and hosts from before 0.9.0:
// a key or a click injected here then lands in the window that sends it back, and comes again without end,
// as fast as the connection carries it. What no person does: the same key pressed and let go 45 times within
// 3 s, or 30 clicks within 3 s (a held key repeats without being let go, and does not count). Then input
// stops for 5 s (30 s when it happens again within a minute), everything held is let go, and handle() says
// 'storm' once: main tells the page, the page the client. Moves still go (they press nothing; a lost button
// is let go by them). Keys of a phone's keyboard (`s` on kd/ku: the page's key row and text field, which
// deletes a word as many Backspaces at once) do not count: a phone is no host, so nothing comes back to it.
const STORM = { window: 3000, keys: 45, clicks: 30, pause: 5000, again: 30000, within: 60000 };
let storm = { keys: new Map(), clicks: [], until: 0, last: -1e15, pause: 0 };
let clock = Date.now; // the dry run's is its own (simulate: { t: 'wait', ms } moves it on)
const recent = (list, now) => { while (list.length && now - list[0] > STORM.window) list.shift(); return list; };
// -> true when this message trips the guard
function stormed(m, now) {
  let list = null;
  if (m.t === 'ku' && !m.s && down.has(String(m.c))) {
    const c = String(m.c).slice(0, 40);
    list = storm.keys.get(c);
    if (!list) { if (storm.keys.size > 200) storm.keys.clear(); storm.keys.set(c, (list = [])); }
  } else if (m.t === 'mu' && buttonsDown & (1 << (m.b | 0))) list = storm.clicks;
  if (!list) return false;
  list.push(now);
  if (recent(list, now).length < (list === storm.clicks ? STORM.clicks : STORM.keys)) return false;
  storm.pause = now - storm.last < STORM.within ? STORM.again : STORM.pause;
  storm.until = now + storm.pause;
  storm.last = now;
  storm.keys.clear();
  storm.clicks = [];
  return true;
}
// How long input stops after the guard tripped (ms), for main's word to the page.
const stormPause = () => storm.pause;

function handle(text) {
  if (typing) { if (queued.length < 5000) queued.push(text); return; }
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const now = clock();
  if (storm.until > now && m.t !== 'mm' && m.t !== 'reset') return;
  if (stormed(m, now)) { reset(); return 'storm'; }
  switch (m.t) {
    case 'mm': {
      const t = target(m.d | 0, +m.x, +m.y);
      if (t) move(t);
      // `h`: the buttons the client's pointer holds right now (same bits as buttonsDown). One held
      // here that the client no longer holds lost its release on the way (the browser cancelled the
      // pointer, the window changed under it, ...): let it go now, where the pointer is. Otherwise
      // every later move would drag whatever is under the pointer. Never presses anything.
      const lost = Number.isInteger(m.h) ? buttonsDown & ~m.h : 0;
      for (let b = 0; b < BTN.length; b++) if (lost & (1 << b)) { button(b, false); released++; }
      buttonsDown &= ~lost;
      // Presses on the host's own window frame (not injected): the title bar moves the window; a lost release ends one.
      const frameLost = Number.isInteger(m.h) ? frameButtons & ~m.h : 0;
      for (let b = 0; b < BTN.length; b++) if (frameLost & (1 << b)) frameUp(b, null);
      if (framePress && t) frameMove(t);
      break;
    }
    case 'md':
    case 'mu': {
      const b = m.b | 0;
      const t = BTN[b] ? target(m.d | 0, +m.x, +m.y) : null;
      if (!t) break;
      move(t);
      if (m.t === 'md' ? !(buttonsDown & (1 << b)) && frameDown(b, t) : frameUp(b, t)) break; // the host's own window frame: see framePress
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
    // The Korean keys come as a press and its release at once (the page sends them whole). Where the platform presses
    // them by their meaning (X11: the keycode that holds the keysym in the host's layout, see koreanKey in
    // platform/linux.js), the press is the whole key and the release is nothing more.
    case 'kd':
      if (KOREAN_KEYS.has(m.k)) {
        if (backend.koreanKey && !dry) { const p = backend.koreanKey(m.k); if (p && typeof p.then === 'function') typed(p); } else key(String(m.c), m.k, false);
        return m.k === 'HangulMode' ? 'korean' : undefined; // main asks whether it can work here (host/imecheck.js)
      }
      key(String(m.c), String(m.k || ''), false);
      break;
    case 'ku': if (!(KOREAN_KEYS.has(m.k) && backend.koreanKey && !dry)) key(String(m.c), String(m.k || ''), true); break;
    case 'text': { // characters from a phone's keyboard, typed as such (see typeText in platform/*.js)
      const s = String(m.s || '').slice(0, 1000);
      if (!s) break;
      if (dry) { dry.push({ text: s }); break; }
      const p = backend.typeText(s); // Windows types at once; X11 returns a promise
      if (p && typeof p.then === 'function') typed(p);
      break;
    }
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
// opts.ownFrame: a stand-in for the platform's (px, py) -> { hwnd, hit } | null, to try the frame presses.
function simulate(rects, msgs, then, opts = {}) {
  const saved = { monitors, buttonsDown, released, down: [...down], ownFrame, framePress, frameButtons, lastCaption, storm };
  dry = [];
  monitors = rects; buttonsDown = 0; released = 0; down.clear();
  framePress = null; frameButtons = 0; lastCaption = null;
  storm = { keys: new Map(), clicks: [], until: 0, last: -1e15, pause: 0 }; // the dry run's guard is its own,
  let t = 1e12;                                                              // and so is its clock
  clock = () => t;
  ownFrame = opts.ownFrame || (() => null); // never the real windows of this PC in a dry run
  try {
    const said = []; // what handle() answered ('storm')
    for (const m of msgs) {
      if (m.t === 'wait') { t += Number(m.ms) || 0; continue; }
      const r = handle(JSON.stringify(m));
      if (r) said.push(r);
    }
    if (then) then();
    return { log: dry, held: buttonsDown, released, said, pause: storm.pause };
  } finally {
    dry = null;
    monitors = saved.monitors; buttonsDown = saved.buttonsDown; released = saved.released;
    down.clear(); for (const [c, k] of saved.down) down.set(c, k);
    ownFrame = saved.ownFrame; framePress = saved.framePress; frameButtons = saved.frameButtons; lastCaption = saved.lastCaption;
    storm = saved.storm; clock = Date.now;
  }
}
function takeReleased() { const n = released; released = 0; return n; }
// Whether the client holds this key down here right now (KeyboardEvent.code).
const isDown = (code) => down.has(code);

module.exports = {
  handle, reset, setMonitors, whereIs, target, simulate, takeReleased, isDown, MF, buttonUp, tap, stormPause, STORM,
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
  cancelDrag: backend.cancelDrag,
  nudge: backend.nudge,
  idle, // resolves when no text is being typed (X11 types over time and holds later input back)
  dragData: backend.dragData,
  dropFiles: backend.dropFiles,
  clipboardFiles: backend.clipboardFiles,
  underPointer: backend.underPointer,
  buttonsHeld: backend.buttonsHeld,
  modifiersHeld: backend.modifiersHeld,
  clickAt: backend.clickAt,
  dropFilesBuffer: backend.dropFilesBuffer,
  setClipboardFiles: backend.setClipboardFiles,
  processRunning: backend.processRunning,
  clipboardPrivate: backend.clipboardPrivate,
  clipSeq: backend.clipSeq,
  setSink: backend.setSink,
  mainThreadId: backend.mainThreadId, // Windows: the thread that injects (host/inputguard.js watches it)
  ownFrame: (px, py) => backend.ownFrame(px, py), // the self-test's real-input check (framecheck.js)
  // The Korean keys (host/imecheck.js): Windows' Korean keyboard ({ any, active }; undefined elsewhere) and the text
  // cursor of the program in front (physical pixels; null where it cannot be told, as on X11).
  koreanKeyboard: backend.koreanKeyboard,
  caretAt: backend.caretAt || (() => null),
};
