// A worker thread of the host's main process (Windows): the safety net under the frame presses of input.js.
//
// The main thread injects the client's input. When Windows holds that thread in a loop of its own - a
// press on one of its windows' frame (tracked until the button goes up), the window menu, a drag - the
// client's next input, the release that would end the loop, can only be injected once the loop has ended:
// remote control stopped until someone at the PC clicked (the user's report of 2026-11-16, the host
// window's minimize button pressed from the client; the main thread was gone for 184 s and came back when
// Chrome Remote Desktop connected). input.js no longer injects such presses; this is for a loop it did not
// foresee. When the main thread has not beaten for STALE_MS while it holds the mouse, a menu or a window
// being moved or sized, the loop is ended with WM_CANCELMODE, sent: measured in the test VM (2026-11-17),
// a posted one is not taken inside the loop, a sent one ends it at once; the press is then simply undone
// (the button stays down until the client's own release, which the main thread injects once it is back).
// A window being moved by the title bar came back by itself after about 0.5 s (Chromium runs its tasks
// inside that loop), hence the wait.
//   workerData: { koffi: <path of the koffi module>, tid: <main thread id>, hb: Int32Array on a SharedArrayBuffer }
//   hb[0]: the main thread's heartbeat (ms since it started this), hb[1]: loops ended (for the log and the self-test)
'use strict';
const { workerData, parentPort } = require('worker_threads');
const STALE_MS = 800, AGAIN_MS = 2000;
const koffi = require(workerData.koffi);
const user32 = koffi.load('user32.dll');
const RECT = koffi.struct('IG_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GUITHREADINFO = koffi.struct('IG_GUITHREADINFO', {
  cbSize: 'uint32', flags: 'uint32', hwndActive: 'uintptr_t', hwndFocus: 'uintptr_t', hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t', hwndMoveSize: 'uintptr_t', hwndCaret: 'uintptr_t', rcCaret: RECT,
});
const GetGUIThreadInfo = user32.func('GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GUITHREADINFO))]);
const SendMessageTimeoutW = user32.func('SendMessageTimeoutW', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t', 'uint32', 'uint32', koffi.out(koffi.pointer('uintptr_t'))]);
const { tid, hb, t0 } = workerData;
const now = () => Date.now() - t0;
let lastTry = -Infinity;
setInterval(() => {
  const stale = now() - Atomics.load(hb, 0);
  if (stale < STALE_MS || now() - lastTry < AGAIN_MS) return;
  const gi = { cbSize: koffi.sizeof(GUITHREADINFO), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  if (!GetGUIThreadInfo(tid, gi)) return;
  const target = Number(gi.hwndCapture || gi.hwndMenuOwner || gi.hwndMoveSize || 0);
  if (!target) return; // stalled by something else (a long call): nothing a window loop would explain
  lastTry = now();
  const res = [0];
  const r = SendMessageTimeoutW(target, 0x001F /* WM_CANCELMODE */, 0, 0, 0x0002 /* SMTO_ABORTIFHUNG */, 1000, res);
  Atomics.add(hb, 1, 1);
  const what = gi.hwndCapture ? 'the mouse' : gi.hwndMenuOwner ? 'a menu' : 'a window being moved';
  parentPort.postMessage(`the main thread was held ${stale} ms by a window loop (${what}): ended it (WM_CANCELMODE ${r ? 'taken' : 'not taken'})`);
}, 100);
