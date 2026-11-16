// `electron . --selftest --dragout-check`: real drags out of a real Explorer window on this PC.
//
// A. Straight on the host: press on a test file, move until Explorer starts its drag-and-drop, then
//    do what the host does when a client lets go outside its windows (dragOut in main.js): Escape,
//    Ctrl+C, release, read the clipboard. On the way it records what the host can see of the drag
//    (which window of which thread holds the mouse, the drag picture, the cursor).
// B. The whole way through a client window: the real client page inside the client app's shell,
//    driven with pointer events as a person at another PC would: press on the file in the picture,
//    move, leave the window, hold outside, let go. The page waits for the host's drag and asks for
//    it ('dragout'), the host sends the file, the shell puts it where the pointer was let go, which
//    on this one PC is the Explorer window itself: the file must come back as "... (2).txt".
// C. As B, but let go right after leaving the window, before Explorer has started its drag.
//
// THIS INJECTS INPUT on this PC for about half a minute, into the Explorer window it opened itself:
// whoever uses this PC must not touch the mouse or keyboard meanwhile, so ask first. It runs only
// when the clipboard holds nothing or text (plain, HTML, RTF), which is put back afterwards, and it
// presses nothing when anything else covers the test file on the screen.
const { BrowserWindow, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const koffi = require('koffi');
const input = require('./input');

const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
const POINT = koffi.struct('DC_POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('DC_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GTI = koffi.struct('DC_GUITHREADINFO', {
  cbSize: 'uint32', flags: 'uint32', hwndActive: 'uintptr_t', hwndFocus: 'uintptr_t', hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t', hwndMoveSize: 'uintptr_t', hwndCaret: 'uintptr_t', rcCaret: RECT,
});
const TE32 = koffi.struct('DC_THREADENTRY32', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ThreadID: 'uint32', th32OwnerProcessID: 'uint32', tpBasePri: 'int32', tpDeltaPri: 'int32', dwFlags: 'uint32',
});
const GetGUIThreadInfo = user32.func('GetGUIThreadInfo', 'bool', ['uint32', koffi.inout(koffi.pointer(GTI))]);
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uintptr_t', 'uint8*', 'int']);
const WindowFromPoint = user32.func('WindowFromPoint', 'uintptr_t', [POINT]);
const GetAncestor = user32.func('GetAncestor', 'uintptr_t', ['uintptr_t', 'uint32']);
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uintptr_t', koffi.out(koffi.pointer('uint32'))]);
const SetWindowPos = user32.func('SetWindowPos', 'bool', ['uintptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32']);
const ShowWindow = user32.func('ShowWindow', 'bool', ['uintptr_t', 'int']);
const PostMessageW = user32.func('PostMessageW', 'bool', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);
const FindWindowW = user32.func('FindWindowW', 'uintptr_t', ['str16', 'str16']);
const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['uintptr_t']);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr_t']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]);
const CreateToolhelp32Snapshot = kernel32.func('CreateToolhelp32Snapshot', 'intptr_t', ['uint32', 'uint32']);
const Thread32First = kernel32.func('Thread32First', 'bool', ['intptr_t', koffi.inout(koffi.pointer(TE32))]);
const Thread32Next = kernel32.func('Thread32Next', 'bool', ['intptr_t', koffi.inout(koffi.pointer(TE32))]);
const CloseHandle = kernel32.func('CloseHandle', 'bool', ['intptr_t']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const classOf = (h) => { if (!h) return ''; const b = Buffer.alloc(512), n = GetClassNameW(h, b, 256); return n > 0 ? b.toString('utf16le', 0, n * 2) : '?'; };
function gui(tid) {
  const gi = { cbSize: koffi.sizeof(GTI), flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: { left: 0, top: 0, right: 0, bottom: 0 } };
  return GetGUIThreadInfo(tid, gi) ? gi : null;
}
function threadsOf(pid) {
  const snap = CreateToolhelp32Snapshot(4, 0), out = []; // TH32CS_SNAPTHREAD
  if (snap === -1 || !snap) return out;
  try {
    const te = { dwSize: koffi.sizeof(TE32), cntUsage: 0, th32ThreadID: 0, th32OwnerProcessID: 0, tpBasePri: 0, tpDeltaPri: 0, dwFlags: 0 };
    for (let ok = Thread32First(snap, te); ok; ok = Thread32Next(snap, te)) if (te.th32OwnerProcessID === pid) out.push(te.th32ThreadID);
  } finally { CloseHandle(snap); }
  return out;
}
// What the host can see of a drag in the program that owns `hwnd`.
function look(hwnd) {
  const fg = gui(0) || {}, pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  const holders = [];
  for (const tid of threadsOf(pid[0])) { const g = gui(tid); if (g && g.hwndCapture) holders.push(classOf(g.hwndCapture)); }
  const img = FindWindowW('SysDragImage', null), cur = input.cursorState();
  return {
    foreground: { active: classOf(fg.hwndActive), capture: classOf(fg.hwndCapture), flags: fg.flags || 0 },
    explorerThreadsHoldingTheMouse: holders,
    dragPicture: !!img && IsWindowVisible(img),
    cursor: cur.name || 'not a system cursor',
    hostSaysDragging: input.dragging(),
  };
}
const ps = (script, ms = 20000) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script],
  { windowsHide: true, timeout: ms }, (err, out) => resolve(err ? '' : String(out).trim())));
// The Explorer window that shows `dir` (asked of the shell, read-only).
async function explorerWindow(dir) {
  const out = await ps(`$t=[DateTime]::Now.AddSeconds(12); do { foreach($w in (New-Object -ComObject Shell.Application).Windows()){ try { if($w.Document.Folder.Self.Path -eq '${dir.replace(/'/g, "''")}'){ [int64]$w.HWND; exit } } catch {} }; Start-Sleep -Milliseconds 300 } while([DateTime]::Now -lt $t)`);
  return Number(out) || 0;
}
// Where to press on an item whose name starts with `prefix` in that window's file list (UI
// Automation, read-only). The point lies in the VISIBLE part of the list (Explorer scrolls the list
// sideways when something is dragged past its edge, and a point computed from the item alone then
// fell on the navigation pane, which shows the user's own folders), and the item found at that
// point is checked to be this item. Null when that cannot be made sure of: then nothing is pressed.
async function itemRect(hwnd, prefix) {
  const out = await ps(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase; $A=[System.Windows.Automation.AutomationElement]; $root=$A::FromHandle([IntPtr]${hwnd});
    $c=New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty,[System.Windows.Automation.ControlType]::ListItem); $v=New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty,'UIItemsView');
    $t=[DateTime]::Now.AddSeconds(8); do { $list=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$v); if($list){ $lr=$list.Current.BoundingRectangle;
      foreach($e in $list.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)){ $n=$e.Current.Name; if($n -like '${prefix}*' -and $n -notlike '*(*'){ $r=$e.Current.BoundingRectangle;
        if($r.Width -gt 0){ $x=[Math]::Max($r.X + 40, $lr.X + 12); $x=[Math]::Min($x, $r.X + $r.Width - 8, $lr.X + $lr.Width - 24); $y=$r.Y + $r.Height/2;
          if($y -gt $lr.Y + 4 -and $y -lt $lr.Y + $lr.Height - 20){ $hit=$A::FromPoint((New-Object System.Windows.Point($x,$y))); $w=[System.Windows.Automation.TreeWalker]::ControlViewWalker;
            while($hit -and $hit.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem){ $hit=$w.GetParent($hit) }
            if($hit -and $hit.Current.Name -eq $n){ '{0},{1},{2},{3},{4},{5}' -f [int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height,[int]$x,[int]$y; exit } } } } } }; Start-Sleep -Milliseconds 300 } while([DateTime]::Now -lt $t)`);
  const m = /^(-?\d+),(-?\d+),(\d+),(\d+),(-?\d+),(-?\d+)/.exec(out);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4], px: +m[5], py: +m[6] } : null;
}

// A point of empty space inside a folder window's list of items, seen there by UI Automation (a point
// another window covers is not: once a dialog of the person's lay over the target window, and the drop
// point was a SysLink of it).
async function emptySpot(hwnd) {
  const out = await ps(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase; $A=[System.Windows.Automation.AutomationElement]; $root=$A::FromHandle([IntPtr]${hwnd});
    $v=New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty,'UIItemsView'); $w=[System.Windows.Automation.TreeWalker]::ControlViewWalker;
    $t=[DateTime]::Now.AddSeconds(8); do { $list=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$v); if($list){ $lr=$list.Current.BoundingRectangle;
      foreach($p in @(@(0.8,0.8),@(0.55,0.85),@(0.85,0.55),@(0.5,0.6))){ $x=[int]($lr.X + $lr.Width*$p[0]); $y=[int]($lr.Y + $lr.Height*$p[1]);
        $hit=$A::FromPoint((New-Object System.Windows.Point($x,$y))); $item=$false;
        while($hit -and $hit.Current.ClassName -ne 'UIItemsView'){ if($hit.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem){ $item=$true }; $hit=$w.GetParent($hit) }
        if($hit -and -not $item){ '{0},{1}' -f $x,$y; exit } } }; Start-Sleep -Milliseconds 300 } while([DateTime]::Now -lt $t)`);
  const m = /^(-?\d+),(-?\d+)/.exec(out);
  return m ? { px: +m[1], py: +m[2] } : null;
}

// `electron . --selftest --dropin-check`: files dragged IN, for real. A real drag (injected input)
// from an Explorer window on the second display onto a client window's picture of the first one;
// the page uploads the files and the host drops them where they were let go in the picture:
//   D. onto the empty space of another Explorer window (a file),
//   E. onto a folder icon in that window (a file: it must land inside that folder),
//   F. a whole folder onto the empty space.
// The client window does not move the host's pointer while files are dragged over it (both
// pointers are the same one on one PC). INJECTS INPUT for about half a minute: ask first.
exports.runIn = async ({ check, info, cfg, buildClientHtml }) => {
  const displays = screen.getAllDisplays(), prim = screen.getPrimaryDisplay(), other = displays.find((d) => d.id !== prim.id);
  if (!other) { info('drop-in check skipped: it needs a second display'); return; }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dropin-')), src = path.join(base, 'src'), dst = path.join(base, 'dst');
  fs.mkdirSync(path.join(src, 'in-dir', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'sub'), { recursive: true });
  const content = { 'in-a.txt': crypto.randomBytes(30000).toString('hex'), 'in-b.txt': crypto.randomBytes(20000).toString('hex'), x: crypto.randomBytes(9000).toString('hex') };
  fs.writeFileSync(path.join(src, 'in-a.txt'), content['in-a.txt']);
  fs.writeFileSync(path.join(src, 'in-b.txt'), content['in-b.txt']);
  fs.writeFileSync(path.join(src, 'in-dir', 'deeper', 'x.txt'), content.x);
  const rects = displays.map((d) => screen.dipToScreenRect(null, d.bounds));
  input.setMonitors(rects);
  const at = (px, py) => {
    const i = rects.findIndex((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height);
    return i < 0 ? null : { d: i, x: (px - rects[i].x) / (rects[i].width - 1), y: (py - rects[i].y) / (rects[i].height - 1) };
  };
  const send = (o) => input.handle(JSON.stringify(o));
  const home = { x: 0, y: 0 }, hadHome = GetCursorPos(home);
  const RECTS = koffi.struct('DC_RECT2', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr_t', koffi.out(koffi.pointer(RECTS))]);
  let hwndT = 0, hwndS = 0, cw = null, pressed = false;
  try {
    execFile('explorer.exe', [dst], () => {});
    hwndT = await explorerWindow(dst);
    execFile('explorer.exe', [src], () => {});
    hwndS = await explorerWindow(src);
    if (!hwndT || !hwndS) { check('drop-in check: the Explorer windows open', false, `${hwndT} ${hwndS}`); return; }
    const p = rects[displays.findIndex((d) => d.id === prim.id)], o = rects[displays.findIndex((d) => d.id === other.id)];
    ShowWindow(hwndT, 9); SetWindowPos(hwndT, -1, p.x + 160, p.y + 140, 960, 640, 0x0040);
    ShowWindow(hwndS, 9); SetWindowPos(hwndS, -1, o.x + 20, o.y + 120, 640, 520, 0x0040);
    const shell = require('../client/shell');
    const page = path.join(os.tmpdir(), `myremote-dropin-client-${process.pid}.html`);
    fs.writeFileSync(page, buildClientHtml());
    cw = new BrowserWindow({ show: false, focusable: false, x: other.bounds.x + 700, y: other.bounds.y + 120, width: 900, height: 600, alwaysOnTop: true, webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false } });
    shell.attach(cw, { trust: true }); // the page loaded as it is (no loader, nothing signed)
    await cw.loadFile(page, { hash: `k=${cfg.key}&auto` });
    cw.showInactive();
    const cj = (code) => cw.webContents.executeJavaScript(code);
    let st = null;
    for (let i = 0; i < 40; i++) { await sleep(500); st = await cj(`({ s: window.__rd.state, f: window.__rd.frames })`); if (st.s === 'connected' && st.f > 20) break; }
    if (!st || st.s !== 'connected') { check('drop-in check: the client window connects', false, JSON.stringify(st)); return; }
    const tr = { left: 0, top: 0, right: 0, bottom: 0 };
    GetWindowRect(hwndT, tr);
    const mi = await cj(`monitors.findIndex((m) => ${(tr.left + tr.right) >> 1} >= m.x && ${(tr.left + tr.right) >> 1} < m.x + m.width && ${(tr.top + tr.bottom) >> 1} >= m.y && ${(tr.top + tr.bottom) >> 1} < m.y + m.height)`);
    await cj(`window.__rd.stillOver = true; window.__rd.keepFiles = true; setSel(mainView, ${mi}); window.__dropLog = [];
      for (const t of ['dragenter', 'drop']) window.addEventListener(t, (e) => window.__dropLog.push(t + ' ' + e.target.tagName + (e.target.id ? '#' + e.target.id : '') + ' ' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true); 1`);
    await sleep(1500);
    const g = await cj(`(() => { const r = mainView.panes[0].video.getBoundingClientRect(), m = monitors[${mi}]; return { left: r.left, top: r.top, w: r.width, h: r.height, mx: m.x, my: m.y, mw: m.width, mh: m.height }; })()`);
    const cb = cw.getContentBounds(), cbp = screen.dipToScreenRect(cw, cb);
    // Where a point of the host's screen is shown in the client window, on this PC's screen.
    const shown = (px, py) => ({ x: Math.round(cbp.x + (g.left + ((px - g.mx) / (g.mw - 1)) * g.w) * (cbp.width / cb.width)), y: Math.round(cbp.y + (g.top + ((py - g.my) / (g.mh - 1)) * g.h) * (cbp.height / cb.height)) });
    // A real drag with the mouse: press on the item in the source window, carry it onto the picture, let go.
    const nh = cw.getNativeWindowHandle(), cwHwnd = nh.length >= 8 ? Number(nh.readBigUInt64LE(0)) : nh.readUInt32LE(0);
    const rootAt = (pt) => { const leaf = WindowFromPoint(pt); return leaf ? Number(GetAncestor(leaf, 2)) : 0; };
    const dragOnto = async (label, prefix, hostX, hostY, expect) => {
      const r = await itemRect(hwndS, prefix);
      if (!r) { check(`${label}: ${prefix} is found in the visible list`, false, 'nothing was pressed'); return; }
      const s = { x: r.px, y: r.py }, c = shown(hostX, hostY);
      cw.moveTop();
      await sleep(150);
      if (rootAt(s) !== Number(hwndS)) { check(`${label}: nothing covers the source item`, false, classOf(rootAt(s)) + '; nothing was pressed'); return; }
      // Where the host will drop (the same screen here) must be the target window, or the files would be
      // dropped into whatever program is there (once a dialog of the person's covered it: a SysLink of it
      // was under the point, and luckily took nothing).
      if (rootAt({ x: hostX, y: hostY }) !== Number(hwndT)) { check(`${label}: nothing covers the point the host drops onto`, false, `${classOf(rootAt({ x: hostX, y: hostY }))} is there; nothing was pressed`); return; }
      // The drop point must be this test's client window, or a real drop would land in whatever program is there.
      if (rootAt(c) !== cwHwnd) { check(`${label}: the client window is where the file is to be let go`, false, `${classOf(rootAt(c))} is there; nothing was pressed`); return; }
      const x0 = await cj(`({ ...window.__rd.xfer })`);
      send({ t: 'mm', ...at(s.x, s.y), h: 0 }); await sleep(200);
      send({ t: 'md', b: 0, ...at(s.x, s.y) }); pressed = true; await sleep(120);
      for (let k = 1; k <= 24; k++) { const q = at(Math.round(s.x + ((c.x - s.x) * k) / 24), Math.round(s.y + ((c.y - s.y) * k) / 24)); if (q) send({ t: 'mm', ...q, h: 1 }); await sleep(35); }
      for (let k = 0; k < 6; k++) { send({ t: 'mm', ...at(c.x + (k & 1), c.y), h: 1 }); await sleep(40); }
      const underRoot = rootAt(c), drag = input.dragging();
      if (underRoot !== cwHwnd) {
        input.tap(['Escape']); // end the drag without a drop, then let go
        await sleep(150);
        send({ t: 'mu', b: 0, ...at(c.x, c.y) }); pressed = false;
        check(`${label}: the client window is under the pointer when letting go`, false, `${classOf(underRoot)} was there; the drag was cancelled`);
        return;
      }
      send({ t: 'mu', b: 0, ...at(c.x, c.y) }); pressed = false;
      info(`${label}: source ${s.x},${s.y} -> picture ${c.x},${c.y}; Explorer dragging before letting go: ${drag}`);
      let x = null;
      for (let i = 0; i < 60; i++) { await sleep(250); x = await cj(`({ ...window.__rd.xfer })`); if (x.inDone > x0.inDone || x.inFailed > x0.inFailed) break; }
      await sleep(1200);
      info(`${label}: page saw ${JSON.stringify(await cj(`window.__dropLog.splice(0)`))}; read ${JSON.stringify(await cj(`window.__rd.lastDrop || null`))}; why ${await cj(`window.__rd.xfer.inWhy || ''`)}`);
      const ok = x && x.inDone > x0.inDone && x.inHow === 'dropped' && expect();
      check(`${label}: the dragged-in file lands where it was let go on the host`, ok, JSON.stringify({ how: x && x.inHow, inStart: x && x.inStart - x0.inStart, done: x && x.inDone - x0.inDone, failed: x && x.inFailed - x0.inFailed }));
    };
    const empty = await emptySpot(hwndT);
    if (empty) await dragOnto('D (empty space)', 'in-a', empty.px, empty.py, () => fs.existsSync(path.join(dst, 'in-a.txt')) && fs.readFileSync(path.join(dst, 'in-a.txt'), 'utf8') === content['in-a.txt']);
    else check('D: empty space in the target window\'s list is found', false, 'nothing was pressed');
    const sub = await itemRect(hwndT, 'sub');
    if (sub) await dragOnto('E (onto a folder icon)', 'in-b', sub.px, sub.py, () => fs.existsSync(path.join(dst, 'sub', 'in-b.txt')) && fs.readFileSync(path.join(dst, 'sub', 'in-b.txt'), 'utf8') === content['in-b.txt']);
    else check('E: the folder icon is found', false, '');
    const empty2 = await emptySpot(hwndT); // the list has one more item now
    if (empty2) await dragOnto('F (a folder)', 'in-dir', empty2.px, empty2.py, () => fs.existsSync(path.join(dst, 'in-dir', 'deeper', 'x.txt')) && fs.readFileSync(path.join(dst, 'in-dir', 'deeper', 'x.txt'), 'utf8') === content.x);
    else check('F: empty space in the target window\'s list is found', false, 'nothing was pressed');
  } catch (e) {
    check('drop-in check ran', false, e.stack || e.message);
  } finally {
    if (pressed) input.buttonUp(0);
    input.reset();
    if (cw && !cw.isDestroyed()) cw.destroy();
    if (hadHome && at(home.x, home.y)) send({ t: 'mm', ...at(home.x, home.y) });
    for (const h of [hwndT, hwndS]) if (h && IsWindow(h)) { SetWindowPos(h, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); PostMessageW(h, 0x0010, 0, 0); }
    try { fs.rmSync(path.join(os.tmpdir(), `myremote-dropin-client-${process.pid}.html`), { force: true }); } catch {}
    await sleep(800);
    for (let i = 0; i < 20; i++) { try { fs.rmSync(base, { recursive: true, force: true }); break; } catch { await sleep(250); } }
  }
};

exports.run = async ({ check, info, dragOut, closeDragFiles, cfg, buildClientHtml }) => {
  // The clipboard is put back afterwards; that is only possible for text (plain, HTML, RTF).
  const { keepTextClipboard, restoreClipboard } = require('./selftest');
  const keep = await keepTextClipboard(['text/plain', 'text/html', 'text/rtf']);
  if (!keep) { info('drag-out check skipped: the clipboard holds more than text'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragtest-'));
  const content = {};
  for (const n of ['drag-test-a.txt', 'drag-test-b.txt', 'drag-test-c.txt']) fs.writeFileSync(path.join(dir, n), (content[n] = crypto.randomBytes(48000).toString('hex')));
  const rects = screen.getAllDisplays().map((d) => screen.dipToScreenRect(null, d.bounds));
  input.setMonitors(rects);
  const at = (px, py) => {
    const i = rects.findIndex((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height);
    return i < 0 ? null : { d: i, x: (px - rects[i].x) / (rects[i].width - 1), y: (py - rects[i].y) / (rects[i].height - 1) };
  };
  const send = (o) => input.handle(JSON.stringify(o));
  const home = { x: 0, y: 0 }, hadHome = GetCursorPos(home);
  let hwnd = 0, pressed = false, cw = null;
  // Finds a test file in the Explorer window and makes sure nothing covers it.
  const target = async (prefix) => {
    const r = await itemRect(hwnd, prefix);
    if (!r) { check(`drag-out check: ${prefix} is found in the Explorer window`, false, 'UI Automation did not find it in the visible list'); return null; }
    const cx = r.px, cy = r.py;
    const leaf = WindowFromPoint({ x: cx, y: cy }), root = leaf ? GetAncestor(leaf, 2) : 0;
    if (Number(root) !== Number(hwnd) || !at(cx, cy)) {
      check('drag-out check: nothing covers the test file', false, `the window at ${cx},${cy} is ${classOf(root) || 'none'}; nothing was pressed`);
      return null;
    }
    return { cx, cy };
  };
  try {
    execFile('explorer.exe', [dir], { windowsHide: false }, () => {});
    hwnd = await explorerWindow(dir);
    if (!hwnd) { check('drag-out check: an Explorer window on the test folder opens', false, 'not found within 12 s'); return; }
    const primary = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
    ShowWindow(hwnd, 9); // SW_RESTORE
    SetWindowPos(hwnd, -1, primary.x + 160, primary.y + 140, 960, 640, 0x0040); // topmost while the test runs, shown
    await sleep(900);

    // ---- A: straight on the host ----
    let t = await target('drag-test-a');
    if (!t) return;
    const before = look(hwnd);
    send({ t: 'mm', ...at(t.cx, t.cy), h: 0 });
    await sleep(250);
    send({ t: 'md', b: 0, ...at(t.cx, t.cy) });
    pressed = true;
    await sleep(150);
    const t0 = Date.now();
    let seenAt = null;
    for (let k = 1; k <= 12; k++) {
      const p = at(t.cx + k * 8, t.cy + k * 2);
      if (p) send({ t: 'mm', ...p, h: 1 });
      await sleep(30);
      if (seenAt == null && input.dragging()) seenAt = Date.now() - t0;
    }
    for (let k = 0; k < 40 && seenAt == null; k++) { await sleep(25); if (input.dragging()) seenAt = Date.now() - t0; }
    const during = look(hwnd);
    info('A, before the press: ' + JSON.stringify(before));
    info('A, while dragging: ' + JSON.stringify(during));
    check('A: a real Explorer drag is seen by the host', during.hostSaysDragging,
      seenAt != null ? `seen ${seenAt} ms after the pointer started moving` : `not seen; the foreground thread holds the mouse with ${during.foreground.capture || 'nothing'}, Explorer threads with ${during.explorerThreadsHoldingTheMouse.join(', ') || 'nothing'}`);
    const result = await dragOut(0);
    pressed = false;
    const f = result && result.files && result.files[0];
    check('A: dragging out hands over the dragged file', result && result.kind === 'files' && result.files.length === 1 && f.name === 'drag-test-a.txt' && f.size === content['drag-test-a.txt'].length, JSON.stringify(result));
    const after = look(hwnd);
    check('A: no button or drag is left over afterwards', !after.hostSaysDragging && !after.explorerThreadsHoldingTheMouse.length, JSON.stringify(after));
    if (closeDragFiles) closeDragFiles(null);

    // ---- B and C: through a client window running the real page in the client app's shell ----
    if (!cfg || !buildClientHtml) return;
    const shell = require('../client/shell');
    const page = path.join(os.tmpdir(), `myremote-dragtest-client-${process.pid}.html`);
    fs.writeFileSync(page, buildClientHtml());
    // On another display than the Explorer window when there is one, and never taking the focus:
    // on one PC, a client window that loses the focus to the clicked Explorer window would let go of
    // every held button (as it must at a real client when the person switches away).
    const displays = screen.getAllDisplays(), prim = screen.getPrimaryDisplay(), other = displays.find((d) => d.id !== prim.id);
    const spot = other ? { x: other.bounds.x + 40, y: other.bounds.y + 40 } : { x: prim.bounds.x + prim.bounds.width - 760, y: prim.bounds.y + prim.bounds.height - 520 };
    cw = new BrowserWindow({ show: false, focusable: false, ...spot, width: 720, height: 460, webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false } });
    shell.attach(cw, { trust: true }); // the page loaded as it is (no loader, nothing signed)
    await cw.loadFile(page, { hash: `k=${cfg.key}&auto` });
    cw.showInactive();
    const cj = (code) => cw.webContents.executeJavaScript(code);
    let st = null;
    for (let i = 0; i < 40; i++) { await sleep(500); st = await cj(`({ s: window.__rd.state, f: window.__rd.frames, n: monitors.length })`); if (st.s === 'connected' && st.f > 20) break; }
    if (!st || st.s !== 'connected') { check('B: the client window connects', false, JSON.stringify(st)); return; }
    const through = async (label, prefix, holdOutsideMs, insideMoves) => {
      const tt = await target(prefix);
      if (!tt) return;
      const mi = await cj(`monitors.findIndex((m) => ${tt.cx} >= m.x && ${tt.cx} < m.x + m.width && ${tt.cy} >= m.y && ${tt.cy} < m.y + m.height)`);
      await cj(`setSel(mainView, ${mi}); 1`);
      await sleep(1200);
      const g = await cj(`(() => { const r = mainView.panes[0].video.getBoundingClientRect(), m = monitors[${mi}];
        return { left: r.left, top: r.top, w: r.width, h: r.height, mx: m.x, my: m.y, mw: m.width, mh: m.height, sx: window.screenX, sy: window.screenY }; })()`);
      const inPage = (px, py) => ({ clientX: g.left + ((px - g.mx) / (g.mw - 1)) * g.w, clientY: g.top + ((py - g.my) / (g.mh - 1)) * g.h, screenX: g.sx + 20, screenY: g.sy + 60 });
      const outside = (k) => ({ clientX: -150 - k, clientY: g.top + 40, screenX: g.sx - 150 - k, screenY: g.sy + 40 });
      const fire = (type, p, buttons) => cj(`mainView.panes[0].video.dispatchEvent(new PointerEvent('${type}', { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: ${buttons},
        clientX: ${p.clientX}, clientY: ${p.clientY}, screenX: ${p.screenX}, screenY: ${p.screenY} })); 1`);
      const xfer0 = await cj(`({ ...window.__rd.xfer })`);
      await fire('pointermove', inPage(tt.cx, tt.cy), 0);
      await sleep(200);
      await fire('pointerdown', inPage(tt.cx, tt.cy), 1);
      await sleep(150);
      for (let k = 1; k <= insideMoves; k++) { await fire('pointermove', inPage(tt.cx + k * 8, tt.cy + k * 2), 1); await sleep(30); }
      // Out of the window at once: a quick drag leaves before Explorer has started its drag.
      const left = Date.now();
      await fire('pointermove', outside(0), 1);
      const moves = [];
      for (let k = 1; Date.now() - left < holdOutsideMs; k++) { await sleep(40); await fire('pointermove', outside(k), 1); moves.push(await cj(`[hostDrag, mainView.dragOut === true]`)); }
      const state = await cj(`({ hostDrag, out: mainView.dragOut === true })`);
      await fire('pointerup', outside(99), 0);
      let x = null;
      for (let i = 0; i < 80; i++) { await sleep(250); x = await cj(`({ ...window.__rd.xfer })`); if (x.placed > xfer0.placed || x.none > xfer0.none || x.failed > xfer0.failed) break; }
      const back = path.join(dir, prefix + ' (2).txt');
      const firstOut = moves.findIndex((m) => m[1]);
      info(`${label}: held outside ${holdOutsideMs} ms; the client was told of the drag ${firstOut < 0 ? 'only after letting go' : 'about ' + (firstOut + 1) * 40 + ' ms after leaving'}; at release ${JSON.stringify(state)}; transfer ${JSON.stringify(x)}`);
      check(`${label}: the dragged file lands where it was let go`, x && x.how === 'saved' && fs.existsSync(back) && fs.readFileSync(back, 'utf8') === content[prefix + '.txt'],
        fs.existsSync(back) ? 'came back as ' + path.basename(back) : 'nothing arrived; ' + JSON.stringify(x));
      const end = look(hwnd);
      check(`${label}: no button or drag is left over afterwards`, !end.hostSaysDragging && !end.explorerThreadsHoldingTheMouse.length, JSON.stringify(end));
    };
    await through('B (held outside)', 'drag-test-b', 900, 6);
    // Out and let go within 0.1 s of the press: before Explorer has started its drag (about 0.35 s).
    await through('C (let go at once)', 'drag-test-c', 30, 1);
  } catch (e) {
    check('drag-out check ran', false, e.stack || e.message);
  } finally {
    if (pressed) input.buttonUp(0);
    input.reset();
    if (cw && !cw.isDestroyed()) cw.destroy();
    if (hadHome && at(home.x, home.y)) send({ t: 'mm', ...at(home.x, home.y) });
    if (hwnd && IsWindow(hwnd)) { SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); PostMessageW(hwnd, 0x0010, 0, 0); } // not topmost, then WM_CLOSE
    await restoreClipboard(keep);
    if (closeDragFiles) closeDragFiles(null);
    try { fs.rmSync(path.join(os.tmpdir(), `myremote-dragtest-client-${process.pid}.html`), { force: true }); } catch {}
    for (let i = 0; i < 20; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(250); } }
  }
};
