// `electron . --selftest`: runs the real client page against this host, entirely
// on this machine. Signaling goes through a relay on 127.0.0.1, no STUN is used,
// the client is view-only (no input is injected) and a throwaway key/profile is
// used. Nothing is sent to the internet. Output is English on purpose: Korean is
// garbled when PowerShell 5.1 pipes it.
const { BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const input = require('./input');

// --cursor-check: additionally verify, on the real screen, that hiding the host
// cursor removes it from the video. The cursor on this PC disappears for a few
// seconds while it runs, so it is not part of the default self-test.
const CURSOR_CHECK = process.argv.includes('--cursor-check');
// --shell-check: additionally run the client app's one-click layout on the real screens.
// Fullscreen windows cover every monitor of this PC for a few seconds.
const SHELL_CHECK = process.argv.includes('--shell-check');
// --input-check (Linux): real input through XTest into windows and a program the check opens itself
// (inputcheck.js). Meant for a virtual display (Xvfb): it moves the pointer, clicks and types.
const INPUT_CHECK = process.argv.includes('--input-check');
// --client-app-check: at the end, start the client app (client/main.js) as a program of its own on a
// loader that talks to this test's relay only, and wait until it shows the host's picture.
const CLIENT_APP_CHECK = process.argv.includes('--client-app-check');

// Minimal ntfy-compatible pub/sub: POST /topic, GET /topic/sse
exports.startRelay = () => new Promise((resolve) => {
  const subs = new Map();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  const srv = http.createServer((req, res) => {
    const parts = req.url.split('?')[0].split('/').filter(Boolean);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); }
    else if (req.method === 'GET' && parts[1] === 'sse') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      if (!subs.has(parts[0])) subs.set(parts[0], new Set());
      subs.get(parts[0]).add(res);
      req.on('close', () => subs.get(parts[0]).delete(res));
    } else if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        for (const s of subs.get(parts[0]) || []) s.write(`data: ${JSON.stringify({ event: 'message', message: body })}\n\n`);
        res.writeHead(200, cors); res.end('{}');
      });
    } else { res.writeHead(404, cors); res.end(); }
  });
  srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The clipboard's text as it is, to be put back after a check that uses the clipboard: { mime: text },
// {} when it is empty, null when it holds anything but the allowed text types (the check is skipped
// then: that would be lost). Electron's clipboard is promise-based since Electron 44.
async function keepTextClipboard(allowed) {
  const { clipboard } = require('electron');
  try {
    const items = await clipboard.read();
    if (items.length > 1 || items.some((i) => i.types.some((t) => !allowed.includes(t)))) return null;
    const rec = {};
    for (const i of items) for (const t of i.types) rec[t] = await (await i.getType(t)).text();
    return rec;
  } catch { return null; }
}
async function restoreClipboard(rec) {
  const { clipboard, ClipboardItem } = require('electron');
  try { if (rec && Object.keys(rec).length) await clipboard.write([new ClipboardItem(rec)]); else clipboard.clear(); } catch (e) { console.error('putting the clipboard back', e.message); }
}
module.exports.keepTextClipboard = keepTextClipboard; // also for dragcheck.js
module.exports.restoreClipboard = restoreClipboard;

exports.run = async ({ cfg, buildClientHtml, buildLoaderHtml, app, offerFile, dragOut, closeDragFiles, listFolder }) => {
  const results = [];
  const check = (name, ok, detail) => { results.push(!!ok); console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
  const info = (text) => console.log(`[selftest] INFO  ${text}`);

  // --dragout-check: only a real drag out of a real Explorer window (dragcheck.js), then exit.
  // It injects input on this PC for about ten seconds, so it is opt-in and the user must agree first.
  if (process.argv.includes('--dragout-check') || process.argv.includes('--dropin-check')) {
    await sleep(2500); // let the host subscribe before a client window connects
    if (process.platform !== 'win32') {
      info('--dragout-check and --dropin-check are Windows-only (they drive real Explorer windows); on Linux see --input-check');
      return app.exit(0);
    }
    const dc = require('./dragcheck');
    if (process.argv.includes('--dragout-check')) await dc.run({ check, info, dragOut, closeDragFiles, cfg, buildClientHtml });
    if (process.argv.includes('--dropin-check')) await dc.runIn({ check, info, cfg, buildClientHtml });
    const pass = results.length > 0 && results.every(Boolean);
    console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
    return app.exit(pass ? 0 : 1);
  }

  // The DLLs in host/bin are built files that are committed: each must be the one built from its
  // source in native/ as it is now (native/build.js records both). Not there in a packaged copy.
  // Only Windows loads them, but the check is about the repository and runs everywhere.
  for (const name of ['capture', 'shellops']) {
    const dll = path.join(__dirname, 'bin', name + '.dll'), src = path.join(__dirname, '..', 'native', name + '.cpp');
    if (!fs.existsSync(dll) || !fs.existsSync(src)) continue;
    const sha = (data) => require('crypto').createHash('sha256').update(data).digest('hex');
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(dll + '.json', 'utf8')); } catch {}
    const sameSrc = rec.sourceSha256 === sha(fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
    const sameDll = rec.dllSha256 === sha(fs.readFileSync(dll));
    check(`host/bin/${name}.dll is the one built from native/${name}.cpp`, sameSrc && sameDll,
      !sameSrc ? `native/${name}.cpp differs from what host/bin/${name}.dll was built from: run native/build.js`
        : !sameDll ? `host/bin/${name}.dll is not the file native/build.js recorded` : '');
  }

  // Pure coordinate mapping (no input is injected): two monitors side by side, 1080p then 1440p.
  {
    const virt = { x: 0, y: 0, width: 4480, height: 1440 };
    input.setMonitors([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 2560, height: 1440 }]);
    const inside = input.target(1, 0.5, 0.5, virt), past = input.target(0, 1.25, 0.5, virt), far = input.target(0, -3, 0.5, virt);
    check('coordinates: drag continues onto the next monitor',
      inside && Math.abs(inside.px - (1920 + 0.5 * 2559)) < 1 && past && past.px > 1920 && past.px < 4480 && far && far.px === 0 && input.target(0, NaN, 0, virt) === null && input.target(5, 0.5, 0.5, virt) === null,
      `x=1.25 on monitor 1 -> desktop x ${past && Math.round(past.px)}`);
  }

  // Every loader handed out takes the client page in one 'app' reply of at most 40 signaling chunks
  // (signal.js: 3000 characters each, of the deflated and encrypted message). A page that grew past
  // that would leave every client unable to start, so stay well below it.
  {
    const html = buildClientHtml();
    const msg = JSON.stringify({ t: 'app', sid: 'x'.repeat(22), ts: Date.now(), hash: 'h'.repeat(20), html });
    const sealed = require('zlib').deflateRawSync(Buffer.from(msg, 'utf8')).length + 28; // + IV and tag
    const chunks = Math.ceil(Math.ceil((sealed * 4) / 3) / 3000);
    check('the client page fits in what every handed-out loader accepts (40 chunks), with room to spare', chunks <= 36,
      `${(html.length / 1024).toFixed(0)} KB, ${chunks} of 40 chunks`);
  }

  // Keys: a numpad key goes as what the client's NumLock made of it (a digit, or End/an arrow), keys
  // of Japanese and Brazilian keyboards and F17-F24 exist, shortcuts the host presses itself go as
  // virtual keys (layout-independent), and a modifier the person holds is lifted around them.
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const seq = (r) => r.log.filter((e) => e.key).map((e) => (e.up ? '-' : '+') + e.key).join(' ');
    const tapped = input.simulate(R, [{ t: 'kd', c: 'ShiftLeft', k: 'Shift' }], () => input.tap(['ControlLeft', 'KeyC']));
    const ctrlHeld = input.simulate(R, [{ t: 'kd', c: 'ControlLeft', k: 'Control' }], () => input.tap(['ControlLeft', 'KeyV']));
    let keys = 'not Windows';
    if (process.platform === 'win32') {
      const w = require('./platform/win32');
      const k = (c, n, s) => { const x = w.keyOf(c, n, s); return x ? (x.vk ? 'vk' + x.vk.toString(16) : 'sc' + x.scan.toString(16) + (x.flags & 1 ? 'e' : '')) : 'none'; };
      keys = [k('Numpad1', '1'), k('Numpad1', 'End'), k('Numpad5', 'Clear'), k('NumpadDecimal', ','), k('IntlRo', '/'), k('F20', 'F20'), k('KeyC', 'c', true), k('Escape', '', true)].join(' ');
    }
    check('keys: numpad as the client meant it, the extra keys, shortcuts the host presses and modifiers held around them',
      seq(tapped) === '+ShiftLeft -ShiftLeft +ControlLeft +KeyC -KeyC -ControlLeft +ShiftLeft' && seq(ctrlHeld) === '+ControlLeft +KeyV -KeyV'
        && (process.platform !== 'win32' || keys === 'vk61 sc4fe vkc vk6e sc73 vk83 vk43 vk1b'),
      `${seq(tapped)} | ${seq(ctrlHeld)} | ${keys}`);
  }

  // Mouse buttons: a release that got lost on the way is made up for by the next move, which says
  // what the client's pointer really holds. Nothing is injected: input.simulate records what would be.
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }], MF = input.MF;
    const count = (r, bits) => r.log.filter((e) => e.mouse & bits).length, UP = MF.LU | MF.RU | MF.MU | MF.XU, DOWN = MF.LD | MF.RD | MF.MD | MF.XD;
    const at = (t, x, extra) => ({ t, d: 0, x, y: 0.5, ...extra });
    const lost = input.simulate(R, [at('md', 0.5, { b: 0 }), at('mm', 0.6, { h: 1 }), at('mm', 0.7, { h: 0 }), at('mm', 0.8, { h: 0 })]);
    const normal = input.simulate(R, [at('md', 0.5, { b: 0 }), at('mm', 0.6, { h: 1 }), at('mu', 0.6, { b: 0 }), at('mm', 0.7, { h: 0 })]);
    const right = input.simulate(R, [at('md', 0.5, { b: 2 }), at('mm', 0.6), at('mm', 0.7, { h: 1 })]);
    const never = input.simulate(R, [at('mm', 0.5, { h: 7 })]);
    check('a lost button release is made up for by the next move, nothing is ever pressed by it',
      count(lost, UP) === 1 && lost.held === 0 && lost.released === 1 && count(normal, UP) === 1 && normal.released === 0 &&
      count(right, MF.RU) === 1 && right.held === 0 && count(never, DOWN) === 0,
      `lost: ${count(lost, UP)} up, normal: ${count(normal, UP)} up, right button: ${count(right, MF.RU)} up, presses from a move: ${count(never, DOWN)}`);
  }

  // Picture of an app-specific cursor (read-only; uses the standard arrow as a stand-in).
  if (process.platform === 'linux') {
    // X11: the picture of the cursor shown right now, through XFixes (named or not).
    const st = input.cursorState(), b = input.cursorBitmap(st.handle != null ? st.handle : Number(st.key));
    const url = b ? nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL() : '';
    check('cursor picture extraction (X11, XFixes)', b && b.width > 0 && b.height > 0 && b.hx < b.width && b.hy < b.height && url.startsWith('data:image/png;base64,'),
      b ? `${b.width}x${b.height}, hotspot ${b.hx},${b.hy}, ${st.name ? 'named "' + st.name + '"' : 'no standard name (sent as a picture)'}` : `none (${input.viewOnlyReason() || 'no XFixes cursor image'})`);
  } else if (process.platform !== 'win32') {
    info('cursor picture extraction skipped: Windows and Linux only');
  } else {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // 32x32, opaque white, hotspot (3,4)
    const made = user32.func('CreateCursor', 'uintptr_t', ['uintptr_t', 'int', 'int', 'int', 'int', 'uint8*', 'uint8*'])(0, 3, 4, 32, 32, Buffer.alloc(128, 0x00), Buffer.alloc(128, 0xff));
    const b = made ? input.cursorBitmap(made) : null;
    if (made) user32.func('DestroyCursor', 'bool', ['uintptr_t'])(made);
    const url = b ? nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL() : '';
    check('cursor picture extraction', b && b.width === 32 && b.hx === 3 && b.hy === 4 && b.bgra[3] === 255 && b.bgra[0] > 200 && url.startsWith('data:image/png;base64,'), b ? `${b.width}x${b.height}, hotspot ${b.hx},${b.hy}` : 'null');
    const dump = process.argv.find((a) => a.startsWith('--dump-cursor='));
    if (dump && b) fs.writeFileSync(dump.split('=')[1], nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).resize({ width: b.width * 6, quality: 'nearest' }).toPNG());
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-client-'));
  const file = path.join(dir, 'client.html');
  fs.writeFileSync(file, buildClientHtml());
  await sleep(2500); // let the host subscribe first
  const hostWin = BrowserWindow.getAllWindows()[0];
  // The native capturer sends a picture only when the screen changes (and then repeats it for about a
  // second). A virtual display (Xvfb) with this test's windows hidden never changes, unlike a real
  // desktop, where the test's own windows keep changing what is captured: a small counter in a corner
  // keeps the picture moving there, as a person's screen would.
  if (process.platform === 'linux') {
    const b = screen.getPrimaryDisplay().bounds;
    const tick = new BrowserWindow({ x: b.x + b.width - 70, y: b.y + b.height - 34, width: 64, height: 28, frame: false, focusable: false, skipTaskbar: true,
      resizable: false, alwaysOnTop: true, show: false, backgroundColor: '#202830', webPreferences: { backgroundThrottling: false } });
    await tick.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;font:16px monospace;color:#9cf;background:#202830;overflow:hidden">'
      + '<span id="n"></span><script>let i = 0; setInterval(() => { n.textContent = String(i++ % 10000).padStart(4, "0"); }, 50);</script></body>'));
    tick.showInactive();
  }
  const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(file, { hash: `k=${cfg.key}&auto&ro` });
  const js = (code) => w.webContents.executeJavaScript(code);
  const state = () => js(`({ ...window.__rd, sel: mainView.sel, fit: mainView.fit, view: lastView, panes: mainView.panes.length, empty: document.getElementById('empty').style.display === 'flex',
    mons: monitors.map((m) => ({ w: m.width, h: m.height })),
    cursorCss: mainView.panes[0] ? mainView.panes[0].video.style.cursor : '' })`);
  const until = async (pred, secs) => {
    let s;
    for (let i = 0; i < secs; i++) { await sleep(1000); s = await state(); try { if (pred(s)) return [true, s]; } catch {} }
    return [false, s];
  };
  const key = (code) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })),
    window.dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`);
  const width = (res) => Number(String(res || '').split('x')[0]) || 0;
  const onlyFps = (x, idx) => Object.entries(x.fps).every(([i, f]) => (Number(i) === idx ? f > 0 : f === 0));

  try {
    let [ok, s] = await until((x) => x.state === 'connected' && x.frames > 60, 40);
    check('connect and receive video', ok, ok ? `${s.monitors} monitor(s): ${s.mons.map((m) => m.w + 'x' + m.h).join(', ')}` : JSON.stringify(s));
    if (!ok) throw new Error('no connection');
    const N = s.monitors;

    // --soak=<minutes>: a long session instead of the rest, to find what grows (no input injected).
    // The client keeps switching monitors and going to the overview and back, and every minute the
    // host drops the session so that the client connects again. Memory of every process and the two
    // pages' script heaps are sampled every 20 s; growth after the first three minutes is the result.
    const soakArg = process.argv.find((a) => a.startsWith('--soak='));
    if (soakArg) {
      const minutes = Math.max(3, Number(soakArg.split('=')[1]) || 15), end = Date.now() + minutes * 60e3, t0 = Date.now();
      const mb = (kb) => Math.round(kb / 1024);
      // Garbage is collected in every process before a sample (the pages through the debugger protocol,
      // this process through V8's gc()), so a sample shows what is kept, not what has not been collected
      // yet. Without that, the samples swing by tens of MB with the collector's timing.
      let gcMain = null;
      try { require('v8').setFlagsFromString('--expose-gc'); gcMain = require('vm').runInNewContext('gc'); } catch {}
      const gcPage = async (wc) => { try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('HeapProfiler.collectGarbage'); } catch {} };
      // --soak-heap=<folder>: heap snapshots of this (the main) process after the first 3 minutes and at
      // the end, to see what it keeps (compare them in Chrome's DevTools, Memory tab).
      const heapArg = process.argv.find((a) => a.startsWith('--soak-heap='));
      const heapDir = heapArg ? heapArg.slice('--soak-heap='.length) : '';
      // --soak-no-audio: the sessions after the first capture no system sound (then the engine's
      // capturer is not started at all while native capture is in use), to tell its share apart.
      if (process.argv.includes('--soak-no-audio')) await hostWin.webContents.executeJavaScript('cfg.audio = false; 1');
      // Windows: the handles (kernel, GDI, USER) of this process and the host page's, which grow when
      // something is opened per session and never closed.
      let handles = () => null;
      if (process.platform === 'win32') {
        try {
          const koffi = require('koffi'), k32 = koffi.load('kernel32.dll'), u32 = koffi.load('user32.dll');
          const OpenProcess = k32.func('OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
          const CloseHandle = k32.func('CloseHandle', 'bool', ['void *']);
          const GetProcessHandleCount = k32.func('GetProcessHandleCount', 'bool', ['void *', koffi.out(koffi.pointer('uint32'))]);
          const GetGuiResources = u32.func('GetGuiResources', 'uint32', ['void *', 'uint32']);
          handles = (pid) => {
            const h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (!h) return null;
            try { const n = [0]; GetProcessHandleCount(h, n); return { k: n[0], gdi: GetGuiResources(h, 0), user: GetGuiResources(h, 1) }; } finally { CloseHandle(h); }
          };
        } catch (e) { info(`soak: handle counts not available (${e.message})`); }
      }
      const sample = async () => {
        await gcPage(hostWin.webContents); await gcPage(w.webContents);
        if (gcMain) { gcMain(); gcMain(); }
        await sleep(500);
        const by = {}, hostPid = hostWin.webContents.getOSProcessId(), clientPid = w.webContents.getOSProcessId();
        for (const p of app.getAppMetrics()) {
          const k = p.pid === hostPid ? 'hostPage' : p.pid === clientPid ? 'clientPage' : p.type === 'Tab' ? 'renderer' : p.type.toLowerCase();
          by[k] = (by[k] || 0) + (p.memory.privateBytes || p.memory.workingSetSize || 0);
        }
        const heap = async (wc) => { try { return Math.round((await wc.executeJavaScript('performance.memory ? performance.memory.usedJSHeapSize : 0')) / 1048576); } catch { return -1; } };
        const m = process.memoryUsage(), r1 = (b) => Math.round(b / 104857.6) / 10; // MB with one decimal
        const hm = handles(process.pid) || {}, hh = handles(hostPid) || {};
        return { min: +((Date.now() - t0) / 60e3).toFixed(1), browser: mb(by.browser || 0), gpu: mb(by.gpu || 0), hostPage: mb(by.hostPage || 0), clientPage: mb(by.clientPage || 0),
          utility: mb(by.utility || 0), hostHeap: await heap(hostWin.webContents), clientHeap: await heap(w.webContents),
          mainHeap: r1(m.heapUsed), mainHeapTotal: r1(m.heapTotal), mainExt: r1(m.external), mainK: hm.k, mainGdi: hm.gdi, mainUser: hm.user, hostK: hh.k, hostGdi: hh.gdi, hostUser: hh.user, sessions: 0 };
      };
      let snapped = false;
      const snapshot = (name) => { if (!heapDir) return; try { fs.mkdirSync(heapDir, { recursive: true }); info(`soak heap snapshot ${require('v8').writeHeapSnapshot(path.join(heapDir, name))}`); } catch (e) { info(`soak heap snapshot failed: ${e.message}`); } };
      const rows = [];
      let n = 0, reconnects = 0;
      while (Date.now() < end) {
        await sleep(5000);
        n++;
        if (n % 3 === 0) await key('ArrowRight');                                   // every 15 s: another monitor
        if (n % 12 === 6) { await key('ArrowUp'); await sleep(2500); await key('Digit1'); } // every minute: the overview and back
        if (n % 12 === 0) {                                                           // every minute: the host drops the session
          await hostWin.webContents.executeJavaScript(`teardown('soak', true); 1`);
          const [back] = await until((x) => x.state === 'connected' && x.frames > 0, 30);
          if (back) reconnects++;
        }
        // 15, 35 and 55 s after each reconnect: right after one, the main process holds the new
        // session's start-up allocations for a few seconds, and such samples skewed the medians.
        if (n % 4 === 3) {
          const r = await sample(); r.sessions = reconnects; rows.push(r);
          if (!snapped && r.min >= 3) { snapped = true; snapshot('main-early.heapsnapshot'); }
        }
      }
      snapshot('main-late.heapsnapshot');
      for (const r of rows) info(`soak ${String(r.min).padStart(5)} min  browser ${r.browser} MB  gpu ${r.gpu} MB  host page ${r.hostPage} MB  client page ${r.clientPage} MB  utility ${r.utility} MB  heaps host ${r.hostHeap} / client ${r.clientHeap} / main ${r.mainHeap} (of ${r.mainHeapTotal}) MB  main external ${r.mainExt} MB` +
        (r.mainK != null ? `  handles main ${r.mainK}/${r.mainGdi}/${r.mainUser} host ${r.hostK}/${r.hostGdi}/${r.hostUser}` : '') + `  reconnects ${r.sessions}`);
      // Growth: the median of the samples in the last third against the median of those in the first
      // third after the first 3 minutes (a reconnect makes a sample spike now and then), per reconnect.
      const after = rows.filter((r) => r.min >= 3), third = Math.max(1, Math.floor(after.length / 3));
      const median = (list, k) => { const v = list.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] || 0; };
      const first = after.slice(0, third), lastRows = after.slice(-third);
      const done = lastRows.length ? lastRows[lastRows.length - 1].sessions - first[0].sessions : 0;
      const per = (k) => (done > 0 ? +((median(lastRows, k) - median(first, k)) / done).toFixed(1) : 0);
      const growth = { browser: per('browser'), gpu: per('gpu'), hostPage: per('hostPage'), clientPage: per('clientPage'), hostHeap: per('hostHeap'), clientHeap: per('clientHeap'), mainHeap: per('mainHeap'), mainHeapTotal: per('mainHeapTotal'), mainExt: per('mainExt'),
        ...(rows.some((r) => r.mainK != null) ? { mainHandles: per('mainK'), mainGdi: per('mainGdi'), hostHandles: per('hostK'), hostGdi: per('hostGdi') } : {}) };
      const sum = growth.browser + growth.hostPage + growth.clientPage;
      check(`soak: ${minutes} min, ${reconnects} reconnects, what each session leaves behind stays under 2 MB`, sum < 2 && reconnects >= Math.floor(minutes * 0.6),
        `MB per reconnect (median of the last third minus the first): ${JSON.stringify(growth)}`);
      const pass = results.every(Boolean);
      console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(pass ? 0 : 1);
    }

    // --dump-phone=<file.png>: pictures of the phone layout (a client window of a phone's size, 915x412
    // and 412x915, with '#touch'), with the key row open, then exit. No window is shown.
    const dumpPhone = process.argv.find((a) => a.startsWith('--dump-phone='));
    if (dumpPhone) {
      const out = dumpPhone.split('=')[1];
      for (const [name, width, height] of [['-landscape', 915, 412], ['-portrait', 412, 915]]) {
        const pw = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { backgroundThrottling: false } });
        await pw.loadFile(file, { hash: `k=${cfg.key}&auto&ro&touch` });
        const pjs = (code) => pw.webContents.executeJavaScript(code);
        for (let i = 0; i < 30; i++) { await sleep(1000); if (await pjs(`window.__rd.state === 'connected' && window.__rd.frames > 20`)) break; }
        await pjs(`document.getElementById('keyBtn').click(); [...document.getElementById('keyrow').children].find((b) => b.dataset.code === 'ControlLeft').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); 1`);
        await sleep(1500);
        fs.writeFileSync(out.replace(/\.png$/, name + '.png'), (await pw.webContents.capturePage()).toPNG());
        pw.destroy();
      }
      console.log('[selftest] INFO  phone pictures written next to ' + out);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(0);
    }

    // --dump-panel=<file.png>: pictures of the arrangement panel for checking its design, then exit.
    // It is drawn as if this PC had two 2560x1440 screens; nothing is applied and no window is opened.
    const dumpPanel = process.argv.find((a) => a.startsWith('--dump-panel='));
    if (dumpPanel) {
      const out = dumpPanel.split('=')[1], shot = async (name) => fs.writeFileSync(out.replace(/\.png$/, name + '.png'), (await w.webContents.capturePage()).toPNG());
      await js(`mainView.layoutSig = 'demo'; arr.snap = true; document.head.appendChild(document.createElement('style')).textContent = '* { transition: none !important; }'; arrOpen().then(() => { const s = { left: 0, top: 0, width: 2560, height: 1440, availLeft: 0, availTop: 0, availWidth: 2560, availHeight: 1440 };
        arr.cs = { list: [s, { ...s, left: 2560, availLeft: 2560 }], cur: 0 }; arr.A = monitors.map((_, h) => (h < 2 ? h : null)); arr.prev = arr.A.slice(); arrBuild(); arrPaint(arr.A); })`);
      await sleep(3500);
      await shot('');
      await js(`document.getElementById('arrHelp').click(); 1`);
      await sleep(400);
      await shot('-help');
      await js(`document.getElementById('arrHelp').click(); 1`);
      const dbg = await js(`(() => { const t = arr.host[1], r = t.lcd.getBoundingClientRect(), b = arr.host[2] || arr.host[0], q = b.lcd.getBoundingClientRect(), el = document.getElementById('arr');
        const fire = (type, target, x, y, ctrl) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: x, clientY: y, ctrlKey: !!ctrl }));
        fire('pointerdown', t.lcd, r.left + 30, r.top + 30); fire('pointermove', el, r.left + 60, r.top + 40); fire('pointermove', el, q.left + q.width / 2, q.top + q.height / 2, true);
        return JSON.stringify({ drag: !!arr.drag, moved: arr.drag && arr.drag.moved, aim: arr.drag && arr.drag.aim && arr.drag.aim.i, shown: arr.shown }); })()`);
      console.log('[selftest] INFO  panel drag state: ' + dbg);
      await sleep(1500);
      await shot('-ctrl-drag');
      await js(`(() => { const el = document.getElementById('arr'), q = arr.host[0].lcd.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: q.left + q.width / 2, clientY: q.top + q.height / 2, pointerId: 7 })); })()`);
      await sleep(1500);
      await shot('-swap-drag');
      await js(`arrDragEnd(false); arrPaint([null, 0, 0].slice(0, monitors.length)); 1`);
      await sleep(1500);
      await shot('-together');
      console.log('[selftest] INFO  panel pictures written next to ' + out);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(0);
    }

    [ok, s] = await until((x) => !!x.cursor, 5);
    // A standard cursor arrives as its CSS name, any other as a picture (e.g. X11's own cursor under Xvfb).
    check('cursor shape sync', ok && (s.cursor === 'image' ? s.cursorCss.startsWith('url(') : s.cursorCss === s.cursor), `host cursor = ${s.cursor}`);

    // The browser must not be able to take a drag over (its own drag-and-drop or text selection),
    // and when it does end the pointer's events, the button held on the host is let go.
    {
      const r = await js(`(() => {
        const v = mainView.panes[0].video, b = v.getBoundingClientRect(), before = { ...window.__rd.ptr };
        const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true }), sel = new Event('selectstart', { bubbles: true, cancelable: true });
        v.dispatchEvent(drag); v.dispatchEvent(sel);
        const o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
        v.dispatchEvent(new PointerEvent('pointerdown', o));
        const heldAfterDown = held;
        v.dispatchEvent(new PointerEvent('pointercancel', { ...o, buttons: 0 }));
        return { drag: drag.defaultPrevented, sel: sel.defaultPrevented, heldAfterDown, held, cancel: window.__rd.ptr.cancel - before.cancel, released: window.__rd.ptr.released - before.released,
          noSelect: getComputedStyle(document.body).userSelect === 'none' };
      })()`);
      check('the browser cannot take a drag over; a cancelled pointer lets go of the host button',
        r.drag && r.sel && r.noSelect && r.heldAfterDown === 1 && r.held === 0 && r.cancel === 1 && r.released === 1, JSON.stringify(r));
    }
    [ok, s] = await until((x) => !!x.others, 12);
    check('the host says whether another remote session is connected', ok,
      ok ? `Chrome Remote Desktop ${s.others.crd ? 'connected' : 'not connected'}, windows dragged ${s.others.outline ? 'as an outline' : 'with their contents'}` : 'no message');

    // The client window is smaller than the monitor, so the host must send fewer pixels - but never fewer than shown.
    const main = s.sel;
    [ok, s] = await until((x) => {
      const need = JSON.parse(x.view).find((e) => e.i === main), got = width(x.res[main]);
      return need && got > 0 && got >= need.w - 2 && (need.w >= x.mons[main].w || got < x.mons[main].w);
    }, 15);
    const encOf = (x) => (x.host && x.host.mons ? Object.entries(x.host.mons).map(([i, m]) => `monitor ${Number(i) + 1} ${m.res} ${m.impl}`).join('; ') : '?');
    const nativeName = process.platform === 'linux' ? 'native (X11: XDamage and MIT-SHM, platform/x11capture.js)' : 'native (native/capture.cpp)';
    info('screen capture: ' + (await hostWin.webContents.executeJavaScript(`session && session.native ? ${JSON.stringify(nativeName)} : "the browser engine's"`)));
    await sleep(4500); s = await state(); info('video encoder: ' + encOf(s) + ' (libaom = AV1 on the CPU, MediaFoundation = H.264 on the graphics card, OpenH264 = H.264 on the CPU)');
    check('sends only as many pixels as are shown', ok, `monitor ${main + 1} is ${s.mons[main].w}x${s.mons[main].h}, shown at ${JSON.parse(s.view).map((e) => e.w + 'x' + e.h)[0]}, received ${s.res[main]}`);

    await js(`setFit(mainView, '1:1')`);
    [ok, s] = await until((x) => width(x.res[main]) === x.mons[main].w, 15);
    check('1:1 mode receives the full resolution', ok, `received ${s.res[main]}`);
    await js(`setFit(mainView, 'fit')`);

    // A window the client app reports minimized (its preload marks the document, client/preload.js) is
    // not asked for, and is again once it is back.
    {
      const mark = (on) => js(`${on ? "document.documentElement.dataset.mrHidden = '1'" : 'delete document.documentElement.dataset.mrHidden'}; document.dispatchEvent(new Event('mrshown')); 1`);
      await mark(true);
      const [paused, sp] = await until((x) => x.view === '[]' && !(x.fps[main] > 0), 12);
      await mark(false);
      const [back, sb] = await until((x) => JSON.parse(x.view || '[]').some((e) => e.i === main) && x.fps[main] > 0, 12);
      check('a window the client app reports minimized is not sent, and is again when it is back', paused && back, `minimized: requested ${sp.view}, ${sp.fps[main]} fps; back: ${sb.fps[main]} fps`);
    }

    if (N > 1) {
      [ok, s] = await until((x) => onlyFps(x, main), 12);
      check('only viewed monitors are sent', ok, `fps per monitor ${JSON.stringify(s.fps)}`);

      const next = (main + 1) % N;
      await key('ArrowRight');
      [ok, s] = await until((x) => x.sel === next && onlyFps(x, next), 12);
      check('Ctrl+Alt+Right switches the monitor', ok, `now showing monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}, fps ${JSON.stringify(s.fps)}`);

      await key('ArrowUp');
      [ok, s] = await until((x) => x.sel === 'all' && Object.values(x.fps).every((f) => f > 0) && Object.keys(x.res).every((i) => width(x.res[i]) > 0 && width(x.res[i]) < x.mons[i].w), 15);
      check('overview shows every monitor, scaled down', ok, `received ${Object.values(s.res).join(', ')}`);

      await key('Digit1');
      [ok, s] = await until((x) => x.sel === 0, 5);
      check('Ctrl+Alt+1 selects monitor 1', ok);

      const plan = await js(`JSON.stringify([planLayout(3, 3, 1, 0), planLayout(3, 2, 0, 1), planLayout(2, 3, 2, 0)].map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.sel]))))`);
      check('layout plan keeps left-to-right order', plan === JSON.stringify([{ 0: 0, 1: 1, 2: 2 }, { 0: 1, 1: 2 }, { 1: 0, 2: 1 }]), plan);

      // Arrangement panel. First the rules for dragging one tile onto another (host monitors 1..3, this PC's screens 1..2).
      const ops = await js(`JSON.stringify([
        arrOp([0, 1, null], { kind: 'host', i: 1 }, { kind: 'host', i: 2 }, false),
        arrOp([0, 1, null], { kind: 'host', i: 1 }, { kind: 'host', i: 2 }, true),
        arrOp([0, 1, null], { kind: 'host', i: 0 }, { kind: 'host', i: 1 }, false),
        arrOp([0, 1, null], { kind: 'client', i: 1 }, { kind: 'host', i: 2 }, false),
        arrOp([0, 1, null], { kind: 'client', i: 1 }, { kind: 'host', i: 0 }, false),
        arrOp([0, 1, null], { kind: 'host', i: 2 }, { kind: 'client', i: 0 }, true),
        arrOp([0, 1, null], { kind: 'client', i: 0 }, { kind: 'client', i: 1 }, false),
      ])`);
      check('arrangement: move swaps, Ctrl adds, onto an unused monitor takes over',
        ops === JSON.stringify([[0, null, 1], [0, 1, 1], [1, 0, null], [0, null, 1], [1, 0, null], [0, 1, 0], [1, 0, null]]), ops);

      // Applying an arrangement (with a single screen of this PC, so no window is opened here).
      const one = `{ list: [{ left: 0, top: 0, width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 }], cur: 0 }`;
      await js(`applyAssign(monitors.map((_, h) => (h < 2 ? 0 : null)), ${one})`);
      [ok, s] = await until((x) => x.panes === 2 && x.fps[0] > 0 && x.fps[1] > 0 && Object.keys(x.fps).every((i) => Number(i) < 2 || x.fps[i] === 0), 15);
      check('arrangement: one screen shows two monitors together', ok, `showing ${JSON.stringify(s.sel)}, fps ${JSON.stringify(s.fps)}`);
      await js(`applyAssign(monitors.map(() => null), ${one})`);
      [ok, s] = await until((x) => x.sel === 'none' && x.empty && Object.values(x.fps).every((f) => f === 0), 12);
      check('arrangement: a screen can be left empty (nothing is sent)', ok, `fps ${JSON.stringify(s.fps)}`);

      // The panel itself: every monitor is shown small while it is open, and a drag changes what the window shows.
      await js(`arrOpen().then(() => { arr.cs = ${one}; arr.A = monitors.map((_, h) => (h === 0 ? 0 : null)); arr.prev = arr.A.slice(); arrBuild(); arrPaint(arr.A); applyAssign(arr.A, arr.cs); })`);
      [ok, s] = await until((x) => x.sel === 0 && JSON.parse(x.view).length === x.monitors, 12);
      const tiles = await js(`({ host: arr.host.length, client: arr.client.length, shown: document.getElementById('arr').style.display, live: arr.host.every((t) => t.videos.size === 1),
        os: [document.getElementById('arrHostOs').textContent, document.getElementById('arrClientOs').textContent, document.querySelectorAll('.osTag svg').length] })`);
      // Each PC's operating system next to its name: the host's from its offer, this one's from the browser.
      const osName = process.platform === 'win32' ? /^Windows 1[01]$/ : process.platform === 'linux' ? /\S/ : /^macOS/;
      check('arrangement panel: shows every host monitor live, and each PC\'s operating system', ok && tiles.host === N && tiles.client === 1 && tiles.shown === 'flex' && tiles.live
        && osName.test(tiles.os[0]) && osName.test(tiles.os[1]) && tiles.os[2] === 2, JSON.stringify(tiles) + ' requested ' + s.view);
      await js(`(() => {
        const at = (t) => { const r = t.lcd.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
        const fire = (type, target, pos, extra) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos, ...extra }));
        const a = at(arr.host[0]), b = at(arr.host[1]);
        fire('pointerdown', arr.host[0].lcd, a);
        fire('pointermove', document.getElementById('arr'), { clientX: (a.clientX + b.clientX) / 2, clientY: a.clientY });
        fire('pointermove', document.getElementById('arr'), b);
        fire('pointerup', document.getElementById('arr'), b);
      })()`);
      [ok, s] = await until((x) => x.sel === 1, 10);
      const after = await js(`JSON.stringify(arr.A)`);
      check('arrangement panel: dragging one monitor onto another swaps them', s.sel === 1 && JSON.parse(after)[0] === null && JSON.parse(after)[1] === 0, `window shows monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}, arrangement ${after}`);
      await js(`(() => { const t = arr.host[1].lcd, r = t.getBoundingClientRect(), pos = { clientX: r.left + 20, clientY: r.top + 20 };
        for (const type of ['pointerdown', 'pointerup']) (type === 'pointerdown' ? t : document.getElementById('arr')).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos })); })()`);
      const offA = await js(`JSON.stringify(arr.A)`);
      await js(`(() => { const t = arr.host[1].lcd, r = t.getBoundingClientRect(), pos = { clientX: r.left + 20, clientY: r.top + 20 };
        for (const type of ['pointerdown', 'pointerup']) (type === 'pointerdown' ? t : document.getElementById('arr')).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos })); })()`);
      const onA = await js(`JSON.stringify(arr.A)`);
      check('arrangement panel: a click turns a monitor off, another click brings it back', JSON.parse(offA).every((x) => x === null) && JSON.parse(onA)[1] === 0, `${offA} then ${onA}`);
      await js(`arrClose(); applyAssign(monitors.map((_, h) => (h === 0 ? 0 : null)), ${one})`);
      [ok, s] = await until((x) => x.sel === 0 && onlyFps(x, 0), 12);
      check('arrangement: back to one monitor', ok, `fps ${JSON.stringify(s.fps)}`);
    } else {
      info('single monitor host: monitor switching, overview and arrangement checks skipped');
    }

    // Things dragged out of the remote picture. No drag is started here and nothing is clicked or typed:
    // the file channel is driven directly and the remaining pieces are checked one by one.
    {
      const crypto = require('crypto');
      const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragsrc-')), dst = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragdst-'));
      const big = path.join(src, 'big file \ud55c\uae00.bin'), small = path.join(src, 'note.txt');
      fs.writeFileSync(big, crypto.randomBytes(3 * 1024 * 1024 + 123));
      fs.writeFileSync(small, 'hello drag\n');
      // A file inside a dragged folder travels with its path in it; an empty folder as a 'dir' entry.
      const offered = await Promise.all([offerFile(big), offerFile(small), { id: '', name: 'proj/empty', size: 0, dir: true }, offerFile(small, 'proj/sub/note.txt')]);
      await js(`window.__rd.keepFiles = true; window.__rd.files = []; 1`);
      await hostWin.webContents.executeJavaScript(`sendFiles(session, ${JSON.stringify(offered)}); 1`);
      [ok, s] = await until((x) => x.files.length === 3, 25);
      check('dragged-out files arrive intact, with their folders', ok && s.files[0].sha === sha(big) && s.files[1].sha === sha(small) && s.files[0].name === path.basename(big)
        && s.files[2].name === 'proj/sub/note.txt' && s.files[2].sha === sha(small),
        ok ? s.files.map((f) => `${f.name}: ${f.size} bytes`).join(', ') : JSON.stringify(s.files));
      await js(`window.__rd.keepFiles = false; 1`);

      // What a dragged folder becomes on the host: its files with their paths, its empty folders,
      // and nothing behind a link (a junction pointing at the folder itself must not loop).
      {
        const tree = path.join(src, 'tree');
        fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'empty'));
        fs.writeFileSync(path.join(tree, 'a', 'b', 'x.txt'), 'x');
        fs.writeFileSync(path.join(tree, 'top.txt'), 't');
        let linked = false;
        try { fs.symlinkSync(tree, path.join(tree, 'a', 'loop'), 'junction'); linked = true; } catch {}
        const list = [], room = { left: 100, cut: false };
        await listFolder(tree, 'tree', list, room);
        const rels = list.map((e) => (e.dir ? 'dir:' : '') + e.rel).sort();
        check('a dragged folder is listed with its paths, links are not followed', JSON.stringify(rels) === JSON.stringify(['dir:tree/empty', 'tree/a/b/x.txt', 'tree/top.txt']) && !room.cut,
          `${rels.join(', ')}${linked ? ' (a junction back to the folder was skipped)' : ' (no junction could be made here)'}`);
      }

      // Letting go outside every window with a button held. The host's pointer must wait while the
      // host is asked whether a drag-and-drop is under way (a program may take ~0.35 s to start one),
      // then: carry it out when there is one, otherwise let go where it waited, and only after the
      // wait carry on past the edge (a window moved onto a monitor not shown here).
      {
        const leave = await js(`(async () => {
          const v = mainView.panes[0].video, b = v.getBoundingClientRect(), w = window, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const inside = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, screenX: w.screenX + 40, screenY: w.screenY + 40 };
          const outside = { clientX: -300, clientY: b.top + b.height / 2, screenX: w.screenX - 300, screenY: w.screenY + 40 };
          const fire = (type, at, buttons) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons, ...at }));
          const sent = (t) => window.__rd.trace.filter((m) => m.t === t);
          const res = {};
          // While tracing nothing is sent at all, so the view-only lock can be lifted for the test.
          window.__rd.trace = []; READONLY = false;
          try {
          hostDrag = false; window.__rd.trace = [];
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          res.heldBack = sent('mm').length === 0 && sent('dragq').length === 1;
          fire('pointerup', outside, 0);
          await sleep(${700 + 450});
          res.letGoWhereItWaited = sent('mu').length === 1 && sent('mu')[0].x >= 0 && sent('mu')[0].x <= 1 && sent('dragout').length === 0;
          // (outPending = 0 below stands for the host's answer to a dragout, which never comes while tracing)
          window.__rd.trace = []; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          hostDrag = true; fire('pointermove', outside, 1);
          res.outMode = mainView.dragOut === true;
          fire('pointerup', outside, 0);
          res.carriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          // Back into the window before the host has ended its drag: no move (one without the button would
          // have the host let go where its pointer waited, a drop there), until the host answers.
          fire('pointermove', inside, 0);
          res.noMoveUntilTheHostAnswers = sent('mm').length === 0;
          gotDragData({ t: 'dragdata', kind: 'none', why: 'nodrag' }); drop = null;
          fire('pointermove', inside, 0);
          res.movesAgainAfterTheAnswer = sent('mm').length === 1;
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1); fire('pointerup', outside, 0);
          setTimeout(() => { hostDrag = true; }, 200);
          await sleep(550);
          res.lateDragCarriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          await sleep(${700 + 100});
          fire('pointermove', outside, 1);
          res.pastTheEdgeAfterTheWait = sent('mm').length === 1 && sent('mm')[0].x < 0;
          fire('pointerup', outside, 0);
          await sleep(50);
          // Ctrl held: off the picture - here onto this window's own bar above it - the pointer is over at
          // this PC at once: no moves, not even after the wait, also when Ctrl is let go meanwhile; let go
          // there with no drag on the host: the host lets go where its pointer waited.
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          const off = b.left > 10 ? { clientX: b.left - 8, clientY: b.top + b.height / 2 } : b.top > 10 ? { clientX: b.left + 30, clientY: b.top - 8 } : { clientX: b.left + 30, clientY: Math.min(innerHeight - 2, b.bottom + 8) };
          const bar = { ...off, screenX: w.screenX + 40, screenY: w.screenY + 40 }; // in this window, off its picture
          fire('pointerdown', inside, 1); fire('pointermove', { ...bar, ctrlKey: true }, 1);
          await sleep(${700 + 100});
          fire('pointermove', bar, 1);
          res.ctrlCrossedAtOnce = mainView.crossed === true && sent('mm').length === 0 && sent('dragq').length === 1;
          fire('pointerup', bar, 0);
          await sleep(1150);
          res.ctrlLetGoWhereItWaited = sent('mu').length === 1 && sent('mu')[0].x >= 0 && sent('mu')[0].x <= 1 && sent('dragout').length === 0;
          // ... and with a drag on the host, carried out to where it is let go.
          window.__rd.trace = []; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', { ...bar, ctrlKey: true }, 1);
          hostDrag = true; fire('pointermove', { ...bar, ctrlKey: true }, 1); fire('pointerup', { ...bar, ctrlKey: true }, 0);
          res.ctrlCarriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          } finally { READONLY = true; window.__rd.trace = null; hostDrag = false; drop = null; outPending = 0; }
          return res;
        })()`);
        check('drag out: the host pointer waits to learn whether a drag started, then carries it out or lets go where it waited; with Ctrl it is over at this PC at once', Object.values(leave).every(Boolean), JSON.stringify(leave));
      }

      const out = await js(`(() => { const w = window, at = (x, y) => leftAll({ screenX: x, screenY: y });
        return [at(w.screenX + 50, w.screenY + 50), at(w.screenX - 200, w.screenY + 50), at(w.screenX + w.outerWidth + 30, w.screenY + 50)]; })()`);
      const hd = await hostWin.webContents.executeJavaScript(`api.dragOut(0)`);
      check('drag out: leaving every window is recognised; the host injects nothing in a local trial',
        JSON.stringify(out) === '[false,true,true]' && typeof input.captureClass() === 'string' && hd.kind === 'none', `outside ${JSON.stringify(out)}, host says "${hd.why}"`);

      // The client app's part: received files end up in the folder they were dropped on, never over an existing file.
      const drop = require('../client/shell')._drop;
      const stage = (name, from) => { const d = fs.mkdtempSync(path.join(src, 's')), f = path.join(d, name); fs.copyFileSync(from, f); return f; };
      fs.writeFileSync(path.join(dst, 'note.txt'), 'already here');
      const placed = await drop.placeFiles([stage('note.txt', small), stage(path.basename(big), big)], { at: Date.now(), own: false, cls: 'CabinetWClass', folder: Promise.resolve(dst) });
      // Windows' clipboard file list (CF_HDROP); other platforms have their own format (see --clip-check).
      const buf = input.dropFilesBuffer(['C:\\a.txt', 'D:\\b c.txt']), hdrop = process.platform !== 'win32' ||
        (buf.readUInt32LE(0) === 20 && buf.readUInt32LE(16) === 1 && buf.toString('utf16le', 20) === 'C:\\a.txt\0D:\\b c.txt\0\0');
      if (process.platform !== 'win32') info('CF_HDROP buffer check skipped: that clipboard format is Windows-only (the Linux formats are in --clip-check)');
      check('drop into a folder: files are saved there under a free name',
        placed.how === 'saved' && fs.readFileSync(path.join(dst, 'note.txt'), 'utf8') === 'already here' && fs.readFileSync(path.join(dst, 'note (2).txt'), 'utf8') === 'hello drag\n'
        && sha(path.join(dst, path.basename(big))) === sha(big) && drop.safeName('..\\..\\evil:na|me?.txt') === '.._.._evil_na_me_.txt' && drop.safeName('CON') === 'file' && hdrop,
        `${fs.readdirSync(dst).length} files in the folder`);
      // A received folder: names from the other side can never climb out of the staging folder, and
      // the folder (with an empty sub-folder) lands in the target under a free name.
      {
        const g = fs.mkdtempSync(path.join(src, 'g'));
        const escaped = drop.stagedPath(g, '../..\\evil/./sub/..\\CON');
        fs.mkdirSync(path.join(g, 'proj', 'sub'), { recursive: true });
        fs.mkdirSync(path.join(g, 'proj', 'empty'));
        fs.writeFileSync(path.join(g, 'proj', 'sub', 'a.txt'), 'x');
        fs.mkdirSync(path.join(dst, 'proj'));
        const r = await drop.placeFiles([path.join(g, 'proj')], { at: Date.now(), own: false, cls: 'CabinetWClass', folder: Promise.resolve(dst) });
        check('drop of a folder: it keeps its inside and never overwrites; received names cannot leave the staging folder',
          r.how === 'saved' && escaped.startsWith(g + path.sep) && path.relative(g, escaped) === path.join('evil', 'sub', 'file')
          && fs.readFileSync(path.join(dst, 'proj (2)', 'sub', 'a.txt'), 'utf8') === 'x' && fs.statSync(path.join(dst, 'proj (2)', 'empty')).isDirectory(),
          `staged as ${path.relative(g, escaped)}, placed as ${fs.readdirSync(dst).filter((n) => n.startsWith('proj')).join(', ')}`);
      }

      if (process.argv.includes('--clip-check')) {
        // Opt-in: puts two files on this PC's clipboard and reads them back. Only when the clipboard
        // holds nothing or plain text, which is put back afterwards.
        const { clipboard, ClipboardItem } = require('electron');
        const keep = await keepTextClipboard(['text/plain']);
        if (keep) {
          const set = await input.setClipboardFiles([big, small]), back = await input.clipboardFiles();
          // Linux: what a file manager that writes text/uri-list alone (KDE's Dolphin) puts there is read as well.
          let uriList = [big, small];
          if (process.platform === 'linux') {
            await clipboard.write([new ClipboardItem({ 'text/uri-list': [big, small].map((f) => require('url').pathToFileURL(f).href).join('\r\n') + '\r\n' })]);
            uriList = await input.clipboardFiles();
          }
          await restoreClipboard(keep);
          const after = await keepTextClipboard(['text/plain']);
          check('files can be put on the clipboard', set && JSON.stringify(back) === JSON.stringify([big, small]) && JSON.stringify(uriList) === JSON.stringify([big, small]) && JSON.stringify(after) === JSON.stringify(keep),
            `${back.length} read back${process.platform === 'linux' ? `, ${uriList.length} from text/uri-list` : ''}, the text put back`);
        } else info('clipboard check skipped: the clipboard holds more than plain text');
      }
      for (const d of [src, dst]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // Files dragged or pasted in, onto the host: they travel over an 'upload' channel and are written
    // under the host's inbox (a local trial never drops or pastes them). Names from the client can
    // never leave the transfer's folder, a file that sends more than it announced is refused.
    {
      const inbox = path.join(os.tmpdir(), 'my-remote-in');
      const shaOf = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = new Set(fs.existsSync(inbox) ? fs.readdirSync(inbox) : []);
      const r = await js(`(async () => {
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const bytes = new Uint8Array(1500000); for (let i = 0; i < bytes.length; i += 4096) crypto.getRandomValues(bytes.subarray(i, Math.min(bytes.length, i + 4096)));
        const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
        const a = new File([bytes], 'a.bin'), b = new File(['hello in\\n'], 'b.txt'), evil = new File(['x'], 'evil.txt');
        const x0 = { ...window.__rd.xfer };
        READONLY = false;
        try {
          await upload(mainView, 'drop', null, { files: [{ file: a, rel: 'a.bin' }, { file: b, rel: 'proj/sub/b.txt' }, { file: evil, rel: '../../evil.txt' }], dirs: ['proj/empty'] });
          for (let i = 0; i < 60 && window.__rd.xfer.inDone === x0.inDone && window.__rd.xfer.inFailed === x0.inFailed; i++) await sleep(250);
          const dropped = { how: window.__rd.xfer.inHow, done: window.__rd.xfer.inDone - x0.inDone };
          // paste with files on the clipboard: a synthetic paste event carrying them
          const dt = new DataTransfer(); dt.items.add(new File(['pasted'], 'p.txt'));
          document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          for (let i = 0; i < 40 && window.__rd.xfer.inDone === x0.inDone + 1; i++) await sleep(250);
          const pasted = { how: window.__rd.xfer.inHow, done: window.__rd.xfer.inDone - x0.inDone };
          // a file that sends more than it announced
          const ch = pc.createDataChannel('upload', { ordered: true }); ch.binaryType = 'arraybuffer';
          await new Promise((res) => { ch.onopen = res; setTimeout(res, 5000); });
          const failed0 = window.__rd.xfer.inFailed;
          ch.send(JSON.stringify({ t: 'begin', mode: 'drop', at: null })); ch.send(JSON.stringify({ t: 'file', name: 'liar.bin', size: 3 })); ch.send(new Uint8Array(10).buffer);
          for (let i = 0; i < 40 && window.__rd.xfer.inFailed === failed0; i++) await sleep(100);
          return { dropped, pasted, liarRefused: window.__rd.xfer.inFailed > failed0, sha: await hex(bytes) };
        } finally { READONLY = true; }
      })()`);
      const fresh = (fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).filter((n) => !before.has(n)).map((n) => path.join(inbox, n));
      const withA = fresh.find((d) => fs.existsSync(path.join(d, 'a.bin')));
      const withP = fresh.find((d) => fs.existsSync(path.join(d, 'p.txt')));
      const ok = r.dropped.how === 'staged' && r.dropped.done === 1 && r.pasted.done === 2 && r.liarRefused && withA && withP
        && shaOf(path.join(withA, 'a.bin')) === r.sha && fs.readFileSync(path.join(withA, 'proj', 'sub', 'b.txt'), 'utf8') === 'hello in\n'
        && fs.statSync(path.join(withA, 'proj', 'empty')).isDirectory() && fs.existsSync(path.join(withA, 'evil.txt'))
        && !fresh.some((d) => fs.existsSync(path.join(d, 'liar.bin')) && fs.statSync(path.join(d, 'liar.bin')).size > 3);
      check('files dragged or pasted in reach the host intact, inside their folder; a lying file is refused', ok,
        JSON.stringify({ ...r, sha: undefined, staged: withA ? fs.readdirSync(withA) : null }));
      for (const d of fresh) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // --clip-check: files copied on the host (put on this PC's clipboard the way Explorer's Copy
    // does) are announced to the client, and fetched when it leaves its windows. Only when the
    // clipboard holds nothing or text (plain, HTML), which is put back.
    if (process.argv.includes('--clip-check')) {
      const keep = await keepTextClipboard(['text/plain', 'text/html']);
      if (keep) {
        const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-clipfiles-'));
        const a = path.join(cdir, 'copied-a.bin'), b = path.join(cdir, 'copied-b.txt');
        fs.writeFileSync(a, require('crypto').randomBytes(200000)); fs.writeFileSync(b, 'copied on the host\n');
        const shaOf = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        let idir = null;
        try {
          await js(`window.__rd.keepFiles = true; window.__rd.files = []; 1`);
          const notes0 = (await state()).xfer.clipNotes;
          await input.setClipboardFiles([a, b]);
          const [noted] = await until((x) => x.xfer.clipNotes > notes0, 8);
          await js(`READONLY = false; try { maybeFetchClipFiles(); } finally { READONLY = true; } 1`);
          const [got, s2] = await until((x) => x.files.length === 2, 20);
          const files = got ? s2.files : [];
          check('files copied on the host are announced and fetched when the client leaves its windows', noted && got
            && files.some((f) => f.name === 'copied-a.bin' && f.sha === shaOf(a)) && files.some((f) => f.name === 'copied-b.txt' && f.sha === shaOf(b)),
            `announced ${!!noted}, received ${files.map((f) => f.name).join(', ') || 'nothing'}`);
          // Files the client sent itself (a paste: they lie in the host's inbox) are not announced back.
          fs.mkdirSync(path.join(os.tmpdir(), 'my-remote-in'), { recursive: true });
          idir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-remote-in', 'selftest-'));
          const c = path.join(idir, 'from-client.txt');
          fs.writeFileSync(c, 'sent by the client\n');
          const notes1 = (await state()).xfer.clipNotes;
          await input.setClipboardFiles([c]);
          const [echoed] = await until((x) => x.xfer.clipNotes > notes1, 3);
          check('files the client sent are not announced back to it', !echoed);
          // Files pasted into the picture: read like a drop; a folder the browser hands over as an
          // unreadable file is left out and named, the file goes (staged here: a local trial drops nothing).
          const pdir = path.join(cdir, 'pasted-folder'), pfile = path.join(cdir, 'pasted.txt');
          fs.mkdirSync(pdir); fs.writeFileSync(path.join(pdir, 'inner.txt'), 'inside\n'); fs.writeFileSync(pfile, 'pasted file\n');
          await input.setClipboardFiles([pfile, pdir]);
          const px0 = (await state()).xfer;
          await js(`READONLY = false; window.__rd.lastDrop = null; 1`);
          w.webContents.focus(); w.webContents.paste();
          const [pasted, ps] = await until((x) => x.xfer.inDone > px0.inDone || x.xfer.inFailed > px0.inFailed, 8);
          const pl = await js(`(() => { READONLY = true; const l = window.__rd.lastDrop; return l && { plain: l.plain, skipped: l.skipped || [], files: l.files, error: l.error }; })()`);
          info(`pasted a file and a folder: the browser listed ${pl ? pl.plain : '?'}, ${pl && pl.files === 2 ? 'the folder went whole (its file inside)' : 'left out ' + (pl ? JSON.stringify(pl.skipped) : '?')}`);
          check('files pasted into the picture: the file goes, and the folder whole (or, where the browser hands it over as a file, left out and named)', pasted && ps.xfer.inHow === 'staged' && pl
            && (pl.files === 2 || pl.skipped.includes('pasted-folder')), JSON.stringify({ how: ps.xfer.inHow, ...pl }));
          // Text from the client is on the clipboard before the input that follows it is injected: the
          // paste shortcut comes right after the text, and since Electron 44 a write completes later.
          if (process.platform === 'win32') {
            // The input is only looked at, never injected: nothing reaches this PC's keyboard.
            const seen = [], handle = input.handle;
            input.handle = (t) => { if (/"t":"kd"/.test(t)) seen.push(input.clipSeq()); };
            try {
              const seq0 = input.clipSeq();
              await hostWin.webContents.executeJavaScript(`api.writeClip('self-test paste'); api.input(JSON.stringify({ t: 'kd', c: 'F24', k: 'F24' })); api.input(JSON.stringify({ t: 'ku', c: 'F24', k: 'F24' })); 1`);
              await sleep(1200);
              await js(`pendingClip = null; 1`); // the host passed the text on: not to be written here later
              check('text from the client is on the clipboard before the next input is injected', seen.length === 1 && seen[0] !== seq0, `clipboard change count ${seq0} before, ${seen.join(', ') || 'no key seen'} at the key`);
            } finally { input.handle = handle; }
          }
        } finally {
          await js(`window.__rd.keepFiles = false; 1`);
          await restoreClipboard(keep);
          try { fs.rmSync(cdir, { recursive: true, force: true }); } catch {}
          if (idir) try { fs.rmSync(idir, { recursive: true, force: true }); } catch {}
        }
      } else info('copied-files check skipped: the clipboard holds more than text');
    }

    // Pasting must reach the page through the browser's paste event (no clipboard-read permission).
    w.webContents.focus();
    w.webContents.paste();
    [ok, s] = await until((x) => x.pastes > 0, 5);
    check('paste event is handled without clipboard permission', ok);

    [ok, s] = await until((x) => x.host && x.host.codec && Object.keys(x.host.mons || {}).length > 0, 8);
    check('host statistics reach the client', ok, ok ? `${s.host.codec} via ${s.host.enc}, available ${s.host.availMbps} Mbps` : '');
    // Real stutter (see watchFrames in the page): shown frames whose capture times came with them.
    const late = s.hitch || {};
    // The self-test's client window is hidden and draws seldom, so most late frames here are drawn late, not received late.
    if (late.frames > 0) info(`frames late compared with when they were captured (hidden window): shown late ${late.n} of ${late.frames} (worst ${Math.round(late.worst)} ms), received late ${late.rn}`);
    else info('frames shown late: not measured (the client window is hidden in the self-test)');

    info(`audio track: ${s.audio ? 'received' : 'none (normal on a PC without an audio output device)'}`);
    // The host sends the text on its clipboard when a session starts: when there is some, it must have
    // arrived (with Electron 45 an unawaited clipboard read once sent nothing, and only an INFO line said so).
    {
      const { clipboard } = require('electron');
      const text = String((await Promise.resolve().then(() => clipboard.readText()).catch(() => '')) || ''); // a promise since Electron 44
      if (text && text.length <= 60000 && !input.clipboardPrivate()) check('text on the host\'s clipboard reaches the client', s.clipRx, s.clipRx ? 'received' : 'not received');
      else info(`clipboard host->client: ${s.clipRx ? 'received' : 'not checked (the clipboard holds no text)'}`);
    }

    // Host monitors changed (simulated): the session is renegotiated and the client comes back by itself.
    let before = s.connects;
    hostWin.webContents.send('displays-changed');
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 20, 40);
    check('renegotiates when the host monitors change', ok, ok ? `still showing monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}` : JSON.stringify(s));
    // With native capture the new session takes the system sound over from the one before instead of
    // starting the engine's capture again (each start leaves handles behind in the main process).
    {
      const h = await hostWin.webContents.executeJavaScript(`({ reused: typeof audioReuses === 'number' ? audioReuses : -1, native: !!(session && session.native), audio: !!(session && session.streams.some((st) => st.getAudioTracks().some((t) => t.readyState === 'live'))) })`);
      if (!s.audio) info('sound take-over not checked: no audio track (normal on a PC without an audio output device)');
      else if (!h.native) info('sound take-over not checked: native capture is not in use');
      else check('a new session takes the system sound over instead of capturing again', h.reused > 0 && h.audio, JSON.stringify(h));
    }
    // The host's screen locked and unlocked (what main sends on Windows' lock events), and a screen the
    // native capturer cannot read for a while (a UAC prompt): the client says so over the picture.
    {
      const lockShown = () => js(`!!(mainView.lockEl && mainView.lockEl.style.display === 'flex')`);
      hostWin.webContents.send('host-lock', true);
      const [on] = await until((x) => x.lock === 'lock', 6);
      const shown = await lockShown();
      hostWin.webContents.send('host-lock', false);
      const [off] = await until((x) => x.lock === '', 6);
      const gone = !(await lockShown());
      let secure = 'not checked (native capture not in use)';
      if (await hostWin.webContents.executeJavaScript('!!(session && session.native && session.native[0])')) {
        await hostWin.webContents.executeJavaScript(`nativePort.onmessage({ data: { t: 'paused', i: 0, on: true, error: 'self-test' } }); 1`);
        const [sec] = await until((x) => x.lock === 'secure', 6);
        await hostWin.webContents.executeJavaScript(`nativePort.onmessage({ data: { t: 'paused', i: 0, on: false, error: '' } }); 1`);
        const [back] = await until((x) => x.lock === '', 6);
        secure = sec && back ? 'secure prompt shown and cleared' : `secure prompt ${sec ? 'shown' : 'not shown'}, ${back ? 'cleared' : 'not cleared'}`;
      }
      check('the client says when the host screen is locked or behind a secure prompt, and when it is back', on && shown && off && gone && !/not (shown|cleared)/.test(secure),
        `lock ${on && shown ? 'shown' : 'not shown'}, ${off && gone ? 'cleared' : 'not cleared'}; ${secure}`);
    }
    // A phone (attachTouch, the phone keyboard): fingers on the picture made of synthetic touch pointer
    // events, traced (nothing is sent), and what the host makes of the characters a phone types.
    {
      const t = await js(`(async () => {
        if (typeof mainView.sel !== 'number') setSel(mainView, 0);
        if (mainView.fit !== 'fit') setFit(mainView, 'fit');
        const v = mainView.panes[0].video, r = v.getBoundingClientRect();
        const P = (type, id, fx, fy) => v.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 11, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, cancelable: true }));
        const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
        const INPUT = new Set(['mm', 'md', 'mu', 'mw', 'kd', 'ku', 'text']);
        const out = {};
        const run = async (name, fn) => {
          window.__rd.trace = []; await fn(); await wait(80);
          out[name] = window.__rd.trace.filter((m) => INPUT.has(m.t)).map((m) => m.t + (m.b != null ? m.b : '') + (m.t === 'mw' ? (m.dy > 0 ? '+' : m.dy < 0 ? '-' : '0') : ''));
        };
        await run('tap', async () => { P('pointerdown', 11, .5, .5); await wait(60); P('pointerup', 11, .5, .5); });
        await run('long', async () => { P('pointerdown', 11, .3, .3); await wait(700); P('pointerup', 11, .3, .3); });
        await run('drag', async () => { P('pointerdown', 11, .4, .4); await wait(420); P('pointermove', 11, .45, .4); P('pointermove', 11, .5, .4); P('pointerup', 11, .5, .4); });
        await run('swipe', async () => { P('pointerdown', 11, .5, .6); await wait(30); P('pointermove', 11, .5, .55); P('pointermove', 11, .5, .45); await wait(40); P('pointerup', 11, .5, .45); });
        await run('pinch', async () => { P('pointerdown', 11, .45, .5); P('pointerdown', 12, .55, .5); P('pointermove', 11, .35, .5); P('pointermove', 12, .65, .5); P('pointerup', 12, .65, .5); P('pointerup', 11, .35, .5); });
        out.zoom = +(mainView.zoom || 1).toFixed(2);
        document.getElementById('zoomBtn').click();
        // The phone keyboard: what changes in the hidden field goes over; Backspace also when only the
        // kept space is left; a key-row Ctrl makes the next letter a shortcut.
        const k = document.getElementById('kbd'), type = (val, inputType) => { k.value = val; k.dispatchEvent(new InputEvent('input', { inputType })); };
        await run('kbd', async () => { type(' 한글a', 'insertText'); type(' 한글', 'deleteContentBackward'); type(' 한', 'deleteContentBackward'); type(' ', 'deleteContentBackward'); type('', 'deleteContentBackward'); });
        out.kept = JSON.stringify(k.value);
        await run('ctrl', async () => {
          const ctrl = [...document.getElementById('keyrow').children].find((b) => b.dataset.code === 'ControlLeft');
          ctrl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          type(' c', 'insertText');
        });
        out.kbdTrace = window.__rd.trace;
        window.__rd.trace = null;
        return out;
      })()`);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const typed = input.simulate([{ x: 0, y: 0, width: 1920, height: 1080 }], [{ t: 'text', s: '한글 a' }]).log.find((e) => e.text);
      const ok = same(t.tap, ['md0', 'mu0']) && same(t.long, ['md2', 'mu2']) && t.drag[0] === 'md0' && t.drag.includes('mm') && t.drag[t.drag.length - 1] === 'mu0'
        && t.swipe.includes('mw+') && !t.swipe.some((x) => /^m[du]/.test(x)) && !t.pinch.some((x) => /^m[du]/.test(x)) && t.zoom > 1.2
        && same(t.kbd, ['text', 'kd', 'ku', 'kd', 'ku', 'kd', 'ku', 'kd', 'ku']) && t.kept === '" "' && same(t.ctrl, ['kd', 'kd', 'ku', 'ku']) && typed && typed.text === '한글 a';
      // The first rule: in a window this PC's system shortcuts stay here, in fullscreen they go to the
      // host; a key whose press went keeps its release. The clipboard is shared either way.
      const r = await js(`(() => {
        const K = (type, code, o = {}) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...o }));
        const sent = () => window.__rd.trace.filter((m) => m.t === 'kd' || m.t === 'ku').map((m) => m.t + ':' + m.c);
        const out = {};
        window.__rd.trace = []; window.__rd.forceFull = false;
        K('keydown', 'MetaLeft', { metaKey: true }); K('keydown', 'KeyS', { metaKey: true, shiftKey: true }); K('keyup', 'KeyS', { metaKey: true }); K('keyup', 'MetaLeft');
        K('keydown', 'PrintScreen'); K('keyup', 'PrintScreen'); K('keydown', 'KeyA'); K('keyup', 'KeyA');
        out.window = sent();
        window.__rd.trace = []; window.__rd.forceFull = true;
        K('keydown', 'MetaLeft', { metaKey: true }); K('keydown', 'KeyD', { metaKey: true }); K('keyup', 'KeyD', { metaKey: true });
        window.__rd.forceFull = false; K('keyup', 'MetaLeft'); // fullscreen left with the key still held: its release still goes
        out.full = sent();
        // In a window Alt+Space stays here, but Alt went first: the host lets go of everything (masked);
        // the releases of Alt and of a key never pressed here are not sent.
        window.__rd.trace = [];
        K('keydown', 'AltLeft', { altKey: true }); K('keydown', 'Space', { altKey: true }); K('keyup', 'Space', { altKey: true }); K('keyup', 'AltLeft'); K('keyup', 'KeyB');
        out.altSpace = window.__rd.trace.filter((m) => ['kd', 'ku', 'reset'].includes(m.t)).map((m) => m.t + (m.c ? ':' + m.c : ''));
        // The client app's clipboard: what was there before the session is never sent, a copy made here is,
        // once; text from the host that both have already is not written again.
        window.__rd.trace = [];
        const keepLast = lastClip;
        clipSeqSeen = null; lastClip = null;
        gotClientClip({ seq: 101, text: 'before the session' }); gotClientClip({ seq: 102, text: 'before the session' });
        gotClientClip({ seq: 103, text: 'copied here' }); gotClientClip({ seq: 104, text: 'copied here' });
        out.clip = window.__rd.trace.filter((m) => m.t === 'clip').map((m) => m.s);
        lastClip = 'the same text'; pendingClip = null; gotClip('the same text'); out.sameKept = pendingClip === null;
        clipSeqSeen = null; lastClip = keepLast; pendingClip = null; window.__rd.trace = null; window.__rd.forceFull = false;
        return out;
      })()`);
      const masked = input.simulate([{ x: 0, y: 0, width: 1920, height: 1080 }], [{ t: 'kd', c: 'AltLeft', k: 'Alt' }, { t: 'reset' }]).log.map((e) => e.key + (e.up ? '-up' : ''));
      check('fullscreen is the host: in a window the system keys stay here (Alt+Space lets go of the Alt already sent), in fullscreen they go; the clipboard is shared; a lone Alt let go is masked', same(r.window, ['kd:KeyA', 'ku:KeyA'])
        && same(r.full, ['kd:MetaLeft', 'kd:KeyD', 'ku:KeyD', 'ku:MetaLeft']) && same(r.altSpace, ['kd:AltLeft', 'reset']) && same(r.clip, ['copied here']) && r.sameKept
        && same(masked, ['AltLeft', 'mask', 'AltLeft-up']),
        `window ${r.window} | fullscreen ${r.full} | Alt+Space in a window ${r.altSpace} | clipboard ${JSON.stringify(r.clip)}${r.sameKept ? '' : ', the same text written again'} | reset ${masked}`);
      check('a phone: tap, long press, hold and drag, swipe, pinch; its keyboard (Hangul, Backspace, key-row Ctrl); the host types the characters', ok,
        `tap ${t.tap} | long ${t.long} | drag ${t.drag} | swipe ${t.swipe} | pinch ${t.pinch.join(',') || 'nothing sent'}, zoom ${t.zoom} | kbd ${t.kbd} kept ${t.kept} | ctrl ${t.ctrl} | host typed ${typed ? 'yes' : 'no'}`);
    }

    if (INPUT_CHECK) {
      if (process.platform === 'linux') {
        const native = await hostWin.webContents.executeJavaScript('!!(session && session.native)');
        await require('./inputcheck').run({ check, info, js, until, dragOut, native });
      }
      else info('--input-check is for Linux (X11); on Windows input injection was verified separately');
      s = await state();
    }

    if (CURSOR_CHECK && !input.hidesCursors) info('--cursor-check skipped: hiding the host cursor is Windows-only');
    else if (CURSOR_CHECK) {
      // Compare the pixels under the cursor with the cursor shown and hidden.
      const pt = screen.getCursorScreenPoint();
      const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
      const d = screen.getDisplayNearestPoint(pt), idx = displays.findIndex((x) => x.id === d.id);
      const lx = Math.round((pt.x - d.bounds.x) * d.scaleFactor), ly = Math.round((pt.y - d.bounds.y) * d.scaleFactor);
      // A small always-on-top window under the cursor gives the comparison a static background
      // (and a standard arrow cursor) whatever happens to be on screen.
      const pad = new BrowserWindow({ x: pt.x - 60, y: pt.y - 60, width: 120, height: 120, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, backgroundColor: '#6a7f96', show: false });
      pad.setAlwaysOnTop(true, 'screen-saver');
      pad.showInactive();
      const grab = async () => {
        await sleep(2500);
        return js(`(() => { const v = mainView.panes[0].video, c = document.createElement('canvas'); c.width = c.height = 64;
          const g = c.getContext('2d'); g.drawImage(v, ${lx} - 8, ${ly} - 8, 64, 64, 0, 0, 64, 64); return Array.from(g.getImageData(0, 0, 64, 64).data); })()`);
      };
      const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++; return n; };
      const renegotiate = async () => {
        const c = (await state()).connects;
        hostWin.webContents.send('displays-changed');
        return (await until((x) => x.connects > c && x.state === 'connected' && Number(String(x.res[idx]).split('x')[0]) === x.mons[idx].w, 40))[0];
      };
      await js(`setSel(mainView, ${idx}); setFit(mainView, '1:1')`);
      await until((x) => Number(String(x.res[idx]).split('x')[0]) === x.mons[idx].w, 15);
      const shown1 = await grab(), shown2 = await grab();
      cfg.hideHostCursor = true;
      const okA = await renegotiate();
      const hidden = await grab();
      cfg.hideHostCursor = false;
      const okB = await renegotiate();
      const shown3 = await grab();
      const noise = diff(shown1, shown2), gone = diff(shown1, hidden), back = diff(shown1, shown3);
      check('hiding the host cursor removes it from the video', okA && okB && gone > 30 && gone > noise * 3 && back < gone / 2,
        `pixels changed under the cursor: noise ${noise}, hidden ${gone}, restored ${back}`);
      pad.destroy();
      await js(`setFit(mainView, 'fit')`);
      s = await state();
    }

    // Host program restarted: same.
    before = s.connects;
    hostWin.reload();
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 20, 60);
    check('auto reconnect after host restart', ok, ok ? '' : JSON.stringify(s));
    // The loader file: fetches the client page from the host, runs it, and skips the download next time.
    {
      const lf = path.join(dir, 'loader.html');
      fs.writeFileSync(lf, buildLoaderHtml());
      w.destroy();
      const lw = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
      const ljs = (code) => lw.webContents.executeJavaScript(code);
      const lstate = () => ljs(`({ boot: window.__mrBoot ? { updated: window.__mrBoot.updated } : null, state: window.__rd ? window.__rd.state : '', frames: window.__rd ? window.__rd.frames : 0, cached: !!localStorage.getItem('mr_app_html'), hasKeyInStore: !!localStorage.getItem('mr_key') })`);
      const luntil = async (pred, secs) => { let x; for (let i = 0; i < secs; i++) { await sleep(1000); try { x = await lstate(); if (pred(x)) return [true, x]; } catch {} } return [false, x]; };
      await lw.loadFile(lf, { hash: `k=${cfg.key}&auto&ro` });
      let [ok1, a] = await luntil((x) => x.boot && x.state === 'connected' && x.frames > 20, 45);
      check('loader fetches the client page from the host and connects', ok1 && a.boot.updated === true && a.cached, JSON.stringify(a));
      await lw.loadFile(lf, { query: { again: '1' }, hash: `k=${cfg.key}&auto&ro` }); // a different URL forces a real reload
      let [ok2, b] = await luntil((x) => x.boot && x.state === 'connected' && x.frames > 20, 45);
      check('loader reuses the cached page when the host version is unchanged', ok2 && b.boot.updated === false, JSON.stringify(b));

      // The host was updated while this page is open: the page must notice and fetch the new one by itself.
      await ljs(`localStorage.setItem('mr_app_hash', 'stale')`);
      hostWin.webContents.send('displays-changed'); // any new offer carries the host's page version
      let [ok3, c] = await luntil((x) => x.boot && x.boot.updated === true && x.state === 'connected' && x.frames > 20, 60);
      check('an open client updates itself when the host version changes', ok3, JSON.stringify(c));
      lw.destroy();

      if (SHELL_CHECK) {
        // The client app: one call to spread() must put one fullscreen window on every screen, in order.
        const shell = require('../client/shell');
        const sw = new BrowserWindow({ width: 1280, height: 720, webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false, partition: 'shell-check' } });
        const st = shell.attach(sw);
        const sjs = (code, gesture) => sw.webContents.executeJavaScript(code, !!gesture);
        await sw.loadFile(lf, { query: { app: '1' }, hash: `k=${cfg.key}&auto&ro` });
        let okc = false;
        for (let i = 0; i < 45 && !okc; i++) { await sleep(1000); try { okc = await sjs(`!!window.__rd && window.__rd.state === 'connected' && !!window.mrShell`); } catch {} }
        await sjs('spread()', true);
        await sleep(5000);
        const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
        const wins = [sw, ...st.children].filter((x) => !x.isDestroyed());
        const placed = wins.map((x) => ({ display: displays.findIndex((d) => d.id === screen.getDisplayMatching(x.getBounds()).id), fullscreen: x.isFullScreen() }));
        const views = await sjs(`liveViews().map((v) => ({ sel: v.sel, x: v.win.screenX, fs: !!v.win.document.fullscreenElement })).sort((a, b) => a.x - b.x)`);
        const mons = await sjs('monitors.length');
        const want = Math.min(mons, displays.length);
        const sels = views.map((v) => v.sel);
        check('client app: one click puts a fullscreen window on every screen, left to right',
          okc && wins.length === want && new Set(placed.map((x) => x.display)).size === want && placed.every((x) => x.fullscreen) && views.every((v) => v.fs) && sels.every((s, i) => i === 0 || s === sels[i - 1] + 1),
          `${wins.length} window(s) on displays ${JSON.stringify(placed.map((x) => x.display))}, fullscreen ${JSON.stringify(placed.map((x) => x.fullscreen))}, host monitors left to right ${JSON.stringify(sels)}`);
        for (const x of wins) if (!x.isDestroyed()) x.destroy();
      }
    }

    if (CLIENT_APP_CHECK) {
      // The client app as a program of its own, on a loader that knows this test's relay and key (view-only).
      // It counts as working when its measurements (sent to the host every 2 s, kept in the diagnostics
      // log) say it runs in the app's shell and shows the host's picture.
      const loader = path.join(dir, 'client-app-loader.html'), diag = path.join(app.getPath('userData'), 'diag.log');
      fs.writeFileSync(loader, buildLoaderHtml('k=' + cfg.key + '&auto&ro'));
      const from = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const args = [path.join(__dirname, '..', 'client'), '--loader=' + loader, ...process.argv.filter((a) => a === '--no-sandbox' || a === '--disable-gpu')];
      const child = require('child_process').spawn(process.execPath, args, { env, stdio: 'ignore' });
      let seen = null;
      for (let i = 0; i < 60 && !seen; i++) {
        await sleep(1000);
        let text = '';
        try { text = fs.readFileSync(diag, 'utf8').slice(from); } catch {}
        for (const line of text.split('\n')) {
          let e = null;
          try { e = JSON.parse(line); } catch {}
          if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen = e.client;
        }
      }
      check('client app (client/main.js, a program of its own) connects and shows the host\'s picture', !!seen,
        seen ? `fps ${JSON.stringify(seen.fps)}, decoder ${seen.dec}, windows ${JSON.stringify(seen.views)}` : 'no measurements from the app arrived');
      try { child.kill(); } catch {}
      await sleep(1500); // let it go before its profile (inside `dir`) is removed
    }
  } catch (e) {
    console.log('[selftest] aborted:', e.message);
    results.push(false);
  }
  const pass = results.every(Boolean);
  console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(pass ? 0 : 1);
};
