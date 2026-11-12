// The client side of the bench (see bench.js), as its own Electron process, so the client's
// decoding and drawing do not share a GPU process with the host's capture and encoding - a
// client on another PC would not share one either.
//
// It shows the test picture on one display of this PC, connects the real client page to the
// bench host, records for every frame the client shows which picture frame it was and when it
// reached the screen, and reports the result to the host process.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { performance } = require('perf_hooks');

const C = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const B = C.bench, P = C.pattern;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-peer-')));
app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', ...(B.peerDisableFeatures || [])].join(','));
if (B.peerTrials) app.commandLine.appendSwitch('force-fieldtrials', B.peerTrials);
for (const [k, v] of Object.entries(B.peerSwitches || {})) app.commandLine.appendSwitch(k, String(v));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const epoch = () => performance.timeOrigin + performance.now();
const ctl = (pathname, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(C.ctl + pathname, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
    let s = '';
    res.on('data', (d) => (s += d));
    res.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

// Sends the WebRTC traffic through the link emulator: the host's candidates in the offer are
// replaced by the emulator's port (the real one is reported to it), and this side's candidates
// are left out of the answer, so the only path the two can find is the one through the emulator.
const MUNGE = `(() => {
  const setRemote = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (d) {
    let picked = null;
    const lines = d.sdp.split('\\r\\n').map((l) => {
      if (!l.startsWith('a=candidate:')) return l;
      const p = l.split(' ');
      if (p[2].toLowerCase() !== 'udp' || p[7] !== 'host' || !/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(p[4])) return null;
      if (!picked) picked = { address: p[4], port: Number(p[5]) };
      if (p[4] !== picked.address || Number(p[5]) !== picked.port) return null;
      p[5] = '__PORT__';
      return p.join(' ');
    }).filter((l) => l !== null);
    console.log('BENCH-TARGET ' + JSON.stringify(picked));
    return setRemote.call(this, { type: d.type, sdp: lines.join('\\r\\n') });
  };
  const ld = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription');
  Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', { configurable: true, get() {
    const x = ld.get.call(this);
    return x && x.type === 'answer' ? { type: x.type, sdp: x.sdp.split('\\r\\n').filter((l) => !l.startsWith('a=candidate:')).join('\\r\\n') } : x;
  } });
  return true;
})()`;

// Runs in the client page: for every frame the <video> presents, read the row of cells.
const PROBE = `(() => {
  const o = __O__;
  const v = mainView.panes[0].video;
  const R = (window.__bench = { rows: [], bad: 0, calls: 0, err: '', how: '', dbg: [], geo: '' });
  const even = (x) => Math.max(0, Math.floor(x / 2) * 2);
  // lum(i) = brightness (0..765) of cell i
  const decode = (lum, n, now, md) => {
    const hi = (lum(0) + lum(n - 1)) / 2, lo = (lum(1) + lum(n - 2)) / 2;
    if (hi - lo < 240) { R.bad++; if (R.dbg.length < 3) { const a = []; for (let i = 0; i < n; i++) a.push(lum(i)); R.dbg.push(a.join(',')); } return; }
    const mid = (hi + lo) / 2;
    let val = 0;
    for (let i = 2; i < n - 2; i++) val = val * 2 + (lum(i) > mid ? 1 : 0);
    const T = performance.timeOrigin - o.t0;
    R.rows.push([T + now, T + md.expectedDisplayTime, md.receiveTime ? T + md.receiveTime : 0, md.processingDuration || 0, md.presentedFrames, Math.floor(val / 2 ** 30), Math.floor(val / 2 ** 20) % 1024, val % 2 ** 20]);
  };
  // Reading must not hold up the page: a slow read makes the next callback late and frames go by unread.
  // So take the frame and copy two rows of it asynchronously; fall back to a canvas if that is not possible.
  let cv = null, g = null;
  const cb = (now, md) => {
    v.requestVideoFrameCallback(cb);
    R.calls++;
    try {
      const f = new VideoFrame(v);
      const k = f.codedWidth / o.monW, cell = o.cell * k, n = o.cells;
      const rect = { x: even(o.x * k), y: even(o.y * k + cell / 2), width: even(Math.ceil(cell * n) + 1), height: 2 };
      // Some decoders' frames copy out wrong (seen with hardware AV1): after a run of unreadable frames, use the canvas.
      if (R.bad > 20 && !R.rows.length) R.canvas = true;
      const fmt = R.canvas ? null : f.format, planar = !!fmt && !/^(RGB|BGR)/.test(fmt);
      if (!R.geo) R.geo = fmt + ' coded ' + f.codedWidth + 'x' + f.codedHeight + ', visible ' + JSON.stringify(f.visibleRect) + ', video ' + v.videoWidth + 'x' + v.videoHeight + ', rect ' + JSON.stringify(rect);
      if (fmt) {
        const buf = new Uint8Array(f.allocationSize({ rect }));
        f.copyTo(buf, { rect }).then((layout) => {
          f.close();
          const off = layout[0].offset, px = planar ? 1 : 4;
          decode((i) => { const p = off + Math.min(rect.width - 1, Math.floor((i + 0.5) * cell)) * px; return planar ? buf[p] * 3 : buf[p] + buf[p + 1] + buf[p + 2]; }, n, now, md);
          R.how = 'frame ' + fmt;
        }).catch((e) => { try { f.close(); } catch {} R.err = String(e); });
        return;
      }
      f.close();
      if (!cv) { cv = document.createElement('canvas'); g = cv.getContext('2d', { willReadFrequently: true }); }
      const w = rect.width;
      if (cv.width !== w) { cv.width = w; cv.height = 1; }
      g.drawImage(v, rect.x, rect.y, w, 1, 0, 0, w, 1);
      const d = g.getImageData(0, 0, w, 1).data;
      decode((i) => { const p = Math.min(w - 1, Math.floor((i + 0.5) * cell)) * 4; return d[p] + d[p + 1] + d[p + 2]; }, n, now, md);
      R.how = 'canvas';
    } catch (e) { R.err = String(e); }
  };
  v.requestVideoFrameCallback(cb);
  return true;
})()`;

const CLIENT_STATS = `(async () => {
  const rep = await pc.getStats(), mid = monitors[__MON__].mid;
  let o = null, pair = null;
  rep.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video' && r.mid === mid) o = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  return o && {
    framesReceived: o.framesReceived, framesDecoded: o.framesDecoded, framesDropped: o.framesDropped, keyFramesDecoded: o.keyFramesDecoded,
    jitterBufferDelay: o.jitterBufferDelay, jitterBufferEmittedCount: o.jitterBufferEmittedCount, jitterBufferTargetDelay: o.jitterBufferTargetDelay, jitterBufferMinimumDelay: o.jitterBufferMinimumDelay,
    totalDecodeTime: o.totalDecodeTime, totalProcessingDelay: o.totalProcessingDelay, totalAssemblyTime: o.totalAssemblyTime,
    freezeCount: o.freezeCount, totalFreezesDuration: o.totalFreezesDuration, packetsLost: o.packetsLost, packetsReceived: o.packetsReceived,
    nackCount: o.nackCount, pliCount: o.pliCount, bytesReceived: o.bytesReceived, decoder: o.decoderImplementation, w: o.frameWidth, h: o.frameHeight,
    rtt: pair ? pair.currentRoundTripTime : null,
  };
})()`;

const quant = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const dist = (a) => ({ n: a.length, p50: r1(quant(a, 0.5)), p95: r1(quant(a, 0.95)), max: r1(a.length ? Math.max(...a) : null) });

function analyze({ rows, drawn, started, hs, cs0, cs1, m0, m1, offP, offC, mon }) {
  // `drawn` is on the picture renderer's clock, `rows` on the client renderer's; bring both to this process's clock.
  const info = new Map(), burstStart = new Map();
  for (const [t, ph, cyc] of drawn) {
    const at = t - offP.off;
    info.set(t, { ph, cyc, at });
    if (ph === 1 && !burstStart.has(cyc)) burstStart.set(cyc, at);
  }
  rows.sort((a, b) => a[4] - b[4]); // readings finish out of order
  const seen = new Map();
  let unmatched = 0;
  for (const r of rows) {
    const e = info.get(r[7]);
    if (!e) { unmatched++; continue; }
    if (!seen.has(r[7])) seen.set(r[7], { e, disp: r[1] - offC.off, recv: r[2] ? r[2] - offC.off : null, proc: r[3], pres: r[4] });
  }
  // Frames the <video> presented between two readings were on screen but not read by the probe.
  let unread = 0;
  for (let i = 1; i < rows.length; i++) unread += Math.max(0, rows[i][4] - rows[i - 1][4] - 1);
  const inWin = (at) => at >= m0 && at <= m1 - 1000; // the last second is left out so late frames still count as arrived
  const out = { probe: { frames: rows.length, unmatched, unread } };

  // scroll: smoothness and delay while the whole picture moves
  {
    const frames = drawn.filter(([t, ph]) => ph === 1 && inWin(info.get(t).at)).map(([t]) => t);
    const byBurst = new Map();
    for (const t of frames) { const cyc = info.get(t).cyc; if (!byBurst.has(cyc)) byBurst.set(cyc, []); byBurst.get(cyc).push(t); }
    let secs = 0, presented = 0, presentedSecs = 0;
    const lat = [], head = [], tail = [], toRecv = [], clientSide = [], gaps = [];
    for (const [cyc, list] of byBurst) {
      if (list.length < 2) continue;
      secs += (info.get(list[list.length - 1]).at - info.get(list[0]).at) / 1000 * (list.length / (list.length - 1));
      // Frames the <video> put on screen during this burst, whether or not the probe read each one.
      const got = list.map((t) => seen.get(t)).filter(Boolean);
      if (got.length > 1) { presented += got[got.length - 1].pres - got[0].pres; presentedSecs += (got[got.length - 1].disp - got[0].disp) / 1000; }
      let prev = null;
      for (const t of list) {
        const s = seen.get(t);
        if (!s) continue;
        const l = s.disp - s.e.at;
        lat.push(l);
        (s.e.at - burstStart.get(cyc) < 500 ? head : tail).push(l);
        if (s.recv != null) { toRecv.push(s.recv - s.e.at); clientSide.push(s.disp - s.recv); }
        if (prev != null) gaps.push(s.disp - prev);
        prev = s.disp;
      }
    }
    const shown = frames.filter((t) => seen.has(t)).length;
    out.scroll = {
      drawn: frames.length, shown, drawnFps: r1(secs ? frames.length / secs : 0), readFps: r1(secs ? shown / secs : 0), shownFps: r1(presentedSecs ? presented / presentedSecs : 0),
      lat: dist(lat), latHead: dist(head), latTail: dist(tail), toRecv: dist(toRecv), clientSide: dist(clientSide),
      gap: { ...dist(gaps), over25: gaps.filter((x) => x > 25).length, over50: gaps.filter((x) => x > 50).length, over100: gaps.filter((x) => x > 100).length },
    };
  }
  // sparse: how long one small change on a still screen takes to appear
  {
    const events = drawn.filter(([t, ph]) => ph === 0 && inWin(info.get(t).at)).map(([t]) => t);
    const lat = [], toRecv = [], clientSide = [];
    for (const t of events) {
      const s = seen.get(t);
      if (!s) continue;
      lat.push(s.disp - s.e.at);
      if (s.recv != null) { toRecv.push(s.recv - s.e.at); clientSide.push(s.disp - s.recv); }
    }
    out.sparse = { events: events.length, missed: events.length - lat.length, lat: dist(lat), toRecv: dist(toRecv), clientSide: dist(clientSide) };
  }
  // host: what the encoder and the bandwidth estimate did, overall and during scrolling only
  {
    const list = hs.filter((h) => h && h.mons && h.mons[mon]);
    const per = P.sparse + P.scroll;
    const scrolling = (t) => { const el = t - C.t0 - (started - offP.off); return el >= 0 && el % per >= P.sparse; };
    const sum = (pairs) => {
      const a = { dt: 0, src: 0, enc: 0, bytes: 0, qp: 0, encT: 0, pkt: 0, pace: 0, key: 0, huge: 0 };
      for (const [x, y] of pairs) {
        const p = x.mons[mon], n = y.mons[mon];
        a.dt += (y.t - x.t) / 1000; a.src += n.srcFrames - p.srcFrames; a.enc += n.framesEncoded - p.framesEncoded; a.bytes += n.bytesSent - p.bytesSent;
        a.qp += n.qpSum - p.qpSum; a.encT += n.totalEncodeTime - p.totalEncodeTime; a.pkt += n.packetsSent - p.packetsSent; a.pace += n.totalPacketSendDelay - p.totalPacketSendDelay;
        a.key += n.keyFramesEncoded - p.keyFramesEncoded; a.huge += n.hugeFramesSent - p.hugeFramesSent;
      }
      return a.dt ? { captureFps: r1(a.src / a.dt), encodeFps: r1(a.enc / a.dt), mbps: r1(a.bytes * 8 / a.dt / 1e6), qp: r1(a.enc ? a.qp / a.enc : null), encodeMs: r1(a.enc ? a.encT / a.enc * 1000 : null), pacerMs: r1(a.pkt ? a.pace / a.pkt * 1000 : null), keyFrames: a.key, hugeFrames: a.huge } : null;
    };
    const pairs = list.slice(1).map((y, i) => [list[i], y]);
    // Per half second: [seconds, scrolling, capture fps, encode fps, Mbps, QP, frames the capture side discarded]
    out.timeline = pairs.map(([x, y]) => {
      const a = sum([[x, y]]) || {};
      return [r1((y.t - list[0].t) / 1000), scrolling(x.t) && scrolling(y.t) ? 1 : scrolling(x.t) || scrolling(y.t) ? 0.5 : 0, a.captureFps, a.encodeFps, a.mbps, a.qp,
        y.mons[mon].discarded != null ? y.mons[mon].discarded - x.mons[mon].discarded : null];
    });
    const first = list[0], lastS = list[list.length - 1];
    const avail = list.map((h) => (h.avail || 0) / 1e6);
    const lim = (k) => (lastS && first ? r1(((lastS.mons[mon].limitDur || {})[k] || 0) - ((first.mons[mon].limitDur || {})[k] || 0)) : null);
    out.host = {
      all: sum(pairs), scroll: sum(pairs.filter(([x, y]) => scrolling(x.t) && scrolling(y.t))), sparse: sum(pairs.filter(([x, y]) => !scrolling(x.t) && !scrolling(y.t))),
      encoder: lastS ? lastS.mons[mon].impl : '', codec: lastS ? lastS.mons[mon].codec : '', res: lastS ? lastS.mons[mon].w + 'x' + lastS.mons[mon].h : '',
      bwe: { min: r1(Math.min(...avail)), p50: r1(quant(avail, 0.5)), max: r1(Math.max(...avail)), series: avail.map(r1) },
      targetMbps: r1(quant(list.map((h) => (h.mons[mon].targetBitrate || 0) / 1e6), 0.5)),
      limitedSecs: { cpu: lim('cpu'), bandwidth: lim('bandwidth'), other: lim('other') },
      rttMs: r1(quant(list.map((h) => (h.rtt || 0) * 1000), 0.5)),
    };
  }
  // client: receive side
  if (cs0 && cs1) {
    const d = (k) => cs1[k] - cs0[k], fr = d('framesDecoded');
    out.client = {
      jitterBufferMs: r1(d('jitterBufferEmittedCount') ? d('jitterBufferDelay') / d('jitterBufferEmittedCount') * 1000 : null),
      jitterTargetMs: r1(d('jitterBufferEmittedCount') ? d('jitterBufferTargetDelay') / d('jitterBufferEmittedCount') * 1000 : null),
      decodeMs: r1(fr ? d('totalDecodeTime') / fr * 1000 : null), processingMs: r1(fr ? d('totalProcessingDelay') / fr * 1000 : null),
      decoded: fr, dropped: d('framesDropped'), freezes: d('freezeCount'), freezeSecs: r1(d('totalFreezesDuration')), lost: d('packetsLost'), packets: d('packetsReceived'),
      nack: d('nackCount'), pli: d('pliCount'), keyFrames: d('keyFramesDecoded'), decoder: cs1.decoder, res: cs1.w + 'x' + cs1.h, rttMs: cs1.rtt != null ? r1(cs1.rtt * 1000) : null,
    };
  }
  return out;
}

async function run() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  // Stay out of the way: prefer a display the pointer is not on, and not the primary one.
  const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id, prim = screen.getPrimaryDisplay().id;
  const score = (i) => (displays[i].id !== cur ? 2 : 0) + (displays[i].id !== prim ? 1 : 0);
  let di = Number.isInteger(B.display) && displays[B.display] ? B.display : displays.map((_, i) => i).sort((a, b) => score(b) - score(a) || b - a)[0];
  const d = displays[di], phys = screen.dipToScreenRect(null, d.bounds);
  const pw = Math.min(P.w, d.bounds.width), ph = Math.min(P.h, d.bounds.height);
  const mk = (o) => {
    const w = new BrowserWindow({ frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, show: false, ...o, webPreferences: { backgroundThrottling: false } });
    w.setAlwaysOnTop(true, 'screen-saver');
    return w;
  };
  const pat = mk({ x: d.bounds.x, y: d.bounds.y, width: pw, height: ph });
  await pat.loadFile(path.join(__dirname, 'bench-pattern.html'), { query: { t0: String(C.t0), sparse: String(P.sparse), scroll: String(P.scroll), speed: String(P.speed), every: String(P.every), cell: String(P.cell) } });
  pat.showInactive();

  // The client window: small, in a corner of another display. On the captured display it would
  // feed back: every frame it presents counts as a screen change there, so a still screen would
  // never be still for the capturer. (With a single display that cannot be avoided.)
  const CW = 320, CH = 200;
  const cd = displays.find((x) => x.id !== d.id && x.id !== cur) || displays.find((x) => x.id !== d.id) || d;
  const cw = mk({ x: cd.bounds.x + cd.bounds.width - CW, y: cd.bounds.y + cd.bounds.height - CH, width: CW, height: CH });
  cw.webContents.on('console-message', (_e, _l, m) => {
    if (String(m).startsWith('BENCH-TARGET ')) ctl('/target', JSON.parse(String(m).slice(13))).catch(() => {});
  });
  await cw.loadFile(C.clientFile, { hash: 'k=' + C.key + '&ro' });
  cw.showInactive();
  const js = (code) => cw.webContents.executeJavaScript(code);
  if (C.proxyPort) await js(MUNGE.replace('__PORT__', String(C.proxyPort)));
  if (B.clientJs) await js(B.clientJs + '\n;0');
  await js(`mode = ${JSON.stringify(B.mode === 'smooth' ? 'smooth' : 'sharp')}; codec = ${JSON.stringify(B.codec || '')}; connect(); 1`);

  const until = async (code, secs) => {
    for (let i = 0; i < secs * 4; i++) { await sleep(250); try { if (await js(code)) return true; } catch {} }
    return false;
  };
  if (!(await until(`window.__rd.state === 'connected' && window.__rd.frames > 30`, 45))) throw new Error('the client did not connect: ' + (await js('window.__rd.state')));
  const mon = di; // the host lists its monitors left to right, like `displays`
  await js(`setSel(mainView, ${mon}); setFit(mainView, '1:1'); 1`);
  if (!(await until(`Number(String(window.__rd.res[${mon}]).split('x')[0]) === ${phys.width}`, 25))) throw new Error('full resolution was not reached: ' + (await js('JSON.stringify(window.__rd.res)')));
  if (B.clientJsConnected) await js(B.clientJsConnected + '\n;0');
  await js(PROBE.replace('__O__', JSON.stringify({
    x: (pat.getBounds().x - d.bounds.x) * d.scaleFactor, y: (pat.getBounds().y - d.bounds.y) * d.scaleFactor,
    cell: Math.round(P.cell * d.scaleFactor), cells: 36, monW: phys.width, t0: C.t0,
  })));

  const clockOffset = async (wc) => {
    let best = null;
    for (let i = 0; i < 25; i++) {
      const a = epoch(), r = await wc.executeJavaScript('performance.timeOrigin + performance.now()'), b = epoch();
      if (!best || b - a < best.rt) best = { rt: b - a, off: r - (a + b) / 2 };
    }
    return best;
  };
  await sleep(B.warmup * 1000);
  const offP = await clockOffset(pat.webContents), offC = await clockOffset(cw.webContents);
  const stats = CLIENT_STATS.replace('__MON__', String(mon));
  const cs0 = await js(stats);
  const hs = [await ctl('/hoststats')];
  await ctl('/cpu'); app.getAppMetrics(); // start of the CPU measurement on both sides
  const m0 = epoch() - C.t0;
  while (epoch() - C.t0 - m0 < B.secs * 1000) { await sleep(500); hs.push(await ctl('/hoststats')); }
  const m1 = epoch() - C.t0;
  const cs1 = await js(stats);
  const rows = await js('window.__bench.rows');
  const probe = await js('({ bad: window.__bench.bad, calls: window.__bench.calls, err: window.__bench.err, how: window.__bench.how, dbg: window.__bench.dbg, geo: window.__bench.geo })');
  const cpuOf = (list) => Math.round(list.reduce((a, p) => a + p.cpu.percentCPUUsage, 0) * 10) / 10;
  const cpu = { host: await ctl('/cpu'), client: cpuOf(app.getAppMetrics()) };
  if (B.snapshot) {
    // What the client actually shows: the picture's top-left part, once mid-scroll and once after 2.5 s of stillness.
    const phase = () => pat.webContents.executeJavaScript('window.__pat.drawn[window.__pat.drawn.length - 1][1]');
    const shot = async (name) => {
      const url = await js(`(() => { const c = document.createElement('canvas'); c.width = 960; c.height = 300; c.getContext('2d').drawImage(mainView.panes[0].video, 0, 0, 960, 300, 0, 0, 960, 300); return c.toDataURL('image/png'); })()`);
      fs.writeFileSync(B.snapshot + '.' + name + '.png', Buffer.from(url.split(',')[1], 'base64'));
    };
    for (let i = 0; i < 200 && (await phase()) !== 0; i++) await sleep(50);
    for (let i = 0; i < 200 && (await phase()) !== 1; i++) await sleep(50);
    await sleep(1500); await shot('scroll');
    for (let i = 0; i < 200 && (await phase()) !== 0; i++) await sleep(50);
    await sleep(2500); await shot('still');
  }
  const pinfo = await pat.webContents.executeJavaScript('({ drawn: window.__pat.drawn, started: window.__pat.started, raf: window.__pat.raf, w: window.__pat.w, h: window.__pat.h })');
  const res = analyze({ rows, drawn: pinfo.drawn, started: pinfo.started, hs, cs0, cs1, m0, m1, offP, offC, mon });
  Object.assign(res.probe, probe);
  res.cpu = cpu; // percent of the whole machine (all cores), over the measured window, both including the picture window's process share
  res.setup = {
    display: di + 1, monitor: phys.width + 'x' + phys.height, picture: pinfo.w + 'x' + pinfo.h, clientWindowOnDisplay: displays.indexOf(cd) + 1,
    clockUncertaintyMs: r1((offP.rt + offC.rt) / 2), clockOffsetMs: r1(offC.off - offP.off),
  };
  return res;
}

app.whenReady().then(async () => {
  const out = { ok: false };
  try { Object.assign(out, await run()); out.ok = true; } catch (e) { out.error = String((e && e.stack) || e); }
  try { await ctl('/done', out); } catch {}
  app.exit(0);
});
