// `electron . --bench --bench-config=<file.json>`: measures what a user would feel, on this PC only.
//
// A test picture (bench-pattern.html) is shown on one display. The real host captures and sends
// it, the real client page (in a second Electron process, bench-peer.js) receives and shows it,
// and every frame the client shows is matched to the picture frame it carries. That gives:
//   - scroll: frames shown per second, delay from "drawn on the host" to "on the client's screen",
//     and the gaps between shown frames (stutter), while the whole picture moves
//   - sparse: the delay of one small change on an otherwise still screen (typing, clicking)
// With `net`, the WebRTC traffic goes through a link emulator (netem.js) with a chosen delay,
// jitter, loss and bandwidth, so a home connection can be imitated without leaving this PC.
//
// Like --selftest it is isolated: local relay, no STUN, throwaway key and profile, view-only
// client, no input injected, nothing sent to the internet. It does show windows on one display
// (the picture and a small client window) for the length of the run; they never take focus.
//
// Config (all optional): { name, secs, warmup, mode, codec, display, out,
//   pattern: { w, h, sparse, scroll, speed, every },      picture size and phase lengths (ms)
//   net: { delay, jitter, loss, rate, queue, toClient: {...}, toHost: {...} },
//   cfg: { ...host config overrides }, trials, switches, disableFeatures,     host process
//   peerTrials, peerSwitches, hostJs, clientJs, clientJsConnected }
//
// The delay includes the picture's own way to the host's screen (about one to two refresh
// intervals) - the same in every run, so runs can be compared, but subtract it for an absolute figure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_STATS = `(async () => {
  const s = session;
  if (!s || !s.mids) return null;
  const rep = await s.pc.getStats();
  const out = { t: performance.timeOrigin + performance.now(), mons: {} };
  rep.forEach((r) => {
    if (r.type === 'outbound-rtp' && r.kind === 'video') {
      const idx = s.mids.indexOf(r.mid), src = r.mediaSourceId && rep.get(r.mediaSourceId), codec = r.codecId && rep.get(r.codecId);
      if (idx < 0) return;
      let ts = null;
      try { ts = s.videoSenders[idx].track.stats; } catch {}
      out.mons[idx] = {
        discarded: ts ? ts.discardedFrames : null, delivered: ts ? ts.deliveredFrames : null, total: ts ? ts.totalFrames : null,
        active: r.active, contentType: r.contentType || '', framesEncoded: r.framesEncoded || 0, framesSent: r.framesSent || 0, keyFramesEncoded: r.keyFramesEncoded || 0, bytesSent: r.bytesSent || 0,
        qpSum: r.qpSum || 0, totalEncodeTime: r.totalEncodeTime || 0, totalPacketSendDelay: r.totalPacketSendDelay || 0, packetsSent: r.packetsSent || 0,
        hugeFramesSent: r.hugeFramesSent || 0, targetBitrate: r.targetBitrate || 0, w: r.frameWidth || 0, h: r.frameHeight || 0,
        limit: r.qualityLimitationReason, limitDur: r.qualityLimitationDurations, impl: r.encoderImplementation || '', codec: codec ? codec.mimeType.replace('video/', '') : '',
        srcFrames: src ? src.frames || 0 : 0,
      };
    }
    const pair = r.type === 'transport' && r.selectedCandidatePairId ? rep.get(r.selectedCandidatePairId) : null;
    if (pair) { out.avail = pair.availableOutgoingBitrate || 0; out.rtt = pair.currentRoundTripTime || 0; }
  });
  return out;
})()`;

// Runs in the host page: reads the frames of one monitor's capture as they arrive from the
// capturer (a second reader next to the encoder) and notes which picture frame each one is.
// That gives the part of the delay that passes before encoding starts.
const CAP_PROBE = `(() => {
  const o = __O__;
  const track = session.streams[o.mon].getVideoTracks()[0].clone();
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const R = (window.__cap = { rows: [], bad: 0, n: 0, fmt: '', err: '' });
  const even = (x) => Math.max(0, Math.floor(x / 2) * 2);
  const T = performance.timeOrigin - o.t0;
  (async () => {
    for (;;) {
      const { value: f, done } = await reader.read();
      if (done) break;
      const at = performance.now();
      R.n++;
      try {
        const k = f.codedWidth / o.monW, cell = o.cell * k, n = o.cells;
        const rect = { x: even(o.x * k), y: even(o.y * k + cell / 2), width: even(Math.ceil(cell * n) + 1), height: 2 };
        const fmt = f.format || '', planar = !/^(RGB|BGR)/.test(fmt);
        const buf = new Uint8Array(f.allocationSize({ rect })), layout = await f.copyTo(buf, { rect });
        R.fmt = fmt;
        const off = layout[0].offset, px = planar ? 1 : 4;
        const lum = (i) => { const q = off + Math.min(rect.width - 1, Math.floor((i + 0.5) * cell)) * px; return planar ? buf[q] * 3 : buf[q] + buf[q + 1] + buf[q + 2]; };
        const hi = (lum(0) + lum(n - 1)) / 2, lo = (lum(1) + lum(n - 2)) / 2;
        if (hi - lo < 240) R.bad++;
        else {
          const mid = (hi + lo) / 2;
          let val = 0;
          for (let i = 2; i < n - 2; i++) val = val * 2 + (lum(i) > mid ? 1 : 0);
          R.rows.push([T + at, val % 2 ** 20]);
        }
      } catch (e) { R.err = String(e); }
      f.close();
    }
  })();
  return true;
})()`;

function startLink(net) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'netem.js'), JSON.stringify(net)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    child.once('error', reject);
    child.once('exit', (c) => reject(new Error('link emulator exited with code ' + c)));
    child.once('message', (m) => resolve({
      port: m.port,
      setTarget: (t) => { try { child.send({ target: t }); } catch {} },
      stats: () => new Promise((res) => {
        const timer = setTimeout(() => res(null), 2000);
        child.once('message', (x) => { clearTimeout(timer); res(x.stats); });
        try { child.send({ stats: true }); } catch { res(null); }
      }),
      stop: () => { try { child.kill(); } catch {} },
    }));
  });
}

// One result as a few lines of text.
function format(r) {
  const L = [];
  const d = (x) => (x && x.n ? `${x.p50}/${x.p95}/${x.max}` : '-');
  L.push(`${r.name}: ${r.ok ? '' : 'FAILED - ' + String(r.error).split('\n')[0]}`);
  if (!r.ok) return L;
  const h = r.host, s = r.scroll, sp = r.sparse, c = r.client || {}, q = r.quality;
  L.push(`  setup    ${r.captureKind || ''} ${h.codec} ${h.encoder} ${h.res}, picture ${r.setup.picture} on display ${r.setup.display} (${r.setup.monitor}), link ${r.config.net ? JSON.stringify(r.config.net) : 'direct'}`);
  if (s.lat.n) L.push(`  scroll   shown ${s.shownFps} of ${s.drawnFps} fps drawn | delay ms p50/p95/max ${d(s.lat)} (first 0.5 s ${d(s.latHead)}) | gaps >25/>50/>100 ms: ${s.gap.over25}/${s.gap.over50}/${s.gap.over100}, longest ${s.gap.max} ms`);
  if (sp.events) L.push(`  sparse   delay ms p50/p95/max ${d(sp.lat)} over ${sp.events} changes, ${sp.missed} never shown`);
  if (s.lat.n || sp.events) L.push(`  where    until received p50 ${s.toRecv.p50} ms (scroll) ${sp.toRecv.p50} ms (sparse) | received to screen p50 ${s.clientSide.p50} / ${sp.clientSide.p50} ms | jitter buffer ${c.jitterBufferMs} ms, decode ${c.decodeMs} ms, sound packets ${c.audioPackets}`);
  if (r.capture) L.push(`  split    drawn to "frame reaches the encoder" p50/p95: scroll ${r.capture.scroll.p50}/${r.capture.scroll.p95} ms, typing ${r.capture.sparse.p50}/${r.capture.sparse.p95} ms (${r.capture.fps} frames/s, ${r.capture.fmt}) | from there until received: scroll ${r.capture.restScroll} ms, typing ${r.capture.restSparse} ms`);
  if (r.native) {
    const n = r.native, pp = (x) => (x && x.n ? x.p50 + '/' + x.p95 : '-');
    L.push(`  native   on the host's own screen ${pp(n.toScreen.scroll)} ms after it is drawn (typing ${pp(n.toScreen.sparse)}) | a native capturer has the frame ${pp(n.handed.scroll)} ms after that (p50/p95), ${n.scrollFps} frames/s of ${r.scroll.drawnFps} drawn | the capturer in use hands it to the encoder ${pp(n.chromium.scroll)} ms after the screen (typing ${pp(n.chromium.sparse)})`);
    L.push(`  behind   the client shows it this long after the host's own screen, p50/p95: scroll ${pp(n.remote.scroll)} ms, typing ${pp(n.remote.sparse)} ms`);
  }
  if (q && q.open) L.push(`  open     new picture first shown after ${q.open.firstMs} ms at ${q.open.firstDb} dB | dB at 150/300/500/1000/2000 ms: ${Object.values(q.open.at).map((x) => (x == null ? '-' : x)).join('/')} | settles at ${q.open.finalDb} dB | good (36 dB) after ${q.open.goodMs} ms, settled after ${q.open.settledMs} ms (${q.open.events} changes)`);
  if (q && (q.drag || q.scroll)) L.push(`  moving   dB p10/p50: drag ${q.drag ? q.drag.p10 + '/' + q.drag.p50 : '-'}, scroll ${q.scroll ? q.scroll.p10 + '/' + q.scroll.p50 : '-'}   (30 = soft but readable, 35 = good, 40+ = like the original)`);
  for (const type of Object.keys(h).filter((k) => ['scroll', 'sparse', 'open', 'drag'].includes(k) && h[k])) {
    const x = h[type];
    L.push(`  host     ${type}: capture ${x.captureFps} fps, encode ${x.encodeFps} fps, ${x.mbps} Mbps, QP ${x.qp}, encode ${x.encodeMs} ms, pacer ${x.pacerMs} ms`);
  }
  if (r.setup.remote) L.push(`  client   on another machine (${r.setup.remote.threads} threads, video decode ${r.setup.remote.gpu.split('/')[0]}, compositing ${r.setup.remote.gpu.split('/')[1]}); clocks matched to within ${r.setup.clockUncertaintyMs} ms`);
  if (r.cpu) L.push(`  cpu      host ${r.cpu.host}% of the machine, client side ${r.cpu.client}%${r.setup.remote ? ' of the other machine' : ' (includes drawing the test picture)'}`);
  L.push(`  network  estimate min/median/max ${h.bwe.min}/${h.bwe.p50}/${h.bwe.max} Mbps, target ${h.targetMbps} Mbps, rtt ${h.rttMs} ms, limited by cpu ${h.limitedSecs.cpu}s bandwidth ${h.limitedSecs.bandwidth}s | client lost ${c.lost}/${c.packets}, nack ${c.nack}, pli ${c.pli}, dropped ${c.dropped}, freezes ${c.freezes}`);
  if (r.link) L.push(`  emulator to client: ${r.link.toClient.packets} packets, ${r.link.toClient.lost} lost, ${r.link.toClient.overflow} over the queue, longest wait ${Math.round(r.link.toClient.maxQueueMs)} ms | timer ${r.link.tickAvgMs.toFixed(2)} ms avg, ${r.link.tickWorstMs.toFixed(1)} ms worst`);
  if (r.probe.bad || r.probe.unmatched || r.probe.unread || r.probe.err) L.push(`  note     of ${r.probe.frames} frames read: unreadable ${r.probe.bad}, unmatched ${r.probe.unmatched}; shown but not read by the probe ${r.probe.unread}${r.probe.err ? ', error ' + r.probe.err : ''}`);
  return L;
}
exports.format = format;

exports.run = async ({ cfg, bench, buildClientHtml, app }) => {
  const { BrowserWindow } = require('electron');
  const B = { name: 'run', secs: 24, warmup: 6, mode: 'sharp', codec: '', net: null, ...bench };
  const P = { w: 1280, h: 720, sparse: 4000, scroll: 4000, speed: 24, every: 500, cell: 20, ...(bench.pattern || {}) };
  if (!P.phases) P.phases = [{ type: 'sparse', ms: P.sparse }, { type: 'scroll', ms: P.scroll }];
  P.phases = P.phases.filter((x) => x.ms > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-bench-'));
  const hostWin = BrowserWindow.getAllWindows()[0];
  let link = null, peer = null, done = false;

  const finish = async (res) => {
    if (done) return;
    done = true;
    const result = { name: B.name, config: B, ...res };
    try { result.captureKind = await hostWin.webContents.executeJavaScript(`session && session.native ? 'native capture,' : 'engine capture,'`); } catch {}
    try { if (link) result.link = await link.stats(); } catch {}
    try { if (B.out) fs.writeFileSync(B.out, JSON.stringify(result, null, 1)); } catch (e) { console.log('[bench] could not write the result file: ' + e.message); }
    for (const l of format(result)) console.log('[bench] ' + l);
    try { if (peer) peer.kill(); } catch {}
    if (link) link.stop();
    // End the session properly, so the engine writes its end-of-stream summary when logging is on.
    try { await hostWin.webContents.executeJavaScript(`teardown('bench end'); 0`); await sleep(800); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    app.exit(result.ok ? 0 : 1);
  };

  try {
    if (B.net) link = await startLink(B.net);
    const srv = http.createServer(async (req, res) => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      try {
        if (req.url === '/hoststats') return send(await hostWin.webContents.executeJavaScript(HOST_STATS));
        // CPU used by this host's processes since the previous call, as a percentage of the whole machine.
        if (req.url === '/cpu') return send(Math.round(app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0) * 10) / 10);
        let body = '';
        for await (const c of req) body += c;
        const m = body ? JSON.parse(body) : null;
        if (req.url === '/target') { if (link && m) link.setTarget(m); return send({}); }
        if (req.url === '/capprobe') return send(await hostWin.webContents.executeJavaScript(CAP_PROBE.replace('__O__', JSON.stringify(m))));
        if (req.url === '/caprows') return send(await hostWin.webContents.executeJavaScript('window.__cap || null'));
        if (req.url === '/hostnow') return send(await hostWin.webContents.executeJavaScript('performance.timeOrigin + performance.now()'));
        if (req.url === '/done') { send({}); return finish(m || { ok: false, error: 'empty result' }); }
        res.writeHead(404); res.end();
      } catch (e) { try { res.writeHead(500); res.end(String(e)); } catch {} }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await sleep(2500); // let the host subscribe first
    if (B.hostJs) await hostWin.webContents.executeJavaScript(B.hostJs + '\n;0');

    const clientFile = path.join(dir, 'client.html'), peerFile = path.join(dir, 'peer.json');
    fs.writeFileSync(clientFile, buildClientHtml());
    // The key in this file is the throwaway one of this isolated run.
    fs.writeFileSync(peerFile, JSON.stringify({ ctl: 'http://127.0.0.1:' + srv.address().port, key: cfg.key, server: cfg.server, clientFile, proxyPort: link ? link.port : 0, t0: Date.now(), bench: B, pattern: P }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // A syntax error in the peer script would otherwise show up as an error dialog on the screen.
    new (require('vm').Script)(fs.readFileSync(path.join(__dirname, 'bench-peer.js'), 'utf8'), { filename: 'bench-peer.js' });
    peer = spawn(process.execPath, [path.join(__dirname, 'bench-peer.js'), peerFile], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    peer.once('exit', (c) => setTimeout(() => finish({ ok: false, error: 'the client process ended (code ' + c + ') without a result' }), 1000));
    setTimeout(() => finish({ ok: false, error: 'timed out' }), (B.warmup + B.secs + 100) * 1000);
  } catch (e) {
    finish({ ok: false, error: String((e && e.stack) || e) });
  }
};
