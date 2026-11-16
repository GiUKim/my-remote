// --frame-check (Windows): presses from the client onto the host window's own frame - its minimize button, its
// title bar - through the real input path (input.handle, which the host's page feeds the client's messages
// to), and then a press that does not go through it (the safety net, host/inputguard.js). Before 0.8.1 the
// first of these stopped remote control for good (the user's report of 2026-11-16). INJECTS INPUT for about
// fifteen seconds, onto the host window this run shows: run it in the test VM, or with the person's agreement.
'use strict';
const { BrowserWindow, screen } = require('electron');
const input = require('./input');

exports.run = async ({ check, info, guardHb }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const win = BrowserWindow.getAllWindows().find((w) => /My Remote Host/.test(w.getTitle()));
  if (!win) return check('frame check: the host window is there', false, 'not found');
  win.setBounds({ x: 120, y: 120, width: 560, height: 680 });
  win.show(); win.focus();
  await sleep(1200);
  const area = screen.dipToScreenRect(null, screen.getDisplayMatching(win.getBounds()).bounds);
  input.setMonitors([area]);
  const send = (m) => input.handle(JSON.stringify(m));
  const at = (p) => ({ d: 0, x: (p.x - area.x) / (area.width - 1), y: (p.y - area.y) / (area.height - 1) });
  // A point of the given part of the frame, found the way input.js asks (WM_NCHITTEST on this thread).
  const find = (hit) => {
    const r = screen.dipToScreenRect(win, win.getBounds()), y = r.y + 14;
    for (let x = r.x + r.width - 3; x > r.x; x -= 2) { const f = input.ownFrame(x, y); if (f && f.hit === hit) return { x, y }; }
    return null;
  };
  // This thread's beat: a window loop holding it shows as a long gap.
  let maxGap = 0, last = Date.now();
  const beat = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
  const gap = () => { const g = maxGap; maxGap = 0; last = Date.now(); return g; };
  try {
    const pMin = find('min'), pCap = find('caption');
    info(`frame check: minimize button at ${pMin ? pMin.x + ',' + pMin.y : '?'}, title bar at ${pCap ? pCap.x + ',' + pCap.y : '?'}, close button ${find('close') ? 'found' : 'not found'}`);
    if (!pMin || !pCap) return check('frame check: the frame of the host window is found', false, 'no minimize button or title bar');

    // 1. The minimize button, pressed and let go 150 ms later as a client's click comes.
    gap();
    send({ t: 'mm', ...at(pMin), h: 0 }); send({ t: 'md', b: 0, ...at(pMin) }); await sleep(150); send({ t: 'mu', b: 0, ...at(pMin) });
    await sleep(800);
    const g1 = gap(), minimized = win.isMinimized();
    check('the client presses the host window\'s minimize button: it minimizes, and input goes on', minimized && g1 < 400, `minimized: ${minimized}, longest stop of the input thread ${g1} ms`);
    win.restore(); win.focus(); await sleep(800);

    // 2. The title bar dragged 80 px right and 50 px down.
    const before = win.getBounds(), p = find('caption');
    gap();
    send({ t: 'md', b: 0, ...at(p) });
    for (let i = 1; i <= 5; i++) { await sleep(30); send({ t: 'mm', ...at({ x: p.x + 16 * i, y: p.y + 10 * i }), h: 1 }); }
    await sleep(60); send({ t: 'mu', b: 0, ...at({ x: p.x + 80, y: p.y + 50 }) });
    await sleep(400);
    const after = win.getBounds(), g2 = gap(), dx = after.x - before.x, dy = after.y - before.y;
    check('the client drags the host window by its title bar: it moves with the pointer, and input goes on', Math.abs(dx - 80) <= 4 && Math.abs(dy - 50) <= 4 && g2 < 400, `moved ${dx},${dy} (wanted 80,50), longest stop ${g2} ms`);

    // 3. The safety net: a press onto the minimize button that does not go through input.js (as one it did not
    // foresee would), its release a later task of this thread. The input guard ends the window loop.
    const w32 = require('./platform/win32');
    const q = find('min');
    if (!guardHb) { info('frame check: no input guard in this run'); return; }
    const ended = Atomics.load(guardHb, 1);
    gap();
    const t = input.target(0, at(q).x, at(q).y);
    w32.move(t); w32.button(0, true);
    let releasedAfter = -1; const t0 = Date.now();
    setTimeout(() => { releasedAfter = Date.now() - t0; w32.button(0, false); }, 150);
    await sleep(2500);
    const g3 = gap(), byGuard = Atomics.load(guardHb, 1) - ended;
    check('a press the input path did not foresee (the safety net): the input guard frees the input thread within about a second',
      byGuard >= 1 && releasedAfter >= 0 && releasedAfter < 1600 && !win.isMinimized(),
      `loops ended by the guard: ${byGuard}, the later release ran after ${releasedAfter} ms, longest stop ${g3} ms, minimized: ${win.isMinimized()}`);
    if (releasedAfter < 0) w32.button(0, false);
  } finally {
    clearInterval(beat);
    input.reset();
    win.hide();
  }
};
