// Injects mouse / keyboard input with Win32 SendInput (via koffi FFI).
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'int32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
// INPUT is a tagged union; declare one layout per variant, both 40 bytes on x64.
const INPUT_M = koffi.struct('INPUT_M', { type: 'uint32', mi: MOUSEINPUT });
const INPUT_K = koffi.struct('INPUT_K', { type: 'uint32', ki: KEYBDINPUT, pad: koffi.array('uint8', 8) });
const SIZE = koffi.sizeof(INPUT_M);
if (SIZE !== koffi.sizeof(INPUT_K)) throw new Error('INPUT struct layout mismatch');

const SendMouse = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT_M), 'int']);
const SendKey = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT_K), 'int']);
const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int']);

const MF = { MOVE: 0x1, LD: 0x2, LU: 0x4, RD: 0x8, RU: 0x10, MD: 0x20, MU: 0x40, XD: 0x80, XU: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VDESK: 0x4000, ABS: 0x8000 };
const KF = { EXT: 0x1, UP: 0x2, SCAN: 0x8 };

// KeyboardEvent.code -> [scancode set 1, extended]
const SC = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06], Digit6: [0x07],
  Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c], Equal: [0x0d], Backspace: [0x0e],
  Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16],
  KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c],
  ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23],
  KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a],
  Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31],
  KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37],
  AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a], F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f],
  F6: [0x40], F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], ScrollLock: [0x46], Numpad7: [0x47],
  Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b], Numpad5: [0x4c], Numpad6: [0x4d],
  NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], AltRight: [0x38, 1], Home: [0x47, 1],
  ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1], ArrowRight: [0x4d, 1], End: [0x4f, 1],
  ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], MetaLeft: [0x5b, 1],
  MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
};
// Keys that are more reliable as virtual-key codes.
const VK = {
  PrintScreen: 0x2c, Pause: 0x13, NumLock: 0x90, Lang1: 0x15, Lang2: 0x19,
  AudioVolumeMute: 0xad, AudioVolumeDown: 0xae, AudioVolumeUp: 0xaf,
  MediaTrackNext: 0xb0, MediaTrackPrevious: 0xb1, MediaStop: 0xb2, MediaPlayPause: 0xb3,
  F13: 0x7c, F14: 0x7d, F15: 0x7e, F16: 0x7f,
};

let monitors = []; // physical-pixel rects, index = monitor idx sent to the client
const down = new Set(); // codes currently held, so we can release them on disconnect
let buttonsDown = 0;

function setMonitors(rects) { monitors = rects; }

function mouse(flags, dx = 0, dy = 0, data = 0) {
  SendMouse(1, [{ type: 0, mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } }], SIZE);
}
function moveTo(d, x, y) {
  const r = monitors[d];
  if (!r || !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return false;
  const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
  const px = r.x + x * (r.width - 1), py = r.y + y * (r.height - 1);
  const nx = Math.round(((px - vx) * 65535) / Math.max(1, vw - 1));
  const ny = Math.round(((py - vy) * 65535) / Math.max(1, vh - 1));
  mouse(MF.MOVE | MF.ABS | MF.VDESK, nx, ny);
  return true;
}
function key(code, keyName, up) {
  let vk = 0, scan = 0, flags = up ? KF.UP : 0;
  if (keyName === 'HangulMode') vk = 0x15;
  else if (keyName === 'HanjaMode') vk = 0x19;
  else if (VK[code]) vk = VK[code];
  else if (SC[code]) { scan = SC[code][0]; flags |= KF.SCAN | (SC[code][1] ? KF.EXT : 0); }
  else return;
  if (up) down.delete(code); else down.add(code);
  SendKey(1, [{ type: 1, ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 }, pad: [0, 0, 0, 0, 0, 0, 0, 0] }], SIZE);
}
const BTN = [[MF.LD, MF.LU, 0], [MF.MD, MF.MU, 0], [MF.RD, MF.RU, 0], [MF.XD, MF.XU, 1], [MF.XD, MF.XU, 2]];

function reset() {
  for (const code of [...down]) key(code, '', true);
  down.clear();
  for (let b = 0; b < BTN.length; b++) if (buttonsDown & (1 << b)) mouse(BTN[b][1], 0, 0, BTN[b][2]);
  buttonsDown = 0;
}

function handle(text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'mm': moveTo(m.d | 0, +m.x, +m.y); break;
    case 'md':
    case 'mu': {
      const b = BTN[m.b | 0];
      if (!b || !moveTo(m.d | 0, +m.x, +m.y)) break;
      if (m.t === 'md') buttonsDown |= 1 << (m.b | 0); else buttonsDown &= ~(1 << (m.b | 0));
      mouse(m.t === 'md' ? b[0] : b[1], 0, 0, b[2]);
      break;
    }
    case 'mw': {
      const clamp = (v) => Math.max(-2400, Math.min(2400, Math.round(+v || 0)));
      const dy = clamp(-m.dy * 1.2), dx = clamp(m.dx * 1.2);
      if (dy) mouse(MF.WHEEL, 0, 0, dy);
      if (dx) mouse(MF.HWHEEL, 0, 0, dx);
      break;
    }
    case 'kd': key(String(m.c), String(m.k || ''), false); break;
    case 'ku': key(String(m.c), String(m.k || ''), true); break;
    case 'reset': reset(); break;
  }
}

// ---- cursor shape -----------------------------------------------------------
// The client draws its own cursor (zero latency). We tell it which standard
// shape the host cursor currently has, as a CSS cursor name.
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const CURSORINFO = koffi.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'uintptr_t', pt: POINT });
const GetCursorInfo = user32.func('GetCursorInfo', 'bool', [koffi.inout(koffi.pointer(CURSORINFO))]);
const LoadCursorW = user32.func('LoadCursorW', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
const IDC = {
  32512: 'default', 32513: 'text', 32514: 'wait', 32515: 'crosshair', 32516: 'default', 32642: 'nwse-resize',
  32643: 'nesw-resize', 32644: 'ew-resize', 32645: 'ns-resize', 32646: 'move', 32648: 'not-allowed',
  32649: 'pointer', 32650: 'progress', 32651: 'help',
};
const cursorByHandle = new Map();
for (const [id, css] of Object.entries(IDC)) {
  const h = LoadCursorW(0, Number(id));
  if (h) cursorByHandle.set(String(h), css);
}
function cursorName() {
  const ci = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0, pt: { x: 0, y: 0 } };
  if (!GetCursorInfo(ci)) return 'default';
  return cursorByHandle.get(String(ci.hCursor)) || 'default'; // app-specific cursors fall back to the arrow
}

module.exports = { handle, reset, setMonitors, cursorName };
