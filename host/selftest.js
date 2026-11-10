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

exports.run = async ({ cfg, buildClientHtml, buildLoaderHtml, app }) => {
  const results = [];
  const check = (name, ok, detail) => { results.push(!!ok); console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
  const info = (text) => console.log(`[selftest] INFO  ${text}`);

  // Pure coordinate mapping (no input is injected): two monitors side by side, 1080p then 1440p.
  {
    const virt = { x: 0, y: 0, width: 4480, height: 1440 };
    input.setMonitors([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 2560, height: 1440 }]);
    const inside = input.target(1, 0.5, 0.5, virt), past = input.target(0, 1.25, 0.5, virt), far = input.target(0, -3, 0.5, virt);
    check('coordinates: drag continues onto the next monitor',
      inside && Math.abs(inside.px - (1920 + 0.5 * 2559)) < 1 && past && past.px > 1920 && past.px < 4480 && far && far.px === 0 && input.target(0, NaN, 0, virt) === null && input.target(5, 0.5, 0.5, virt) === null,
      `x=1.25 on monitor 1 -> desktop x ${past && Math.round(past.px)}`);
  }

  // Picture of an app-specific cursor (read-only; uses the standard arrow as a stand-in).
  {
    const koffi = require('koffi');
    const arrow = koffi.load('user32.dll').func('LoadCursorW', 'uintptr_t', ['uintptr_t', 'uintptr_t'])(0, 32512);
    const b = input.cursorBitmap(arrow);
    const url = b ? nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL() : '';
    check('cursor picture extraction', b && url.startsWith('data:image/png;base64,') && url.length > 150, b ? `${b.width}x${b.height}, hotspot ${b.hx},${b.hy}` : 'null');
    const dump = process.argv.find((a) => a.startsWith('--dump-cursor='));
    if (dump && b) fs.writeFileSync(dump.split('=')[1], nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).resize({ width: b.width * 6, quality: 'nearest' }).toPNG());
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-client-'));
  const file = path.join(dir, 'client.html');
  fs.writeFileSync(file, buildClientHtml());
  await sleep(2500); // let the host subscribe first
  const hostWin = BrowserWindow.getAllWindows()[0];
  const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(file, { hash: `k=${cfg.key}&auto&ro` });
  const js = (code) => w.webContents.executeJavaScript(code);
  const state = () => js(`({ ...window.__rd, sel: mainView.sel, fit: mainView.fit, view: lastView,
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

    [ok, s] = await until((x) => !!x.cursor, 5);
    check('cursor shape sync', ok && s.cursorCss === s.cursor, `host cursor = ${s.cursor}`);

    // The client window is smaller than the monitor, so the host must send fewer pixels - but never fewer than shown.
    const main = s.sel;
    [ok, s] = await until((x) => {
      const need = JSON.parse(x.view).find((e) => e.i === main), got = width(x.res[main]);
      return need && got > 0 && got >= need.w - 2 && (need.w >= x.mons[main].w || got < x.mons[main].w);
    }, 15);
    const encOf = (x) => (x.host && x.host.mons ? Object.entries(x.host.mons).map(([i, m]) => `monitor ${Number(i) + 1} ${m.res} ${m.impl}`).join('; ') : '?');
    await sleep(4500); s = await state(); info('video encoder: ' + encOf(s) + ' (OpenH264 here means no hardware encoder is being used)');
    check('sends only as many pixels as are shown', ok, `monitor ${main + 1} is ${s.mons[main].w}x${s.mons[main].h}, shown at ${JSON.parse(s.view).map((e) => e.w + 'x' + e.h)[0]}, received ${s.res[main]}`);

    await js(`setFit(mainView, '1:1')`);
    [ok, s] = await until((x) => width(x.res[main]) === x.mons[main].w, 15);
    check('1:1 mode receives the full resolution', ok, `received ${s.res[main]}`);
    await js(`setFit(mainView, 'fit')`);

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
    } else {
      info('single monitor host: monitor switching and overview checks skipped');
    }

    // Pasting must reach the page through the browser's paste event (no clipboard-read permission).
    w.webContents.focus();
    w.webContents.paste();
    [ok, s] = await until((x) => x.pastes > 0, 5);
    check('paste event is handled without clipboard permission', ok);

    [ok, s] = await until((x) => x.host && x.host.codec && Object.keys(x.host.mons || {}).length > 0, 8);
    check('host statistics reach the client', ok, ok ? `${s.host.codec} via ${s.host.enc}, available ${s.host.availMbps} Mbps` : '');

    info(`audio track: ${s.audio ? 'received' : 'none (normal on a PC without an audio output device)'}`);
    info(`clipboard host->client: ${s.clipRx ? 'received' : 'none (normal when the clipboard holds no text)'}`);

    // Host monitors changed (simulated): the session is renegotiated and the client comes back by itself.
    let before = s.connects;
    hostWin.webContents.send('displays-changed');
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 20, 40);
    check('renegotiates when the host monitors change', ok, ok ? `still showing monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}` : JSON.stringify(s));

    if (CURSOR_CHECK) {
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
      lw.destroy();
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
