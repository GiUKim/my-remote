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
// Maps (monitor, 0..1 position) to the virtual desktop. Positions outside 0..1
// continue onto the neighbouring monitor, which is what lets a drag that leaves
// one monitor's view carry on to the next monitor, as it would at the real desk.
function target(d, x, y, virt) {
  const r = monitors[d];
  if (!r || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16 || Math.abs(y) > 16) return null;
  const v = virt || { x: GetSystemMetrics(76), y: GetSystemMetrics(77), width: GetSystemMetrics(78), height: GetSystemMetrics(79) };
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
  mouse(MF.MOVE | MF.ABS | MF.VDESK, t.nx, t.ny);
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
// App-specific cursors (Office, design tools...) have no CSS name, so their picture
// is sent instead. The cursor is drawn on black and on white; the difference gives
// the alpha, which handles colour, masked and alpha-blended cursors the same way.
const gdi32 = koffi.load('gdi32.dll');
const ICONINFO = koffi.struct('ICONINFO', { fIcon: 'int', xHotspot: 'uint32', yHotspot: 'uint32', hbmMask: 'uintptr_t', hbmColor: 'uintptr_t' });
const BITMAP = koffi.struct('BITMAP', { bmType: 'long', bmWidth: 'long', bmHeight: 'long', bmWidthBytes: 'long', bmPlanes: 'uint16', bmBitsPixel: 'uint16', bmBits: 'uintptr_t' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
  biSizeImage: 'uint32', biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32',
});
const GetIconInfo = user32.func('GetIconInfo', 'bool', ['uintptr_t', koffi.out(koffi.pointer(ICONINFO))]);
const GetObjectW = gdi32.func('GetObjectW', 'int', ['uintptr_t', 'int', koffi.out(koffi.pointer(BITMAP))]);
const DeleteObject = gdi32.func('DeleteObject', 'bool', ['uintptr_t']);
const GetDC = user32.func('GetDC', 'uintptr_t', ['uintptr_t']);
const ReleaseDC = user32.func('ReleaseDC', 'int', ['uintptr_t', 'uintptr_t']);
const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', 'uintptr_t', ['uintptr_t']);
const DeleteDC = gdi32.func('DeleteDC', 'bool', ['uintptr_t']);
const CreateCompatibleBitmap = gdi32.func('CreateCompatibleBitmap', 'uintptr_t', ['uintptr_t', 'int', 'int']);
const SelectObject = gdi32.func('SelectObject', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
const GetStockObject = gdi32.func('GetStockObject', 'uintptr_t', ['int']);
const FillRect = user32.func('FillRect', 'int', ['uintptr_t', koffi.pointer(RECT), 'uintptr_t']);
const DrawIconEx = user32.func('DrawIconEx', 'bool', ['uintptr_t', 'int', 'int', 'uintptr_t', 'int', 'int', 'uint32', 'uintptr_t', 'uint32']);
const GetDIBits = gdi32.func('GetDIBits', 'int', ['uintptr_t', 'uintptr_t', 'uint32', 'uint32', 'uint8*', koffi.inout(koffi.pointer(BITMAPINFOHEADER)), 'uint32']);

function drawCursor(h, w, hgt, white) {
  const screenDc = GetDC(0), dc = CreateCompatibleDC(screenDc), bmp = CreateCompatibleBitmap(screenDc, w, hgt);
  const old = SelectObject(dc, bmp);
  FillRect(dc, { left: 0, top: 0, right: w, bottom: hgt }, GetStockObject(white ? 0 : 4));
  DrawIconEx(dc, 0, 0, h, 0, 0, 0, 0, 3);
  SelectObject(dc, old);
  const buf = Buffer.alloc(w * hgt * 4);
  const bmi = { biSize: 40, biWidth: w, biHeight: -hgt, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
  const rows = GetDIBits(screenDc, bmp, 0, hgt, buf, bmi, 0);
  DeleteObject(bmp); DeleteDC(dc); ReleaseDC(0, screenDc);
  return rows ? buf : null;
}
// -> { width, height, hx, hy, bgra } (premultiplied BGRA) or null
function cursorBitmap(h) {
  const ii = {};
  if (!GetIconInfo(h, ii)) return null;
  const bm = {};
  const got = GetObjectW(ii.hbmMask, koffi.sizeof(BITMAP), bm);
  const colour = !!ii.hbmColor;
  if (ii.hbmMask) DeleteObject(ii.hbmMask);
  if (ii.hbmColor) DeleteObject(ii.hbmColor);
  if (!got) return null;
  const w = bm.bmWidth, hgt = colour ? bm.bmHeight : bm.bmHeight / 2;
  if (!(w > 0 && hgt > 0 && w <= 128 && hgt <= 128)) return null;
  const k = drawCursor(h, w, hgt, false), wh = drawCursor(h, w, hgt, true);
  if (!k || !wh) return null;
  const out = Buffer.alloc(w * hgt * 4);
  let visible = 0;
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.max(wh[i] - k[i], wh[i + 1] - k[i + 1], wh[i + 2] - k[i + 2]);
    if (k[i] > wh[i] + 32 || k[i + 1] > wh[i + 1] + 32 || k[i + 2] > wh[i + 2] + 32) {
      // "Inverting" pixel (white on black, black on white): draw it dark and opaque.
      out[i] = out[i + 1] = out[i + 2] = 0x18; out[i + 3] = 255;
    } else {
      const a = Math.max(0, Math.min(255, 255 - d));
      out[i] = Math.min(k[i], a); out[i + 1] = Math.min(k[i + 1], a); out[i + 2] = Math.min(k[i + 2], a); out[i + 3] = a;
    }
    if (out[i + 3] > 24) visible++;
  }
  if (!visible) return null;
  return { width: w, height: hgt, hx: Math.min(ii.xHotspot, w - 1), hy: Math.min(ii.yHotspot, hgt - 1), bgra: out };
}

// Current host cursor: { key, name } for a standard cursor, { key, bitmap } for an app-specific one.
function cursorState() {
  const ci = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0, pt: { x: 0, y: 0 } };
  if (!GetCursorInfo(ci) || !ci.hCursor) return { key: '0', name: 'default' };
  const key = String(ci.hCursor);
  const name = cursorByHandle.get(key);
  return name ? { key, name } : { key, handle: ci.hCursor };
}

// ---- hiding the host cursor during a session --------------------------------
// Chromium always paints the cursor into captured frames, and it reads the cursor
// picture from the system. Swapping the system cursors for a transparent one
// before capture starts therefore gives cursor-free video, so the only cursor the
// remote user sees is the one their own machine draws, with no trailing copy.
// SPI_SETCURSORS reloads the user's real cursors. Handles stay the same across
// both, so cursorState() keeps working while hidden.
const CreateCursor = user32.func('CreateCursor', 'uintptr_t', ['uintptr_t', 'int', 'int', 'int', 'int', 'uint8*', 'uint8*']);
const SetSystemCursor = user32.func('SetSystemCursor', 'bool', ['uintptr_t', 'uint32']);
const SystemParametersInfoW = user32.func('SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'uintptr_t', 'uint32']);
function hideCursors() {
  let ok = 0;
  for (const id of Object.keys(IDC)) {
    const h = CreateCursor(0, 0, 0, 32, 32, Buffer.alloc(128, 0xff), Buffer.alloc(128, 0x00)); // fully transparent
    if (h && SetSystemCursor(h, Number(id))) ok++; // SetSystemCursor takes ownership of h
  }
  return ok;
}
function restoreCursors() { return SystemParametersInfoW(0x0057, 0, 0, 0); }

// Changes whenever the clipboard content changes; reading it does not open the clipboard.
const GetClipboardSequenceNumber = user32.func('GetClipboardSequenceNumber', 'uint32', []);

// ---- displays in HDR mode ----------------------------------------------------------
// A display with Windows HDR switched on is captured wrong: the capture gets the desktop after
// Windows has raised SDR content to its HDR brightness and cut it off at SDR white, so everything
// comes out brighter and the light half of the tones turns plain white. Nothing in the capture
// path can undo that (the cut-off part is gone), so the host only finds such displays and says so.
// Returns [{ x, y, hdr, gain }] per active display: position on the virtual desktop in physical
// pixels, whether HDR is on, and how much brighter (in linear light) SDR content is drawn there.
const GetDisplayConfigBufferSizes = user32.func('GetDisplayConfigBufferSizes', 'long', ['uint32', koffi.out(koffi.pointer('uint32')), koffi.out(koffi.pointer('uint32'))]);
const QueryDisplayConfig = user32.func('QueryDisplayConfig', 'long', ['uint32', koffi.inout(koffi.pointer('uint32')), 'uint8*', koffi.inout(koffi.pointer('uint32')), 'uint8*', 'uintptr_t']);
const DisplayConfigGetDeviceInfo = user32.func('DisplayConfigGetDeviceInfo', 'long', ['uint8*']);
function displayColor() {
  const out = [];
  try {
    const QDC_ONLY_ACTIVE_PATHS = 2, PATH = 72, MODE = 64;
    const np = [0], nm = [0];
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, np, nm) !== 0) return out;
    const paths = Buffer.alloc(PATH * np[0]), modes = Buffer.alloc(MODE * nm[0]);
    if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, np, paths, nm, modes, 0) !== 0) return out;
    for (let i = 0; i < np[0]; i++) {
      const p = i * PATH, mi = paths.readUInt32LE(p + 12);
      if (mi >= nm[0] || modes.readUInt32LE(mi * MODE) !== 1) continue; // 1 = source mode
      const x = modes.readInt32LE(mi * MODE + 28), y = modes.readInt32LE(mi * MODE + 32);
      // Request header: type, size, adapter (8 bytes), target id.
      const ask = (type, size) => {
        const b = Buffer.alloc(size);
        b.writeUInt32LE(type, 0); b.writeUInt32LE(size, 4);
        paths.copy(b, 8, p + 20, p + 28); b.writeUInt32LE(paths.readUInt32LE(p + 28), 16);
        return DisplayConfigGetDeviceInfo(b) === 0 ? b : null;
      };
      const color = ask(9, 32), white = ask(11, 24); // advanced colour info, SDR white level
      const hdr = !!color && (color.readUInt32LE(20) & 2) !== 0;
      out.push({ x, y, hdr, gain: hdr && white ? white.readUInt32LE(20) / 1000 : 1 });
    }
  } catch (e) { console.error('display colour', e); }
  return out;
}

// ---- something dragged out of the remote picture ------------------------------------
// While a program runs a drag-and-drop (a file from Explorer, selected text, ...), it has handed
// the mouse to a hidden window of OLE's own, of class CLIPBRDWNDCLASS. That tells a real drag from
// a text selection or a window being moved, which keep the mouse themselves.
// Returns the class of the window that has the mouse in the foreground program ('' = none).
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32', flags: 'uint32', hwndActive: 'uintptr_t', hwndFocus: 'uintptr_t', hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t', hwndMoveSize: 'uintptr_t', hwndCaret: 'uintptr_t', rcCaret: RECT,
});
const GetGUIThreadInfo = user32.func('GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GUITHREADINFO))]);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr_t', 'uint8*', 'int']);
function captureClass() {
  try {
    const gi = { cbSize: koffi.sizeof(GUITHREADINFO), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
    if (!GetGUIThreadInfo(0, gi) || !gi.hwndCapture) return '';
    const buf = Buffer.alloc(256), n = GetClassNameW(gi.hwndCapture, buf, 128);
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  } catch { return ''; }
}
const dragging = () => captureClass() === 'CLIPBRDWNDCLASS';
// The files on the clipboard (what Ctrl+C in Explorer puts there), as full paths.
const shell32 = koffi.load('shell32.dll');
const OpenClipboard = user32.func('OpenClipboard', 'bool', ['uintptr_t']);
const CloseClipboard = user32.func('CloseClipboard', 'bool', []);
const GetClipboardData = user32.func('GetClipboardData', 'uintptr_t', ['uint32']);
const DragQueryFileW = shell32.func('DragQueryFileW', 'uint32', ['uintptr_t', 'uint32', 'uint8*', 'uint32']);
function clipboardFiles() {
  const out = [];
  try {
    if (!OpenClipboard(0)) return out;
    try {
      const h = GetClipboardData(15); // CF_HDROP
      const n = h ? DragQueryFileW(h, 0xffffffff, null, 0) : 0;
      for (let i = 0; i < n && i < 500; i++) {
        const len = DragQueryFileW(h, i, null, 0), buf = Buffer.alloc((len + 1) * 2);
        DragQueryFileW(h, i, buf, len + 1);
        out.push(buf.toString('utf16le', 0, len * 2));
      }
    } finally { CloseClipboard(); }
  } catch (e) { console.error('clipboard files', e); }
  return out;
}
// ---- for the client app (client/shell.js): putting a dropped thing where it was let go ----
const kernel32 = koffi.load('kernel32.dll');
const GetCursorPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]);
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr_t', [POINT]);
const GetAncestor = user32.func('GetAncestor', 'uintptr_t', ['uintptr_t', 'uint32']);
const classOf = (hwnd) => { const buf = Buffer.alloc(256), n = GetClassNameW(hwnd, buf, 128); return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''; };
// What the pointer is over: its position (physical pixels), the top-level window there and that window's class.
function underPointer() {
  const pt = { x: 0, y: 0 };
  if (!GetCursorPos(pt)) return null;
  const leaf = WindowFromPoint(pt), root = leaf ? GetAncestor(leaf, 2) || leaf : 0; // 2 = GA_ROOT
  return { x: pt.x, y: pt.y, hwnd: Number(root), cls: root ? classOf(root) : '' };
}
// A left click at a point of the desktop; the pointer then goes back to where it was.
function clickAt(px, py) {
  const v = { x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) };
  const go = (x, y) => mouse(MF.MOVE | MF.ABS | MF.VDESK, Math.round(((x - v.x) * 65535) / Math.max(1, v.w - 1)), Math.round(((y - v.y) * 65535) / Math.max(1, v.h - 1)));
  const back = { x: 0, y: 0 }, had = GetCursorPos(back);
  go(px, py);
  mouse(MF.LD); mouse(MF.LU);
  if (had) go(back.x, back.y);
}
// Files onto the clipboard, the way Explorer's "Copy" puts them there (CF_HDROP): a DROPFILES
// header followed by the paths in UTF-16, each ended by a zero and the list by one more.
function dropFilesBuffer(paths) {
  const list = Buffer.from(paths.join('\0') + '\0\0', 'utf16le'), buf = Buffer.alloc(20 + list.length);
  buf.writeUInt32LE(20, 0); // where the list starts
  buf.writeUInt32LE(1, 16); // wide characters
  list.copy(buf, 20);
  return buf;
}
const GlobalAlloc = kernel32.func('GlobalAlloc', 'uintptr_t', ['uint32', 'size_t']);
const GlobalLock = kernel32.func('GlobalLock', 'uintptr_t', ['uintptr_t']);
const GlobalUnlock = kernel32.func('GlobalUnlock', 'bool', ['uintptr_t']);
const GlobalFree = kernel32.func('GlobalFree', 'uintptr_t', ['uintptr_t']);
const RtlMoveMemory = kernel32.func('RtlMoveMemory', 'void', ['uintptr_t', 'uint8*', 'size_t']);
const EmptyClipboard = user32.func('EmptyClipboard', 'bool', []);
const SetClipboardData = user32.func('SetClipboardData', 'uintptr_t', ['uint32', 'uintptr_t']);
function setClipboardFiles(paths) {
  const buf = dropFilesBuffer(paths);
  const h = GlobalAlloc(0x42, buf.length); // movable, zeroed
  if (!h) return false;
  const mem = GlobalLock(h);
  if (!mem) { GlobalFree(h); return false; }
  RtlMoveMemory(mem, buf, buf.length);
  GlobalUnlock(h);
  if (!OpenClipboard(0)) { GlobalFree(h); return false; }
  let ok = false;
  try { EmptyClipboard(); ok = !!SetClipboardData(15, h); } finally { CloseClipboard(); } // the clipboard owns the memory now
  if (!ok) GlobalFree(h);
  return ok;
}

// A mouse button released where the pointer is, and keys pressed and released in order.
function buttonUp(b) {
  const B = BTN[b | 0];
  if (!B) return;
  buttonsDown &= ~(1 << (b | 0));
  mouse(B[1], 0, 0, B[2]);
}
function tap(codes) {
  for (const c of codes) key(c, '', false);
  for (const c of [...codes].reverse()) key(c, '', true);
}

module.exports = { handle, reset, setMonitors, target, cursorState, cursorBitmap, hideCursors, restoreCursors, displayColor, captureClass, dragging, clipboardFiles, buttonUp, tap, underPointer, clickAt, dropFilesBuffer, setClipboardFiles, clipSeq: () => GetClipboardSequenceNumber() };
