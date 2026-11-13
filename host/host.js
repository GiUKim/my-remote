const api = window.hostApi;
const $ = (id) => document.getElementById(id);
const CLIP_MAX = 60000;
let cfg, keys, chan;
let session = null;

function log(s) {
  const line = `${new Date().toLocaleTimeString()}  ${s}`;
  $('log').textContent = (line + '\n' + $('log').textContent).slice(0, 6000);
  api.log(s);
}
function status(text, cls) { $('status').textContent = text; $('dot').className = 'dot ' + cls; }

// ---- native capture (optional) -----------------------------------------------------
// The preload script runs the native capturer and sends each monitor's frames over a message
// port (see preload.js); here they go into a MediaStreamTrackGenerator, which the engine encodes
// and sends like any other video track.
let nativePort = null, nativeOff = false, nativeTurn = Promise.resolve(), sizeRenewAt = 0;
const nativeOpening = new Map();
function nativeChannel() {
  if (nativePort) return nativePort;
  const ch = new MessageChannel();
  nativePort = ch.port1;
  nativePort.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'frame') {
      const n = session && session.native && session.native[m.i];
      if (n) n.writer.write(m.frame).catch(() => {}); else m.frame.close();
    } else if (m.t === 'opened') {
      const done = nativeOpening.get(m.i);
      if (done) { nativeOpening.delete(m.i); done(m); }
    } else if (m.t === 'paused' && session && session.native && session.native[m.i]) {
      // The lock screen or a permission prompt has the screen, or the capturer is starting again
      // after a mode change or a reset of the graphics card. It keeps trying by itself: the session
      // stays and the client keeps the last picture meanwhile.
      log(m.on ? `모니터 ${m.i + 1}: 지금은 화면을 읽을 수 없습니다 (${m.error}) — 다시 읽을 수 있게 되면 이어서 보냅니다` : `모니터 ${m.i + 1}: 화면을 다시 읽습니다`);
    } else if (m.t === 'failed' && session && session.native && session.native[m.i]) {
      // A monitor in HDR mode, or one the capturer could not get back (GIVE_UP_MS in
      // native/capture.cpp): go on with the engine's capturer. Only a loop of this session counts:
      // what a loop of an earlier session reported arrives before the first of this session's loops
      // has opened.
      log(`네이티브 캡처 중단 (모니터 ${m.i + 1}: ${m.error}) — 기본 캡처로 다시 연결합니다`);
      if (m.error !== 'size') nativeOff = true; // a changed size is a changed monitor setup: that renegotiates by itself
      else sizeRenewAt = performance.now(); // see onDisplaysChanged
      renew(session, '캡처 방식 변경');
    }
  };
  window.postMessage('mr-native-capture', '*', [ch.port2]);
  return nativePort;
}
// One generator per monitor, or null when any monitor cannot be captured natively or the session
// ended meanwhile. The preload knows the capture loops by monitor number only, and 'close' ends all
// of them, so sessions take turns: a session opens its loops only after the one before it has closed
// its own (its teardown does that, or the session itself when it finds itself replaced while opening).
function openNative(s, sources) {
  const turn = nativeTurn.then(() => openNativeLoops(s, sources));
  nativeTurn = turn.catch(() => null);
  return turn;
}
async function openNativeLoops(s, sources) {
  if (nativeOff || session !== s) return null;
  const port = nativeChannel(), list = [];
  for (let i = 0; i < sources.length; i++) {
    const r = await new Promise((done) => {
      nativeOpening.set(i, done);
      port.postMessage({ t: 'open', i, x: sources[i].x + 8, y: sources[i].y + 8, gap: Math.max(0, Number(cfg.captureGap) || 0) });
      // A capturer that has not answered in 4 s is not asked again: its answer, should it still come,
      // would be taken for the answer to a later request.
      setTimeout(() => { if (nativeOpening.get(i) === done) { nativeOpening.delete(i); nativeOff = true; } done({ ok: false, error: 'no answer' }); }, 4000);
    });
    // Replaced or ended meanwhile: close what was opened for it.
    if (session !== s) { port.postMessage({ t: 'close' }); return null; }
    if (!r.ok || r.width !== sources[i].width || r.height !== sources[i].height) {
      log(`네이티브 캡처를 쓸 수 없습니다 (모니터 ${i + 1}: ${r.ok ? '크기 불일치' : r.error}) — 기본 캡처를 사용합니다`);
      port.postMessage({ t: 'close' });
      s.native = null;
      return null;
    }
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    list.push({ gen, writer: gen.writable.getWriter() });
    // From the first loop on, so that a teardown closes them and their frames and failures count as
    // this session's.
    s.native = list;
  }
  return list;
}

function teardown(reason, silent) {
  if (!session) return;
  const s = session;
  session = null;
  if (s.native && nativePort) nativePort.postMessage({ t: 'close' });
  for (const t of s.timers) clearInterval(t);
  clearTimeout(s.dropTimer);
  api.input('{"t":"reset"}');
  api.session(false);
  api.hideCursor(false);
  for (const st of s.streams) st.getTracks().forEach((t) => (s.native && t.kind === 'audio' ? keepSpareAudio(t) : t.stop())); // the sound waits for the next session
  // Tell the client this was deliberate so it does not auto-reconnect, then close.
  try { if (!silent && s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'bye' })); } catch {}
  setTimeout(() => { try { s.pc.close(); } catch {} }, 200);
  $('stats').textContent = '';
  status('대기 중 — 접속을 기다리는 중', 'ok');
  log('세션 종료: ' + reason);
}

// Ends the session and has the client come back at once with a new hello, keeping its windows: the
// monitors or the capture method changed. The client hears 'renew' on the session's channel; a session
// whose channel is not open yet is ended when it opens, because a client that heard nothing would wait
// out its 20-s hello timer first.
function renew(s, reason) {
  if (session !== s) return;
  if (s.dc && s.dc.readyState === 'open') {
    try { s.dc.send(JSON.stringify({ t: 'renew' })); } catch {}
    teardown(reason, true);
  } else s.stale = reason;
}

const CODECS = ['H264', 'VP9', 'AV1', 'VP8'];
// The client's choice, else the configured one, else ("auto") AV1 where this PC has the cores for it.
// The AV1 encoder runs on the CPU and is built for screen content: in the bench it kept text sharp
// while scrolling at about a third of the bitrate, encoded every captured frame and stayed on its
// bitrate. The graphics card's H.264 encoder costs almost no CPU, but when a still screen starts
// moving it sends several times its bitrate for up to a second (lag or loss on a link without that
// much room) and the engine then drops frames to make up for it.
//
// 'H264HQ' is H.264 on the graphics card with three times the bitrate. On a link with room for it
// (tens of Mbps to spare) the picture is as good as the original from the first frame after a
// change (50 dB and more in the bench, where AV1 levels off near 42 dB); on any slower link it is
// the worst choice, because of the bursts described above.
// `codecFrom` says whose choice it was ('client', 'config', 'auto'), for the diagnostics.
function pickCodec(hello) {
  const ok = (c) => c === 'H264HQ' || CODECS.includes(c);
  const want = ok(hello.codec) ? hello.codec : ok(cfg.codec) ? cfg.codec : '';
  const codecFrom = !want ? 'auto' : want === hello.codec ? 'client' : 'config';
  if (want === 'H264HQ') return { codec: 'H264', hq: true, codecFrom };
  if (want) return { codec: want, hq: false, codecFrom };
  let av1 = false;
  try { av1 = RTCRtpSender.getCapabilities('video').codecs.some((c) => c.mimeType.toLowerCase() === 'video/av1'); } catch {}
  return { codec: av1 && navigator.hardwareConcurrency >= 8 ? 'AV1' : 'H264', hq: false, codecFrom };
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
    return { scale, mbps: Math.max(1.5, cfg.mbpsPer1080p * (s.hq ? 3 : 1) * Math.pow(px / (1920 * 1080), 0.75)) };
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
      if (session !== s) return; // the next session's capture loops go by the same monitor numbers
      if (s.native && nativePort) nativePort.postMessage({ t: 'show', i, on: !!plan[i] }); // a monitor nobody looks at is not captured
    }
  });
  return s.encQueue;
}

// refine: when the screen stops changing, the engine goes on sending the still picture until the
// encoder reports that it is as good as it gets, then falls silent. Without it a still screen gets
// a few frames a second, and a picture that changed all at once (a window opening) took 2.5 s to
// become fully sharp in the bench; with it under a second. The price is 13 to 16 ms of delay on
// everything (the engine then releases frames on a fixed beat; measured between two machines),
// hence the `refine` setting.
// It needs an encoder that reports when it has settled: the AV1 encoder does; with the graphics
// card's H.264 encoder it is left off.
// The system sound comes from the engine's capture of the first monitor, whose picture is thrown
// away while native capture runs. Starting that capture for every session cost about 40 MB in the
// main process for a moment and left two sections and two mutexes behind there each time (Chromium,
// measured: 16 of each after 8 starts), so with native capture the sound track alone outlives its
// session by a minute and the next session takes it over: a reconnect starts no capture at all.
const SPARE_AUDIO_MS = 60000;
let spareAudio = null, audioReuses = 0; // { track, timer }; how often a session took the sound over (self-test)
function takeSpareAudio() {
  const k = spareAudio;
  spareAudio = null;
  if (!k) return null;
  clearTimeout(k.timer);
  if (k.track.readyState === 'live') return k.track;
  return null;
}
function keepSpareAudio(track) {
  if (track.readyState !== 'live') return;
  if (spareAudio) { clearTimeout(spareAudio.timer); if (spareAudio.track !== track) spareAudio.track.stop(); }
  const k = (spareAudio = { track, timer: setTimeout(() => { if (spareAudio === k) { spareAudio = null; track.stop(); } }, SPARE_AUDIO_MS) });
}
window.addEventListener('beforeunload', () => { const t = takeSpareAudio(); if (t) t.stop(); });
function capture(src, withAudio, refine) {
  const video = { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: src.id,
    minWidth: src.width, maxWidth: src.width, minHeight: src.height, maxHeight: src.height,
    maxFrameRate: cfg.maxFps,
  } };
  // 'always': the capturer hands over every frame it takes, changed or not (about 50 a second).
  // No added delay and the fastest sharpening, but a still screen then costs about 0.7 Mbps and
  // 0.4 of a processor core for every monitor on screen, for as long as the client is connected.
  if (refine) video.mandatory.minFrameRate = refine === 'always' ? 20 : 0;
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
  } else if (m.t === 'dragout') {
    dragOut(s, m.b | 0);
  } else if (m.t === 'dragq') {
    pollDrag(s, 1200);
  } else if (m.t === 'clipget') {
    clipGet(s, Number(m.seq));
  } else if (m.t === 'cs') {
    // Client-side measurements: keep them with ours in the local diagnostics log.
    if (data.length < 6000 && m.s && typeof m.s === 'object') api.diag({ client: m.s, host: s.lastHs || null });
  } else if (data.length < 500) {
    if (m.t === 'md' || m.t === 'kd') s.putTouched = true; // see receiveUpload: no drop at an old place after this
    api.input(data);
  }
}

// Files dragged in (dropped on the picture) or pasted (Ctrl+V with files on the client's clipboard)
// come on a channel of their own: {t:'begin', mode, at}, then {t:'dir', name} for empty folders,
// {t:'file', name, size} + the bytes + {t:'fileend'} for each file, and {t:'done'}. main.js writes
// them (put-*) and, when complete, hands them to the program under the pointer with a real drop,
// or puts them on the clipboard (see putDone there). The answer goes back as {t:'put', state, ...}.
function receiveUpload(s, ch) {
  ch.binaryType = 'arraybuffer';
  let gid = null, fid = null, mode = 'drop', at = null, failed = false, n = 0;
  let queue = Promise.resolve();
  const fail = (why) => {
    if (failed) return;
    failed = true;
    txTo(s, { t: 'put', state: 'error', why });
    if (gid) api.putAbort(gid);
    log('받기 실패: ' + why);
    try { ch.close(); } catch {}
  };
  const step = async (data) => {
    if (failed) return;
    if (typeof data !== 'string') {
      if (!fid || !(await api.putChunk(fid, new Uint8Array(data)))) fail('write');
      return;
    }
    const m = JSON.parse(data);
    if (m.t === 'begin') {
      gid = await api.putBegin();
      if (!gid) return fail('begin');
      mode = m.mode === 'paste' ? 'paste' : 'drop';
      at = m.at && Number.isInteger(m.at.d) ? { d: m.at.d, x: +m.at.x, y: +m.at.y } : null;
      s.putTouched = false;
    } else if (m.t === 'dir') {
      if (!gid || !(await api.putDir(gid, String(m.name)))) fail('dir');
    } else if (m.t === 'file') {
      fid = gid ? await api.putFile(gid, String(m.name), Number(m.size)) : null;
      if (!fid) return fail('toobig');
      n++;
    } else if (m.t === 'fileend') {
      if (!fid || !(await api.putEnd(fid))) return fail('size');
      fid = null;
    } else if (m.t === 'done') {
      // A drop goes where it was let go - unless the person has clicked or typed since, then onto the clipboard.
      const r = await api.putDone(gid, mode === 'drop' && !s.putTouched ? at : null, mode);
      gid = null;
      log(`받기: 파일 ${n}개 — ${r.how}${r.why ? ' (' + r.why + ')' : ''}`);
      txTo(s, { t: 'put', state: 'done', how: r.how, n: r.n || n, why: r.why || '' });
      try { ch.close(); } catch {}
    }
  };
  ch.onmessage = (e) => { queue = queue.then(() => step(e.data)).catch((err) => fail(err && err.message ? err.message : 'error')); };
  ch.onclose = () => { if (gid && !failed) { failed = true; api.putAbort(gid); } };
}

// The client let go of something it had dragged out of the picture: fetch it from this PC
// (see dragOut in main.js) and send it over - text at once, files over a channel of their own
// so that a large file does not hold up the cursor and input messages.
const txTo = (s, o) => { try { if (s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify(o)); } catch {} };
async function dragOut(s, button) {
  const r = await api.dragOut(button);
  if (session !== s) return;
  if (r.kind === 'files') {
    const n = r.files.filter((f) => !f.dir).length;
    log(`끌어내기: 파일 ${n}개를 보냅니다${r.skipped ? ` (${r.skipped}개는 제외: 너무 많거나 큼)` : ''}`);
    txTo(s, { t: 'dragdata', kind: 'files', files: r.files, skipped: r.skipped || 0 });
    sendFiles(s, r.files);
  } else if (r.kind === 'text') {
    log(`끌어내기: 글자 ${r.s.length}자를 보냅니다`);
    txTo(s, { t: 'dragdata', kind: 'text', s: r.s, cut: !!r.cut });
  } else {
    log('끌어내기: 가져올 것이 없습니다 — ' + r.why);
    txTo(s, { t: 'dragdata', kind: 'none', why: r.why });
  }
}
// The client's pointer left its windows with a button held. Whether a drag-and-drop is under way
// here decides what that means, and a program may take a few hundred ms to start one (Explorer:
// about 0.35 s on the test PC), so look often for a while and tell the client the moment it starts.
async function pollDrag(s, ms) {
  if (s.dragPoll) return;
  s.dragPoll = true;
  try {
    const end = performance.now() + ms;
    while (session === s && performance.now() < end) {
      const on = !!(await api.dragging());
      if (on !== !!s.drag) { s.drag = on; txTo(s, { t: 'drag', on }); }
      if (on) break;
      await new Promise((r) => setTimeout(r, 15));
    }
  } finally { s.dragPoll = false; }
}
async function sendFiles(s, files) {
  const ch = s.pc.createDataChannel('file', { ordered: true });
  ch.binaryType = 'arraybuffer';
  const CHUNK = 60000;
  try {
    await new Promise((res, rej) => { ch.onopen = res; ch.onerror = rej; ch.onclose = () => rej(new Error('connection closed')); setTimeout(() => rej(new Error('channel did not open')), 8000); });
    for (const f of files) {
      if (f.dir) { ch.send(JSON.stringify({ t: 'dir', name: f.name })); continue; } // an empty folder of a dragged folder
      ch.send(JSON.stringify({ t: 'file', id: f.id, name: f.name, size: f.size }));
      for (let off = 0; off < f.size; off += CHUNK) {
        if (session !== s || ch.readyState !== 'open') throw new Error('connection closed');
        const buf = await api.dragFileRead(f.id, off, Math.min(CHUNK, f.size - off));
        if (!buf || !buf.byteLength) throw new Error('could not read ' + f.name);
        ch.send(buf);
        // Wait while 4 MB are queued. A channel that closes keeps its queued count, so the wait must
        // also end when the channel or the session does.
        while (ch.bufferedAmount > 4 * 1024 * 1024) {
          if (session !== s || ch.readyState !== 'open') throw new Error('connection closed');
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      ch.send(JSON.stringify({ t: 'fileend', id: f.id }));
      api.dragFileDone(f.id);
    }
    ch.send(JSON.stringify({ t: 'filesdone' }));
    log('끌어내기: 파일 전송을 마쳤습니다');
  } catch (e) {
    log('끌어내기: 파일 전송 실패 — ' + e.message);
    try { ch.send(JSON.stringify({ t: 'fileerror' })); } catch {}
    // Only this transfer's files: a newer drag-out may have offered others meanwhile.
    for (const f of files) if (f.id) api.dragFileDone(f.id);
  }
  setTimeout(() => { try { ch.close(); } catch {} }, 5000);
}

function startChannelTasks(s, dc) {
  const tx = (o) => { if (dc.readyState === 'open') dc.send(JSON.stringify(o)); };
  // Cursor shape (or picture) -> the client draws the cursor itself.
  // Also whether something is being dragged here, so the client knows what leaving its window means.
  let cur = null;
  s.drag = false;
  s.timers.push(setInterval(async () => {
    const c = await api.cursor(cur); // the picture comes along only when the cursor changed
    if (!!c.drag !== s.drag) { s.drag = !!c.drag; tx({ t: 'drag', on: s.drag }); }
    if (c.k === cur) return;
    cur = c.k;
    tx(c.img ? { t: 'cur', img: c.img, hx: c.hx, hy: c.hy } : { t: 'cur', c: c.c });
  }, 33));
  // Another remote-control program connected to this PC as well (see 'others' in main.js): tell the
  // client when that starts or ends, so the person knows why dragging or clicking may misbehave.
  let others = '';
  const checkOthers = async () => {
    const o = await api.others().catch(() => null);
    if (!o || session !== s) return;
    const k = JSON.stringify(o);
    if (k !== others) { others = k; tx({ t: 'others', ...o }); log(`other remote session: ${o.crd ? 'Chrome Remote Desktop connected' : 'none'}${o.outline ? ', windows are dragged as an outline' : ''}`); }
  };
  checkOthers();
  s.timers.push(setInterval(checkOthers, 10000));
  // Clipboard host -> client: text as it is; files only as a note of what they are (the client
  // fetches them with 'clipget' when it wants them, see main.js). Files that were already on the
  // clipboard when the session began are not announced: only what is copied during it.
  if (cfg.clipboard) {
    let seq = -1, first = true;
    s.timers.push(setInterval(async () => {
      const r = await api.readClip(seq);
      seq = r.seq;
      if (r.files) {
        if (!first) tx({ t: 'clipfiles', seq: r.seq, n: r.files.n, dirs: r.files.dirs, bytes: r.files.bytes, names: r.files.names });
      } else {
        const t = r.text;
        if (t && t !== s.clip && t.length <= CLIP_MAX) { s.clip = t; tx({ t: 'clip', s: t }); }
      }
      first = false;
    }, 500));
  }
}
// The client wants the files now on this PC's clipboard (it was told of them with 'clipfiles').
async function clipGet(s, seq) {
  const r = await api.clipGet(seq);
  if (session !== s) return;
  if (r.kind === 'files') {
    log(`복사한 파일: ${r.files.filter((f) => !f.dir).length}개를 보냅니다`);
    txTo(s, { t: 'dragdata', kind: 'files', files: r.files, skipped: r.skipped || 0, clip: true });
    sendFiles(s, r.files);
  } else txTo(s, { t: 'dragdata', kind: 'none', why: r.why, clip: true });
}

async function startSession(hello) {
  teardown('새 접속 요청');
  // The session is the current one from here on, so that a newer hello or a teardown during any of the
  // waits below finds it and closes what it has. After each wait it checks that it still is the
  // current one; if not, it stops there and closes what it got during that wait.
  const s = (session = {
    sid: hello.sid, started: performance.now(), streams: [], timers: [], dropTimer: 0, videoSenders: [], clip: null, native: null,
    mode: hello.mode === 'smooth' ? 'smooth' : 'sharp', encQueue: Promise.resolve(),
  });
  log('접속 요청 수신 — 화면 캡처 시작');
  status('연결 협상 중…', 'wait');
  const sources = await (s.sourcesP = api.getSources());
  if (session !== s) return;
  if (!sources.length) { log('캡처할 모니터를 찾지 못했습니다'); teardown('모니터 없음', true); return; }
  for (const src of sources) if (src.hdr) log(`주의: 모니터 ${src.idx + 1}은 Windows HDR이 켜져 있어 원격 화면에서 색이 밝게 날아갑니다. 이 PC의 설정 > 시스템 > 디스플레이에서 그 모니터의 HDR을 끄면 정상으로 보입니다.`);
  const pc = (s.pc = new RTCPeerConnection({ iceServers: cfg.iceServers }));
  s.sources = sources;
  s.need = new Map(sources.map((_, i) => [i, { w: 0, h: 0 }])); // w,h 0 = full size

  const dc = (s.dc = pc.createDataChannel('input', { ordered: true }));
  dc.onmessage = (e) => onClientMessage(s, dc, e.data);
  dc.onopen = () => { if (session !== s) return; if (s.stale) renew(s, s.stale); else startChannelTasks(s, dc); };
  // The client closed its connection (연결 끊기, its page closed or reloaded). The channel closes at
  // once, while the connection state would say so only after the ICE timeout and the 15-s grace.
  dc.onclose = () => { if (session === s) teardown('클라이언트 연결 종료', true); };
  // Files the client drags or pastes in come on channels it opens (see receiveUpload).
  pc.ondatachannel = (e) => { if (e.channel.label === 'upload' && session === s) receiveUpload(s, e.channel); else try { e.channel.close(); } catch {} };

  // The native capturer when it is there: its images carry no pointer, so nothing has to be hidden
  // on this PC. Otherwise the engine's capturer, with this PC's pointer hidden before capture
  // starts, so that the frames carry no pointer (see input.js).
  s.native = cfg.capture !== 'engine' && !nativeOff && api.nativeCapture() ? await openNative(s, sources) : null;
  if (session !== s) return; // the loops it opened are closed (see openNative)
  s.cursorHidden = s.native ? true : await api.hideCursor(true);
  if (session !== s) return;
  log(s.native ? '화면 캡처: 네이티브' : '화면 캡처: 기본(브라우저 엔진)');
  Object.assign(s, pickCodec(hello));
  const refine = s.codec === 'AV1' ? (cfg.refine === 'always' ? 'always' : cfg.refine !== false) : false;

  let audio = false;
  for (let i = 0; i < sources.length; i++) {
    let stream;
    if (i === 0 && cfg.audio) {
      let kept = takeSpareAudio(); // the sound of the session before (see keepSpareAudio)
      if (kept && !s.native) { kept.stop(); kept = null; } // the engine's capture of the picture brings its own
      if (kept) { stream = new MediaStream([kept]); audio = true; audioReuses++; }
      else {
        try { stream = await capture(sources[i], true, refine); audio = true; }
        catch (e) { log('시스템 소리 캡처 불가 — 소리 없이 진행: ' + e.message); }
      }
    }
    if (s.native) {
      // From the engine's capture only the sound is kept.
      const a = stream && stream.getAudioTracks()[0];
      if (stream) stream.getVideoTracks().forEach((t) => t.stop());
      stream = new MediaStream(a ? [s.native[i].gen, a] : [s.native[i].gen]);
    } else if (!stream) stream = await capture(sources[i], false, refine);
    if (session !== s) { stream.getTracks().forEach((t) => (s.native && t.kind === 'audio' ? keepSpareAudio(t) : t.stop())); return; }
    s.streams.push(stream);
    s.videoSenders.push(pc.addTrack(stream.getVideoTracks()[0], stream));
    // The sound goes out as a stream of its own. Sent in the same stream as the first monitor's
    // picture, the receiver keeps the two in step (lip sync) by holding the picture back to the
    // sound's buffering: measured between two machines, that monitor was 130 ms late whenever
    // any sound was playing, and only that monitor. Working on a remote PC needs the picture at
    // once more than it needs lip sync.
    const a = stream.getAudioTracks()[0];
    if (a) pc.addTrack(a, new MediaStream([a]));
  }
  preferCodec(pc, s.codec);

  pc.onconnectionstatechange = () => {
    if (session !== s) return;
    const st = pc.connectionState;
    log('연결 상태: ' + st);
    if (st === 'connected') {
      clearTimeout(s.dropTimer);
      if (s.stale) return; // ended as soon as its channel opens (see renew)
      status('원격 접속 중 (화면 전송 중)', 'live');
      api.session(true);
      applyEncoding(s);
    } else if (st === 'failed' || st === 'closed') teardown('연결 ' + st);
    else if (st === 'disconnected') { clearTimeout(s.dropTimer); s.dropTimer = setTimeout(() => teardown('연결 끊김'), 15000); }
  };

  await pc.setLocalDescription(await pc.createOffer());
  if (session !== s) return;
  await applyEncoding(s);
  await RD.waitIce(pc, 2500);
  if (session !== s) return;
  const mids = (s.mids = s.videoSenders.map((sender) => pc.getTransceivers().find((t) => t.sender === sender).mid));
  const appHash = await api.getClientHash();
  if (session !== s) return;
  await chan.send({
    app: appHash,
    t: 'offer', sid: s.sid, ts: Date.now(), sdp: pc.localDescription.sdp, ice: cfg.iceServers, audio, codec: s.codec, cursorHidden: s.cursorHidden,
    monitors: sources.map((src, i) => ({ idx: i, mid: mids[i], x: src.x, y: src.y, width: src.width, height: src.height, primary: src.primary, hdr: src.hdr || undefined })),
  });
  if (session !== s) return; // ended while the offer was being posted: no timers for it
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
      // The pair in use. (Several pairs can be "nominated" when a machine has several addresses.)
      const pair = r.type === 'transport' && r.selectedCandidatePairId ? rep.get(r.selectedCandidatePairId) : null;
      if (pair) { rtt = pair.currentRoundTripTime; avail = pair.availableOutgoingBitrate || 0; const lc = rep.get(pair.localCandidateId); kind = lc ? lc.candidateType : ''; }
    });
    const codec = codecId && rep.get(codecId) ? rep.get(codecId).mimeType.replace('video/', '') : '';
    const now = performance.now();
    // Host-side numbers for the client's diagnostics report.
    s.lastHs = { codec, from: s.codecFrom, enc: impl, availMbps: +(avail / 1e6).toFixed(1), targetMbps: +(target / 1e6).toFixed(1), rtt: rtt != null ? Math.round(rtt * 1000) : null, mons };
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

// Replay protection. Every ver and hello carries a new random sid and the sender's clock time: each is
// taken once, and only within five minutes of that time (the clocks of two PCs may differ that much).
// The sids taken are kept in this page's storage for as long as they could pass that test, so that a
// message recorded before the host restarted cannot be played back right after (a hello would end the
// session that is live then). Only messages that decrypted with the key ever get here.
const MAX_AGE = 5 * 60 * 1000, SEEN_KEY = 'mr_host_seen';
const seen = new Map(); // sid -> ts
try { for (const [sid, ts] of JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) if (Date.now() - ts <= MAX_AGE) seen.set(sid, ts); } catch {}
function firstTime(m) {
  if (seen.has(m.sid)) return false;
  for (const [sid, ts] of seen) if (Date.now() - ts > MAX_AGE) seen.delete(sid); // too old to pass the age test anyway
  seen.set(m.sid, Number(m.ts));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch {}
  return true;
}

async function onMessage(m) {
  if (!m || typeof m.sid !== 'string' || !(Math.abs(Date.now() - m.ts) <= MAX_AGE)) return; // also without a ts
  if (m.sid.length > 64) return; // a sid is 22 characters; a long one would only fill `seen`
  if (m.t === 'ver') {
    // A loader asking for the current client page. Only someone holding the key can have sent
    // this, and the reply is encrypted to the key. The page is skipped when the loader has it.
    if (!firstTime(m)) return; // replay
    try {
      const app = await api.getClientApp();
      const fresh = m.have !== app.hash;
      await chan.send({ t: 'app', sid: m.sid, ts: Date.now(), hash: app.hash, html: fresh ? app.html : undefined });
      log(fresh ? '클라이언트 화면을 최신 버전으로 전송했습니다' : '클라이언트 화면이 이미 최신입니다');
    } catch (e) {
      // The loader says so and can be tried again. A session that is live has nothing to do with it.
      log('클라이언트 화면 전송 실패: ' + e.message);
    }
  } else if (m.t === 'hello') {
    if (!firstTime(m)) return; // replay
    try { await startSession(m); } catch (e) {
      log('오류: ' + e.message);
      api.sourcesFailed(); // the monitors main keeps listed may be out of date: it asks Windows again next time
      // Only the session this hello started; a newer one may have taken its place meanwhile. No 'bye':
      // that would tell the client not to try again.
      if (session && session.sid === m.sid) teardown('오류', true);
    }
  } else if (m.t === 'answer' && session && m.sid === session.sid && session.pc && session.pc.signalingState === 'have-local-offer') {
    const s = session;
    try {
      await s.pc.setRemoteDescription({ type: 'answer', sdp: hintBitrate(m.sdp, Math.round(cfg.startBitrateMbps * 1000), Math.round(cfg.minBitrateMbps * 1000), Math.round(cfg.maxTotalMbps * 1000)) });
      log('answer 수신 — 연결 수립 중');
    } catch (e) {
      log('오류: ' + e.message);
      if (session === s) teardown('오류', true);
    }
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
  if (cfg.viewOnly) log('주의: 이 PC에서는 원격 입력을 넣을 수 없어 보기 전용으로 동작합니다 (' + cfg.viewOnly + ')');

  let shown = false;
  $('show').onclick = () => { shown = !shown; $('key').textContent = shown ? cfg.key : '••••••••••••••••••••••••'; $('show').textContent = shown ? '숨기기' : '표시'; };
  $('copy').onclick = async () => { await api.copyKey(); log('접속 키를 클립보드에 복사했습니다'); };
  $('regen').onclick = () => api.regenKey();
  $('kick').onclick = () => teardown('사용자가 끊음');
  api.onKick(() => teardown('사용자가 끊음'));
  api.onDisplaysChanged(async () => {
    const s = session;
    if (!s) return;
    // A capture loop that saw a monitor change size has renewed the session at once (see 'failed'),
    // and main reports that change 1.5 s after its last display event, often while the client's next
    // session is being set up. Leave a session alone that started after such a renew and already has
    // the monitors as they are now. (Any other report renews, changed or not: the self-test sends one
    // to have the session renegotiated.)
    if (sizeRenewAt && s.started > sizeRenewAt && performance.now() - sizeRenewAt < 10000) {
      const [had, now] = await Promise.all([s.sourcesP, api.getSources()]).catch(() => []);
      if (session !== s || (had && now && JSON.stringify(had) === JSON.stringify(now))) return;
    }
    log('호스트 모니터 구성 변경 감지 — 세션을 다시 협상합니다');
    renew(s, '모니터 구성 변경');
  });
  $('export').onclick = async () => { const p = await api.exportClient(); if (p) log('클라이언트 파일 저장: ' + p); };
})();
