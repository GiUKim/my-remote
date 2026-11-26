const api = window.hostApi;
const $ = (id) => document.getElementById(id);
// The language (host/i18n.js, loaded before this script): t() gives every text this window shows in this PC's
// language, and a change made anywhere on this PC (here, the client app, a session's toolbar) draws them again
// at once (relabel). Lines already in the log stay as they were written.
const I18N = window.MRI18N;
let t = I18N.translator('ko');
const relabel = new Set();
function useLang(code) {
  t = I18N.translator(code, api.strings(code));
  I18N.apply(document, t);
  I18N.fillSelect($('lang'), code);
  for (const f of relabel) { try { f(); } catch (e) { console.error('relabel', e); } }
}
// A name this host gives a connection (whoOf, ask; kept in Korean in the access log as the source of the text):
// a device's own name, or a few words of ours, said in this language.
const whoText = (name) => {
  const s = String(name || ''), m = /^(.*) \((키|앱)\)$/.exec(s);
  return m ? `${m[1]} (${t(m[2])})` : t(s);
};
I18N.fonts(document);
useLang(api.lang());
$('lang').onchange = () => { api.setLang($('lang').value).catch(() => {}); };
api.onLang(useLang);
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
  const line = `${new Date().toLocaleTimeString(t.lang)}  ${s}`;
  $('log').textContent = (line + '\n' + $('log').textContent).slice(0, 6000);
  api.log(s);
}
// The status line: its Korean source and arguments are kept, so that it is said again in a new language.
let statusNow = null;
function status(text, cls, ...args) { statusNow = [text, cls, args]; $('status').textContent = t(text, ...args); $('dot').className = 'dot ' + cls; }
relabel.add(() => { if (statusNow) status(statusNow[0], statusNow[1], ...statusNow[2]); });
// The numbers under it (every 2 s during a session, see the stats loop): numbers kept, words said again.
const statsText = (x) => `${x.head} · ${x.relay ? t('TURN 중계') : t('P2P 직접')}${x.limit === 'cpu' ? ' · ' + t('제한: 이 PC 성능') : x.limit === 'bandwidth' ? ' · ' + t('제한: 네트워크') : ''}`;
relabel.add(() => { if (session && session.statsLine && $('stats').textContent) $('stats').textContent = statsText(session.statsLine); });
// The status line while no session is on: waiting, unless the relay refuses what this host sends (relayLimit).
function idle() {
  if (relayLimit.on) status('대기 중 — 시그널링 서버가 메시지를 받지 않아 지금은 접속할 수 없습니다', 'wait');
  else status('대기 중 — 접속을 기다리는 중', 'ok');
}

// ---- the relay refusing what this host sends (HTTP 429) ---------------------------------------------
// ntfy.sh takes a limited number of messages a day from one internet address (anonymous: 250, seen 2026-11-25;
// every 3000 characters of a message are one, so the client page, sent whole after each update, is up to 36),
// and PCs behind the same router share that address. Once they are used up the relay answers HTTP 429 to every
// message until the limit resets: no client can connect (its loader says the host does not answer), and nothing
// can tell it why, since telling it is a message too. Reported 2026-11-25 by the person, connecting from home
// while three updates in one day had used the office's messages up. So this window says so, and when the relay
// takes messages again, which the relay itself tells (`/v1/account`, without an account: asked when the refusals
// begin, then at most every 10 minutes while they last and once at the reset; asking publishes nothing). Every
// message to a client goes through relaySend; one that goes through again ends it.
const RELAY_RECHECK = 600e3, RELAY_BURST = 180e3, RELAY_ASK_GAP = 30e3;
// kind: 'daily' (the day's messages are used up: the account says none remain), 'burst' (some remain: too many
// at once, which ntfy gives back within minutes), '' (no account answered: another relay, or none could be asked).
const relayLimit = { on: false, kind: '', reset: 0, limit: 0, asked: -1e12, asking: false, timer: 0, told: false };
function relaySend(o, to) {
  return chan.send(o, to).then(
    () => { if (relayLimit.on) relayFree(false); },
    (e) => { if (/HTTP 429\b/.test((e && e.message) || '')) relayRefused(); throw e; },
  );
}
function relayRefused() {
  if (relayLimit.on) return;
  Object.assign(relayLimit, { on: true, kind: '', reset: 0, limit: 0, told: false });
  log(t('시그널링 서버가 이 PC에서 보내는 메시지를 받지 않습니다 (HTTP 429)'));
  showRelayLimit();
  relayCheck();
}
// quiet: the refusals were too many at once and are surely over by now (nothing was sent to find out).
function relayFree(quiet) {
  clearTimeout(relayLimit.timer);
  if (!relayLimit.on) return;
  relayLimit.on = false;
  if (!quiet) log(t('시그널링 서버가 다시 메시지를 받습니다'));
  showRelayLimit();
}
async function relayAccount() {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`${cfg.server}/v1/account`, { signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return null;
    const j = await r.json(), st = j && j.stats, lim = j && j.limits;
    if (!st || typeof st.messages_remaining !== 'number') return null;
    return {
      remaining: st.messages_remaining,
      limit: lim && typeof lim.messages === 'number' ? lim.messages : 0,
      reset: typeof st.reset_at === 'number' && st.reset_at > 0 ? st.reset_at * 1000 : 0,
    };
  } catch { return null; } finally { clearTimeout(tm); }
}
async function relayCheck() {
  clearTimeout(relayLimit.timer);
  if (!relayLimit.on || relayLimit.asking) return;
  const since = performance.now() - relayLimit.asked;
  if (since < RELAY_ASK_GAP) { relayLimit.timer = setTimeout(relayCheck, RELAY_ASK_GAP - since); return; }
  relayLimit.asked = performance.now();
  relayLimit.asking = true;
  const a = await relayAccount();
  relayLimit.asking = false;
  if (!relayLimit.on) return;
  if (a && a.remaining > 0 && relayLimit.kind === 'daily') { relayFree(false); return; } // the limit was reset
  let wait = RELAY_RECHECK;
  if (a) {
    relayLimit.kind = a.remaining > 0 ? 'burst' : 'daily';
    relayLimit.limit = a.limit;
    relayLimit.reset = relayLimit.kind === 'daily' ? a.reset : 0;
    if (relayLimit.kind === 'burst') wait = RELAY_BURST;
    else if (relayLimit.reset > Date.now()) wait = Math.min(wait, relayLimit.reset - Date.now() + 5000);
  }
  showRelayLimit();
  if (!relayLimit.told) { relayLimit.told = true; log($('relayText').textContent); }
  relayLimit.timer = setTimeout(() => (relayLimit.kind === 'burst' ? relayFree(true) : relayCheck()), wait);
}
function showRelayLimit() {
  const L = relayLimit;
  $('relayNote').style.display = L.on ? '' : 'none';
  if (!session) idle();
  if (!L.on) return;
  let host = cfg.server;
  try { host = new URL(cfg.server).host; } catch {}
  const when = L.reset ? new Date(L.reset).toLocaleString(t.lang, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const [title, text] = L.kind === 'daily' ? [
    t('시그널링 서버의 하루 한도를 다 써서 지금은 다른 PC에서 이 PC에 접속할 수 없습니다'),
    when ? t('한도는 {0}에 풀립니다. {1}는 인터넷 주소 하나에서 하루 {2}개의 메시지만 받고, 같은 공유기를 쓰는 PC들이 이 한도를 함께 씁니다. 업데이트 직후의 첫 접속은 화면 페이지를 보내느라 30개 넘게 씁니다.', when, host, L.limit || '?')
      : t('한도가 풀릴 때까지 기다려야 합니다. {0}는 인터넷 주소 하나에서 하루 {1}개의 메시지만 받고, 같은 공유기를 쓰는 PC들이 이 한도를 함께 씁니다. 업데이트 직후의 첫 접속은 화면 페이지를 보내느라 30개 넘게 씁니다.', host, L.limit || '?'),
  ] : L.kind === 'burst' ? [
    t('시그널링 서버가 이 PC의 메시지를 잠시 받지 않습니다'),
    t('짧은 시간에 메시지를 너무 많이 보냈습니다. 보통 몇 분 안에 다시 받습니다.'),
  ] : [
    t('시그널링 서버가 이 PC의 메시지를 받지 않아 지금은 다른 PC에서 이 PC에 접속할 수 없습니다'),
    t('{0}가 메시지가 너무 많다고 답했습니다 (HTTP 429). 서버가 정한 한도가 풀리면 다시 접속할 수 있습니다.', host),
  ];
  $('relayTitle').textContent = title;
  $('relayText').textContent = text;
}
relabel.add(() => { if (relayLimit.on) showRelayLimit(); });

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
  // live: the secure desktop's picture is in the video of the monitors `ds` (`d`: the primary when it is
  // among them, where the password box is); input: the person may type into it (the lock screen; never a
  // UAC prompt).
  const ds = why && assist.secure ? assistLive() : [];
  const live = ds.length > 0;
  const key = why + (live ? (assist.input ? '+live+input:' : '+live:') + ds.join(',') : '');
  if (!force && screenGone.sentFor === s && screenGone.sent === key) return;
  screenGone.sentFor = s; screenGone.sent = key;
  const msg = why ? { t: 'lock', on: true, why, live, input: live && assist.input, d: live ? ds[0] : undefined, ds: live ? ds : undefined } : { t: 'lock', on: false };
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
  api.hostLocked().then((v) => { if (!v && screenGone.lock && screenGone.lockFrom === 'query') { screenGone.lock = false; unlocked(); log(t('이 PC의 잠금이 풀렸습니다')); sendLock(); } }, () => {});
}, 2000);

// ---- the lock screen through the assist service (Windows; host/assist.js, native/winassist.cpp) --------
// With the service installed, main.js connects to it during a session. While a secure desktop has the
// screen, its pictures arrive here and go into each monitor's video track in place of the capturer's,
// which cannot read that desktop (a service from before 2026-11-18 sends the primary monitor's only); on
// the lock screen main.js sends the client's input to the service's helper, so the person types their
// password as at the keyboard. UAC prompts are shown only.
// mons: monitor index -> { last: the last picture, left: repeats still to send, at: when it last went }.
// held: frames of the capturer kept out of a video that has the secure desktop's picture (see nativeChannel).
const assist = { secure: false, locked: false, input: false, mons: new Map(), timer: 0, held: 0 };
const ASSIST_REPEATS = 30, ASSIST_REPEAT_MS = 33; // a still picture brought to full quality (cf. REPEATS in preload.js)
// How often a still picture goes again once it is sharp (config keepAlive; 0: never), so that the client never
// asks for a key frame: see the keep-alive in preload.js. Here for the lock screen's pictures, a typed
// password's next dot after a pause; preload.js is given the same for the capturer's.
const keepAliveMs = () => (cfg && cfg.keepAlive > 0 ? Math.max(200, Number(cfg.keepAlive)) : 0);
// The lock screen's pictures are stamped on the capturer's clock (the page's: preload.js), always rising.
let assistTs = 0;
const frameTs = () => (assistTs = Math.max(assistTs + 1, Math.round(performance.now() * 1000)));
const primaryIndex = (s) => (s && s.sources ? s.sources.findIndex((src) => src.primary) : -1);
// Which monitor a picture is of: by its rectangle on the virtual screen (physical pixels, as the sources'),
// else by its top left; one without a place ('F') is the primary's. -1: none of this session's.
function assistMonitor(s, m) {
  if (!s || !s.sources) return -1;
  if (typeof m.x !== 'number') return primaryIndex(s);
  const same = s.sources.findIndex((src) => src.x === m.x && src.y === m.y && src.width === m.w && src.height === m.h);
  return same >= 0 ? same : s.sources.findIndex((src) => src.x === m.x && src.y === m.y);
}
function assistTarget(i) {
  const s = session;
  return s && s.native && i >= 0 && s.native[i] ? s.native[i] : null; // only a native track takes our pictures
}
// The monitors whose secure-desktop picture is in their video now, the primary first.
function assistLive() {
  const p = primaryIndex(session);
  return [...assist.mons.keys()].filter((i) => assistTarget(i)).sort((a, b) => (b === p) - (a === p) || a - b);
}
function assistForget() {
  clearTimeout(assist.timer); assist.timer = 0;
  for (const e of assist.mons.values()) if (e.last) e.last.close();
  assist.mons.clear();
}
function assistState(m) {
  const was = assist.secure;
  assist.secure = !!m.secure; assist.locked = !!m.locked; assist.input = !!m.input;
  if (!assist.secure) assistForget();
  if (was !== assist.secure) {
    log(!assist.secure ? t('보안 화면이 닫혔습니다') : assist.locked ? t('잠금 화면: 클라이언트에 보이고, 원격에서 비밀번호를 입력할 수 있습니다') : t('보안 화면(UAC 등): 클라이언트에 보이기만 합니다'));
  }
  sendLock();
}
function assistFrame(m) {
  if (!assist.secure || !m || !m.data) return;
  const i = assistMonitor(session, m), n = assistTarget(i);
  if (!n) return;
  let frame;
  // GDI leaves the fourth byte 0: BGRX, as the native capturer's pictures (BGRA would make it transparent).
  try { frame = new VideoFrame(m.data, { format: 'BGRX', codedWidth: m.w, codedHeight: m.h, timestamp: frameTs() }); }
  catch (e) { log(t('잠금 화면 그림을 쓸 수 없습니다: {0}', e.message)); return; }
  const e = assist.mons.get(i), first = !e;
  if (e && e.last) e.last.close();
  assist.mons.set(i, { last: frame, left: ASSIST_REPEATS, at: performance.now() });
  n.writer.write(new VideoFrame(frame, { timestamp: frame.timestamp })).catch(() => {});
  assistAgain(ASSIST_REPEAT_MS);
  if (first) sendLock(); // this monitor's picture is live now: the client shows it instead of a notice
}
function assistAgain(ms) { clearTimeout(assist.timer); assist.timer = setTimeout(assistRepeat, ms); }
// The repeats of each monitor's last picture, then the keep-alive, each monitor's on its own time; ends when no
// picture has a video to go into (a new session's starts again with the next picture) and with the secure
// desktop (assistForget). Before 2026-11-20 the keep-alive was looked at a whole `keep` after any monitor's
// repeats ended, so another monitor's came up to that much late (1.5 s apart, measured with three monitors).
function assistRepeat() {
  assist.timer = 0;
  const keep = keepAliveMs(), now = performance.now();
  let more = false, next = Infinity; // next: ms until the next keep-alive is due
  for (const [i, e] of assist.mons) {
    const n = assistTarget(i);
    if (!n || !e.last) continue;
    if (e.left > 0) e.left--;
    else if (!keep) continue;
    else if (now - e.at < keep - 5) { next = Math.min(next, e.at + keep - now); continue; }
    e.at = now;
    n.writer.write(new VideoFrame(e.last, { timestamp: frameTs() })).catch(() => {});
    if (e.left > 0) more = true;
    else if (keep) next = Math.min(next, keep);
  }
  if (more) assistAgain(ASSIST_REPEAT_MS);
  else if (next < Infinity) assistAgain(Math.max(ASSIST_REPEAT_MS, next));
}
// Only during a session: main.js lets go of the service when one ends, and what is still on its way from that
// connection then must not bring back what teardown forgot.
if (api.assist) api.assist.onMessage((m) => { if (!session) return; if (m.t === 'state') assistState(m); else if (m.t === 'frame') assistFrame(m); });

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
      // The secure desktop's picture (the assist service's) is in this monitor's video: the capturer cannot read
      // that desktop, and what it still sends, its last picture of the desktop (the rest of a series of repeats
      // under way when the screen locked, or a whole series that a 'show' starts when the client changes what it
      // shows), went into the same encoder in turn with the lock screen's: the desktop flickered over it, or stood
      // there for a second (found in a review, 2026-11-20). Kept out until the secure desktop is gone.
      if (n && assist.secure && assist.mons.has(m.i)) { assist.held++; m.frame.close(); return; }
      if (n) { n.written = (n.written || 0) + 1; n.writer.write(m.frame).catch(() => {}); } else m.frame.close(); // `written`: see stalled()
      if (n && session.soundLater) soundSoon(session); // started on the lock screen: the screen is readable now
    } else if (m.t === 'opened') {
      const done = nativeOpening.get(m.i);
      if (done) { nativeOpening.delete(m.i); done(m); }
    } else if (m.t === 'paused' && session && session.native && session.native[m.i]) {
      // The lock screen or a permission prompt has the screen, or the capturer is starting again
      // after a mode change or a reset of the graphics card. It keeps trying by itself: the session
      // stays and the client keeps the last picture meanwhile.
      log(m.on ? t('모니터 {0}: 지금은 화면을 읽을 수 없습니다 ({1}) — 다시 읽을 수 있게 되면 이어서 보냅니다', m.i + 1, m.error) : t('모니터 {0}: 화면을 다시 읽습니다', m.i + 1));
      screenPaused(m.i, !!m.on); // the client is told when it lasts (see sendLock)
    } else if (m.t === 'failed' && session && session.native && session.native[m.i]) {
      // A monitor in HDR mode, or one the capturer could not get back (GIVE_UP_MS in
      // native/capture.cpp): go on with the engine's capturer. Only a loop of this session counts:
      // what a loop of an earlier session reported arrives before the first of this session's loops
      // has opened.
      log(t('네이티브 캡처 중단 (모니터 {0}: {1}) — 기본 캡처로 다시 연결합니다', m.i + 1, m.error));
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
      port.postMessage({ t: 'open', i, x: sources[i].x + 8, y: sources[i].y + 8, gap: Math.max(0, Number(cfg.captureGap) || 0), gpu: cfg.capture === 'gpu', keep: keepAliveMs(),
        rect: { x: sources[i].x, y: sources[i].y, w: sources[i].width, h: sources[i].height } });
      // A capturer that has not answered in 4 s is not asked again: its answer, should it still come,
      // would be taken for the answer to a later request.
      setTimeout(() => { if (nativeOpening.get(i) === done) { nativeOpening.delete(i); nativeGiveUp('no answer'); } done({ ok: false, error: 'no answer' }); }, 4000);
    });
    // Replaced or ended meanwhile: close what was opened for it.
    if (session !== s) { port.postMessage({ t: 'close' }); return null; }
    if (!r.ok || r.width !== sources[i].width || r.height !== sources[i].height) {
      log(t('네이티브 캡처를 쓸 수 없습니다 (모니터 {0}: {1}) — 기본 캡처를 사용합니다', i + 1, r.ok ? t('크기 불일치') : r.error));
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
  // main.js lets go of the service when told the session ended (below), and the next session's connection to it
  // says afresh how the screen is (assist.js setState). Kept, what it said last outlived the session: a lock
  // screen unlocked at the PC before the next session was still "locked" for that session's client, over the
  // desktop (found in a review, 2026-11-20).
  assistForget();
  assist.secure = assist.locked = assist.input = false;
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
  idle();
  log(t('세션 종료: {0}', t(reason)));
  if (s.connectedAt) {
    // Its 'connect' first, when the address had not come yet (noteConnected then writes nothing).
    if (!s.connectLogged) { s.connectLogged = true; api.access({ ev: 'connect', via: s.route.kind, dev: s.route.id, name: s.who }); }
    api.access({ ev: 'end', via: s.route.kind, dev: s.route.id, name: s.who, ip: s.ip, dur: (Date.now() - s.connectedAt) / 1000, in: s.filesIn, out: s.filesOut, why: reason });
    showDevices(); // no longer "접속 중"
  }
  // A session on a one-time code: the code ends a moment later, unless its page comes back (see oneTime).
  if (s.route.kind === 'code' && oneTime && oneTime.pk) {
    const o = oneTime;
    clearTimeout(o.timer);
    o.timer = setTimeout(() => { if (oneTime === o && !(session && session.route.kind === 'code')) endOneTime('done'); }, ONE_TIME_GRACE_MS);
    showOneTime();
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
    } catch (e) { log(t('코덱 우선순위 설정 실패(기본값 사용): {0}', e.message)); }
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
        // 'detail' in both modes. With 'motion' (smooth mode up to 0.9.2) Chromium 156 encodes the screen as
        // camera content: in the bench 22-23 dB while scrolling (text unreadable), QP about 200, 35 of 50
        // captured frames encoded, and on the narrow link the picture fell to 107x60. Smooth mode is 'balanced'
        // instead: the engine lowers frame rate and size as it sees fit, which measured smoother than holding the
        // frame rate on every link, at the same sharpness as the sharp mode (2026-11-18, see CLAUDE.md).
        sender.track.contentHint = 'detail';
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) continue;
        p.encodings[0].active = !!plan[i];
        p.encodings[0].scaleResolutionDownBy = plan[i] ? plan[i].scale : 1;
        p.encodings[0].maxBitrate = Math.round((plan[i] ? plan[i].mbps : 1.5) * 1e6);
        p.encodings[0].maxFramerate = cfg.maxFps;
        p.degradationPreference = smooth ? 'balanced' : 'maintain-resolution';
        await sender.setParameters(p);
      } catch (e) { log(t('인코더 설정 실패: {0}', e.message)); }
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
  catch (e) { log(t('시스템 소리 캡처 불가 — 소리 없이 진행: {0}', e.message)); return; }
  stream.getVideoTracks().forEach((t) => t.stop());
  const a = stream.getAudioTracks()[0];
  if (!a) return;
  if (session !== s) return void keepSpareAudio(a);
  s.streams.push(new MediaStream([a])); // the teardown keeps it for the next session, as any session's sound
  try { await sender.replaceTrack(a); log(t('잠금이 풀려 시스템 소리도 보냅니다')); }
  catch (e) { log(t('시스템 소리를 보낼 수 없습니다: {0}', e.message)); }
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
    log(t('화질 모드: {0}', s.mode === 'smooth' ? t('부드러움 우선') : t('선명도 우선')));
  } else if (m.t === 'clip') {
    if (cfg.clipboard && typeof m.s === 'string' && m.s.length <= CLIP_MAX) { s.clip = m.s; api.writeClip(m.s); }
  } else if (m.t === 'dragout') {
    dragOut(s, m.b | 0);
  } else if (m.t === 'dragq') {
    pollDrag(s, 1200);
  } else if (m.t === 'caretq') {
    caretQuery(s);
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
  } else if (m.t === 'lang') {
    // The client page's texts in the language of the PC it runs on (host/i18n/page*.json, which always match the
    // page this host serves), once per language and session: at most one answer per language offered, a dozen
    // tables of some 15 KB. The page keeps them (see its useLang): someone trying the languages one after another
    // gets each (a limit of 4 left the fifth one tried in Korean; found by the self-test's walk through all twelve).
    const l = I18N.normalize(m.l);
    s.langsSent = s.langsSent || new Set();
    if (l && l !== 'ko' && I18N.CODES.includes(l) && !s.langsSent.has(l)) {
      s.langsSent.add(l);
      const strings = api.pageStrings(l);
      try { if (strings && dc.readyState === 'open') dc.send(JSON.stringify({ t: 'strings', l, s: strings })); } catch {}
    }
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
    log(t('받기 실패: {0}', why));
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
      log(t('받기: 파일 {0}개 — {1}', n, r.how + (r.why ? ' (' + r.why + ')' : '')));
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
    log(t('끌어내기: 파일 {0}개를 보냅니다', n) + (r.skipped ? ' ' + t('({0}개는 제외: 너무 많거나 큼)', r.skipped) : ''));
    txTo(s, { t: 'dragdata', kind: 'files', files: r.files, skipped: r.skipped || 0 });
    sendFiles(s, r.files);
  } else if (r.kind === 'text') {
    log(t('끌어내기: 글자 {0}자를 보냅니다', r.s.length));
    txTo(s, { t: 'dragdata', kind: 'text', s: r.s, cut: !!r.cut });
  } else {
    log(t('끌어내기: 가져올 것이 없습니다 — {0}', r.why));
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
// A phone tapped the picture (the client sends `caretq` right after its click): whether a text caret came up there,
// so that the phone's keyboard comes up by itself (main.js caretForClient). Programs take a moment to put the focus
// where it was clicked, and a Chromium program tells only from a moment after the first question (see main.js), so it
// is looked at a few times over a second; the first caret seen is said at once.
// A new tap starts again. Answered once: { on: true, d, x, y, h } (where: the keyboard must not cover it),
// { on: false } (none: a keyboard brought up by an earlier tap goes down), or nothing at all when this host cannot
// tell (Linux for now; an old DLL).
const CARET_LOOKS = [120, 200, 300, 400];
async function caretQuery(s) {
  const my = s.caretSeq = (s.caretSeq || 0) + 1;
  let got = null;
  for (const wait of CARET_LOOKS) {
    await new Promise((r) => setTimeout(r, wait));
    if (session !== s || s.caretSeq !== my) return;
    got = await api.caret().catch(() => null);
    if (session !== s || s.caretSeq !== my) return;
    if (!got || got.on) break;
  }
  if (!got) return;
  txTo(s, got.on ? { t: 'caret', on: true, d: got.d, x: got.x, y: got.y, h: got.h || 0, field: !!got.field } : { t: 'caret', on: false });
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
    log(t('끌어내기: 파일 전송을 마쳤습니다'));
  } catch (e) {
    log(t('끌어내기: 파일 전송 실패 — {0}', e.message));
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
    log(t('복사한 파일: {0}개를 보냅니다', r.files.filter((f) => !f.dir).length));
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
    log(r && r.why === 'full' ? t('이 클라이언트 앱을 기기로 등록하지 못했습니다 (등록된 기기가 너무 많습니다: 쓰지 않는 기기를 지우세요)')
      : r && r.why === 'nostore' ? t('이 클라이언트 앱을 기기로 등록하지 못했습니다 (이 PC의 암호화 저장소를 쓸 수 없습니다)') : t('이 클라이언트 앱을 기기로 등록하지 못했습니다'));
    txTo(s, { t: 'device', ok: false, why: r ? r.why : 'error' });
    return;
  }
  txTo(s, { t: 'device', ok: true, id: r.id, secret: r.secret });
  log(p.pc ? t('{0}을(를) 기기로 등록했습니다 — 다음부터 키 없이 접속합니다', p.pc) : t('이 클라이언트 앱을 기기로 등록했습니다 — 다음부터 키 없이 접속합니다'));
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
  log(t('접속 요청 수신 ({0}) — 화면 캡처 시작', whoText(s.who)));
  status('연결 협상 중…', 'wait');
  const sources = await (s.sourcesP = api.getSources());
  if (session !== s) return;
  if (!sources.length) { log(t('캡처할 모니터를 찾지 못했습니다')); teardown('모니터 없음', true); return; }
  for (const src of sources) if (src.hdr) log(t('주의: 모니터 {0}은 Windows HDR이 켜져 있어 원격 화면에서 색이 밝게 날아갑니다. 이 PC의 설정 > 시스템 > 디스플레이에서 그 모니터의 HDR을 끄면 정상으로 보입니다.', src.idx + 1));
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
  log(s.native ? t('화면 캡처: 네이티브') : t('화면 캡처: 기본(브라우저 엔진) — {0}', s.capWhy));
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
        catch (e) { log(t('시스템 소리 캡처 불가 — 소리 없이 진행: {0}', e.message)); }
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
    log(t('잠금 화면 상태에서 접속: 화면과 소리는 잠금이 풀리면 이어서 보냅니다'));
  }
  preferCodec(pc, s.codec);

  pc.onconnectionstatechange = () => {
    if (session !== s) return;
    const st = pc.connectionState;
    log(t('연결 상태: {0}', st));
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
    } else if (st === 'failed' || st === 'closed') teardown(st === 'failed' ? '연결 실패' : '연결 닫힘');
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
    // `instance`: this start of the host, which a client app keeps in its live.json while it controls this PC (cycle.js).
    t: 'offer', sid: s.sid, ts: Date.now(), sdp: pc.localDescription.sdp, ice: cfg.iceServers, audio, codec: s.codec, cursorHidden: s.cursorHidden, os: cfg.hostOs, instance: cfg.instance,
    monitors: sources.map((src, i) => ({ idx: i, mid: mids[i], x: src.x, y: src.y, width: src.width, height: src.height, primary: src.primary, hdr: src.hdr || undefined })),
  });
  if (session !== s) return; // ended while the offer was being posted: no timers for it
  log(audio ? t('offer 전송 (모니터 {0}개, 소리 포함)', sources.length) : t('offer 전송 (모니터 {0}개)', sources.length));
  // Give up if the client never completes the handshake.
  s.dropTimer = setTimeout(() => { if (session === s && pc.connectionState !== 'connected') teardown('협상 시간 초과'); }, 30000);

  let last = null;
  s.timers.push(setInterval(async () => {
    if (session !== s) return;
    if (pc.connectionState !== 'connected') { stallForget(s); return; } // the readings stalled() compares follow each other
    const rep = await pc.getStats();
    if (session !== s) return;
    let bytes = 0, fps = [], impl = '', codecId = '', rtt = null, kind = '', limit = '', avail = 0, target = 0;
    const mons = {}, encoded = {};
    rep.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const idx = s.mids.indexOf(r.mid), src = r.mediaSourceId && rep.get(r.mediaSourceId);
        if (idx >= 0 && r.active !== false) {
          mons[idx] = { cap: src ? Math.round(src.framesPerSecond || 0) : null, enc: Math.round(r.framesPerSecond || 0), res: (r.frameWidth || 0) + 'x' + (r.frameHeight || 0), limit: r.qualityLimitationReason || 'none', impl: r.encoderImplementation || '' };
          target += r.targetBitrate || 0;
          encoded[idx] = r.framesEncoded || 0;
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
    if (stalled(s, encoded)) return; // the session is made anew (see stalled)
    // Host-side numbers for the client's diagnostics report.
    s.lastHs = { codec, from: s.codecFrom, enc: impl, availMbps: +(avail / 1e6).toFixed(1), targetMbps: +(target / 1e6).toFixed(1), rtt: rtt != null ? Math.round(rtt * 1000) : null, mons,
      cap: s.native ? 'native' : 'engine', ...(s.native ? {} : { capWhy: String(s.capWhy || '').slice(0, 120) }), ...(stallRenews ? { stalls: stallRenews } : {}) };
    try { if (s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'hs', ...s.lastHs })); } catch {}
    if (last) {
      const mbps = ((bytes - last.bytes) * 8) / ((now - last.t) / 1000) / 1e6;
      // The encoder's name is hidden by Chromium unless the page captures something through the browser (on
      // a PC without a sound device nothing is): then only the codec. Its words are put in by statsText, again
      // when the language changes.
      s.statsLine = { head: `${codec}${impl ? ` (${impl})` : ''} · ${fps.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join('/')} fps · ${mbps.toFixed(1)} Mbps · RTT ${rtt != null ? Math.round(rtt * 1000) + ' ms' : '?'}`, relay: kind === 'relay', limit };
      const text = statsText(s.statsLine);
      $('stats').textContent = text;
      if (!s.loggedStats) { s.loggedStats = true; log(t('전송 상태: {0}', text)); }
    }
    last = { bytes, t: now };
  }, 2000));
}

// An encoder that takes no frames while frames keep going into its track (native capture). Seen in CI on
// Linux (6 of 25 runs, H.264 from OpenH264, mostly right after the encoder was set up anew for a new size):
// the engine took every frame from then on for one out of order ("Incoming frame timestamp is not
// monotonically increasing", its own clock against ours, frame_cadence_adapter.cc) and dropped it, so the
// picture stood still for the rest of the session; once the first check of a self-test failed on it. The
// cause is inside the engine (our timestamps rise; 50 runs on a fast Linux server never showed it), so the
// host notices it here: two readings in a row (4 s) with frames written (4 or more each: a still screen's
// keep-alive is one a second) and none encoded. A new session starts the engine's side afresh: the client
// reconnects at once and keeps its windows (renew). At most once a minute; counted (`stalls` in the host's
// numbers, the diagnostics log). `encoded`: framesEncoded by monitor, of the monitors being sent.
const STALL_READINGS = 2, STALL_FRAMES = 4, STALL_RENEW_MS = 60e3;
let stallRenews = 0, stallRenewAt = -1e9;
function stalled(s, encoded) {
  if (!s.native) return false;
  let stuck = -1;
  s.native.forEach((n, i) => {
    if (!n) return;
    const enc = encoded[i];
    // Not in this reading (not being sent): compared afresh from its next reading on (see stallForget).
    if (enc === undefined) { n.seen = null; n.stuck = 0; return; }
    const w = n.written || 0, p = n.seen;
    n.stuck = p && enc === p.enc && w - p.w >= STALL_FRAMES ? (n.stuck || 0) + 1 : 0;
    n.seen = { enc, w };
    if (n.stuck >= STALL_READINGS) stuck = i;
  });
  if (stuck < 0) return false;
  s.native[stuck].stuck = 0;
  if (performance.now() - stallRenewAt < STALL_RENEW_MS) return false; // it came back at once: not again and again
  stallRenewAt = performance.now();
  stallRenews++;
  log(t('모니터 {0}: 화면을 보내는데 인코더가 4초째 받지 않습니다 — 연결을 새로 맺습니다', stuck + 1));
  renew(s, '인코더 멈춤');
  return true;
}
// A reading that did not happen (the connection was not up): the next ones compare afresh. Before 2026-11-20 a
// reading was compared with the last one taken, also across such a gap, so two readings around a short loss of
// the connection could count as seconds with nothing encoded and renew a session that was coming back by itself.
function stallForget(s) { if (s && s.native) for (const n of s.native) if (n) { n.seen = null; n.stuck = 0; } }

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
      send: (o) => relaySend(o, { pubTopic: k.topicClient, txKey: k.h2c }),
    });
  }
  // A one-time code while it lasts (see oneTime).
  if (oneTime) {
    const k = oneTime.keys;
    next.set(k.topicHost, { kind: 'code', key: 'code', keys: k, send: (o) => relaySend(o, { pubTopic: k.topicClient, txKey: k.h2c }) });
  }
  if (my !== subSeq) return; // a newer list is on its way
  routes = next;
  const c = RD.channel({
    server: cfg.server, subTopic: [...next.keys()].join(','), pubTopic: keys.topicClient, txKey: keys.h2c,
    rxKey: (t) => { const r = t ? next.get(t) : master; return r ? r.keys.c2h : null; },
    onMessage: (m, t) => { const r = t ? routes.get(t) : master; if (r) onMessage(m, r); },
    onState: (st) => { if (c === chan && !session) { if (st === 'open') idle(); else status('시그널링 서버 재연결 중…', 'wait'); } },
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
const GATE_HOW = { host: '이 PC에서 허용', otp: '인증 앱 코드', first: '첫 기기', again: '방금 허용한 기기', auto: '자동 허용', off: '' };
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
  const via = route.kind === 'code' ? 'code' : 'key';
  const name = via === 'code' ? '1회용 코드로 접속' : m.pair && typeof m.pair.pc === 'string' && m.pair.pc ? m.pair.pc.slice(0, 60) + ' (앱)' : '브라우저';
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
      api.access({ ev: 'denied', via, name, why: 'busy' });
      log(busy.n > 1 ? t('새 기기 요청이 겹치거나 너무 잦아 받지 않았습니다 (지난 1분 {0}번). 모르는 요청이 계속되면 키가 샌 것일 수 있습니다: 새 키 발급(등록된 기기도 모두 삭제)', busy.n)
        : t('새 기기 요청이 겹치거나 너무 잦아 받지 않았습니다. 모르는 요청이 계속되면 키가 샌 것일 수 있습니다: 새 키 발급(등록된 기기도 모두 삭제)'));
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
  log(via === 'code' ? t('1회용 코드로 접속을 요청했습니다 · 확인 숫자 {0} — 이 창에서 허용하거나 거부하세요', code)
    : t('새 기기가 접속을 요청했습니다: {0} · 확인 숫자 {1} — 이 창에서 허용하거나 거부하세요', whoText(name), code));
  api.access({ ev: 'asked', via, name });
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
  api.access({ ev: 'denied', via: p.route.kind === 'code' ? 'code' : 'key', name: p.name, why });
  if (p.route.kind === 'code') { log(`${whoText(p.name)}: ${why === 'timeout' ? t('2분 안에 허용하지 않아 끝냈습니다') : t('거부했습니다')}`); return; }
  log(`${whoText(p.name)}: ${why === 'refused' ? t('거부했습니다. 내가 보낸 요청이 아니라면 키가 샌 것일 수 있습니다: 새 키 발급(등록된 기기도 모두 삭제)') : why === 'timeout' ? t('2분 안에 허용하지 않아 끝냈습니다') : t('막았습니다')}`);
}
async function allow(how) {
  const p = endAsk();
  if (!p) return;
  if (p.route.kind === 'code') {
    // One request per code: only this page may come back on it (never through the key's gate), for as long as it lasts.
    if (!oneTime || p.route.keys !== oneTime.keys) return;
    oneTime.pk = p.m.pk;
    clearTimeout(oneTime.timer);
    showOneTime();
  } else allowPk(p.m.pk);
  api.access({ ev: 'approved', via: p.route.kind === 'code' ? 'code' : 'key', name: p.name, how });
  log(`${whoText(p.name)}: ${t('허용했습니다 ({0})', GATE_HOW[how] ? t(GATE_HOW[how]) : how)}`);
  try { await startSession(p.m, p.route); } catch (e) {
    log(t('오류: {0}', e.message));
    api.sourcesFailed();
    if (session && session.sid === p.m.sid) teardown('오류', true);
  }
}
// The waiting request in this window: who, the number its screen shows too, 허용 / 거부, the time left.
let askTick = 0;
const ASK_TEXT = '그 기기 화면에도 같은 숫자가 보입니다. 내가 접속하는 것이 맞을 때만 허용하세요. 클라이언트 앱은 허용하면 기기로 등록되어 다음부터 묻지 않습니다(브라우저는 매번 묻습니다).'; // said through t()
function showAsk(p) {
  const byCode = p.route.kind === 'code';
  $('askTitle').textContent = byCode ? t('1회용 코드로 접속하려고 합니다') : t('새 기기가 접속하려고 합니다');
  $('askText').textContent = byCode ? t('상대 화면에도 같은 숫자가 보입니다. 내가 코드를 알려 준 사람이 맞을 때만 허용하세요. 허용하면 그 사람이 이 PC를 보고 조작할 수 있습니다(기기로 등록되지는 않습니다).') : t(ASK_TEXT);
  $('askWho').textContent = whoText(p.name);
  $('askCode').textContent = p.code;
  $('ask').style.display = '';
  $('askYes').onclick = () => { if (pending === p) allow('host'); };
  $('askNo').onclick = () => { if (pending === p) refuse('refused'); };
  clearInterval(askTick);
  const left = () => { const s = Math.max(0, Math.round((GATE_WAIT - (performance.now() - p.since)) / 1000)); $('askLeft').textContent = t('— {0} 남음', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); };
  left();
  askTick = setInterval(left, 1000);
  window.scrollTo(0, 0);
}
function hideAsk() { clearInterval(askTick); $('ask').style.display = 'none'; }
relabel.add(() => { if (pending) showAsk(pending); });

// ---- one-time codes: help from someone who has no key (the user's go-ahead, 2026-11-17) ----------------------
// The person at this PC has this window make a code (signal.js newCode) and gives it to whoever is to help. The
// code opens a route of its own (keys and topics from the code: RD.deriveCode) for ONE_TIME_MS. A request on it
// always waits for 허용 in this window (never the authenticator app, whatever "새 기기 확인" says), one request
// is let in, and its session gets no device token (pairDevice takes key routes only). The helper's page may come
// back while the session lasts (a renew, a short loss of the network: its own key, `pk`, as with the gate);
// ONE_TIME_GRACE_MS after the session ended the code ends too. 끝내기 ends code and session at once.
// 자동 허용 (the user's wish, 2026-11-20): a switch on the card, off for every new code. Turned on, the first page
// that signs its hello on the code comes in without the card, as if 허용 had been pressed; everything else stays
// (one page, no device token, the same ending). It adds nothing a person connected to this window could not do
// already (make a code and press 허용), so it is not refused during a remote session as the gate's settings are.
const ONE_TIME_MS = 10 * 60e3, ONE_TIME_GRACE_MS = 2 * 60e3;
let oneTime = null; // { code, keys, until, timer, pk: '' once a request was allowed, auto: 자동 허용 }
async function makeOneTimeCode() {
  endOneTime('replaced');
  const code = RD.newCode(), k = await RD.deriveCode(code);
  const o = (oneTime = { code, keys: k, until: Date.now() + ONE_TIME_MS, pk: '', auto: false });
  o.timer = setTimeout(() => { if (oneTime === o && !o.pk) endOneTime('expired'); }, ONE_TIME_MS);
  await subscribe();
  showOneTime();
  log(t('1회용 코드를 만들었습니다: 10분 안에 한 번 쓸 수 있고, 들어오기 전에 이 창에서 허용해야 합니다'));
}
function endOneTime(why) {
  const o = oneTime;
  if (!o) return;
  oneTime = null;
  clearTimeout(o.timer);
  if (pending && pending.route.kind === 'code') refuse(why === 'expired' ? 'timeout' : 'refused');
  if (session && session.route.kind === 'code') teardown('1회용 접속 끝냄');
  subscribe();
  showOneTime();
  if (why !== 'replaced') log(t({ expired: '1회용 코드가 쓰이지 않고 만료되었습니다', done: '1회용 접속이 끝나 코드도 끝났습니다', ended: '1회용 코드를 끝냈습니다' }[why] || '1회용 코드를 끝냈습니다'));
}
let otTick = 0;
function showOneTime() {
  const o = oneTime;
  clearInterval(otTick);
  $('ot').classList.toggle('on', !!o);
  $('otBox').style.display = o ? '' : 'none';
  $('otNote').style.display = o ? 'none' : '';
  $('otBtn').textContent = o ? t('새 코드') : t('코드 만들기');
  $('otBtn').style.display = o && o.pk ? 'none' : ''; // a new code would end the session the person allowed
  if (!o) { $('otState').textContent = ''; return; }
  $('otCode').textContent = RD.showCode(o.code);
  $('otAuto').setAttribute('aria-checked', String(!!o.auto));
  $('otAutoRow').style.display = o.pk ? 'none' : ''; // used: nobody else comes in on it either way
  const tick = () => {
    if (oneTime !== o) return;
    const live = session && session.route.kind === 'code';
    if (o.pk) {
      $('otState').textContent = live ? t('— 접속 중') : t('— 접속 끝남');
      $('otText').textContent = live ? t('도와주는 사람이 이 PC에 접속해 있습니다. 끝내기를 누르면 바로 끊기고 코드도 사라집니다.')
        : t('접속이 끊겼습니다. 잠시 안에 다시 붙지 않으면 코드가 사라집니다.');
    } else {
      const s = Math.max(0, Math.round((o.until - Date.now()) / 1000));
      $('otState').textContent = t('— {0} 남음', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      $('otText').textContent = o.auto ? t('이 코드를 도와줄 사람에게 알려 주세요. 그 사람이 Pangmote 클라이언트의 접속 키 칸에 이 코드를 넣으면 허용 카드 없이 바로 연결됩니다.')
        : t('이 코드를 도와줄 사람에게 알려 주세요. 그 사람이 Pangmote 클라이언트의 접속 키 칸에 이 코드를 넣으면 이 창에 허용 카드가 뜹니다.');
    }
  };
  tick();
  otTick = setInterval(tick, 1000);
}
relabel.add(() => showOneTime());

// Who is on the other end, for the log and the access log. A device's name as the host window has it now
// (a rename does not make a new subscription: devNames, filled by showDevices).
const devNames = new Map();
const refused = new Map(); // a blocked device -> when it was last answered, and how often it asked since
const cycleSaid = new Map(); // 'self' | 'loop' -> when it was last logged
const cycleN = new Map();    // 'self' | 'loop' -> how many hellos were turned away so (the self-test reads it)
const deviceName = (route) => devNames.get(route.id) || route.name;
const whoOf = (route, pair) => (route.kind === 'device' ? deviceName(route) : route.kind === 'code' ? '1회용 코드 접속' : pair && pair.pc ? pair.pc + ' (키)' : '키로 접속');

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
      log(r.n > 1 ? t('차단한 기기의 접속을 거부했습니다: {0} (지난 1분 {1}번)', whoText(name), r.n) : t('차단한 기기의 접속을 거부했습니다: {0}', whoText(name)));
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
      log((fresh ? t('클라이언트 화면을 최신 버전으로 전송했습니다') : t('클라이언트 화면이 이미 최신입니다')) + (route.kind === 'device' ? ` (${whoText(route.name)})` : ''));
    } catch (e) {
      // The loader says so and can be tried again. A session that is live has nothing to do with it.
      log(t('클라이언트 화면 전송 실패: {0}', e.message));
    }
  } else if (m.t === 'hello') {
    if (!firstTime(m)) return; // replay
    // The page's own key, taken only with the hello's signature by it: the answer must be signed with it (see
    // 'answer'), and nobody but that page can come back in its name or replace its request.
    m.bind = await importPk(m.pk);
    if (m.bind && !(await verifySig(m.bind, helloText(m), m.hsig))) m.bind = null;
    // A connection that comes back on itself (cycle.js): the client app on this very PC ('self'), or the client
    // app of a PC that this PC's own client app controls right now ('loop'). Refused before anything is asked or
    // started, whatever the route: the picture would show itself without end, and a key or a click would come
    // back to where it came from. Told and logged at most once a minute (the page does not try again).
    const cyc = await api.cycleCheck(typeof m.from === 'string' ? m.from.slice(0, 64) : '').catch(() => '');
    if (cyc) {
      cycleN.set(cyc, (cycleN.get(cyc) || 0) + 1);
      route.send({ t: 'denied', sid: m.sid, ts: Date.now(), why: cyc }).catch(() => {});
      if (performance.now() - (cycleSaid.get(cyc) || -1e12) >= 60000) {
        cycleSaid.set(cyc, performance.now());
        log(cyc === 'self' ? t('이 PC의 클라이언트 앱이 이 PC 자신에 접속하려 해서 막았습니다 (자기 화면을 끝없이 비추고, 입력이 되돌아옵니다)')
          : t('이 PC가 지금 조종하고 있는 PC에서 거꾸로 이 PC에 접속하려 해서 막았습니다 (서로를 조종하면 입력이 두 PC 사이를 끝없이 오갑니다)'));
        api.access({ ev: 'denied', via: route.kind === 'device' ? 'device' : route.kind === 'code' ? 'code' : 'key', dev: route.kind === 'device' ? route.id : undefined, name: whoOf(route, m.pair), why: cyc });
      }
      return;
    }
    if (route.kind === 'code') {
      // A one-time code: the page allowed on it may come back while it lasts; anything else waits for 허용 here,
      // or with 자동 허용 on comes in at once if it signed its hello (a page without its own key goes to ask(),
      // which tells an old page to reload and refuses a bad signature).
      if (!oneTime) return;
      if (m.bind && oneTime.pk && m.pk === oneTime.pk) m.allowed = 'again';
      else if (oneTime.pk) { route.send({ t: 'denied', sid: m.sid, ts: Date.now(), why: 'used' }).catch(() => {}); return; }
      else if (oneTime.auto && m.bind && route.keys === oneTime.keys) {
        // A card shown for this code before the switch was turned on: the same page asking again comes in instead
        // of it; another page is told the code is used now.
        if (pending && pending.route.kind === 'code') {
          const p = endAsk();
          if (p.m.pk !== m.pk) p.route.send({ t: 'denied', sid: p.m.sid, ts: Date.now(), why: 'used' }).catch(() => {});
        }
        oneTime.pk = m.pk;
        clearTimeout(oneTime.timer);
        showOneTime();
        m.allowed = 'auto';
        api.access({ ev: 'approved', via: 'code', name: '1회용 코드로 접속', how: 'auto' });
        log(t('1회용 코드로 접속: 자동 허용이 켜져 있어 바로 연결합니다'));
      } else { ask(m, route, { otp: false, locked: false }); return; }
    } else if (route.kind === 'key') {
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
      log(t('오류: {0}', e.message));
      api.sourcesFailed(); // the monitors main keeps listed may be out of date: it asks Windows again next time
      // Only the session this hello started; a newer one may have taken its place meanwhile. No 'bye':
      // that would tell the client not to try again.
      if (session && session.sid === m.sid) teardown('오류', true);
    }
  } else if (m.t === 'otp' && pending && m.sid === pending.m.sid && route.key === pending.route.key && pending.route.kind !== 'code') {
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
    if (r.why === 'locked') log(`${whoText(p.name)}: ${t('인증 앱 코드를 여러 번 틀려 코드 확인을 잠시 막았습니다. 이 창의 허용은 그대로 됩니다')}`);
  } else if (m.t === 'cancel' && pending && m.sid === pending.m.sid && route.key === pending.route.key) {
    // The client gave up waiting (its 취소), signed like its code: the next request need not wait for this one.
    const p = pending;
    if (!(await verifySig(p.m.bind, `cancel\n${m.sid}`, m.sig)) || pending !== p) return;
    endAsk();
    log(`${whoText(p.name)}: ${t('요청을 취소했습니다')}`);
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
      log(t('answer 수신 — 연결 수립 중'));
    } catch (e) {
      log(t('오류: {0}', e.message));
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
let lastUpdate = null; // what showUpdate showed last: shown again in a new language
relabel.add(() => { if (lastUpdate) showUpdate(lastUpdate); });
function showUpdate(u) {
  if (!u) return;
  lastUpdate = u;
  $('ver').textContent = 'v' + u.version + (u.installed ? '' : ' · ' + t('소스 폴더에서 실행 중'));
  document.title = 'Pangmote Host v' + u.version; // the window's title too
  // "업데이트 확인": the installed app with a feed (from a source folder updates come by git).
  $('updCheck').style.display = u.installed && u.state && u.state !== 'off' && u.state !== 'none' ? '' : 'none';
  $('updCheck').disabled = ['checking', 'downloading', 'ready'].includes(u.state);
  // "나가기": back to the start screen (two big buttons); the host keeps running. Not in the isolated runs.
  $('exitStart').style.display = u.startScreen ? '' : 'none';
  $('ver').title = !u.installed ? t('소스 폴더에서 실행 중입니다. 업데이트는 git pull과 설치 스크립트로 합니다.')
    : u.error ? t('업데이트를 확인하지 못했습니다: {0}', u.error)
    : u.checkedAt ? t('최신 버전입니다 · 확인 {0}', new Date(u.checkedAt).toLocaleTimeString(t.lang)) : '';
  const a = u.available, card = $('upd');
  if (!updateTold) for (const r of u.rolledBack || []) log(t('버전 {0}은 이 PC에서 시작하지 못해 이전 버전으로 되돌렸습니다 ({1})', r.version, r.why));
  updateTold = true;
  if (!a || (a.version === updateLater && !a.required && u.state === 'available')) { card.style.display = 'none'; return; }
  card.style.display = '';
  const pack = a.kind === 'package';
  $('updTitle').textContent = a.required ? t('중요 업데이트 {0}', a.version) : t('새 버전 {0}이 있습니다', a.version);
  $('updText').textContent = u.state === 'downloading' ? t('받는 중… {0}%', Math.round((u.progress || 0) * 100))
    : u.state === 'ready' ? (a.required ? t('설치했습니다. 원격 접속이 없을 때 호스트를 다시 시작합니다(늦어도 30분 뒤).') : t('설치했습니다. 다시 시작합니다…'))
    : pack ? t('이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요(접속 키와 설정은 그대로 남습니다).')
    : a.required ? t('이 버전의 심각한 문제를 고친 업데이트라 자동으로 설치합니다.') + (u.error ? ' ' + t('(실패: {0} — 다시 시도합니다)', u.error) : '')
    : t('현재 v{0} · {1} MB', u.version, (a.size / 1024 / 1024).toFixed(1)) + (u.error ? ' · ' + t('실패: {0}', u.error) : '');
  const ul = $('updNotes');
  ul.textContent = '';
  // In this language when the release has it (ko and en so far), else English, else Korean.
  const notes = a.notes ? a.notes[t.lang] || a.notes.en || a.notes.ko : null;
  for (const line of notes || []) { const li = document.createElement('li'); li.textContent = line; ul.append(li); }
  const busy = u.state === 'downloading' || u.state === 'ready';
  $('updGo').style.display = busy || (a.required && !pack) ? 'none' : '';
  $('updGo').textContent = pack ? t('내려받기 페이지 열기') : t('지금 업데이트');
  $('updGo').onclick = () => { if (pack) api.update.page(); else { if (session) log(t('업데이트를 설치하고 다시 시작합니다. 접속 중인 클라이언트는 잠시 뒤 다시 연결됩니다.')); api.update.install(); } };
  $('updLater').style.display = busy || a.required ? 'none' : '';
  $('updLater').onclick = () => { updateLater = a.version; card.style.display = 'none'; };
}
// "업데이트 확인": the feed now instead of at the next look (20 s after the start, then every 6 h). An
// update found shows on its card, also one that was put off; otherwise the button's note says how it went.
let updMsgTimer = 0;
async function checkUpdate() {
  $('updCheck').disabled = true;
  $('updMsg').textContent = t('확인 중…');
  let u = null;
  try { u = await api.update.check(true); } catch {} // an update found is asked about in a dialog of main's
  updateChecked(u);
}
function updateChecked(u) {
  const m = $('updMsg');
  $('updCheck').disabled = false;
  updateLater = ''; // the person asked: one put off before is shown again
  if (u) showUpdate(u);
  m.textContent = !u ? t('확인하지 못했습니다') : u.available ? '' : u.error ? t('확인하지 못했습니다: {0}', u.error) : t('최신 버전입니다');
  if (m.textContent) log(t('업데이트 확인: {0}', m.textContent + (u && !u.available && !u.error ? ` (v${u.version})` : '')));
  clearTimeout(updMsgTimer);
  updMsgTimer = setTimeout(() => { m.textContent = ''; }, 20000);
}
function watchUpdates() {
  if (!api.update) return;
  $('updCheck').onclick = checkUpdate;
  $('exitStart').onclick = () => api.startScreen().then((ok) => { if (!ok) log(t('처음 화면을 열지 못했습니다')); }, () => {});
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
  const why = ASSIST_WHY[r.why] ? t(ASSIST_WHY[r.why]) : r.why;
  if (r.ok) log(what === 'install' ? t('잠금 화면 지원을 설치했습니다') : t('잠금 화면 지원을 제거했습니다'));
  else log(what === 'install' ? t('잠금 화면 지원 설치: {0}', why) : t('잠금 화면 지원 제거: {0}', why));
  showAssist(r.status);
}
// The offer at the host's first start (main.js): the card follows it.
if (api.assist && api.assist.onChanged) api.assist.onChanged((m) => {
  if (m && m.busy) api.assist.status().then((st) => showAssist({ ...st, busy: true }), () => {});
  else if (m && m.result) assistDone('install', m.result);
});
let lastAssist = null; // shown again in a new language as it was (a "busy" one too)
relabel.add(() => { if (lastAssist) showAssist(lastAssist); });
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
  lastAssist = st;
  $('assistState').textContent = '— ' + t(state);
  $('assistText').textContent = t(text);
  $('assistGo').style.display = go && !st.busy ? '' : 'none';
  $('assistGo').textContent = go ? t(go) : '';
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
// Month, day and time as this language writes them (11/20 09:41, 20.11. 09:41, 11月20日 09:41).
const fmtTime = (ms) => { if (!ms) return ''; try { return new Date(ms).toLocaleString(t.lang, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; } };
let devShowSeq = 0;
relabel.add(() => showDevices());
async function showDevices() {
  const my = ++devShowSeq;
  const r = await api.devices.list().catch(() => null);
  if (my !== devShowSeq || !r) return;
  devNames.clear();
  for (const d of r.list) devNames.set(d.id, d.name || '이름 없는 기기');
  const box = $('devList');
  box.textContent = '';
  $('devsNote').textContent = (r.list.length ? t('— {0}대', r.list.length) : '') + (r.note ? ' · ' + t('기기 목록 파일을 읽지 못했습니다 (원래 파일은 사본으로 남겨 두었습니다)') : '');
  if (!r.list.length) {
    const p = document.createElement('small');
    p.textContent = t('아직 없습니다. 클라이언트 앱에서 접속 키로 한 번 접속하면 그 PC가 여기에 등록되고, 다음부터는 키 없이 접속합니다. 잃어버린 PC는 여기서 차단하거나 삭제하면 그 PC만 끊깁니다.');
    box.append(p);
    return;
  }
  const live = session && session.connectedAt && session.route.kind === 'device' ? session.route.id : null;
  for (const d of r.list) {
    const row = document.createElement('div');
    row.className = 'dev';
    row.dataset.id = d.id;
    const name = document.createElement('b');
    name.textContent = d.name || t('이름 없는 기기');
    const tag = document.createElement('span');
    tag.className = 'tag';
    if (d.blocked) { tag.textContent = t('차단됨'); tag.classList.add('bad'); } else if (d.id === live) { tag.textContent = t('접속 중'); tag.classList.add('on'); } else tag.style.display = 'none';
    const btns = document.createElement('span');
    btns.className = 'btns';
    const button = (text, fn) => { const b = document.createElement('button'); b.className = 'sub mini'; b.textContent = text; b.onclick = fn; btns.append(b); };
    button(t('이름 바꾸기'), () => renameDevice(d, name));
    button(d.blocked ? t('차단 해제') : t('차단'), () => api.devices.block(d.id, !d.blocked).then((ok) => { if (ok) log(`${d.name || t('기기')}: ${d.blocked ? t('차단을 풀었습니다') : t('차단했습니다 — 이 기기는 더 이상 접속할 수 없습니다')}`); }));
    button(t('삭제'), () => api.devices.remove(d.id).then((ok) => { if (ok) log(`${d.name || t('기기')}: ${t('삭제했습니다')}`); }));
    const top = document.createElement('div');
    top.className = 'row';
    top.append(name, tag, btns);
    const meta = document.createElement('small');
    meta.textContent = [d.osName, d.last ? t('마지막 접속 {0}', fmtTime(d.last) + (d.lastIp ? ' (' + d.lastIp + ')' : '')) : t('키 없이 접속한 적 아직 없음'), t('등록 {0}', fmtTime(d.added))].filter(Boolean).join(' · ');
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
// (Words of their own, not the buttons' '허용'/'거부' or the tray's '종료': a translation reads them as what happened.)
const ACCESS_WHAT = { connect: '접속', end: '접속 종료', denied: '거부됨', paired: '기기 등록', asked: '허용 요청', approved: '허용됨' };
const ACCESS_WHY = { blocked: '차단된 기기', refused: '거부함', timeout: '2분 안에 허용하지 않음', busy: '요청이 겹치거나 너무 잦음', locked: '코드를 여러 번 틀림', self: '이 PC 자신에 접속', loop: '서로를 조종' };
async function showAccess() {
  const box = $('accessList');
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  await renderAccess();
  box.style.display = '';
}
// The entries keep Korean words of ours (a reason, a name like 키로 접속): said in this language when shown.
async function renderAccess() {
  const box = $('accessList');
  const list = await api.accessLog().catch(() => []);
  box.textContent = '';
  if (!list.length) { const p = document.createElement('small'); p.textContent = t('기록이 없습니다.'); box.append(p); }
  for (const e of list) {
    const parts = [fmtTime(e.t), ACCESS_WHAT[e.ev] ? t(ACCESS_WHAT[e.ev]) : e.ev, e.name ? whoText(e.name) : e.via === 'device' ? t('기기') : e.via === 'code' ? t('1회용 코드') : t('키로 접속')];
    if (e.ip) parts.push(e.ip);
    if (e.ev === 'end') {
      parts.push(t('{0}분', Math.max(1, Math.round((e.dur || 0) / 60))));
      if (e.in || e.out) parts.push(t('파일 받음 {0} · 보냄 {1}', e.in || 0, e.out || 0));
    }
    if (e.ev === 'denied') parts.push(ACCESS_WHY[e.why] ? t(ACCESS_WHY[e.why]) : e.why || '');
    if (e.ev === 'approved') parts.push(GATE_HOW[e.how] ? t(GATE_HOW[e.how]) : e.how || '');
    const line = document.createElement('div');
    line.textContent = parts.filter(Boolean).join(' · ');
    box.append(line);
  }
}
relabel.add(() => { if ($('accessList').style.display !== 'none') renderAccess(); });

// ---- the settings: new devices confirmed, and the authenticator app (main.js 'gate', 'otp-*') ------------
const GATE_WHY = { remote: '원격 접속 중에는 할 수 없습니다. 이 PC 앞에서 하세요(접속한 사람이 보안 설정을 풀 수 없게 막아 둔 것입니다)', none: '다시 시도하세요' };
relabel.add(() => showGate());
async function showGate(info) {
  info = info && 'confirmNew' in info ? info : await api.gate.info().catch(() => null);
  if (!info) return;
  $('gateState').textContent = info.confirmNew ? t('켜짐') : t('꺼짐');
  $('gateState').className = info.confirmNew ? 'on' : 'off';
  $('gateBtn').textContent = info.confirmNew ? t('끄기') : t('켜기');
  $('otpState').textContent = info.otp ? (info.locked ? t('켜짐 (코드를 여러 번 틀려 잠시 막힘)') : t('켜짐')) : t('꺼짐');
  $('otpState').className = info.otp ? 'on' : 'off';
  $('otpBtn').textContent = info.otp ? t('끄기') : t('설정');
  $('gateNote').textContent = !info.confirmNew
    ? t('꺼져 있으면 접속 키만 있으면 어느 기기든 접속합니다. 키가 샐 때를 대비해 켜 두기를 권합니다.')
    : (info.firstFree ? t('처음 접속하는 클라이언트 앱 하나는 묻지 않고 등록합니다. 그다음부터 새 기기는 이 창에서 허용해야 접속됩니다.')
      : t('등록되지 않은 기기(브라우저 포함)는 이 창에서 허용해야 접속됩니다. 이미 등록한 기기로 원격 접속해 이 창의 허용을 눌러도 됩니다.'))
      + ' ' + (info.otp ? t('휴대폰 인증 앱의 코드로도 허용됩니다.') : t('아무도 이 PC 앞에 없을 때를 위해 휴대폰 인증 앱을 설정해 둘 수 있습니다(선택).'));
}
$('gateBtn').onclick = async () => {
  const info = await api.gate.info();
  const r = await api.gate.set(!info.confirmNew);
  log(r.ok ? (r.confirmNew ? t('새 기기 확인을 켰습니다') : t('새 기기 확인을 껐습니다')) : t('새 기기 확인: {0}', GATE_WHY[r.why] ? t(GATE_WHY[r.why]) : r.why));
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
    log(r.ok ? t('휴대폰 인증 앱을 껐습니다') : t('휴대폰 인증 앱: {0}', GATE_WHY[r.why] ? t(GATE_WHY[r.why]) : r.why));
    showGate(r);
    return;
  }
  const r = await api.otp.begin();
  if (!r.ok) { log(t('휴대폰 인증 앱: {0}', GATE_WHY[r.why] ? t(GATE_WHY[r.why]) : r.why)); return; }
  try { $('otpQr').innerHTML = QR.svg(r.uri, { scale: 4 }); } catch (e) { $('otpQr').textContent = ''; log(t('QR 코드를 만들지 못했습니다: 아래 키를 인증 앱에 직접 넣으세요')); } // our own markup: numbers only
  $('otpSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
  $('otpMsg').textContent = '';
  otpForm(true);
  $('otpCode').focus();
};
$('otpOk').onclick = async () => {
  const r = await api.otp.confirm($('otpCode').value.trim());
  if (!r.ok) { $('otpMsg').textContent = r.why === 'code' ? t('코드가 맞지 않습니다. 앱에 지금 보이는 6자리를 넣으세요.') : t('설정하지 못했습니다: {0}', GATE_WHY[r.why] ? t(GATE_WHY[r.why]) : r.why); return; }
  otpForm(false);
  log(t('휴대폰 인증 앱을 설정했습니다. 휴대폰을 잃어버리면 등록한 다른 기기로 접속해 이 창에서 허용하거나, 이 PC 앞에서 다시 설정하세요'));
  showGate(r);
};
$('otpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('otpOk').click(); });
$('otpCancel').onclick = () => otpForm(false);

(async () => {
  cfg = await api.getConfig();
  keys = await RD.derive(cfg.key);
  master = { kind: 'key', key: 'key', keys, send: (o) => relaySend(o) };
  await subscribe();
  api.devices.onChanged((resub) => { if (resub) subscribe(); showDevices(); showGate(); });
  showDevices();
  showGate();
  $('accessBtn').onclick = showAccess;
  log(t('시그널링 서버: {0}', cfg.server));
  log(t('호스트 시작: {0}', new Date().toLocaleString(t.lang)));
  if (cfg.viewOnly) log(t('주의: 이 PC에서는 원격 입력을 넣을 수 없어 보기 전용으로 동작합니다 ({0})', cfg.viewOnly));
  if (cfg.updateNote) log(t('주의: {0}', cfg.updateNote));
  watchUpdates();
  showAssist();

  let shown = false;
  $('show').onclick = () => { shown = !shown; $('key').textContent = shown ? cfg.key : '••••••••••••••••••••••••'; $('show').textContent = shown ? t('숨기기') : t('표시'); };
  relabel.add(() => { $('show').textContent = shown ? t('숨기기') : t('표시'); });
  $('copy').onclick = async () => { await api.copyKey(); log(t('접속 키를 클립보드에 복사했습니다')); };
  $('regen').onclick = () => api.regenKey();
  $('kick').onclick = () => teardown('사용자가 끊음');
  api.onKick(() => teardown('사용자가 끊음'));
  $('otBtn').onclick = () => { makeOneTimeCode().catch((e) => log(t('1회용 코드를 만들지 못했습니다: {0}', e.message))); };
  $('otEnd').onclick = () => endOneTime('ended');
  $('otAuto').onclick = () => {
    const o = oneTime;
    if (!o || o.pk) return;
    o.auto = !o.auto;
    log(o.auto ? t('1회용 코드: 자동 허용을 켰습니다 — 코드를 넣은 사람은 허용 없이 바로 접속합니다') : t('1회용 코드: 자동 허용을 껐습니다 — 들어오기 전에 이 창에서 허용해야 합니다'));
    showOneTime();
  };
  showOneTime();
  // The same key or click again and again, faster than a person (input.js): input stopped for a while. The
  // client is told why its keys and clicks do nothing meanwhile.
  api.onInputStorm((o) => {
    const sec = Math.round((Number(o.ms) || 0) / 1000);
    log(t('같은 키나 클릭이 사람보다 빠르게 계속 들어와 입력을 {0}초 멈췄습니다 (이 PC를 이 PC에서 보거나, 두 PC가 서로를 조종하고 있지 않은지 확인하세요)', sec));
    if (session) txTo(session, { t: 'storm', ms: Number(o.ms) || 0 });
  });
  // A Korean key (한/영, 한자) cannot work here, and what fixes it (host/imecheck.js): the client says so where the person
  // types (`at`: the text cursor's monitor and place, when the system knows it).
  api.onIme((o) => {
    if (!session) return;
    const at = o.at && Number.isInteger(o.at.d) ? { d: o.at.d, x: +o.at.x || 0, y: +o.at.y || 0 } : null;
    txTo(session, { t: 'ime', os: String(o.os || ''), why: String(o.why || ''), im: String(o.im || ''), fix: String(o.fix || '').slice(0, 200), at });
  });
  api.onHostLock((on) => {
    screenGone.lockFrom = 'event';
    if (screenGone.lock === on) return;
    screenGone.lock = on;
    if (!on) unlocked();
    log(on ? t('이 PC가 잠겼습니다') : t('이 PC의 잠금이 풀렸습니다'));
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
    log(t('호스트 모니터 구성 변경 감지 — 세션을 다시 협상합니다'));
    renew(s, '모니터 구성 변경');
  });
  $('export').onclick = async () => { const p = await api.exportClient(); if (p) log(t('클라이언트 파일 저장: {0}', p)); };
})();
