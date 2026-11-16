const api = window.hostApi;
const $ = (id) => document.getElementById(id);
const CLIP_MAX = 60000;
let cfg, keys, chan;
let session = null;
// Where a signaling message came from, and where its answer goes: the access key's own topics (`master`),
// or a device's (a client app with a token of its own, host/devices.js; its topics and keys come from that
// token alone, so it reaches this host without the key, and nobody without the token can read or forge
// what goes to it). routes: the topic this host listens on -> its route. See subscribe().
let master = null, routes = new Map(), subSeq = 0;
const openChans = new Set(); // relay subscriptions not let go yet (see subscribe)

function log(s) {
  const line = `${new Date().toLocaleTimeString()}  ${s}`;
  $('log').textContent = (line + '\n' + $('log').textContent).slice(0, 6000);
  api.log(s);
}
function status(text, cls) { $('status').textContent = text; $('dot').className = 'dot ' + cls; }

// ---- the screen locked or behind a secure prompt ---------------------------------------------
// The lock screen and UAC prompts are on a desktop this page can neither see nor control. The client
// is told ('lock'), so that a picture that stopped is not taken for a hang. `lock`: Windows reports
// the session locked (powerMonitor in main.js); `paused`: native capture loops that could not read
// their screen for more than a moment (the lock screen, a UAC prompt, another user's session; a
// mode change for a moment).
const screenGone = { lock: false, lockFrom: '', paused: new Set(), timers: new Map(), sentFor: null, sent: null, unlockedAt: -1e9 };
// Right after an unlock the capture loops need a moment to read the screen again: that is not taken
// for a secure prompt (UNLOCK_GRACE_MS; sendLock looks again once it is over).
const UNLOCK_GRACE_MS = 2500;
// The assist service (see below) knows exactly: the lock screen ('lock') or another secure desktop ('secure').
const lockReason = () => (screenGone.lock || (assist.secure && assist.locked) ? 'lock'
  : assist.secure || (screenGone.paused.size && performance.now() - screenGone.unlockedAt > UNLOCK_GRACE_MS) ? 'secure' : '');
function unlocked() { screenGone.unlockedAt = performance.now(); setTimeout(() => sendLock(), UNLOCK_GRACE_MS + 100); }
function sendLock(force) {
  const s = session, dc = s && s.dc;
  if (!dc || dc.readyState !== 'open') return;
  const why = lockReason();
  // live: the secure desktop's picture is in the video of monitor `d` (the primary); input: the person may
  // type into it (the lock screen; never a UAC prompt).
  const live = !!(why && assist.secure && assist.frames && assistTarget());
  const key = why + (live ? (assist.input ? '+live+input' : '+live') : '');
  if (!force && screenGone.sentFor === s && screenGone.sent === key) return;
  screenGone.sentFor = s; screenGone.sent = key;
  const msg = why ? { t: 'lock', on: true, why, live, input: live && assist.input, d: live ? primaryIndex(s) : undefined } : { t: 'lock', on: false };
  try { dc.send(JSON.stringify(msg)); } catch {}
}
function screenPaused(i, on) {
  clearTimeout(screenGone.timers.get(i));
  screenGone.timers.delete(i);
  if (on) screenGone.timers.set(i, setTimeout(() => { screenGone.paused.add(i); sendLock(); }, 1500));
  else if (screenGone.paused.delete(i)) sendLock();
}
function forgetPaused() { for (const t of screenGone.timers.values()) clearTimeout(t); screenGone.timers.clear(); screenGone.paused.clear(); }
// A lock learned by asking (at a session's start; also a screensaver that does not lock, which Windows'
// idle check reports as locked; on Linux, where no lock events come, any lock) ends with no event: while
// it lasts, ask again every 2 s. A lock reported by an event is ended by the matching event.
setInterval(() => {
  if (!screenGone.lock || screenGone.lockFrom !== 'query' || !session) return;
  api.hostLocked().then((v) => { if (!v && screenGone.lock && screenGone.lockFrom === 'query') { screenGone.lock = false; unlocked(); log('이 PC의 잠금이 풀렸습니다'); sendLock(); } }, () => {});
}, 2000);

// ---- the lock screen through the assist service (Windows; host/assist.js, native/winassist.cpp) --------
// With the service installed, main.js connects to it during a session. While a secure desktop has the
// screen, its pictures arrive here and go into the primary monitor's video track in place of the
// capturer's, which cannot read that desktop; on the lock screen main.js sends the client's input to the
// service's helper, so the person types their password as at the keyboard. UAC prompts are shown only.
const assist = { secure: false, locked: false, input: false, frames: 0, last: null, left: 0, timer: 0 };
const ASSIST_REPEATS = 30, ASSIST_REPEAT_MS = 33; // a still picture brought to full quality (cf. REPEATS in preload.js)
const primaryIndex = (s) => (s && s.sources ? s.sources.findIndex((src) => src.primary) : -1);
function assistTarget() {
  const s = session, i = primaryIndex(s);
  return s && s.native && i >= 0 && s.native[i] ? s.native[i] : null; // only a native track takes our pictures
}
function assistForget() {
  assist.frames = 0; assist.left = 0;
  clearInterval(assist.timer); assist.timer = 0;
  if (assist.last) { assist.last.close(); assist.last = null; }
}
function assistState(m) {
  const was = assist.secure;
  assist.secure = !!m.secure; assist.locked = !!m.locked; assist.input = !!m.input;
  if (!assist.secure) assistForget();
  if (was !== assist.secure) {
    log(!assist.secure ? '보안 화면이 닫혔습니다' : assist.locked ? '잠금 화면: 클라이언트에 보이고, 원격에서 비밀번호를 입력할 수 있습니다' : '보안 화면(UAC 등): 클라이언트에 보이기만 합니다');
  }
  sendLock();
}
function assistFrame(m) {
  const n = assistTarget();
  if (!n || !assist.secure || !m || !m.data) return;
  let frame;
  // GDI leaves the fourth byte 0: BGRX, as the native capturer's pictures (BGRA would make it transparent).
  try { frame = new VideoFrame(m.data, { format: 'BGRX', codedWidth: m.w, codedHeight: m.h, timestamp: Math.round(performance.now() * 1000) }); }
  catch (e) { log('잠금 화면 그림을 쓸 수 없습니다: ' + e.message); return; }
  if (assist.last) assist.last.close();
  assist.last = frame;
  n.writer.write(new VideoFrame(frame, { timestamp: frame.timestamp })).catch(() => {});
  assist.left = ASSIST_REPEATS;
  if (!assist.timer) assist.timer = setInterval(assistRepeat, ASSIST_REPEAT_MS);
  if (++assist.frames === 1) sendLock(); // the picture is live now: the client shows it instead of a notice
}
function assistRepeat() {
  const n = assistTarget();
  if (!n || !assist.last || assist.left <= 0) { clearInterval(assist.timer); assist.timer = 0; return; }
  assist.left--;
  n.writer.write(new VideoFrame(assist.last, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {});
}
if (api.assist) api.assist.onMessage((m) => { if (m.t === 'state') assistState(m); else if (m.t === 'frame') assistFrame(m); });

// ---- native capture (optional) -----------------------------------------------------
// The preload script runs the native capturer and sends each monitor's frames over a message
// port (see preload.js); here they go into a MediaStreamTrackGenerator, which the engine encodes
// and sends like any other video track.
let nativePort = null, nativeTurn = Promise.resolve(), sizeRenewAt = 0;
// Native capture given up for a while, and why (the diagnostics log says it: before 0.8.1 nothing told
// that a host ran on the engine's capturer for hours). A monitor in HDR mode stays that way for good (each
// session would start natively, fail and reconnect); anything else is tried again by a session that starts
// NATIVE_RETRY_MS later: one failed start must not cost native capture until the host restarts.
const NATIVE_RETRY_MS = 10 * 60e3;
let nativeOffUntil = 0, nativeOffWhy = '';
const nativeOff = () => performance.now() < nativeOffUntil;
function nativeGiveUp(why) {
  nativeOffWhy = String(why || 'failed').slice(0, 120);
  nativeOffUntil = nativeOffWhy === 'hdr' ? Infinity : performance.now() + NATIVE_RETRY_MS;
}
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
      if (n && session.soundLater) soundSoon(session); // started on the lock screen: the screen is readable now
    } else if (m.t === 'opened') {
      const done = nativeOpening.get(m.i);
      if (done) { nativeOpening.delete(m.i); done(m); }
    } else if (m.t === 'paused' && session && session.native && session.native[m.i]) {
      // The lock screen or a permission prompt has the screen, or the capturer is starting again
      // after a mode change or a reset of the graphics card. It keeps trying by itself: the session
      // stays and the client keeps the last picture meanwhile.
      log(m.on ? `모니터 ${m.i + 1}: 지금은 화면을 읽을 수 없습니다 (${m.error}) — 다시 읽을 수 있게 되면 이어서 보냅니다` : `모니터 ${m.i + 1}: 화면을 다시 읽습니다`);
      screenPaused(m.i, !!m.on); // the client is told when it lasts (see sendLock)
    } else if (m.t === 'failed' && session && session.native && session.native[m.i]) {
      // A monitor in HDR mode, or one the capturer could not get back (GIVE_UP_MS in
      // native/capture.cpp): go on with the engine's capturer. Only a loop of this session counts:
      // what a loop of an earlier session reported arrives before the first of this session's loops
      // has opened.
      log(`네이티브 캡처 중단 (모니터 ${m.i + 1}: ${m.error}) — 기본 캡처로 다시 연결합니다`);
      if (m.error !== 'size') nativeGiveUp(m.error); // a changed size is a changed monitor setup: that renegotiates by itself
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
  if (nativeOff() || session !== s) return null;
  const port = nativeChannel(), list = [];
  for (let i = 0; i < sources.length; i++) {
    const r = await new Promise((done) => {
      nativeOpening.set(i, done);
      port.postMessage({ t: 'open', i, x: sources[i].x + 8, y: sources[i].y + 8, gap: Math.max(0, Number(cfg.captureGap) || 0),
        rect: { x: sources[i].x, y: sources[i].y, w: sources[i].width, h: sources[i].height } });
      // A capturer that has not answered in 4 s is not asked again: its answer, should it still come,
      // would be taken for the answer to a later request.
      setTimeout(() => { if (nativeOpening.get(i) === done) { nativeOpening.delete(i); nativeGiveUp('no answer'); } done({ ok: false, error: 'no answer' }); }, 4000);
    });
    // Replaced or ended meanwhile: close what was opened for it.
    if (session !== s) { port.postMessage({ t: 'close' }); return null; }
    if (!r.ok || r.width !== sources[i].width || r.height !== sources[i].height) {
      log(`네이티브 캡처를 쓸 수 없습니다 (모니터 ${i + 1}: ${r.ok ? '크기 불일치' : r.error}) — 기본 캡처를 사용합니다`);
      s.capWhy = `monitor ${i + 1}: ${r.ok ? `size ${r.width}x${r.height}, expected ${sources[i].width}x${sources[i].height}` : r.error}`;
      port.postMessage({ t: 'close' });
      s.native = null;
      return null;
    }
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    // waiting: the lock screen or a permission prompt has the screen now; the loop says 'paused' until it can read it.
    list.push({ gen, writer: gen.writable.getWriter(), waiting: !!r.waiting });
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
  forgetPaused(); // the next session's capture loops report for themselves
  assistForget(); // main.js lets go of the service when told the session ended (below)
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
  if (s.connectedAt) {
    // Its 'connect' first, when the address had not come yet (noteConnected then writes nothing).
    if (!s.connectLogged) { s.connectLogged = true; api.access({ ev: 'connect', via: s.route.kind, dev: s.route.id, name: s.who }); }
    api.access({ ev: 'end', via: s.route.kind, dev: s.route.id, name: s.who, ip: s.ip, dur: (Date.now() - s.connectedAt) / 1000, in: s.filesIn, out: s.filesOut, why: reason });
    showDevices(); // no longer "접속 중"
  }
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
      if (s.native && nativePort) {
        nativePort.postMessage({ t: 'show', i, on: !!plan[i] }); // a monitor nobody looks at is not captured
        // Its loop stops reading the screen and so can never report it back: not counted as paused any
        // more (shown again, it reports for itself).
        if (!plan[i]) screenPaused(i, false);
      }
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
// A session that started while the PC was locked (or behind a permission prompt) could not start the
// engine's capture, which brings the sound: its offer has a sound transceiver without a track
// (s.soundLater, see startSession), and once a capture loop delivers a picture again the sound is
// fetched and put on it. Once per session: every start of that capture costs the main process handles.
function soundSoon(s) {
  if (!s || !s.soundLater || s.soundTimer) return;
  s.soundTimer = setTimeout(() => soundNow(s), 1000); // the desktop settles first
}
async function soundNow(s) {
  if (session !== s || !s.soundLater) return;
  const sender = s.soundLater;
  s.soundLater = null;
  let stream;
  try { stream = await capture(s.sources[0], true, false); }
  catch (e) { log('시스템 소리 캡처 불가 — 소리 없이 진행: ' + e.message); return; }
  stream.getVideoTracks().forEach((t) => t.stop());
  const a = stream.getAudioTracks()[0];
  if (!a) return;
  if (session !== s) return void keepSpareAudio(a);
  s.streams.push(new MediaStream([a])); // the teardown keeps it for the next session, as any session's sound
  try { await sender.replaceTrack(a); log('잠금이 풀려 시스템 소리도 보냅니다'); }
  catch (e) { log('시스템 소리를 보낼 수 없습니다: ' + e.message); }
}
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
  } else if (m.t === 'sas') {
    if (api.assist) api.assist.sas(); // Ctrl+Alt+Del for a lock screen that asks for it (the helper refuses it elsewhere)
  } else if (m.t === 'clipget') {
    clipGet(s, Number(m.seq));
  } else if (m.t === 'pair') {
    // The app's own name for its token (see pairDevice); once per session.
    if (s.pairInstall === undefined && typeof m.install === 'string') { s.pairInstall = m.install.slice(0, 64); if (s.pairWait) s.pairWait(); }
  } else if (m.t === 'cs') {
    // Client-side measurements: keep them with ours in the local diagnostics log.
    if (data.length < 6000 && m.s && typeof m.s === 'object') api.diag({ client: m.s, host: s.lastHs || null });
  } else if (data.length < (m.t === 'text' ? 2000 : 500)) { // 'text': up to 400 characters from a phone's keyboard
    if (m.t === 'md' || m.t === 'kd' || m.t === 'text') s.putTouched = true; // see receiveUpload: no drop at an old place after this
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
      s.filesIn += n;
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
// What is being dragged here, said once the drag is seen, where the host can tell without ending it
// (X11): the client app shows it beside the person's pointer while it is carried out of the picture.
function tellDragWhat(s) {
  if (!api.dragWhat) return;
  api.dragWhat().then((what) => { if (what && session === s && s.drag) txTo(s, { t: 'drag', on: true, what }); }, () => {});
}
async function dragOut(s, button) {
  const r = await api.dragOut(button);
  if (session !== s) return;
  if (r.kind === 'files') {
    const n = r.files.filter((f) => !f.dir).length;
    s.filesOut += n;
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
// Meanwhile the client holds the host's pointer still, and a program that starts its drag only on
// motion (GTK 4) would then never start it: every other look moves the pointer a pixel aside and back
// first (input.nudge; X11 only).
async function pollDrag(s, ms) {
  if (s.dragPoll) return;
  s.dragPoll = true;
  try {
    const end = performance.now() + ms;
    for (let i = 0; session === s && performance.now() < end; i++) {
      const on = !!(await api.dragging(i % 2 === 1));
      if (on !== !!s.drag) { s.drag = on; txTo(s, { t: 'drag', on }); if (on) tellDragWhat(s); }
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
  // Whether the screen is locked right now (the session may have started on a locked PC).
  api.hostLocked().then((v) => { screenGone.lock = !!v; screenGone.lockFrom = 'query'; }, () => {}).then(() => { if (session === s) sendLock(true); });
  // Cursor shape (or picture) -> the client draws the cursor itself.
  // Also whether something is being dragged here, so the client knows what leaving its window means.
  // One question at a time: main leaves the picture out when it is the cursor the page says it has
  // (`cur`), and an answer overtaken by a later question could name a cursor without its picture.
  let cur = null, asking = false;
  s.drag = false;
  s.timers.push(setInterval(async () => {
    if (asking) return;
    asking = true;
    try {
      const c = await api.cursor(cur); // the picture comes along only when the cursor changed
      if (!!c.drag !== s.drag) { s.drag = !!c.drag; tx({ t: 'drag', on: s.drag }); if (s.drag) tellDragWhat(s); }
      if (c.k === cur) return;
      cur = c.k;
      tx(c.img ? { t: 'cur', img: c.img, hx: c.hx, hy: c.hy } : { t: 'cur', c: c.c || 'default' });
    } catch {} finally { asking = false; }
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
    let seq = -1, first = true, busy = false;
    s.timers.push(setInterval(async () => {
      if (busy) return; // a reading still under way (sizing files on a network share takes a while)
      busy = true;
      let r;
      try { r = await api.readClip(seq); } catch { r = null; } finally { busy = false; }
      if (session !== s || !r) return;
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
    s.filesOut += r.files.filter((f) => !f.dir).length;
    log(`복사한 파일: ${r.files.filter((f) => !f.dir).length}개를 보냅니다`);
    txTo(s, { t: 'dragdata', kind: 'files', files: r.files, skipped: r.skipped || 0, clip: true });
    sendFiles(s, r.files);
  } else txTo(s, { t: 'dragdata', kind: 'none', why: r.why, clip: true });
}

// The token goes over the session's own connection (DTLS, whose fingerprints the offer and the answer
// carry), never through the relay: someone reading the relay with the key in hand does not pick it up.
async function pairDevice(s) {
  const p = s.pair;
  s.pair = null;
  // The app's own name comes over this connection ('pair'), right after it opened.
  if (s.pairInstall === undefined) await new Promise((r) => { s.pairWait = r; setTimeout(r, 3000); });
  s.pairWait = null;
  if (session !== s) return;
  p.install = typeof s.pairInstall === 'string' ? s.pairInstall : '';
  const r = await api.devices.pair(p).catch(() => null);
  if (session !== s) return;
  if (!r || !r.ok) {
    log('이 클라이언트 앱을 기기로 등록하지 못했습니다' + (r && r.why === 'full' ? ' (등록된 기기가 너무 많습니다: 쓰지 않는 기기를 지우세요)' : r && r.why === 'nostore' ? ' (이 PC의 암호화 저장소를 쓸 수 없습니다)' : ''));
    txTo(s, { t: 'device', ok: false, why: r ? r.why : 'error' });
    return;
  }
  txTo(s, { t: 'device', ok: true, id: r.id, secret: r.secret });
  log(`${p.pc || '이 클라이언트 앱'}을(를) 기기로 등록했습니다 — 다음부터 키 없이 접속합니다`);
}
// The address the session's connection uses (the remote end of the selected candidate pair), for the log.
// The engine does not reveal a peer-reflexive one (the client's own addresses come hidden behind mDNS
// names): then the public address the client learned through STUN, from its answer, if it has one.
async function remoteAddress(pc) {
  let out = { ip: '', kind: '' };
  try {
    const rep = await pc.getStats();
    rep.forEach((r) => {
      const pair = r.type === 'transport' && r.selectedCandidatePairId ? rep.get(r.selectedCandidatePairId) : null;
      const c = pair && rep.get(pair.remoteCandidateId);
      if (c) out = { ip: c.address || c.ip || '', kind: c.candidateType || '' };
    });
  } catch {}
  if (!out.ip) {
    const m = /^a=candidate:\S+ \d+ \S+ \d+ ([0-9A-Fa-f.:]+) \d+ typ srflx/m.exec((pc.remoteDescription && pc.remoteDescription.sdp) || '');
    if (m) out.ip = m[1];
  }
  return out;
}
async function noteConnected(s) {
  const a = await remoteAddress(s.pc);
  if (s.connectLogged) return; // the session ended meanwhile, and its end wrote the entry (teardown)
  s.connectLogged = true;
  s.ip = a.ip;
  const r = s.route;
  api.access({ ev: 'connect', via: r.kind, dev: r.id, name: s.who, ip: a.ip, kind: a.kind });
  if (r.kind === 'device') api.devices.seen(r.id, a.ip); else showDevices();
}
// A client app connected with the key may ask for a token of its own (hello.pair: what it says it is).
function pairWish(hello, route) {
  const p = route.kind === 'key' && hello.pair && typeof hello.pair === 'object' ? hello.pair : null;
  if (!p) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return { pc: str(p.pc, 60), os: str(p.os, 10), osName: str(p.osName, 60), app: str(p.app, 20) };
}
async function startSession(hello, route) {
  teardown('새 접속 요청');
  // The session is the current one from here on, so that a newer hello or a teardown during any of the
  // waits below finds it and closes what it has. After each wait it checks that it still is the
  // current one; if not, it stops there and closes what it got during that wait.
  const s = (session = {
    sid: hello.sid, started: performance.now(), streams: [], timers: [], dropTimer: 0, videoSenders: [], clip: null, native: null,
    mode: hello.mode === 'smooth' ? 'smooth' : 'sharp', encQueue: Promise.resolve(),
    route, pair: pairWish(hello, route), filesIn: 0, filesOut: 0, connectedAt: 0, bind: hello.bind || null, allowed: hello.allowed || '',
  });
  s.who = whoOf(route, s.pair);
  log(`접속 요청 수신 (${s.who}) — 화면 캡처 시작`);
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
  dc.onopen = () => { if (session !== s) return; if (s.stale) renew(s, s.stale); else { startChannelTasks(s, dc); if (s.pair) pairDevice(s); } };
  // The client closed its connection (연결 끊기, its page closed or reloaded). The channel closes at
  // once, while the connection state would say so only after the ICE timeout and the 15-s grace.
  dc.onclose = () => { if (session === s) teardown('클라이언트 연결 종료', true); };
  // Files the client drags or pastes in come on channels it opens (see receiveUpload).
  pc.ondatachannel = (e) => { if (e.channel.label === 'upload' && session === s) receiveUpload(s, e.channel); else try { e.channel.close(); } catch {} };

  // The native capturer when it is there: its images carry no pointer, so nothing has to be hidden
  // on this PC. Otherwise the engine's capturer, with this PC's pointer hidden before capture
  // starts, so that the frames carry no pointer (see input.js).
  s.native = cfg.capture !== 'engine' && !nativeOff() && api.nativeCapture() ? await openNative(s, sources) : null;
  if (session !== s) return; // the loops it opened are closed (see openNative)
  // Why not natively, for this host's log and the diagnostics log (hs.capWhy).
  if (!s.native && !s.capWhy) s.capWhy = cfg.capture === 'engine' ? 'config' : nativeOff() ? `given up: ${nativeOffWhy}` : !api.nativeCapture() ? `no capturer: ${api.nativeWhy ? api.nativeWhy() : '?'}` : 'not opened';
  s.cursorHidden = s.native ? true : await api.hideCursor(true);
  if (session !== s) return;
  log(s.native ? '화면 캡처: 네이티브' : `화면 캡처: 기본(브라우저 엔진) — ${s.capWhy}`);
  Object.assign(s, pickCodec(hello));
  const refine = s.codec === 'AV1' ? (cfg.refine === 'always' ? 'always' : cfg.refine !== false) : false;

  // The lock screen or a permission prompt has the screen: the engine's capture, which brings the sound,
  // cannot start now either (and each start costs the main process handles). The sound follows once a
  // capture loop reads the screen again (soundSoon).
  const unreadable = !!(s.native && s.native.some((n) => n.waiting));
  let audio = false;
  for (let i = 0; i < sources.length; i++) {
    let stream;
    if (i === 0 && cfg.audio) {
      let kept = takeSpareAudio(); // the sound of the session before (see keepSpareAudio)
      if (kept && !s.native) { kept.stop(); kept = null; } // the engine's capture of the picture brings its own
      if (kept) { stream = new MediaStream([kept]); audio = true; audioReuses++; }
      else if (!unreadable) {
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
  // A sound transceiver without a track goes into the offer, so that no renegotiation is needed later.
  if (cfg.audio && unreadable && !audio) {
    s.soundLater = pc.addTransceiver('audio', { direction: 'sendonly', streams: [new MediaStream()] }).sender;
    audio = true;
    log('잠금 화면 상태에서 접속: 화면과 소리는 잠금이 풀리면 이어서 보냅니다');
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
      if (!s.connectedAt) {
        s.connectedAt = Date.now();
        if (s.allowed === 'first') api.gate.firstUsed(); // a new install's free first connection is up: no other gets one
        noteConnected(s);
      }
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
  await route.send({
    app: appHash,
    t: 'offer', sid: s.sid, ts: Date.now(), sdp: pc.localDescription.sdp, ice: cfg.iceServers, audio, codec: s.codec, cursorHidden: s.cursorHidden, os: cfg.hostOs,
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
    s.lastHs = { codec, from: s.codecFrom, enc: impl, availMbps: +(avail / 1e6).toFixed(1), targetMbps: +(target / 1e6).toFixed(1), rtt: rtt != null ? Math.round(rtt * 1000) : null, mons,
      cap: s.native ? 'native' : 'engine', ...(s.native ? {} : { capWhy: String(s.capWhy || '').slice(0, 120) }) };
    try { if (s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'hs', ...s.lastHs })); } catch {}
    if (last) {
      const mbps = ((bytes - last.bytes) * 8) / ((now - last.t) / 1000) / 1e6;
      const why = limit === 'cpu' ? ' · 제한: 이 PC 성능' : limit === 'bandwidth' ? ' · 제한: 네트워크' : '';
      // The encoder's name is hidden by Chromium unless the page captures something through the browser (on
      // a PC without a sound device nothing is): then only the codec.
      const text = `${codec}${impl ? ` (${impl})` : ''} · ${fps.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('/')} fps · ${mbps.toFixed(1)} Mbps · RTT ${rtt != null ? Math.round(rtt * 1000) + ' ms' : '?'} · ${kind === 'relay' ? 'TURN 중계' : 'P2P 직접'}${why}`;
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

// The relay subscription: this host's own topic (the access key's) and one per device token, on one
// connection (ntfy sends each message with the topic it came on). Made anew when a token comes, goes or is
// blocked. The new one is made before the old one is let go, so what is sent meanwhile is not missed: a
// message heard on both is taken once (firstTime; an answer only fits the offer it answers). The route is
// looked up when a message arrives, so a token removed meanwhile is not heard on the old subscription.
async function subscribe() {
  const my = ++subSeq;
  const list = await api.devices.secrets().catch(() => []);
  const next = new Map([[keys.topicHost, master]]);
  for (const d of list) {
    let k;
    try { k = await RD.derive(d.secret, RD.DEVICE); } catch { continue; }
    next.set(k.topicHost, {
      kind: 'device', key: 'dev:' + d.id, id: d.id, name: d.name || '이름 없는 기기', blocked: !!d.blocked, keys: k,
      send: (o) => chan.send(o, { pubTopic: k.topicClient, txKey: k.h2c }),
    });
  }
  if (my !== subSeq) return; // a newer list is on its way
  routes = next;
  const c = RD.channel({
    server: cfg.server, subTopic: [...next.keys()].join(','), pubTopic: keys.topicClient, txKey: keys.h2c,
    rxKey: (t) => { const r = t ? next.get(t) : master; return r ? r.keys.c2h : null; },
    onMessage: (m, t) => { const r = t ? routes.get(t) : master; if (r) onMessage(m, r); },
    onState: (st) => { if (c === chan && !session) status(st === 'open' ? '대기 중 — 접속을 기다리는 중' : '시그널링 서버 재연결 중…', st === 'open' ? 'ok' : 'wait'); },
  });
  chan = c;
  // The subscriptions before this one go once it is open (a minute at most, should it never open): until
  // then the host still hears what comes on the topics it had.
  const before = [...openChans];
  openChans.add(c);
  const drop = () => { for (const x of before) { x.close(); openChans.delete(x); } };
  c.ready.then(drop);
  setTimeout(drop, 60000);
  // A device blocked or removed while its session is on: that session ends, and its client is told not to come back.
  const s = session;
  if (s && s.route.kind === 'device') {
    const now = [...routes.values()].find((r) => r.key === s.route.key);
    if (!now || now.blocked) teardown(now ? '기기 차단' : '기기 삭제');
  }
}
// ---- new devices confirmed at this PC (main.js 'gate'; the user's go-ahead 2026-11-16) -----------------
// While confirmation is on, a hello with the key waits here until the person at this PC presses 허용 (also
// from a registered device: it sees this window), or the client gives the code of their authenticator app
// (opt-in). The hello carries the client page's own public key (`pk`) and is signed with it (`hsig`); the
// answer, a code and a cancel must be signed with it too, so that nobody else holding the key, reading the
// relay, can take the session the person allowed, replace their request or come back in its name. One
// request waits at a time (the same page asking again replaces its own), at most 6 in 10 minutes, each for 2
// minutes. A page allowed once may come again for 12 hours without asking (a reconnect).
const GATE_WAIT = 120e3, ASK_LIMIT = 6, ASK_WINDOW = 600e3, ALLOWED_FOR = 12 * 3600e3;
const GATE_HOW = { host: '이 PC에서 허용', otp: '인증 앱 코드', first: '첫 기기', again: '방금 허용한 기기', off: '' };
let pending = null;
const askTimes = [];
const allowedPks = new Map(); // a client page's pk -> until when it may come again without asking
// 'busy' is answered at most every 10 s and logged at most once a minute (with how many): someone holding the
// key who keeps asking must not use up what this host may send to the relay, nor push the log out.
const busy = { said: -1e12, logged: -1e12, n: 0 };
const helloText = (m) => `hello\n${m.sid}\n${m.ts}\n${m.pk}`;
const allowPk = (pk) => {
  for (const [k, until] of allowedPks) if (until < performance.now()) allowedPks.delete(k);
  if (pk && allowedPks.size < 50) allowedPks.set(pk, performance.now() + ALLOWED_FOR);
};
const unb64 = (s) => { try { return Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0)); } catch { return null; } };
async function importPk(s) {
  const raw = typeof s === 'string' && s.length < 200 ? unb64(s) : null;
  if (!raw) return null;
  try { return await crypto.subtle.importKey('spki', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); } catch { return null; }
}
async function verifySig(pk, text, sig) {
  const s = typeof sig === 'string' && sig.length < 200 ? unb64(sig) : null;
  if (!pk || !s) return false;
  try { return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, s, new TextEncoder().encode(text)); } catch { return false; }
}
function ask(m, route, g) {
  const name = m.pair && typeof m.pair.pc === 'string' && m.pair.pc ? m.pair.pc.slice(0, 60) + ' (앱)' : '브라우저';
  if (!m.bind) {
    // A page from before this host's update (no key of its own): told the host's page is newer, it reloads
    // and comes back with the new one (an offer with only the page's hash: the old page looks at that first).
    // A key that came without a valid signature is refused.
    if (!m.pk) api.getClientHash().then((app) => route.send({ t: 'offer', sid: m.sid, ts: Date.now(), app })).catch(() => {});
    else route.send({ t: 'denied', sid: m.sid, ts: Date.now(), why: 'old' }).catch(() => {});
    return;
  }
  if (pending && pending.m.pk === m.pk) endAsk(); // the same page asking again (only it can sign with its key)
  const now = performance.now();
  while (askTimes.length && now - askTimes[0] > ASK_WINDOW) askTimes.shift();
  if (pending || askTimes.length >= ASK_LIMIT) {
    busy.n++;
    if (now - busy.said >= 10000) { busy.said = now; route.send({ t: 'denied', sid: m.sid, ts: Date.now(), why: 'busy' }).catch(() => {}); }
    if (now - busy.logged >= 60000) {
      busy.logged = now;
      api.access({ ev: 'denied', via: 'key', name, why: 'busy' });
      log(`새 기기 요청이 겹치거나 너무 잦아 받지 않았습니다${busy.n > 1 ? ` (지난 1분 ${busy.n}번)` : ''}. 모르는 요청이 계속되면 키가 샌 것일 수 있습니다: 새 키 발급(등록된 기기도 모두 삭제)`);
      busy.n = 0;
    }
    return;
  }
  askTimes.push(now);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
  const p = (pending = { m, route, name, code, otp: !!g.otp, since: now, tried: new Map() });
  p.timer = setTimeout(() => { if (pending === p) refuse('timeout'); }, GATE_WAIT);
  route.send({ t: 'confirm', sid: m.sid, ts: Date.now(), code, otp: p.otp, locked: !!g.locked, wait: GATE_WAIT }).catch(() => {});
  showAsk(p);
  api.gate.alert(name);
  log(`새 기기가 접속을 요청했습니다: ${name} · 확인 숫자 ${code} — 이 창에서 허용하거나 거부하세요`);
  api.access({ ev: 'asked', via: 'key', name });
}
function endAsk() {
  const p = pending;
  pending = null;
  if (p) clearTimeout(p.timer);
  hideAsk();
  return p;
}
function refuse(why) {
  const p = endAsk();
  if (!p) return;
  p.route.send({ t: 'denied', sid: p.m.sid, ts: Date.now(), why }).catch(() => {});
  api.access({ ev: 'denied', via: 'key', name: p.name, why });
  log(`${p.name}: ${why === 'refused' ? '거부했습니다. 내가 보낸 요청이 아니라면 키가 샌 것일 수 있습니다: 새 키 발급(등록된 기기도 모두 삭제)' : why === 'timeout' ? '2분 안에 허용하지 않아 끝냈습니다' : '막았습니다'}`);
}
async function allow(how) {
  const p = endAsk();
  if (!p) return;
  allowPk(p.m.pk);
  api.access({ ev: 'approved', via: 'key', name: p.name, how });
  log(`${p.name}: 허용했습니다 (${GATE_HOW[how] || how})`);
  try { await startSession(p.m, p.route); } catch (e) {
    log('오류: ' + e.message);
    api.sourcesFailed();
    if (session && session.sid === p.m.sid) teardown('오류', true);
  }
}
// The waiting request in this window: who, the number its screen shows too, 허용 / 거부, the time left.
let askTick = 0;
function showAsk(p) {
  $('askWho').textContent = p.name;
  $('askCode').textContent = p.code;
  $('ask').style.display = '';
  $('askYes').onclick = () => { if (pending === p) allow('host'); };
  $('askNo').onclick = () => { if (pending === p) refuse('refused'); };
  clearInterval(askTick);
  const left = () => { const s = Math.max(0, Math.round((GATE_WAIT - (performance.now() - p.since)) / 1000)); $('askLeft').textContent = `— ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 남음`; };
  left();
  askTick = setInterval(left, 1000);
  window.scrollTo(0, 0);
}
function hideAsk() { clearInterval(askTick); $('ask').style.display = 'none'; }

// Who is on the other end, for the log and the access log. A device's name as the host window has it now
// (a rename does not make a new subscription: devNames, filled by showDevices).
const devNames = new Map();
const refused = new Map(); // a blocked device -> when it was last answered, and how often it asked since
const deviceName = (route) => devNames.get(route.id) || route.name;
const whoOf = (route, pair) => (route.kind === 'device' ? deviceName(route) : pair && pair.pc ? pair.pc + ' (키)' : '키로 접속');

async function onMessage(m, route) {
  if (!m || typeof m.sid !== 'string' || !(Math.abs(Date.now() - m.ts) <= MAX_AGE)) return; // also without a ts
  if (m.sid.length > 64) return; // a sid is 22 characters; a long one would only fill `seen`
  if (route.kind === 'device' && route.blocked) {
    // A blocked device is told so (it would otherwise wait and try again) and nothing else happens. Its
    // token is in someone's hands, who may send one request after another: answered and logged at most
    // once a minute (the relay limits what this host may send, and the log must not fill up).
    if ((m.t === 'ver' || m.t === 'hello') && firstTime(m)) {
      const r = refused.get(route.id) || { at: -Infinity, n: 0 }; // the first is always answered (the page may be young)
      refused.set(route.id, r);
      r.n++;
      if (performance.now() - r.at < 60000) return;
      r.at = performance.now();
      route.send({ t: 'denied', sid: m.sid, ts: Date.now(), why: 'blocked' }).catch(() => {});
      const name = deviceName(route);
      log(`차단한 기기의 접속을 거부했습니다: ${name}${r.n > 1 ? ` (지난 1분 ${r.n}번)` : ''}`);
      api.access({ ev: 'denied', via: 'device', dev: route.id, name, why: 'blocked' });
      r.n = 0;
    }
    return;
  }
  if (m.t === 'ver') {
    // A loader asking for the current client page. Only someone holding the key (or a device's token)
    // can have sent this, and the reply is encrypted to it. The page is skipped when the loader has it.
    if (!firstTime(m)) return; // replay
    try {
      const app = await api.getClientApp();
      const fresh = m.have !== app.hash;
      // `sig`: the release's signature of the page (main.js pageSig), which the client app checks before it runs it.
      await route.send({ t: 'app', sid: m.sid, ts: Date.now(), hash: app.hash, html: fresh ? app.html : undefined, sig: app.sig || undefined });
      log((fresh ? '클라이언트 화면을 최신 버전으로 전송했습니다' : '클라이언트 화면이 이미 최신입니다') + (route.kind === 'device' ? ` (${route.name})` : ''));
    } catch (e) {
      // The loader says so and can be tried again. A session that is live has nothing to do with it.
      log('클라이언트 화면 전송 실패: ' + e.message);
    }
  } else if (m.t === 'hello') {
    if (!firstTime(m)) return; // replay
    // The page's own key, taken only with the hello's signature by it: the answer must be signed with it (see
    // 'answer'), and nobody but that page can come back in its name or replace its request.
    m.bind = await importPk(m.pk);
    if (m.bind && !(await verifySig(m.bind, helloText(m), m.hsig))) m.bind = null;
    if (route.kind === 'key') {
      // New devices confirmed here (see ask): a page allowed a moment ago may come again without asking.
      if (m.bind && (allowedPks.get(m.pk) || 0) > performance.now()) m.allowed = 'again';
      else {
        const g = await api.gate.decide({ app: !!(m.pair && typeof m.pair === 'object') }).catch(() => ({ need: true, otp: false }));
        if (g.need) { ask(m, route, g); return; }
        m.allowed = g.how;
        if (g.how === 'first') {
          // The first connection of a new install: its reconnects come back without asking, and once it is up
          // no other is let in so (gate.firstUsed, see noteConnected).
          allowPk(m.bind ? m.pk : '');
          api.access({ ev: 'approved', via: 'key', name: (m.pair && m.pair.pc) || '', how: 'first' });
        }
      }
    }
    try { await startSession(m, route); } catch (e) {
      log('오류: ' + e.message);
      api.sourcesFailed(); // the monitors main keeps listed may be out of date: it asks Windows again next time
      // Only the session this hello started; a newer one may have taken its place meanwhile. No 'bye':
      // that would tell the client not to try again.
      if (session && session.sid === m.sid) teardown('오류', true);
    }
  } else if (m.t === 'otp' && pending && m.sid === pending.m.sid && route.key === pending.route.key) {
    // The code of the client's authenticator app, signed with that page's own key. A code already checked
    // (heard twice, typed twice) gets the same answer again and is not checked twice.
    const p = pending, code = String(m.code || '').slice(0, 20);
    const again = p.tried.get(code);
    if (again) { if (again !== 'checking') p.route.send(again).catch(() => {}); return; }
    if (!(await verifySig(p.m.bind, `otp\n${m.sid}\n${code}`, m.sig)) || pending !== p || p.tried.has(code)) return;
    p.tried.set(code, 'checking');
    const r = await api.otp.check(code).catch(() => ({ ok: false, why: 'error' }));
    if (pending !== p) return;
    if (r.ok) { allow(r.how); return; }
    // Wrong, or the check is locked (too many wrong codes): the request still waits for 허용 here.
    const reply = { t: 'otp', sid: m.sid, ts: Date.now(), ok: false, why: r.why, left: r.left };
    p.tried.set(code, reply);
    p.route.send(reply).catch(() => {});
    if (r.why === 'locked') log(`${p.name}: 인증 앱 코드를 여러 번 틀려 코드 확인을 잠시 막았습니다. 이 창의 허용은 그대로 됩니다`);
  } else if (m.t === 'cancel' && pending && m.sid === pending.m.sid && route.key === pending.route.key) {
    // The client gave up waiting (its 취소), signed like its code: the next request need not wait for this one.
    const p = pending;
    if (!(await verifySig(p.m.bind, `cancel\n${m.sid}`, m.sig)) || pending !== p) return;
    endAsk();
    log(`${p.name}: 요청을 취소했습니다`);
  } else if (m.t === 'answer' && session && m.sid === session.sid && session.route.key === route.key && session.pc && session.pc.signalingState === 'have-local-offer' && !session.answered) {
    const s = session;
    // From the page that said hello (signed with its key), so that nobody else who holds the key and reads
    // the relay can answer in its place, in a session the person allowed.
    if (s.bind && !(await verifySig(s.bind, `answer\n${m.sid}\n${m.sdp}`, m.sig))) return;
    // Taken once: while subscriptions overlap (see subscribe) the same answer can arrive twice, and a
    // second one applied while the first is still being applied would fail and end the session.
    if (session !== s || s.answered) return;
    s.answered = true;
    try {
      await s.pc.setRemoteDescription({ type: 'answer', sdp: hintBitrate(m.sdp, Math.round(cfg.startBitrateMbps * 1000), Math.round(cfg.minBitrateMbps * 1000), Math.round(cfg.maxTotalMbps * 1000)) });
      log('answer 수신 — 연결 수립 중');
    } catch (e) {
      log('오류: ' + e.message);
      if (session === s) teardown('오류', true);
    }
  }
}

// ---- the installed app's version and updates ------------------------------------------
// The shell (app/updater.js) finds them; here the person at this PC is told and decides. An ordinary
// update waits for "지금 업데이트"; a required one (a serious fault in this version) installs by itself
// and restarts the host once no one is connected. From a source folder (state 'none') only the
// version is shown.
// (showUpdate is a function of its own so that the self-test can show it made-up updates.)
let updateLater = '', updateTold = false; // the version the person put off (until the host starts again); a going back, said once
function showUpdate(u) {
  if (!u) return;
  $('ver').textContent = 'v' + u.version + (u.installed ? '' : ' · 소스 폴더에서 실행 중');
  document.title = 'My Remote Host v' + u.version; // the window's title too
  // "업데이트 확인": the installed app with a feed (from a source folder updates come by git).
  $('updCheck').style.display = u.installed && u.state && u.state !== 'off' && u.state !== 'none' ? '' : 'none';
  $('updCheck').disabled = ['checking', 'downloading', 'ready'].includes(u.state);
  // "나가기": back to the start screen (two big buttons); the host keeps running. Not in the isolated runs.
  $('exitStart').style.display = u.startScreen ? '' : 'none';
  $('ver').title = !u.installed ? '소스 폴더에서 실행 중입니다. 업데이트는 git pull과 설치 스크립트로 합니다.'
    : u.error ? '업데이트를 확인하지 못했습니다: ' + u.error
    : u.checkedAt ? '최신 버전입니다 · 확인 ' + new Date(u.checkedAt).toLocaleTimeString() : '';
  const a = u.available, card = $('upd');
  if (!updateTold) for (const r of u.rolledBack || []) log(`버전 ${r.version}은 이 PC에서 시작하지 못해 이전 버전으로 되돌렸습니다 (${r.why})`);
  updateTold = true;
  if (!a || (a.version === updateLater && !a.required && u.state === 'available')) { card.style.display = 'none'; return; }
  card.style.display = '';
  const pack = a.kind === 'package';
  $('updTitle').textContent = a.required ? `중요 업데이트 ${a.version}` : `새 버전 ${a.version}이 있습니다`;
  $('updText').textContent = u.state === 'downloading' ? `받는 중… ${Math.round((u.progress || 0) * 100)}%`
    : u.state === 'ready' ? (a.required ? '설치했습니다. 원격 접속이 없을 때 호스트를 다시 시작합니다(늦어도 30분 뒤).' : '설치했습니다. 다시 시작합니다…')
    : pack ? '이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요(접속 키와 설정은 그대로 남습니다).'
    : a.required ? '이 버전의 심각한 문제를 고친 업데이트라 자동으로 설치합니다.' + (u.error ? ` (실패: ${u.error} — 다시 시도합니다)` : '')
    : `현재 v${u.version} · ${(a.size / 1024 / 1024).toFixed(1)} MB` + (u.error ? ` · 실패: ${u.error}` : '');
  const ul = $('updNotes');
  ul.textContent = '';
  for (const line of (a.notes && a.notes.ko) || []) { const li = document.createElement('li'); li.textContent = line; ul.append(li); }
  const busy = u.state === 'downloading' || u.state === 'ready';
  $('updGo').style.display = busy || (a.required && !pack) ? 'none' : '';
  $('updGo').textContent = pack ? '내려받기 페이지 열기' : '지금 업데이트';
  $('updGo').onclick = () => { if (pack) api.update.page(); else { if (session) log('업데이트를 설치하고 다시 시작합니다. 접속 중인 클라이언트는 잠시 뒤 다시 연결됩니다.'); api.update.install(); } };
  $('updLater').style.display = busy || a.required ? 'none' : '';
  $('updLater').onclick = () => { updateLater = a.version; card.style.display = 'none'; };
}
// "업데이트 확인": the feed now instead of at the next look (20 s after the start, then every 6 h). An
// update found shows on its card, also one that was put off; otherwise the button's note says how it went.
let updMsgTimer = 0;
async function checkUpdate() {
  $('updCheck').disabled = true;
  $('updMsg').textContent = '확인 중…';
  let u = null;
  try { u = await api.update.check(true); } catch {} // an update found is asked about in a dialog of main's
  updateChecked(u);
}
function updateChecked(u) {
  const m = $('updMsg');
  $('updCheck').disabled = false;
  updateLater = ''; // the person asked: one put off before is shown again
  if (u) showUpdate(u);
  m.textContent = !u ? '확인하지 못했습니다' : u.available ? '' : u.error ? '확인하지 못했습니다: ' + u.error : '최신 버전입니다';
  if (m.textContent) log('업데이트 확인: ' + m.textContent + (u && !u.available && !u.error ? ` (v${u.version})` : ''));
  clearTimeout(updMsgTimer);
  updMsgTimer = setTimeout(() => { m.textContent = ''; }, 20000);
}
function watchUpdates() {
  if (!api.update) return;
  $('updCheck').onclick = checkUpdate;
  $('exitStart').onclick = () => api.startScreen().then((ok) => { if (!ok) log('처음 화면을 열지 못했습니다'); }, () => {});
  api.update.status().then(showUpdate, () => {});
  api.update.onChange(showUpdate);
}

// The lock screen support (Windows; host/assist.js): installed once with administrator rights, from this
// window. Windows asks the person at this PC (UAC), which no one can answer from the client.
const ASSIST_WHY = {
  declined: 'Windows 확인 창에서 취소했습니다', failed: '설치 프로그램이 실패했습니다', missing: '이 버전에 설치 프로그램이 없습니다',
  remote: '원격 접속 중에는 할 수 없습니다. Windows가 이 PC 화면에 관리자 승인 창을 띄우는데, 그 창은 원격에서 누를 수 없습니다. 이 PC 앞에서 해 주세요',
};
function assistDone(what, r) {
  if (r.ok) log(what === 'install' ? '잠금 화면 지원을 설치했습니다' : '잠금 화면 지원을 제거했습니다');
  else log(`잠금 화면 지원 ${what === 'install' ? '설치' : '제거'}: ${ASSIST_WHY[r.why] || r.why}`);
  showAssist(r.status);
}
// The offer at the host's first start (main.js): the card follows it.
if (api.assist && api.assist.onChanged) api.assist.onChanged((m) => {
  if (m && m.busy) api.assist.status().then((st) => showAssist({ ...st, busy: true }), () => {});
  else if (m && m.result) assistDone('install', m.result);
});
async function showAssist(st) {
  if (!api.assist) return;
  st = st || await api.assist.status().catch(() => null);
  const card = $('assist');
  if (!st || !st.supported || !st.bundled) { card.style.display = 'none'; return; }
  card.style.display = '';
  let state, text, go = '';
  const installed = st.state !== 'none';
  if (st.busy) { state = '진행 중…'; text = '이 PC에 뜬 Windows 확인 창(UAC)에서 "예"를 누르세요.'; }
  else if (!installed) {
    state = '설치 안 됨';
    text = '설치하면 이 PC가 잠겨 있을 때도 클라이언트에 잠금 화면이 보이고, 원격에서 비밀번호를 입력해 잠금을 풀 수 있습니다. 비밀번호는 그대로 필요합니다. 관리자 권한으로 한 번 설치합니다(Windows 확인 창이 뜹니다).';
    go = '설치';
  } else if (!st.current) { state = '업데이트 필요'; text = '이 버전의 호스트에 맞게 잠금 화면 지원을 바꿔야 합니다(Windows 확인 창이 뜹니다).'; go = '업데이트'; }
  else if (st.state !== 'running') { state = '멈춤'; text = '잠금 화면 지원 서비스가 멈춰 있습니다. 다시 설치하면 켜집니다.'; go = '다시 설치'; }
  else { state = '켜짐'; text = '이 PC가 잠겨 있어도 원격에서 잠금 화면을 보고 비밀번호를 입력할 수 있습니다. 관리자 권한 확인 창(UAC)은 원격에서 보기만 됩니다.'; }
  $('assistState').textContent = '— ' + state;
  $('assistText').textContent = text;
  $('assistGo').style.display = go && !st.busy ? '' : 'none';
  $('assistGo').textContent = go;
  $('assistOff').style.display = installed && !st.busy ? '' : 'none';
  const act = async (what) => {
    showAssist({ ...st, busy: true });
    const r = await (what === 'install' ? api.assist.install() : api.assist.uninstall()).catch(() => ({ ok: false, why: 'failed' }));
    assistDone(what, r);
  };
  $('assistGo').onclick = () => act('install');
  $('assistOff').onclick = () => act('uninstall');
}

// ---- client apps with a token of their own (host/devices.js), and the access log ---------------------
const two = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => { if (!t) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
let devShowSeq = 0;
async function showDevices() {
  const my = ++devShowSeq;
  const r = await api.devices.list().catch(() => null);
  if (my !== devShowSeq || !r) return;
  devNames.clear();
  for (const d of r.list) devNames.set(d.id, d.name || '이름 없는 기기');
  const box = $('devList');
  box.textContent = '';
  $('devsNote').textContent = (r.list.length ? `— ${r.list.length}대` : '') + (r.note ? ' · 기기 목록 파일을 읽지 못했습니다 (원래 파일은 사본으로 남겨 두었습니다)' : '');
  if (!r.list.length) {
    const p = document.createElement('small');
    p.textContent = '아직 없습니다. 클라이언트 앱에서 접속 키로 한 번 접속하면 그 PC가 여기에 등록되고, 다음부터는 키 없이 접속합니다. 잃어버린 PC는 여기서 차단하거나 삭제하면 그 PC만 끊깁니다.';
    box.append(p);
    return;
  }
  const live = session && session.connectedAt && session.route.kind === 'device' ? session.route.id : null;
  for (const d of r.list) {
    const row = document.createElement('div');
    row.className = 'dev';
    row.dataset.id = d.id;
    const name = document.createElement('b');
    name.textContent = d.name || '이름 없는 기기';
    const tag = document.createElement('span');
    tag.className = 'tag';
    if (d.blocked) { tag.textContent = '차단됨'; tag.classList.add('bad'); } else if (d.id === live) { tag.textContent = '접속 중'; tag.classList.add('on'); } else tag.style.display = 'none';
    const btns = document.createElement('span');
    btns.className = 'btns';
    const button = (text, fn) => { const b = document.createElement('button'); b.className = 'sub mini'; b.textContent = text; b.onclick = fn; btns.append(b); };
    button('이름 바꾸기', () => renameDevice(d, name));
    button(d.blocked ? '차단 해제' : '차단', () => api.devices.block(d.id, !d.blocked).then((ok) => { if (ok) log(`${d.name || '기기'}: ${d.blocked ? '차단을 풀었습니다' : '차단했습니다 — 이 기기는 더 이상 접속할 수 없습니다'}`); }));
    button('삭제', () => api.devices.remove(d.id).then((ok) => { if (ok) log(`${d.name || '기기'}: 삭제했습니다`); }));
    const top = document.createElement('div');
    top.className = 'row';
    top.append(name, tag, btns);
    const meta = document.createElement('small');
    meta.textContent = [d.osName, d.last ? `마지막 접속 ${fmtTime(d.last)}${d.lastIp ? ' (' + d.lastIp + ')' : ''}` : '키 없이 접속한 적 아직 없음', `등록 ${fmtTime(d.added)}`].filter(Boolean).join(' · ');
    row.append(top, meta);
    box.append(row);
  }
}
function renameDevice(d, el) {
  const input = document.createElement('input');
  input.className = 'ren';
  input.value = d.name || '';
  input.maxLength = 40;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const end = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== d.name) api.devices.rename(d.id, v); else showDevices();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); };
  input.onblur = () => end(true);
}
// "접속 기록": what came to this host, the newest first (main.js keeps it in access.log, 90 days).
const ACCESS_WHAT = { connect: '접속', end: '종료', denied: '거부', paired: '기기 등록', asked: '허용 요청', approved: '허용' };
const ACCESS_WHY = { blocked: '차단된 기기', refused: '거부함', timeout: '2분 안에 허용하지 않음', busy: '요청이 겹치거나 너무 잦음', locked: '코드를 여러 번 틀림' };
async function showAccess() {
  const box = $('accessList');
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  const list = await api.accessLog().catch(() => []);
  box.textContent = '';
  if (!list.length) { const p = document.createElement('small'); p.textContent = '기록이 없습니다.'; box.append(p); }
  for (const e of list) {
    const parts = [fmtTime(e.t), ACCESS_WHAT[e.ev] || e.ev, e.name || (e.via === 'device' ? '기기' : '키로 접속')];
    if (e.ip) parts.push(e.ip);
    if (e.ev === 'end') {
      parts.push(`${Math.max(1, Math.round((e.dur || 0) / 60))}분`);
      if (e.in || e.out) parts.push(`파일 받음 ${e.in || 0} · 보냄 ${e.out || 0}`);
    }
    if (e.ev === 'denied') parts.push(ACCESS_WHY[e.why] || e.why || '');
    if (e.ev === 'approved') parts.push(GATE_HOW[e.how] || e.how || '');
    const line = document.createElement('div');
    line.textContent = parts.filter(Boolean).join(' · ');
    box.append(line);
  }
  box.style.display = '';
}

// ---- the settings: new devices confirmed, and the authenticator app (main.js 'gate', 'otp-*') ------------
const GATE_WHY = { remote: '원격 접속 중에는 할 수 없습니다. 이 PC 앞에서 하세요(접속한 사람이 보안 설정을 풀 수 없게 막아 둔 것입니다)', none: '다시 시도하세요' };
async function showGate(info) {
  info = info && 'confirmNew' in info ? info : await api.gate.info().catch(() => null);
  if (!info) return;
  $('gateState').textContent = info.confirmNew ? '켜짐' : '꺼짐';
  $('gateState').className = info.confirmNew ? 'on' : 'off';
  $('gateBtn').textContent = info.confirmNew ? '끄기' : '켜기';
  $('otpState').textContent = info.otp ? (info.locked ? '켜짐 (코드를 여러 번 틀려 잠시 막힘)' : '켜짐') : '꺼짐';
  $('otpState').className = info.otp ? 'on' : 'off';
  $('otpBtn').textContent = info.otp ? '끄기' : '설정';
  $('gateNote').textContent = !info.confirmNew
    ? '꺼져 있으면 접속 키만 있으면 어느 기기든 접속합니다. 키가 샐 때를 대비해 켜 두기를 권합니다.'
    : (info.firstFree ? '처음 접속하는 클라이언트 앱 하나는 묻지 않고 등록합니다. 그다음부터 새 기기는 이 창에서 허용해야 접속됩니다.'
      : '등록되지 않은 기기(브라우저 포함)는 이 창에서 허용해야 접속됩니다. 이미 등록한 기기로 원격 접속해 이 창의 허용을 눌러도 됩니다.')
      + (info.otp ? ' 휴대폰 인증 앱의 코드로도 허용됩니다.' : ' 아무도 이 PC 앞에 없을 때를 위해 휴대폰 인증 앱을 설정해 둘 수 있습니다(선택).');
}
$('gateBtn').onclick = async () => {
  const info = await api.gate.info();
  const r = await api.gate.set(!info.confirmNew);
  log(r.ok ? `새 기기 확인을 ${r.confirmNew ? '켰습니다' : '껐습니다'}` : '새 기기 확인: ' + (GATE_WHY[r.why] || r.why));
  showGate(r);
};
const otpForm = (on) => {
  $('otpSetup').style.display = on ? '' : 'none';
  if (!on) { $('otpQr').textContent = ''; $('otpSecret').textContent = ''; $('otpCode').value = ''; }
};
$('otpBtn').onclick = async () => {
  const info = await api.gate.info();
  if (info.otp) {
    const r = await api.otp.off();
    log(r.ok ? '휴대폰 인증 앱을 껐습니다' : '휴대폰 인증 앱: ' + (GATE_WHY[r.why] || r.why));
    showGate(r);
    return;
  }
  const r = await api.otp.begin();
  if (!r.ok) { log('휴대폰 인증 앱: ' + (GATE_WHY[r.why] || r.why)); return; }
  try { $('otpQr').innerHTML = QR.svg(r.uri, { scale: 4 }); } catch (e) { $('otpQr').textContent = ''; log('QR 코드를 만들지 못했습니다: 아래 키를 인증 앱에 직접 넣으세요'); } // our own markup: numbers only
  $('otpSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
  $('otpMsg').textContent = '';
  otpForm(true);
  $('otpCode').focus();
};
$('otpOk').onclick = async () => {
  const r = await api.otp.confirm($('otpCode').value.trim());
  if (!r.ok) { $('otpMsg').textContent = r.why === 'code' ? '코드가 맞지 않습니다. 앱에 지금 보이는 6자리를 넣으세요.' : '설정하지 못했습니다: ' + (GATE_WHY[r.why] || r.why); return; }
  otpForm(false);
  log('휴대폰 인증 앱을 설정했습니다. 휴대폰을 잃어버리면 등록한 다른 기기로 접속해 이 창에서 허용하거나, 이 PC 앞에서 다시 설정하세요');
  showGate(r);
};
$('otpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('otpOk').click(); });
$('otpCancel').onclick = () => otpForm(false);

(async () => {
  cfg = await api.getConfig();
  keys = await RD.derive(cfg.key);
  master = { kind: 'key', key: 'key', keys, send: (o) => chan.send(o) };
  await subscribe();
  api.devices.onChanged((resub) => { if (resub) subscribe(); showDevices(); showGate(); });
  showDevices();
  showGate();
  $('accessBtn').onclick = showAccess;
  log('시그널링 서버: ' + cfg.server);
  log('호스트 시작: ' + new Date().toLocaleString());
  if (cfg.viewOnly) log('주의: 이 PC에서는 원격 입력을 넣을 수 없어 보기 전용으로 동작합니다 (' + cfg.viewOnly + ')');
  if (cfg.updateNote) log('주의: ' + cfg.updateNote);
  watchUpdates();
  showAssist();

  let shown = false;
  $('show').onclick = () => { shown = !shown; $('key').textContent = shown ? cfg.key : '••••••••••••••••••••••••'; $('show').textContent = shown ? '숨기기' : '표시'; };
  $('copy').onclick = async () => { await api.copyKey(); log('접속 키를 클립보드에 복사했습니다'); };
  $('regen').onclick = () => api.regenKey();
  $('kick').onclick = () => teardown('사용자가 끊음');
  api.onKick(() => teardown('사용자가 끊음'));
  api.onHostLock((on) => {
    screenGone.lockFrom = 'event';
    if (screenGone.lock === on) return;
    screenGone.lock = on;
    if (!on) unlocked();
    log(on ? '이 PC가 잠겼습니다' : '이 PC의 잠금이 풀렸습니다');
    sendLock();
  });
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
