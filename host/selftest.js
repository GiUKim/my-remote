// `electron . --selftest`: runs the real client page against this host, entirely
// on this machine. Signaling goes through a relay on 127.0.0.1, no STUN is used,
// the client is view-only (no input is injected) and a throwaway key/profile is
// used. Nothing is sent to the internet.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

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

exports.run = async ({ cfg, buildClientHtml, app }) => {
  const results = [];
  const check = (name, ok, detail) => { results.push(ok); console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-client-'));
  const file = path.join(dir, 'client.html');
  fs.writeFileSync(file, buildClientHtml());
  await sleep(2500); // let the host subscribe first
  const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(file, { hash: `k=${cfg.key}&auto&ro` });
  const js = (code) => w.webContents.executeJavaScript(code);
  const state = () => js(`({ ...window.__rd, main: mainIdx, view: lastView, stats: document.getElementById('stats').textContent,
    video: mainVideo.videoWidth + 'x' + mainVideo.videoHeight, cursorCss: mainVideo.style.cursor, pendingClip: pendingClip != null })`);
  const until = async (pred, secs) => {
    let s;
    for (let i = 0; i < secs; i++) { await sleep(1000); s = await state(); if (pred(s)) return [true, s]; }
    return [false, s];
  };

  try {
    let [ok, s] = await until((x) => x.state === 'connected' && x.frames > 60 && x.stats, 40);
    check('connect and receive video', ok, ok ? `${s.monitors} monitor(s), ${s.video}, ${s.frames} frames decoded` : JSON.stringify(s));
    if (!ok) throw new Error('no connection');

    [ok, s] = await until((x) => !!x.cursor, 5);
    check('cursor shape sync', ok && s.cursorCss === s.cursor, `host cursor = ${s.cursor}`);

    if (s.monitors > 1) {
      // The client shows only its main monitor, so the others must stop arriving.
      [ok, s] = await until((x) => Object.entries(x.fps).every(([i, f]) => (Number(i) === x.main ? f > 0 : f === 0)), 12);
      check('only viewed monitors are sent', ok, `viewing ${s.view}, fps per monitor ${JSON.stringify(s.fps)}`);
      const other = (s.main + 1) % s.monitors;
      await js(`document.querySelectorAll('#mons button')[${other * 2}].click()`);
      [ok, s] = await until((x) => x.main === other && x.fps[other] > 0 && x.fps[(other + 1) % x.monitors === other ? other : (other + 1) % x.monitors] >= 0 && Object.entries(x.fps).every(([i, f]) => (Number(i) === other ? f > 0 : f === 0)), 12);
      check('switch monitor', ok, `fps per monitor ${JSON.stringify(s.fps)}`);
    }

    // Informational only: both depend on the machine (audio device present, text on the clipboard).
    console.log(`[selftest] INFO  audio track: ${s.audio ? 'received' : 'none (normal on a PC without an audio output device)'}`);
    [ok, s] = await until((x) => x.clipRx, 4);
    console.log(`[selftest] INFO  clipboard host->client: ${ok ? 'received' : 'none (normal when the clipboard holds no text)'}`);

    // Simulate the host program restarting; the client must come back by itself.
    const before = s.connects;
    BrowserWindow.getAllWindows().find((x) => x !== w).reload();
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 30, 60);
    check('auto reconnect after host restart', ok, ok ? `reconnected ${s.connects - 1} time(s)` : JSON.stringify(s));
  } catch (e) {
    console.log('[selftest] aborted:', e.message);
    results.push(false);
  }
  const pass = results.every(Boolean);
  console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(pass ? 0 : 1);
};
