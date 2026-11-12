const api = window.hostApi;
const $ = (id) => document.getElementById(id);
const CLIP_MAX = 60000;
let cfg, keys, chan;
let session = null;
const seen = new Set();

function log(s) {
  const line = `${new Date().toLocaleTimeString()}  ${s}`;
  $('log').textContent = (line + '\n' + $('log').textContent).slice(0, 6000);
  api.log(s);
}
function status(text, cls) { $('status').textContent = text; $('dot').className = 'dot ' + cls; }

function teardown(reason, silent) {
  if (!session) return;
  const s = session;
  session = null;
  for (const t of s.timers) clearInterval(t);
  clearTimeout(s.dropTimer);
  api.input('{"t":"reset"}');
  api.session(false);
  api.hideCursor(false);
  for (const st of s.streams) st.getTracks().forEach((t) => t.stop());
  // Tell the client this was deliberate so it does not auto-reconnect, then close.
  try { if (!silent && s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'bye' })); } catch {}
  setTimeout(() => { try { s.pc.close(); } catch {} }, 200);
  $('stats').textContent = '';
  status('대기 중 — 접속을 기다리는 중', 'ok');
  log('세션 종료: ' + reason);
}

const CODECS = ['H264', 'VP9', 'AV1', 'VP8'];
// The client's choice, else the configured one, else ("auto") AV1 where this PC has the cores for it.
// The AV1 encoder runs on the CPU and is built for screen content: in the bench it kept text sharp
// while scrolling at about a third of the bitrate, encoded every captured frame and stayed on its
// bitrate. The graphics card's H.264 encoder costs almost no CPU, but when a still screen starts
// moving it sends several times its bitrate for up to a second (lag or loss on a link without that
// much room) and the engine then drops frames to make up for it.
function pickCodec(hello) {
  if (CODECS.includes(hello.codec)) return hello.codec;
  if (CODECS.includes(cfg.codec)) return cfg.codec;
  let av1 = false;
  try { av1 = RTCRtpSender.getCapabilities('video').codecs.some((c) => c.mimeType.toLowerCase() === 'video/av1'); } catch {}
  return av1 && navigator.hardwareConcurrency >= 8 ? 'AV1' : 'H264';
}
function preferCodec(pc, codec) {
  const want = 'video/' + codec.toLowerCase();
  for (const tr of pc.getTransceivers()) {
    if (!tr.sender.track || tr.sender.track.kind !== 'video') continue;
    try {
      const caps = RTCRtpReceiver.getCapabilities('video').codecs;
      const first = caps.filter((c) => c.mimeType.toLowerCase() === want);
      if (first.length) tr.setCodecPreferences([...first, ...caps.filter((c) => c.mimeType.toLowerCase() !== want)]);
    } catch (e) { log('코덱 우선순위 설정 실패(기본값 사용): ' + e.message); }
  }
}

// What to send for each monitor, from what the client says it is showing:
//  - not on screen             -> encoding paused
//  - shown smaller than source -> scaled down to (at least) the shown size, never up
//  - bitrate follows the pixels actually sent, within a total cap
const SCALE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];
function encodingPlan(s) {
  const plan = s.sources.map((src, i) => {
    const need = s.need.get(i);
    if (!need) return null;
    const f = need.w > 0 && need.h > 0 ? Math.max(src.width / need.w, src.height / need.h) : 1;
    const scale = SCALE_STEPS.filter((x) => x <= f + 0.01).pop() || 1;
    const px = (src.width / scale) * (src.height / scale);
    return { scale, mbps: Math.max(1.5, cfg.mbpsPer1080p * Math.pow(px / (1920 * 1080), 0.75)) };
  });
  const total = plan.reduce((a, p) => a + (p ? p.mbps : 0), 0);
  if (total > cfg.maxTotalMbps) for (const p of plan) if (p) p.mbps *= cfg.maxTotalMbps / total;
  return plan;
}

// Applies the plan plus fps / quality mode. Calls are serialized: setParameters must not overlap.
function applyEncoding(s) {
  s.encQueue = s.encQueue.then(async () => {
    if (session !== s) return;
    const smooth = s.mode === 'smooth';
    const plan = encodingPlan(s);
    for (let i = 0; i < s.videoSenders.length; i++) {
      const sender = s.videoSenders[i];
      try {
        sender.track.contentHint = smooth ? 'motion' : 'detail';
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) continue;
        p.encodings[0].active = !!plan[i];
        p.encodings[0].scaleResolutionDownBy = plan[i] ? plan[i].scale : 1;
        p.encodings[0].maxBitrate = Math.round((plan[i] ? plan[i].mbps : 1.5) * 1e6);
        p.encodings[0].maxFramerate = cfg.maxFps;
        p.degradationPreference = smooth ? 'maintain-framerate' : 'maintain-resolution';
        await sender.setParameters(p);
      } catch (e) { log('인코더 설정 실패: ' + e.message); }
    }
  });
  return s.encQueue;
}

function capture(src, withAudio) {
  const video = { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: src.id,
    minWidth: src.width, maxWidth: src.width, minHeight: src.height, maxHeight: src.height,
    maxFrameRate: cfg.maxFps,
  } };
  return navigator.mediaDevices.getUserMedia({ audio: withAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false, video });
}

function onClientMessage(s, dc, data) {
  if (session !== s || typeof data !== 'string') return;
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (!m) return;
  if (m.t === 'view' && Array.isArray(m.v)) {
    const dim = (n) => Math.max(0, Math.min(16384, Math.round(Number(n) || 0)));
    const need = new Map();
    for (const raw of m.v) {
      const e = Number.isInteger(raw) ? { i: raw } : raw; // older clients send bare monitor indexes (= full size)
      if (e && Number.isInteger(e.i) && e.i >= 0 && e.i < s.sources.length) need.set(e.i, { w: dim(e.w), h: dim(e.h) });
    }
    s.need = need; // empty = every client window is hidden: pause all video
    applyEncoding(s);
  } else if (m.t === 'mode') {
    s.mode = m.m === 'smooth' ? 'smooth' : 'sharp';
    applyEncoding(s);
    log('화질 모드: ' + (s.mode === 'smooth' ? '부드러움 우선' : '선명도 우선'));
  } else if (m.t === 'clip') {
    if (cfg.clipboard && typeof m.s === 'string' && m.s.length <= CLIP_MAX) { s.clip = m.s; api.writeClip(m.s); }
  } else if (m.t === 'cs') {
    // Client-side measurements: keep them with ours in the local diagnostics log.
    if (data.length < 6000 && m.s && typeof m.s === 'object') api.diag({ client: m.s, host: s.lastHs || null });
  } else if (data.length < 500) {
    api.input(data);
  }
}

function startChannelTasks(s, dc) {
  const tx = (o) => { if (dc.readyState === 'open') dc.send(JSON.stringify(o)); };
  // Cursor shape (or picture) -> the client draws the cursor itself.
  let cur = null;
  s.timers.push(setInterval(async () => {
    const c = await api.cursor();
    if (c.k === cur) return;
    cur = c.k;
    tx(c.img ? { t: 'cur', img: c.img, hx: c.hx, hy: c.hy } : { t: 'cur', c: c.c });
  }, 33));
  // Clipboard (text) host -> client.
  if (cfg.clipboard) {
    let seq = -1;
    s.timers.push(setInterval(async () => {
      const r = await api.readClip(seq);
      seq = r.seq;
      const t = r.text;
      if (t && t !== s.clip && t.length <= CLIP_MAX) { s.clip = t; tx({ t: 'clip', s: t }); }
    }, 500));
  }
}

async function startSession(hello) {
  teardown('새 접속 요청');
  log('접속 요청 수신 — 화면 캡처 시작');
  status('연결 협상 중…', 'wait');
  const sources = await api.getSources();
  if (!sources.length) { log('캡처할 모니터를 찾지 못했습니다'); return; }
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  const s = (session = {
    sid: hello.sid, pc, sources, streams: [], timers: [], dropTimer: 0, videoSenders: [], clip: null,
    need: new Map(sources.map((_, i) => [i, { w: 0, h: 0 }])), /* w,h 0 = full size */ mode: hello.mode === 'smooth' ? 'smooth' : 'sharp', encQueue: Promise.resolve(),
  });

  const dc = (s.dc = pc.createDataChannel('input', { ordered: true }));
  dc.onmessage = (e) => onClientMessage(s, dc, e.data);
  dc.onopen = () => { if (session === s) startChannelTasks(s, dc); };

  // Hide this PC's cursor before capture starts, so the frames carry no cursor (see input.js).
  s.cursorHidden = await api.hideCursor(true);
  if (session !== s) return;
  s.codec = pickCodec(hello);

  let audio = false;
  for (let i = 0; i < sources.length; i++) {
    let stream;
    if (i === 0 && cfg.audio) {
      try { stream = await capture(sources[i], true); audio = true; }
      catch (e) { log('시스템 소리 캡처 불가 — 소리 없이 진행: ' + e.message); }
    }
    if (!stream) stream = await capture(sources[i], false);
    if (session !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
    s.streams.push(stream);
    s.videoSenders.push(pc.addTrack(stream.getVideoTracks()[0], stream));
    const a = stream.getAudioTracks()[0];
    if (a) pc.addTrack(a, stream);
  }
  preferCodec(pc, s.codec);

  pc.onconnectionstatechange = () => {
    if (session !== s) return;
    const st = pc.connectionState;
    log('연결 상태: ' + st);
    if (st === 'connected') {
      clearTimeout(s.dropTimer);
      status('원격 접속 중 (화면 전송 중)', 'live');
      api.session(true);
      applyEncoding(s);
    } else if (st === 'failed' || st === 'closed') teardown('연결 ' + st);
    else if (st === 'disconnected') { clearTimeout(s.dropTimer); s.dropTimer = setTimeout(() => teardown('연결 끊김'), 15000); }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await applyEncoding(s);
  await RD.waitIce(pc, 2500);
  if (session !== s) return;
  const mids = (s.mids = s.videoSenders.map((sender) => pc.getTransceivers().find((t) => t.sender === sender).mid));
  const appHash = (await api.getClientApp()).hash;
  await chan.send({
    app: appHash,
    t: 'offer', sid: s.sid, ts: Date.now(), sdp: pc.localDescription.sdp, ice: cfg.iceServers, audio, codec: s.codec, cursorHidden: s.cursorHidden,
    monitors: sources.map((src, i) => ({ idx: i, mid: mids[i], x: src.x, y: src.y, width: src.width, height: src.height, primary: src.primary })),
  });
  log(`offer 전송 (모니터 ${sources.length}개${audio ? ', 소리 포함' : ''})`);
  // Give up if the client never completes the handshake.
  s.dropTimer = setTimeout(() => { if (session === s && pc.connectionState !== 'connected') teardown('협상 시간 초과'); }, 30000);

  let last = null;
  s.timers.push(setInterval(async () => {
    if (session !== s || pc.connectionState !== 'connected') return;
    const rep = await pc.getStats();
    let bytes = 0, fps = [], impl = '', codecId = '', rtt = null, kind = '', limit = '', avail = 0, target = 0;
    const mons = {};
    rep.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const idx = s.mids.indexOf(r.mid), src = r.mediaSourceId && rep.get(r.mediaSourceId);
        if (idx >= 0 && r.active !== false) {
          mons[idx] = { cap: src ? Math.round(src.framesPerSecond || 0) : null, enc: Math.round(r.framesPerSecond || 0), res: (r.frameWidth || 0) + 'x' + (r.frameHeight || 0), limit: r.qualityLimitationReason || 'none', impl: r.encoderImplementation || '' };
          target += r.targetBitrate || 0;
        }
        bytes += r.bytesSent; fps.push([Number(r.mid) || 0, r.active === false ? '–' : Math.round(r.framesPerSecond || 0)]);
        impl = r.encoderImplementation || impl; codecId = r.codecId || codecId;
        if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') limit = r.qualityLimitationReason;
      }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { rtt = r.currentRoundTripTime; avail = r.availableOutgoingBitrate || 0; const lc = rep.get(r.localCandidateId); kind = lc ? lc.candidateType : ''; }
    });
    const codec = codecId && rep.get(codecId) ? rep.get(codecId).mimeType.replace('video/', '') : '';
    const now = performance.now();
    // Host-side numbers for the client's diagnostics report.
    s.lastHs = { codec, enc: impl, availMbps: +(avail / 1e6).toFixed(1), targetMbps: +(target / 1e6).toFixed(1), rtt: rtt != null ? Math.round(rtt * 1000) : null, mons };
    try { if (s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'hs', ...s.lastHs })); } catch {}
    if (last) {
      const mbps = ((bytes - last.bytes) * 8) / ((now - last.t) / 1000) / 1e6;
      const why = limit === 'cpu' ? ' · 제한: 이 PC 성능' : limit === 'bandwidth' ? ' · 제한: 네트워크' : '';
      const text = `${codec} (${impl}) · ${fps.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('/')} fps · ${mbps.toFixed(1)} Mbps · RTT ${rtt != null ? Math.round(rtt * 1000) + ' ms' : '?'} · ${kind === 'relay' ? 'TURN 중계' : 'P2P 직접'}${why}`;
      $('stats').textContent = text;
      if (!s.loggedStats) { s.loggedStats = true; log('전송 상태: ' + text); }
    }
    last = { bytes, t: now };
  }, 2000));
}

// Without hints the bandwidth estimate starts near 300 kbps and climbs slowly, so a
// connection begins blurry and drops frames whenever the picture moves. Start high
// (the estimator backs off within a second if the link cannot carry it) and never
// sink below a usable floor. The maximum matters just as much: without one, the engine never
// probes the link above 5 Mbps, so on a fast link the estimate sits near 5 Mbps for the whole
// session (seen in a real session's log) and every scroll is starved. All three are read from
// the remote description's codec parameters.
function hintBitrate(sdp, startKbps, minKbps, maxKbps) {
  const extra = 'x-google-start-bitrate=' + startKbps + ';x-google-min-bitrate=' + minKbps + (maxKbps ? ';x-google-max-bitrate=' + maxKbps : '');
  const lines = sdp.split('\r\n');
  let video = false;
  const pts = new Set(), withFmtp = new Set();
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    else if (video) {
      const r = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l); if (r) pts.add(r[1]);
      const f = /^a=fmtp:(\d+) /.exec(l); if (f) withFmtp.add(f[1]);
    }
  }
  const out = [];
  video = false;
  for (const l of lines) {
    if (l.startsWith('m=')) video = l.startsWith('m=video');
    const f = video && /^a=fmtp:(\d+) /.exec(l);
    const r = video && /^a=rtpmap:(\d+) /.exec(l);
    if (f && pts.has(f[1])) out.push(l + ';' + extra);
    else { out.push(l); if (r && pts.has(r[1]) && !withFmtp.has(r[1])) out.push('a=fmtp:' + r[1] + ' ' + extra); }
  }
  return out.join('\r\n');
}

async function onMessage(m) {
  try {
    if (!m || typeof m.sid !== 'string' || Math.abs(Date.now() - m.ts) > 5 * 60 * 1000) return;
    if (m.t === 'ver') {
      // A loader asking for the current client page. Only someone holding the key can have sent
      // this, and the reply is encrypted to the key. The page is skipped when the loader has it.
      if (seen.has(m.sid)) return; // replay
      seen.add(m.sid);
      const app = await api.getClientApp();
      const fresh = m.have !== app.hash;
      await chan.send({ t: 'app', sid: m.sid, ts: Date.now(), hash: app.hash, html: fresh ? app.html : undefined });
      log(fresh ? '클라이언트 화면을 최신 버전으로 전송했습니다' : '클라이언트 화면이 이미 최신입니다');
    } else if (m.t === 'hello') {
      if (seen.has(m.sid)) return; // replay
      seen.add(m.sid);
      if (seen.size > 500) seen.clear();
      await startSession(m);
    } else if (m.t === 'answer' && session && m.sid === session.sid && session.pc.signalingState === 'have-local-offer') {
      await session.pc.setRemoteDescription({ type: 'answer', sdp: hintBitrate(m.sdp, Math.round(cfg.startBitrateMbps * 1000), Math.round(cfg.minBitrateMbps * 1000), Math.round(cfg.maxTotalMbps * 1000)) });
      log('answer 수신 — 연결 수립 중');
    }
  } catch (e) {
    log('오류: ' + e.message);
    teardown('오류');
  }
}

(async () => {
  cfg = await api.getConfig();
  keys = await RD.derive(cfg.key);
  chan = RD.channel({
    server: cfg.server, subTopic: keys.topicHost, pubTopic: keys.topicClient, rxKey: keys.c2h, txKey: keys.h2c,
    onMessage,
    onState: (st) => { if (!session) status(st === 'open' ? '대기 중 — 접속을 기다리는 중' : '시그널링 서버 재연결 중…', st === 'open' ? 'ok' : 'wait'); },
  });
  log('시그널링 서버: ' + cfg.server);
  log('호스트 시작: ' + new Date().toLocaleString());

  let shown = false;
  $('show').onclick = () => { shown = !shown; $('key').textContent = shown ? cfg.key : '••••••••••••••••••••••••'; $('show').textContent = shown ? '숨기기' : '표시'; };
  $('copy').onclick = async () => { await api.copyKey(); log('접속 키를 클립보드에 복사했습니다'); };
  $('regen').onclick = () => api.regenKey();
  $('kick').onclick = () => teardown('사용자가 끊음');
  api.onKick(() => teardown('사용자가 끊음'));
  api.onDisplaysChanged(() => {
    if (!session) return;
    log('호스트 모니터 구성 변경 감지 — 세션을 다시 협상합니다');
    try { if (session.dc && session.dc.readyState === 'open') session.dc.send(JSON.stringify({ t: 'renew' })); } catch {}
    teardown('모니터 구성 변경', true);
  });
  $('export').onclick = async () => { const p = await api.exportClient(); if (p) log('클라이언트 파일 저장: ' + p); };
})();
