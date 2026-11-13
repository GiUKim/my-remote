// The client side of the bench (see bench.js), as its own Electron process, so the client's
// decoding and drawing do not share a GPU process with the host's capture and encoding - a
// client on another PC would not share one either.
//
// It shows the test picture on one display of this PC, connects the real client page to the
// bench host, records for every frame the client shows which picture frame it was and when it
// reached the screen, and reports the result to the host process.
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { performance } = require('perf_hooks');

const C = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const B = C.bench, P = C.pattern;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-peer-'));
app.setPath('userData', profile);
require('./profile-cleanup').watch(profile); // removed once this process has ended
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

// Runs in the client page: for every frame the <video> presents, read the row of cells, and for
// some frames keep the brightness of a rectangle of the picture to compare with what was drawn.
const PROBE = `(() => {
  const o = __O__;
  const v = mainView.panes[0].video;
  const R = (window.__bench = { rows: [], crops: [], bad: 0, calls: 0, err: '', how: '', dbg: [], geo: '', canvas: false });
  const even = (x) => Math.max(0, Math.floor(x / 2) * 2);
  const T = performance.timeOrigin - o.t0;
  // lum(i) = brightness (0..765) of cell i. Returns [phase, time code] of the frame, or null.
  const decode = (lum, n, now, md) => {
    const hi = (lum(0) + lum(n - 1)) / 2, lo = (lum(1) + lum(n - 2)) / 2;
    if (hi - lo < 240) { R.bad++; if (R.dbg.length < 3) { const a = []; for (let i = 0; i < n; i++) a.push(lum(i)); R.dbg.push(a.join(',')); } return null; }
    const mid = (hi + lo) / 2;
    let val = 0;
    for (let i = 2; i < n - 2; i++) val = val * 2 + (lum(i) > mid ? 1 : 0);
    const ph = Math.floor(val / 2 ** 30), t = val % 2 ** 20;
    R.rows.push([T + now, T + md.expectedDisplayTime, md.receiveTime ? T + md.receiveTime : 0, md.processingDuration || 0, md.presentedFrames, ph, Math.floor(val / 2 ** 20) % 1024, t]);
    return [ph, t];
  };
  // Which frames to keep a piece of: after the whole picture changed (phase 2) every frame at first,
  // while things move (phases 1 and 3) one in eight.
  let openT = -1, openN = 0, moveN = 0;
  const wanted = (ph, t) => {
    if (!o.crop || R.crops.length >= 420) return false;
    if (ph === 2) { if (t !== openT) { openT = t; openN = 0; } openN++; return openN <= 90 || openN % 6 === 0; }
    if (ph === 1 || ph === 3) return ++moveN % 8 === 0;
    return false;
  };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
  const keep = (id, md, w, h, lum) => R.crops.push([id[1], id[0], T + md.expectedDisplayTime, w, h, b64(lum)]);
  // Reading must not hold up the page: a slow read makes the next callback late and frames go by unread.
  // So take the frame and copy rows of it asynchronously; fall back to a canvas if that is not possible.
  let cv = null, g = null;
  const cb = (now, md) => {
    v.requestVideoFrameCallback(cb);
    R.calls++;
    try {
      const f = new VideoFrame(v);
      const k = f.codedWidth / o.monW, cell = o.cell * k, n = o.cells;
      const rect = { x: even(o.x * k), y: even(o.y * k + cell / 2), width: even(Math.ceil(cell * n) + 1), height: 2 };
      const crop = o.crop && k === 1 ? { x: even(o.x + o.crop.x), y: even(o.y + o.crop.y), width: o.crop.w, height: o.crop.h } : null;
      // Some decoders' frames copy out wrong (seen with hardware AV1): after a run of unreadable frames, use the canvas.
      if (R.bad > 20 && !R.rows.length) R.canvas = true;
      const fmt = R.canvas ? null : f.format, planar = !!fmt && !/^(RGB|BGR)/.test(fmt), bgr = !!fmt && /^BGR/.test(fmt);
      if (!R.geo) R.geo = fmt + ' coded ' + f.codedWidth + 'x' + f.codedHeight + ', visible ' + JSON.stringify(f.visibleRect) + ', video ' + v.videoWidth + 'x' + v.videoHeight + ', rect ' + JSON.stringify(rect);
      if (fmt) {
        const buf = new Uint8Array(f.allocationSize({ rect }));
        f.copyTo(buf, { rect }).then((layout) => {
          const off = layout[0].offset, px = planar ? 1 : 4;
          const id = decode((i) => { const p = off + Math.min(rect.width - 1, Math.floor((i + 0.5) * cell)) * px; return planar ? buf[p] * 3 : buf[p] + buf[p + 1] + buf[p + 2]; }, n, now, md);
          R.how = 'frame ' + fmt;
          if (!id || !crop || !wanted(id[0], id[1])) return;
          const cbuf = new Uint8Array(f.allocationSize({ rect: crop }));
          return f.copyTo(cbuf, { rect: crop }).then((l) => {
            const w = crop.width, h = crop.height, out = new Uint8Array(w * h), o0 = l[0].offset, st = l[0].stride;
            if (planar) for (let y = 0; y < h; y++) out.set(cbuf.subarray(o0 + y * st, o0 + y * st + w), y * w);
            else for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = o0 + y * st + x * 4; out[y * w + x] = Math.round(0.299 * cbuf[q + (bgr ? 2 : 0)] + 0.587 * cbuf[q + 1] + 0.114 * cbuf[q + (bgr ? 0 : 2)]); }
            keep(id, md, w, h, out);
          });
        }).then(() => f.close(), (e) => { try { f.close(); } catch {} R.err = String(e); });
        return;
      }
      f.close();
      if (!cv) { cv = document.createElement('canvas'); g = cv.getContext('2d', { willReadFrequently: true }); }
      // One drawing holds both the row of cells and the rectangle, so they are from the same frame.
      const W = crop ? Math.max(rect.width, o.crop.x + o.crop.w) : rect.width, Hh = crop ? Math.max(rect.y - o.y + 1, o.crop.y + o.crop.h) : rect.y - o.y + 1;
      if (cv.width !== W || cv.height !== Hh) { cv.width = W; cv.height = Hh; }
      g.drawImage(v, o.x * k, o.y * k, W, Hh, 0, 0, W, Hh);
      const d = g.getImageData(0, rect.y - even(o.y * k), rect.width, 1).data;
      const id = decode((i) => { const p = Math.min(rect.width - 1, Math.floor((i + 0.5) * cell)) * 4; return d[p] + d[p + 1] + d[p + 2]; }, n, now, md);
      R.how = 'canvas';
      if (id && crop && wanted(id[0], id[1])) {
        const c = g.getImageData(o.crop.x, o.crop.y, o.crop.w, o.crop.h).data, out = new Uint8Array(o.crop.w * o.crop.h);
        for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = Math.round(0.299 * c[i] + 0.587 * c[i + 1] + 0.114 * c[i + 2]);
        keep(id, md, o.crop.w, o.crop.h, out);
      }
    } catch (e) { R.err = String(e); }
  };
  v.requestVideoFrameCallback(cb);
  return true;
})()`;

const CLIENT_STATS = `(async () => {
  const rep = await pc.getStats(), mid = monitors[__MON__].mid;
  let o = null, pair = null, audio = 0;
  rep.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') audio += r.packetsReceived || 0;
    if (r.type === 'inbound-rtp' && r.kind === 'video' && r.mid === mid) o = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId) || pair;
  });
  return o && {
    framesReceived: o.framesReceived, framesDecoded: o.framesDecoded, framesDropped: o.framesDropped, keyFramesDecoded: o.keyFramesDecoded,
    jitterBufferDelay: o.jitterBufferDelay, jitterBufferEmittedCount: o.jitterBufferEmittedCount, jitterBufferTargetDelay: o.jitterBufferTargetDelay, jitterBufferMinimumDelay: o.jitterBufferMinimumDelay,
    totalDecodeTime: o.totalDecodeTime, totalProcessingDelay: o.totalProcessingDelay, totalAssemblyTime: o.totalAssemblyTime,
    freezeCount: o.freezeCount, totalFreezesDuration: o.totalFreezesDuration, packetsLost: o.packetsLost, packetsReceived: o.packetsReceived,
    nackCount: o.nackCount, pliCount: o.pliCount, bytesReceived: o.bytesReceived, decoder: o.decoderImplementation, w: o.frameWidth, h: o.frameHeight,
    rtt: pair ? pair.currentRoundTripTime : null, audioPackets: audio,
  };
})()`;

const quant = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const dist = (a) => ({ n: a.length, p50: r1(quant(a, 0.5)), p95: r1(quant(a, 0.95)), max: r1(a.length ? Math.max(...a) : null) });

function analyze({ rows, drawn, started, hs, cs0, cs1, m0, m1, offP, offC, mon, cap, offH, nat }) {
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
  // capture: when each picture frame reached the encoder on the host (config captureProbe)
  const first = new Map();
  if (cap && cap.rows && offH) {
    for (const [at, t] of cap.rows) if (!first.has(t)) first.set(t, at - offH.off);
    const lat = [[], []];
    let n = 0;
    for (const [t, ph] of drawn) {
      const e = info.get(t);
      if (ph > 1 || !inWin(e.at) || !first.has(t)) continue;
      lat[ph].push(first.get(t) - e.at);
      n++;
    }
    const sp = dist(lat[0]), sc = dist(lat[1]);
    out.capture = {
      sparse: sp, scroll: sc, fmt: cap.fmt, frames: cap.n, unreadable: cap.bad, err: cap.err, fps: r1(cap.rows.length > 1 ? (cap.rows.length - 1) / ((cap.rows[cap.rows.length - 1][0] - cap.rows[0][0]) / 1000) : 0),
      restScroll: r1(out.scroll.toRecv.p50 != null && sc.p50 != null ? out.scroll.toRecv.p50 - sc.p50 : null),
      restSparse: r1(out.sparse.toRecv.p50 != null && sp.p50 != null ? out.sparse.toRecv.p50 - sp.p50 : null),
    };
  }
  // native: the same frames as a native capturer saw them. Everything here is counted from the
  // moment Windows presented the frame, i.e. from when a person at the host would see it.
  if (nat && nat.rows.length) {
    const seenN = new Map();
    for (const [acquired, presented, readable, code] of nat.rows) if (!seenN.has(code)) seenN.set(code, { acquired: acquired - nat.off, presented: presented - nat.off, readable: readable - nat.off });
    const A = { toScreen: [[], []], handed: [[], []], readable: [[], []], chromium: [[], []], remote: [[], []] };
    for (const [t, ph] of drawn) {
      const e = info.get(t), n = seenN.get(t);
      if (ph > 1 || !inWin(e.at) || !n) continue;
      A.toScreen[ph].push(n.presented - e.at);
      A.handed[ph].push(n.acquired - n.presented);
      A.readable[ph].push(n.readable - n.presented);
      if (first.has(t)) A.chromium[ph].push(first.get(t) - n.presented);
      const s = seen.get(t);
      if (s) A.remote[ph].push(s.disp - n.presented);
    }
    const both = (a) => ({ sparse: dist(a[0]), scroll: dist(a[1]) });
    const secs = out.scroll.drawnFps ? out.scroll.drawn / out.scroll.drawnFps : 0;
    out.native = {
      toScreen: both(A.toScreen), handed: both(A.handed), readable: both(A.readable), chromium: both(A.chromium), remote: both(A.remote),
      scrollFps: r1(secs ? A.handed[1].length / secs : 0), stats: nat.stats,
    };
  }
  // host: what the encoder and the bandwidth estimate did, overall and during scrolling only
  {
    const list = hs.filter((h) => h && h.mons && h.mons[mon]);
    const total = P.phases.reduce((a, x) => a + x.ms, 0);
    const phaseAt = (t) => {
      let rest = (t - C.t0 - (started - offP.off)) % total;
      if (rest < 0) return '';
      for (const x of P.phases) { if (rest < x.ms) return x.type; rest -= x.ms; }
      return '';
    };
    const during = (type) => ([x, y]) => phaseAt(x.t) === type && phaseAt(y.t) === type;
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
    // Per half second: [seconds, phase (lower case = it changed within the half second), capture fps, encode fps, Mbps, QP]
    out.timeline = pairs.map(([x, y]) => {
      const a = sum([[x, y]]) || {}, ph = phaseAt(x.t), same = ph === phaseAt(y.t);
      return [r1((y.t - list[0].t) / 1000), (ph[0] || '?')[same ? 'toUpperCase' : 'toLowerCase'](), a.captureFps, a.encodeFps, a.mbps, a.qp];
    });
    const first = list[0], lastS = list[list.length - 1];
    const avail = list.map((h) => (h.avail || 0) / 1e6);
    const lim = (k) => (lastS && first ? r1(((lastS.mons[mon].limitDur || {})[k] || 0) - ((first.mons[mon].limitDur || {})[k] || 0)) : null);
    out.host = {
      all: sum(pairs), ...Object.fromEntries([...new Set(P.phases.map((x) => x.type))].map((type) => [type, sum(pairs.filter(during(type)))])),
      contentType: lastS ? lastS.mons[mon].contentType : '', encoder: lastS ? lastS.mons[mon].impl : '', codec: lastS ? lastS.mons[mon].codec : '', res: lastS ? lastS.mons[mon].w + 'x' + lastS.mons[mon].h : '',
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
      audioPackets: d('audioPackets'), nack: d('nackCount'), pli: d('pliCount'), keyFrames: d('keyFramesDecoded'), decoder: cs1.decoder, res: cs1.w + 'x' + cs1.h, rttMs: cs1.rtt != null ? r1(cs1.rtt * 1000) : null,
    };
  }
  return out;
}

// Picture quality. Each kept piece of a client frame is compared with the same rectangle of the
// frame as it was drawn (the picture window draws it again). The measure is PSNR of brightness,
// in dB: about 30 = soft but readable, 35 = good, 40+ = hard to tell from the original. A constant
// gain/offset between the two (video range, colour conversion) is taken out first.
async function quality({ crops, drawn, pat, offP, offC, rect, snapshot }) {
  if (!crops.length) return null;
  const info = new Map(drawn.map((e) => [e[0], e]));
  const cache = new Map();
  const truth = async (t) => {
    if (!cache.has(t)) {
      const s = await pat.webContents.executeJavaScript(`window.__pat.truth(${t}, ${JSON.stringify(rect)})`);
      cache.set(t, s ? Buffer.from(s, 'base64') : null);
    }
    return cache.get(t);
  };
  const items = [];
  for (const [t, ph, disp, w, h, b] of crops) {
    const tr = info.has(t) ? await truth(t) : null, px = Buffer.from(b, 'base64');
    if (!tr || tr.length !== px.length) continue;
    items.push({ t, ph, age: disp - offC.off - (t - offP.off), w, h, px, tr });
  }
  if (!items.length) return null;
  const fit = (it) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const n = it.px.length;
    for (let i = 0; i < n; i++) { const x = it.tr[i], y = it.px[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const a = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
    return [a, (sy - a * sx) / n];
  };
  // The gain/offset comes from frames that had time to settle (the last one of each still period).
  const groups = new Map();
  for (const it of items) if (it.ph === 2) { if (!groups.has(it.t)) groups.set(it.t, []); groups.get(it.t).push(it); }
  for (const g of groups.values()) g.sort((x, y) => x.age - y.age);
  const settled = [...groups.values()].map((g) => g[g.length - 1]).filter((it) => it.age > 1500);
  const fits = (settled.length ? settled : items).map(fit);
  const a = quant(fits.map((f) => f[0]), 0.5), b = quant(fits.map((f) => f[1]), 0.5);
  const psnr = (it) => {
    let se = 0;
    for (let i = 0; i < it.px.length; i++) { const e = (it.px[i] - b) / a - it.tr[i]; se += e * e; }
    return Math.min(60, 10 * Math.log10(255 * 255 / Math.max(1e-6, se / it.px.length)));
  };
  for (const it of items) it.db = psnr(it);
  const out = { gain: r1(a * 100) / 100, offset: r1(b), pieces: items.length };
  const med = (list) => r1(quant(list.filter((x) => x != null), 0.5));
  if (groups.size) {
    // After the whole picture changed: when the new picture first shows, how good it is then, and how it improves.
    const AT = [150, 300, 500, 1000, 2000];
    const ev = [...groups.values()].map((g) => {
      const final = g[g.length - 1].age > 1500 ? g[g.length - 1].db : null;
      const at = (ms) => { const upTo = g.filter((it) => it.age <= ms); return upTo.length ? upTo[upTo.length - 1].db : null; };
      const reach = (db) => { const hit = g.find((it) => it.db >= db); return hit ? hit.age : null; };
      return { first: g[0].age, firstDb: g[0].db, at: AT.map(at), final, readable: reach(32), good: reach(36), settled: final != null ? reach(final - 1.5) : null, frames: g.length, page: info.get(g[0].t)[3] };
    });
    out.open = {
      events: ev.length, firstMs: med(ev.map((e) => e.first)), firstDb: med(ev.map((e) => e.firstDb)),
      at: Object.fromEntries(AT.map((ms, i) => [ms, med(ev.map((e) => e.at[i]))])), finalDb: med(ev.map((e) => e.final)),
      readableMs: med(ev.map((e) => e.readable)), goodMs: med(ev.map((e) => e.good)), settledMs: med(ev.map((e) => e.settled)),
      each: ev.map((e) => ({ page: e.page, firstMs: r1(e.first), firstDb: r1(e.firstDb), at: e.at.map(r1), finalDb: r1(e.final), goodMs: r1(e.good), settledMs: r1(e.settled), frames: e.frames })),
    };
  }
  for (const [name, code] of [['scroll', 1], ['drag', 3]]) {
    const list = items.filter((it) => it.ph === code).map((it) => it.db);
    if (list.length) out[name] = { n: list.length, p10: r1(quant(list, 0.1)), p50: r1(quant(list, 0.5)), p90: r1(quant(list, 0.9)) };
  }
  if (snapshot) {
    // Side by side, drawn | shown, for looking at: first frame after a change, about 0.3 s later, settled; one mid-drag, one mid-scroll.
    const png = (it, name) => {
      const W = it.w * 2 + 8, buf = Buffer.alloc(W * it.h * 4, 255);
      for (let y = 0; y < it.h; y++) for (let x = 0; x < it.w; x++) {
        const tv = it.tr[y * it.w + x], cvv = Math.max(0, Math.min(255, Math.round((it.px[y * it.w + x] - b) / a)));
        let o = (y * W + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = tv;
        o = (y * W + it.w + 8 + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = cvv;
      }
      fs.writeFileSync(`${snapshot}.${name}.png`, nativeImage.createFromBitmap(buf, { width: W, height: it.h }).toPNG());
    };
    let n = 0;
    for (const g of groups.values()) {
      if (n >= 2) break;
      n++;
      // The raw brightness of the settled frame, drawn then shown, for a closer look (w*h bytes each).
      fs.writeFileSync(`${snapshot}.open${n}-settled.${g[0].w}x${g[0].h}.raw`, Buffer.concat([g[g.length - 1].tr, g[g.length - 1].px]));
      png(g[0], `open${n}-first-${Math.round(g[0].age)}ms-${Math.round(g[0].db)}dB`);
      const mid = g.find((it) => it.age >= g[0].age + 250) || g[g.length - 1];
      png(mid, `open${n}-later-${Math.round(mid.age)}ms-${Math.round(mid.db)}dB`);
      png(g[g.length - 1], `open${n}-settled-${Math.round(g[g.length - 1].db)}dB`);
    }
    for (const [name, code] of [['scroll', 1], ['drag', 3]]) {
      const list = items.filter((it) => it.ph === code).sort((x, y) => x.db - y.db);
      if (list.length) { const it = list[Math.floor(list.length / 2)]; png(it, `${name}-typical-${Math.round(it.db)}dB`); }
    }
  }
  return out;
}

// A native capturer watching the same display (config nativeProbe; native/capprobe.cpp built into
// tools/native/capprobe.dll by native/build.js). For every desktop image it reports when Windows
// presented it - the moment the picture is on the host's own screen - and when a native capturer
// had it. Read-only.
function nativeProbe(d, phys, pat) {
  const koffi = require('koffi');
  const lib = koffi.load(path.join(__dirname, '..', 'tools', 'native', 'capprobe.dll'));
  const start = lib.func('int cap_start(int px, int py, int x, int y, int cell, int cells)');
  const rowsOf = lib.func('int cap_rows(_Out_ double *out, int max)');
  const statsOf = lib.func('void cap_stats(_Out_ double *out)');
  const now = lib.func('double cap_now()');
  const error = lib.func('const char *cap_error()');
  const stop = lib.func('void cap_stop()');
  const cell = Math.round(P.cell * d.scaleFactor);
  const x = Math.round((pat.getBounds().x - d.bounds.x) * d.scaleFactor), y = Math.round((pat.getBounds().y - d.bounds.y) * d.scaleFactor + cell / 2);
  if (start(phys.x + 8, phys.y + 8, x, y, cell, 36) !== 1) throw new Error('the native capture probe did not start: ' + error());
  return {
    // How far its clock is from this process's clock.
    offset() { let best = null; for (let i = 0; i < 20; i++) { const a = epoch(), n = now(), b = epoch(); if (!best || b - a < best.rt) best = { rt: b - a, off: n - (a + b) / 2 }; } return best.off; },
    finish() {
      const MAX = 60000, buf = new Float64Array(MAX * 4), st = new Float64Array(8);
      const n = rowsOf(buf, MAX);
      statsOf(st);
      stop();
      const rows = [];
      for (let i = 0; i < n; i++) rows.push([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]]);
      const [images, pointerOnly, timeouts, unreadable, composed, lost, refresh, format] = st;
      return { rows, stats: { images, pointerOnly, timeouts, unreadable, composed, lost, refresh, format } };
    },
  };
}

// The client on another machine (config `remote: { ssh: 'user@host', dir }`): bench-remote.js is
// copied there and started over ssh under a virtual display, and this side drives it through the
// ssh session's stdin/stdout. Signaling reaches this PC's relay through an ssh tunnel, so the only
// thing that crosses the network between the two machines directly is the WebRTC traffic itself.
// The other machine needs `<dir>/electron/electron` (an unpacked Electron release) and xvfb-run.
function remoteClient() {
  const { spawn, spawnSync } = require('child_process');
  const R = B.remote, dir = R.dir || 'my-remote-dev', ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  const cp = spawnSync('scp', [...ssh, path.join(__dirname, 'bench-remote.js'), `${R.ssh}:${dir}/run/bench-remote.js`], { encoding: 'utf8', windowsHide: true });
  if (cp.status !== 0) throw new Error('could not copy the client script to the other machine: ' + String(cp.stderr || cp.error).trim());
  const port = new URL(C.server).port;
  const opts = Buffer.from(JSON.stringify({ disableFeatures: B.peerDisableFeatures || [], trials: B.peerTrials || '', switches: B.peerSwitches || {} })).toString('base64');
  const cmd = `cd ${dir} && exec xvfb-run -a -s '-screen 0 1920x1080x24' ./electron/electron run/bench-remote.js ${opts}`;
  const child = spawn('ssh', [...ssh, '-o', 'ExitOnForwardFailure=yes', '-R', `${port}:127.0.0.1:${port}`, R.ssh, cmd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = new Map();
  let seq = 0, buf = '', errTail = '', dead = null, ready;
  const readyP = new Promise((res, rej) => { ready = { res, rej }; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    buf += s;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('@@RPC ')) continue;
      let m;
      try { m = JSON.parse(line.slice(6)); } catch { continue; }
      if (m.ready) ready.res(true);
      else if (m.event === 'target') ctl('/target', m.value).catch(() => {});
      else { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); if (m.ok) w.res(m.value); else w.rej(new Error(m.error)); } }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => { errTail = (errTail + s).slice(-3000); });
  const end = (why) => { if (dead) return; dead = new Error(why + ': ' + errTail.trim().split('\n').slice(-4).join(' | ')); ready.rej(dead); for (const w of waiting.values()) w.rej(dead); waiting.clear(); };
  child.on('error', (e) => end('ssh could not be started (' + e.message + ')'));
  child.on('exit', (c) => end('the client on the other machine ended (code ' + c + ')'));
  const call = (op, extra) => new Promise((res, rej) => {
    if (dead) return rej(dead);
    const id = ++seq;
    waiting.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
  });
  return { ready: readyP, call, js: (code) => call('js', { code }), close: () => { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 1500); } };
}

async function run() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  // Stay out of the way: prefer a display the pointer is not on, and not the primary one.
  const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id, prim = screen.getPrimaryDisplay().id;
  // A display in HDR mode is captured with wrong tones, which would spoil the picture-quality comparison.
  const color = require('./input').displayColor();
  const isHdr = (x) => { const r = screen.dipToScreenRect(null, x.bounds); return color.some((e) => e.hdr && e.x === r.x && e.y === r.y); };
  const score = (i) => (isHdr(displays[i]) ? 0 : 4) + (displays[i].id !== cur ? 2 : 0) + (displays[i].id !== prim ? 1 : 0);
  let di = Number.isInteger(B.display) && displays[B.display] ? B.display : displays.map((_, i) => i).sort((a, b) => score(b) - score(a) || b - a)[0];
  const d = displays[di], phys = screen.dipToScreenRect(null, d.bounds);
  const pw = Math.min(P.w, d.bounds.width), ph = Math.min(P.h, d.bounds.height);
  const mk = (o) => {
    const w = new BrowserWindow({ frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, show: false, ...o, webPreferences: { backgroundThrottling: false } });
    w.setAlwaysOnTop(true, 'screen-saver');
    return w;
  };
  const pat = mk({ x: d.bounds.x, y: d.bounds.y, width: pw, height: ph });
  await pat.loadFile(path.join(__dirname, 'bench-pattern.html'), { query: { t0: String(C.t0), phases: JSON.stringify(P.phases), speed: String(P.speed), every: String(P.every), cell: String(P.cell) } });
  pat.showInactive();

  // The client window: small, in a corner of another display. On the captured display it would
  // feed back: every frame it presents counts as a screen change there, so a still screen would
  // never be still for the capturer. (With a single display that cannot be avoided.)
  const CW = 320, CH = 200;
  const cd = displays.find((x) => x.id !== d.id && x.id !== cur) || displays.find((x) => x.id !== d.id) || d;
  let js, remote = null;
  if (B.remote) {
    remote = remoteClient();
    await remote.ready;
    await remote.call('open', { html: fs.readFileSync(C.clientFile, 'utf8'), hash: 'k=' + C.key + '&ro', width: CW, height: CH });
    js = remote.js;
  } else {
    const cw = mk({ x: cd.bounds.x + cd.bounds.width - CW, y: cd.bounds.y + cd.bounds.height - CH, width: CW, height: CH });
    // The message is on the event since Electron 35; the positional argument goes in 47.
    cw.webContents.on('console-message', (e, _l, legacy) => {
      const m = String(e && e.message !== undefined ? e.message : legacy);
      if (m.startsWith('BENCH-TARGET ')) ctl('/target', JSON.parse(m.slice(13))).catch(() => {});
    });
    await cw.loadFile(C.clientFile, { hash: 'k=' + C.key + '&ro' });
    cw.showInactive();
    js = (code) => cw.webContents.executeJavaScript(code);
  }
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
  // The rectangle compared for picture quality, in picture pixels: below the row of cells, over text and pictures.
  const CROP = { x: 40, y: 60, w: 416, h: 200 };
  await js(PROBE.replace('__O__', JSON.stringify({
    x: (pat.getBounds().x - d.bounds.x) * d.scaleFactor, y: (pat.getBounds().y - d.bounds.y) * d.scaleFactor,
    cell: Math.round(P.cell * d.scaleFactor), cells: 36, monW: phys.width, t0: C.t0, crop: d.scaleFactor === 1 ? CROP : null,
  })));

  // How far a page's clock is from this process's clock: the answer that came back fastest is the
  // most trustworthy one. For a page on another machine the question travels through ssh, so more are asked.
  const NOW = 'performance.timeOrigin + performance.now()';
  const clockOffset = async (ask, n) => {
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = epoch(), r = await ask(NOW), b = epoch();
      if (!best || b - a < best.rt) best = { rt: b - a, off: r - (a + b) / 2 };
    }
    return best;
  };
  const native = B.nativeProbe ? nativeProbe(d, phys, pat) : null;
  if (B.captureProbe) await ctl('/capprobe', { mon, x: (pat.getBounds().x - d.bounds.x) * d.scaleFactor, y: (pat.getBounds().y - d.bounds.y) * d.scaleFactor, cell: Math.round(P.cell * d.scaleFactor), cells: 36, monW: phys.width, t0: C.t0 });
  await sleep(B.warmup * 1000);
  const offH = B.captureProbe ? await clockOffset(() => ctl('/hostnow'), 25) : null;
  const offP = await clockOffset((c) => pat.webContents.executeJavaScript(c), 25), offC = await clockOffset(js, remote ? 80 : 25);
  if (remote) await remote.call('cpu');
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
  const cpu = { host: await ctl('/cpu'), client: remote ? await remote.call('cpu') : cpuOf(app.getAppMetrics()) };
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
  const cap = B.captureProbe ? await ctl('/caprows') : null;
  const nat = native ? { off: native.offset() + C.t0, ...native.finish() } : null; // its times are absolute; everything else here counts from t0
  const res = analyze({ rows, drawn: pinfo.drawn, started: pinfo.started, hs, cs0, cs1, m0, m1, offP, offC, mon, cap, offH, nat });
  // The kept pieces of frames come over in batches (they are large), then are compared with what was drawn.
  const crops = [];
  for (const total = await js('window.__bench.crops.length'); crops.length < total;) crops.push(...(await js(`window.__bench.crops.slice(${crops.length}, ${crops.length + 30})`)));
  res.quality = await quality({ crops, drawn: pinfo.drawn, pat, offP, offC, rect: CROP, snapshot: B.snapshot });
  Object.assign(res.probe, probe);
  res.cpu = cpu; // percent of the whole machine (all cores), over the measured window, both including the picture window's process share
  res.setup = {
    display: di + 1, hdr: isHdr(d), monitor: phys.width + 'x' + phys.height, picture: pinfo.w + 'x' + pinfo.h, clientWindowOnDisplay: remote ? 0 : displays.indexOf(cd) + 1,
    remote: remote ? await remote.call('info') : null,
    clockUncertaintyMs: r1((offP.rt + offC.rt) / 2), clockOffsetMs: r1(offC.off - offP.off),
  };
  if (remote) remote.close();
  return res;
}

app.whenReady().then(async () => {
  const out = { ok: false };
  try { Object.assign(out, await run()); out.ok = true; } catch (e) { out.error = String((e && e.stack) || e); }
  try { await ctl('/done', out); } catch {}
  app.exit(0);
});
