// `electron . --selftest --input-check` on Linux (X11): real input through XTest on the display the
// self-test runs on, into a window and a second program this check opens itself. Meant for a virtual
// display (Xvfb): it moves the pointer, clicks, scrolls and types, so not on a desktop someone uses.
//
// A. The pointer goes where the client said (read back with XQueryPointer).
// B. Whether the browser engine's capturer puts the pointer into the video (an INFO line).
// C. Every key of the key table, the five buttons and the wheel arrive in a test window with the code,
//    button and direction the client sent; the window under the pointer and the bare desktop are told
//    apart (what the client app uses to place dropped files).
// D. Selected text, then a file, dragged out of another program (a second Electron process, so a
//    Chromium-based program: it drops its text selection when a drag is cancelled): its drag-and-drop
//    (XDND) is noticed while the button is held, and the host's real drag-out step (dragOut in main.js:
//    what is dragged, asked of that program; Escape; release) hands the text and the file over.
// E. The client app's side (client/shell.js, through its preload as the page uses it): a file let go
//    over the bare desktop is saved in the desktop folder (a temporary folder stands in for it), one
//    let go over another program's window goes onto the clipboard, and nothing is clicked or typed.
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const input = require('./input');
const { keyCodes } = require('./platform/linux');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCKS = new Set(['CapsLock', 'NumLock', 'ScrollLock']); // pressed twice, so they end as they were

const TEST_PAGE = `<!doctype html><body style="margin:0;height:100vh;background:#345" tabindex="0"><script>
window.ev = [];
for (const t of ['keydown', 'keyup']) addEventListener(t, (e) => { ev.push([t, e.code]); e.preventDefault(); }, true);
for (const t of ['mousedown', 'mouseup']) addEventListener(t, (e) => ev.push([t, e.button]), true);
addEventListener('wheel', (e) => ev.push(['wheel', Math.sign(e.deltaX), Math.sign(e.deltaY)]), true);
for (const t of ['contextmenu', 'auxclick']) addEventListener(t, (e) => e.preventDefault(), true);
</script></body>`;
// The second program: a window with selected text and an element that drags a file (Electron's
// startDrag, which offers it as text/uri-list as file managers do). It says where both are, and logs
// what its page sees.
const DRAG_SOURCE = `const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
app.setPath('userData', path.join(__dirname, 'profile'));
ipcMain.on('drag-file', (e) => e.sender.startDrag({ file: path.join(__dirname, 'dragged file.txt'), icon: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }) }));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ x: 700, y: 420, width: 560, height: 300, show: false, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') } });
  w.removeMenu();
  w.webContents.on('console-message', (_e, _level, msg) => process.stdout.write('EV ' + msg + '\\n'));
  const log = '<script>for (const t of ["dragstart", "dragend", "keydown", "copy", "mousedown", "mouseup"]) addEventListener(t, (e) => console.log(t + " " + (e.code || "") + " " + Math.round(performance.now())), true);'
    + 'document.getElementById("f").addEventListener("dragstart", (e) => { e.preventDefault(); window.dragFile(); });</script>';
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#fff"><p id="t" style="font:28px sans-serif;margin:40px">' + __TEXT__ + '</p>'
    + '<div id="f" draggable="true" style="font:20px sans-serif;margin:0 40px;padding:14px;background:#cde;width:200px">a file</div>' + log + '</body>'));
  w.show(); w.focus();
  await new Promise((r) => setTimeout(r, 800));
  const r = await w.webContents.executeJavaScript(\`(() => { const t = document.getElementById('t'), r = document.createRange(); r.selectNodeContents(t);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); const b = r.getBoundingClientRect(), f = document.getElementById('f').getBoundingClientRect();
    return { text: { x: b.left + b.width / 2, y: b.top + b.height / 2 }, file: { x: f.left + f.width / 2, y: f.top + f.height / 2 } }; })()\`);
  const c = w.getContentBounds(), on = (p) => ({ x: c.x + p.x, y: c.y + p.y });
  process.stdout.write('READY ' + JSON.stringify({ text: on(r.text), file: on(r.file) }) + '\\n');
});
app.on('window-all-closed', () => app.quit());
`;
const DRAG_SOURCE_PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dragFile', () => ipcRenderer.send('drag-file'));
`;

exports.run = async ({ check, info, js, until, dragOut }) => {
  const why = input.viewOnlyReason();
  if (why) { check('X11: input can be injected', false, why); return; }
  const mons = await js(`monitors.map((m) => ({ x: m.x, y: m.y, width: m.width, height: m.height }))`);
  const at = (px, py) => {
    const i = mons.findIndex((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height);
    return i < 0 ? null : { d: i, x: (px - mons[i].x) / (mons[i].width - 1), y: (py - mons[i].y) / (mons[i].height - 1) };
  };
  const send = (o) => input.handle(JSON.stringify(o));
  const moveTo = (px, py) => send({ t: 'mm', ...at(px, py), h: 0 });
  const physical = (x, y) => { const s = screen.getPrimaryDisplay().scaleFactor || 1; return { x: Math.round(x * s), y: Math.round(y * s) }; };
  const m0 = mons[0];

  // ---- A ----
  const goal = { x: m0.x + Math.round((m0.width - 1) * 0.3), y: m0.y + Math.round((m0.height - 1) * 0.65) };
  moveTo(goal.x, goal.y);
  await sleep(150);
  const p = input.underPointer();
  check('X11: the pointer goes where the client said (XTest, read back with XQueryPointer)', p && Math.abs(p.x - goal.x) <= 1 && Math.abs(p.y - goal.y) <= 1,
    `wanted ${goal.x},${goal.y}, the pointer is at ${p ? p.x + ',' + p.y : '?'}`);

  // ---- B ----
  {
    await js(`setSel(mainView, 0); setFit(mainView, '1:1')`);
    await until((x) => Number(String(x.res[0]).split('x')[0]) === x.mons[0].w, 15);
    const grab = async () => {
      await sleep(1500);
      return js(`(() => { const v = mainView.panes[0].video, c = document.createElement('canvas'); c.width = c.height = 40;
        const g = c.getContext('2d'); g.drawImage(v, ${goal.x - m0.x - 4}, ${goal.y - m0.y - 4}, 40, 40, 0, 0, 40, 40); return Array.from(g.getImageData(0, 0, 40, 40).data); })()`);
    };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++; return n; };
    const on1 = await grab(), on2 = await grab();
    moveTo(goal.x + 240, goal.y + 120);
    const off = await grab();
    const noise = diff(on1, on2), changed = diff(on1, off);
    info(`the browser engine's capturer on X11 ${changed > 20 && changed > noise * 3 ? 'paints the pointer into the video' : 'leaves the pointer out of the video'}`
      + ` (${changed} pixels under the pointer changed when it moved away, ${noise} without moving)`);
    await js(`setFit(mainView, 'fit')`);
  }

  // ---- C ----
  const tw = new BrowserWindow({ x: 160, y: 120, width: 560, height: 360, show: false, backgroundColor: '#334455', webPreferences: { backgroundThrottling: false } });
  try {
    tw.removeMenu(); // no menu, so no key is taken as a menu shortcut
    await tw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_PAGE));
    tw.show();
    tw.focus();
    await sleep(1000);
    const tjs = (code) => tw.webContents.executeJavaScript(code);
    const cb = tw.getContentBounds(), c0 = physical(cb.x, cb.y), c1 = physical(cb.x + cb.width, cb.y + cb.height);
    const mid = { x: Math.round((c0.x + c1.x) / 2), y: Math.round((c0.y + c1.y) / 2) };
    moveTo(mid.x, mid.y);
    await sleep(300);
    const over = input.underPointer();
    moveTo(c1.x + 150, c1.y + 150); // nothing there but the root window
    await sleep(200);
    const bare = input.underPointer();
    const handle = tw.getNativeWindowHandle(), xid = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    check('X11: the window under the pointer and the bare desktop are told apart (where the client app puts a drop)',
      over && over.hwnd === xid && !over.desktop && bare && bare.desktop, JSON.stringify({ test_window: xid, over_it: over, beside_it: bare }));

    moveTo(mid.x, mid.y);
    await sleep(200);
    await tjs('window.ev = []; 1');
    for (const c of keyCodes) for (let n = LOCKS.has(c) ? 2 : 1; n > 0; n--) { send({ t: 'kd', c, k: '' }); send({ t: 'ku', c, k: '' }); await sleep(3); }
    send({ t: 'kd', c: 'AltRight', k: 'HangulMode' }); send({ t: 'ku', c: 'AltRight', k: 'HangulMode' }); // a Korean keyboard's Hangul key
    await sleep(1000);
    const ev = await tjs('window.ev');
    const downs = ev.filter((e) => e[0] === 'keydown').map((e) => e[1]), ups = new Set(ev.filter((e) => e[0] === 'keyup').map((e) => e[1]));
    const missing = keyCodes.filter((c) => !downs.includes(c) || !ups.has(c));
    const hangul = downs.filter((c) => c === 'Lang1').length === 2;
    check('X11: every key of the table arrives with the code the client sent (XTest, evdev + 8)', !missing.length && hangul && tw.isFocused(),
      `${keyCodes.length - missing.length} of ${keyCodes.length} keys${missing.length ? ', not arriving: ' + missing.join(' ') : ''}; HangulMode arrives as ${hangul ? 'Lang1' : 'something else'}${tw.isFocused() ? '' : '; the test window had no focus'}`);

    await tjs('window.ev = []; 1');
    for (let b = 0; b < 5; b++) { send({ t: 'md', b, ...at(mid.x, mid.y) }); await sleep(40); send({ t: 'mu', b, ...at(mid.x, mid.y) }); await sleep(80); }
    for (const [dx, dy] of [[0, 100], [0, -100], [100, 0], [-100, 0]]) { send({ t: 'mw', dx, dy }); await sleep(120); }
    await sleep(500);
    const ev2 = await tjs('window.ev');
    const btns = ev2.filter((e) => e[0] === 'mousedown').map((e) => e[1]), wheels = ev2.filter((e) => e[0] === 'wheel').map((e) => e[1] + ',' + e[2]);
    check('X11: the five buttons and the wheel arrive as the client sent them', JSON.stringify(btns) === '[0,1,2,3,4]' && JSON.stringify(wheels) === JSON.stringify(['0,1', '0,-1', '1,0', '-1,0']),
      `buttons ${JSON.stringify(btns)}, wheel (x,y direction) ${JSON.stringify(wheels)}`);
  } finally { tw.destroy(); }

  // ---- D ----
  const text = 'dragged ' + crypto.randomBytes(4).toString('hex');
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragsrc-'));
  fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'myremote-dragsource', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(srcDir, 'main.js'), DRAG_SOURCE.replace('__TEXT__', JSON.stringify(text)));
  fs.writeFileSync(path.join(srcDir, 'preload.js'), DRAG_SOURCE_PRELOAD);
  const fileText = crypto.randomBytes(3000).toString('hex');
  fs.writeFileSync(path.join(srcDir, 'dragged file.txt'), fileText);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [srcDir, ...process.argv.filter((a) => a === '--no-sandbox' || a === '--disable-gpu')], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  const seen = () => out.split('\n').filter((l) => l.startsWith('EV ')).map((l) => l.slice(3)).join(', '); // what the program saw
  // Press on `pt`, move until the program has started its drag, then the host's drag-out step.
  const dragFrom = async (pt) => {
    const p0 = physical(pt.x, pt.y);
    moveTo(p0.x, p0.y);
    await sleep(300);
    send({ t: 'md', b: 0, ...at(p0.x, p0.y) });
    await sleep(150);
    const t0 = Date.now();
    let seenAt = null;
    for (let k = 1; k <= 15 && seenAt == null; k++) { send({ t: 'mm', ...at(p0.x + k * 6, p0.y + k * 3), h: 1 }); await sleep(40); if (input.dragging()) seenAt = Date.now() - t0; }
    for (let k = 0; k < 60 && seenAt == null; k++) { await sleep(25); if (input.dragging()) seenAt = Date.now() - t0; }
    const t1 = Date.now(), r = await dragOut(0), took = Date.now() - t1;
    await sleep(400);
    const end = input.underPointer();
    return { seenAt, r, took, left: end ? end.buttons : -1 };
  };
  try {
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 30000);
      child.stdout.on('data', (d) => { out += d; const m = /READY (\{.*\})/.exec(out); if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); } });
      child.on('exit', () => { clearTimeout(timer); resolve(null); });
    });
    if (!ready) { check('X11: a second program to drag from starts', false, 'it did not say where its text is'); return; }
    const a = await dragFrom(ready.text);
    check('X11: a drag-and-drop started in another program is noticed (it takes XdndSelection while the button is held)', a.seenAt != null,
      a.seenAt != null ? `${a.seenAt} ms after the pointer started moving` : 'not seen');
    const okText = a.r && a.r.kind === 'text' && String(a.r.s).trim() === text;
    check('X11: dragging text out hands it over and ends the drag (asked of the dragging program, Escape, release)', okText && a.left === 0 && !input.dragging(),
      `${JSON.stringify(a.r)} after ${a.took} ms; buttons held afterwards: ${a.left}${okText ? '' : '; the program saw: ' + seen()}`);
    const b = await dragFrom(ready.file);
    const f = b.r && b.r.files && b.r.files[0];
    check('X11: dragging a file out hands over its name and size (text/uri-list), and nothing is left held',
      b.r && b.r.kind === 'files' && b.r.files.length === 1 && f.name === 'dragged file.txt' && f.size === fileText.length && b.left === 0 && !input.dragging(),
      `${JSON.stringify(b.r)} after ${b.took} ms (drag seen after ${b.seenAt} ms); buttons held afterwards: ${b.left}`);

    // ---- E ----
    const shell = require('../client/shell');
    const desk = app.getPath('desktop'), stand = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-desktop-'));
    const sw = new BrowserWindow({ show: false, webPreferences: { preload: shell.PRELOAD, partition: 'input-check' } }); // its own session: attach() sets permission handlers
    try {
      app.setPath('desktop', stand);
      shell.attach(sw);
      await sw.loadURL('data:text/html,<p>drop</p>');
      // What the page does when something it received is let go at the pointer (receiveFiles in the client page).
      const dropHere = (name, group) => sw.webContents.executeJavaScript(`(async () => { const s = window.mrShell, id = await s.dropPoint();
        const f = await s.fileBegin(${JSON.stringify(name)}, '${group}'); await s.fileChunk(f, new TextEncoder().encode('dropped')); await s.fileEnd(f);
        return s.dropFiles(id, [f], '${group}'); })()`);
      moveTo(m0.x + m0.width - 40, m0.y + 40); // a corner where no window is: the bare desktop
      await sleep(200);
      const before = input.underPointer();
      const group = () => crypto.randomBytes(5).toString('hex');
      const onDesk = await dropHere('dropped.txt', group());
      const p1 = physical(ready.text.x, ready.text.y);
      moveTo(p1.x, p1.y); // over the other program's window
      await sleep(200);
      const seq = input.clipSeq(), onWindow = await dropHere('dropped2.txt', group());
      await sleep(200);
      const listed = input.clipboardFiles(), after = input.underPointer();
      check('X11: client app: a file let go over the desktop is saved there; over a program it goes onto the clipboard, nothing is clicked',
        before.desktop && onDesk.how === 'saved' && fs.readFileSync(path.join(stand, 'dropped.txt'), 'utf8') === 'dropped' && onWindow.how === 'clipboard'
        && input.clipSeq() !== seq && listed.length === 1 && path.basename(listed[0]) === 'dropped2.txt' && before.buttons === 0 && after.buttons === 0,
        `desktop: ${JSON.stringify(onDesk)}, a program's window: ${JSON.stringify(onWindow)}, on the clipboard: ${listed.map((x) => path.basename(x)).join(', ') || 'nothing'}`);
      if (listed.length === 1 && path.basename(path.dirname(listed[0])).startsWith('g-')) try { fs.rmSync(path.dirname(listed[0]), { recursive: true, force: true }); } catch {}
    } finally {
      app.setPath('desktop', desk);
      sw.destroy();
      try { fs.rmSync(stand, { recursive: true, force: true }); } catch {}
    }
  } finally {
    try { child.kill(); } catch {}
    await sleep(1000);
    try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch {}
  }
};
