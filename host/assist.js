// The Windows assist service (native/winassist.cpp) from the host's side, in the main process.
//
// Windows draws the lock screen and UAC prompts on its secure desktop, which this program (it runs as the
// signed-in user) can neither see nor control. The assist service, installed once with administrator
// rights, keeps a LocalSystem helper in the console session that can. During a remote session this module
// connects to it and
//   - learns which desktop has the screen and whether the session is locked ('state' to the page);
//   - while a secure desktop has it, receives its pictures ('frame'), which host.js puts into each
//     monitor's video track in place of the capturer's (which cannot read that desktop): every monitor's
//     from a service of 2026-11-18 on (x, y say which), only the primary's from an older one;
//   - while the session is locked (the lock screen and nothing else), sends the person's input to the
//     helper instead of SendInput (input.setSink), so they type their password as at the keyboard. A UAC
//     prompt gets no input: dropped here, and refused by the helper too (see native/winassist.cpp).
// Before anything typed is sent, each pipe's server is checked: the control pipe's must run in session 0
// (the service), the data pipe's in this session (the helper). A pipe of the same name made first by
// another account on this PC (fast user switching) runs in that account's session and is refused, so it
// can never receive the password typed into the lock screen. (A program of this same user could listen
// in anyway: it can read this process's memory.)
//
// Installing, updating and removing run winassist.exe elevated. Windows asks the person at this PC (UAC),
// which cannot be answered from the client.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const input = require('./input');

const CONTROL = '\\\\.\\pipe\\my-remote-assist';
const DATA = '\\\\.\\pipe\\my-remote-assist-data';
const PROTOCOL = 1; // ASSIST_PROTOCOL in native/winassist.cpp
// ASSIST_CAPS: the answer's fourth byte. 'M': its helper sends every monitor once asked ('V'); a service
// from before 2026-11-18 answers three bytes and its helper gets the primary monitor's pictures only ('F'),
// as before (it would end on a 'V').
const CAP_MONITORS = 0x4d;
// The service and the folder its program runs from. Up to 0.9.x the program was called My Remote and so were they:
// a PC whose service was installed then keeps it (the pipes above kept their names, the protocol is the same)
// until the host window's card updates it, which installs this one and removes that one (winassist.exe install).
const SERVICES = [{ name: 'PangmoteAssist', folder: 'Pangmote' }, { name: 'MyRemoteAssist', folder: 'MyRemote' }];
let found = SERVICES[0]; // the one serviceState() found last (the new one when there is none)
const BUNDLED = path.join(__dirname, 'bin', 'winassist.exe');
const installedPath = (s = found) => path.join(process.env.ProgramFiles || 'C:\\Program Files', s.folder, 'winassist.exe');
const log = (s) => console.log('[assist] ' + s);
const supported = process.platform === 'win32';
// release/test-assist.js and the self-test only: other pipe names, the session the control pipe's server
// must run in ('own': the test's), whether the service runs, the first retry delay, and what runs in place
// of the elevated winassist.exe (verb -> exit code), so that no test ever raises a real UAC prompt. A
// test's fake service runs in the test's own session and is no service.
const T = { control: CONTROL, data: DATA, controlSession: 0, serviceState: null, retryMs: 2500, elevate: null };

// ---- Win32 through koffi -----------------------------------------------------------------
let w = null;
function win() {
  if (w) return w;
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll'), adv = koffi.load('advapi32.dll');
  const OVERLAPPED = koffi.struct({ Internal: 'uintptr_t', InternalHigh: 'uintptr_t', Offset: 'uint32', OffsetHigh: 'uint32', hEvent: 'intptr_t' });
  const SERVICE_STATUS = koffi.struct({ type: 'uint32', state: 'uint32', accepted: 'uint32', exitCode: 'uint32', specific: 'uint32', checkPoint: 'uint32', waitHint: 'uint32' });
  const u32out = koffi.out(koffi.pointer('uint32'));
  w = {
    koffi, OVERLAPPED,
    CreateFileW: k32.func('CreateFileW', 'intptr_t', ['str16', 'uint32', 'uint32', 'intptr_t', 'uint32', 'uint32', 'intptr_t']),
    CloseHandle: k32.func('CloseHandle', 'bool', ['intptr_t']),
    CreateEventW: k32.func('CreateEventW', 'intptr_t', ['intptr_t', 'bool', 'bool', 'intptr_t']),
    ResetEvent: k32.func('ResetEvent', 'bool', ['intptr_t']),
    ReadFile: k32.func('ReadFile', 'bool', ['intptr_t', 'void *', 'uint32', 'intptr_t', 'void *']),
    WriteFile: k32.func('WriteFile', 'bool', ['intptr_t', 'void *', 'uint32', 'intptr_t', 'void *']),
    GetOverlappedResult: k32.func('GetOverlappedResult', 'bool', ['intptr_t', 'void *', u32out, 'bool']),
    WaitForSingleObject: k32.func('WaitForSingleObject', 'uint32', ['intptr_t', 'uint32']),
    CancelIoEx: k32.func('CancelIoEx', 'bool', ['intptr_t', 'void *']),
    GetNamedPipeServerSessionId: k32.func('GetNamedPipeServerSessionId', 'bool', ['intptr_t', u32out]),
    ProcessIdToSessionId: k32.func('ProcessIdToSessionId', 'bool', ['uint32', u32out]),
    OpenSCManagerW: adv.func('OpenSCManagerW', 'intptr_t', ['intptr_t', 'intptr_t', 'uint32']),
    OpenServiceW: adv.func('OpenServiceW', 'intptr_t', ['intptr_t', 'str16', 'uint32']),
    QueryServiceStatus: adv.func('QueryServiceStatus', 'bool', ['intptr_t', koffi.out(koffi.pointer(SERVICE_STATUS))]),
    CloseServiceHandle: adv.func('CloseServiceHandle', 'bool', ['intptr_t']),
  };
  return w;
}

// A named pipe opened for overlapped I/O: reads wait on a worker thread (koffi's async call), writes
// complete on this thread (they are a few bytes and the pipe has room). Synchronous handles would make
// a write wait for the read under way on another thread.
const STATUS_PENDING = 0x103, WAIT_TIMEOUT = 0x102, CHUNK = 256 * 1024;
class Pipe {
  static open(name) {
    const k = win();
    const h = k.CreateFileW(name, 0xc0000000 /* GENERIC_READ|WRITE */, 0, 0, 3 /* OPEN_EXISTING */, 0x40000000 /* OVERLAPPED */, 0);
    return h === -1 || h === 0 ? null : new Pipe(h);
  }
  constructor(h) {
    const k = win();
    this.h = h; this.closed = false; this.waiting = false;
    this.rev = k.CreateEventW(0, true, false, 0); this.wev = k.CreateEventW(0, true, false, 0);
    this.rov = k.koffi.alloc(k.OVERLAPPED, 1); this.wov = k.koffi.alloc(k.OVERLAPPED, 1);
    // Allocated memory is not zeroed: an OVERLAPPED that never started must not look pending (see end()).
    k.koffi.encode(this.rov, k.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.rev });
    k.koffi.encode(this.wov, k.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.wev });
    this.rbuf = k.koffi.alloc('uint8', CHUNK); this.wbuf = k.koffi.alloc('uint8', 4096);
    this.chunkType = k.koffi.array('uint8', CHUNK, 'Typed');
  }
  pending(ov) { const k = win(); return Number(k.koffi.decode(ov, k.OVERLAPPED).Internal) === STATUS_PENDING; }
  serverSession() { const id = [0]; return win().GetNamedPipeServerSessionId(this.h, id) ? id[0] : -1; }
  // Writes all of buf (at most 4096 bytes); false when the pipe is broken or the write did not finish in 1 s.
  write(buf) {
    if (this.closed || buf.length > 4096) return false;
    const k = win();
    k.koffi.encode(this.wbuf, 'uint8', Array.from(buf), buf.length);
    k.ResetEvent(this.wev);
    k.koffi.encode(this.wov, k.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.wev });
    k.WriteFile(this.h, this.wbuf, buf.length, 0, this.wov);
    if (this.pending(this.wov) && k.WaitForSingleObject(this.wev, 1000) === WAIT_TIMEOUT) k.CancelIoEx(this.h, this.wov);
    const n = [0];
    return k.GetOverlappedResult(this.h, this.wov, n, true) && n[0] === buf.length;
  }
  // onData(Buffer) for every piece read; onEnd() once when the pipe breaks or is closed.
  read(onData, onEnd) { this.onData = onData; this.onEnd = onEnd; this.next(); }
  next() {
    if (this.closed) return this.end();
    const k = win();
    k.ResetEvent(this.rev);
    k.koffi.encode(this.rov, k.OVERLAPPED, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: this.rev });
    k.ReadFile(this.h, this.rbuf, CHUNK, 0, this.rov);
    this.wait();
  }
  wait() {
    const k = win();
    // Still pending: wait for it on a worker thread, half a second at a time (so a close is noticed and the
    // thread pool is not held for good). Done (or failed at once, which leaves Internal as we set it):
    // GetOverlappedResult tells.
    if (this.pending(this.rov)) {
      this.waiting = true;
      k.WaitForSingleObject.async(this.rev, 500, (err, r) => {
        this.waiting = false;
        if (this.closed && r === WAIT_TIMEOUT) return this.end();
        if (!err && r === WAIT_TIMEOUT) return this.wait();
        this.done();
      });
      return;
    }
    this.done();
  }
  done() {
    const k = win(), n = [0];
    if (!k.GetOverlappedResult(this.h, this.rov, n, false) || !n[0]) return this.end();
    const bytes = k.koffi.decode(this.rbuf, this.chunkType); // a copy (memory outside V8 cannot be viewed in Electron)
    try { this.onData(Buffer.from(bytes.buffer, bytes.byteOffset, n[0])); } catch (e) { log('read: ' + e.message); }
    this.next();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { win().CancelIoEx(this.h, 0 /* every operation */); } catch {}
    if (!this.waiting) this.end();
  }
  end() {
    if (this.freed) return;
    this.closed = true; this.freed = true;
    const k = win(), n = [0];
    // A cancelled operation finishes on its own time: its OVERLAPPED and buffer must outlive it.
    try { k.CancelIoEx(this.h, 0); } catch {}
    if (this.pending(this.rov)) k.GetOverlappedResult(this.h, this.rov, n, true);
    if (this.pending(this.wov)) k.GetOverlappedResult(this.h, this.wov, n, true);
    k.CloseHandle(this.h); k.CloseHandle(this.rev); k.CloseHandle(this.wev);
    k.koffi.free(this.rov); k.koffi.free(this.wov); k.koffi.free(this.rbuf); k.koffi.free(this.wbuf);
    const f = this.onEnd; this.onEnd = null;
    if (f) try { f(); } catch {}
  }
}

// ---- installed, running, current ------------------------------------------------------------
function serviceState() { // 'none' | 'stopped' | 'running' | 'other'; sets `found`
  found = SERVICES[0];
  if (T.serviceState) return T.serviceState();
  const k = win();
  const scm = k.OpenSCManagerW(0, 0, 0x0001 /* SC_MANAGER_CONNECT */);
  if (!scm) return 'none';
  try {
    for (const s of SERVICES) {
      const svc = k.OpenServiceW(scm, s.name, 0x0004 /* SERVICE_QUERY_STATUS */);
      if (!svc) continue;
      found = s;
      try { const st = {}; return k.QueryServiceStatus(svc, st) ? (st.state === 4 ? 'running' : st.state === 1 ? 'stopped' : 'other') : 'other'; } finally { k.CloseServiceHandle(svc); }
    }
    return 'none';
  } finally { k.CloseServiceHandle(scm); }
}
function sameFile(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}
// What the host window shows: whether the service is there, running, and the program this app brings.
function status() {
  if (!supported) return { supported: false };
  const bundled = fs.existsSync(BUNDLED);
  let state = 'none';
  try { state = serviceState(); } catch (e) { log('status: ' + e.message); }
  return { supported: true, bundled, state, current: state !== 'none' && bundled && sameFile(BUNDLED, installedPath()), busy: !!busy };
}

// Runs the bundled winassist.exe with `verb` elevated; Windows' UAC prompt appears on this PC. -> exit code
// (1223: the person said no).
let busy = null;
function elevated(verb) {
  if (busy) return busy;
  if (T.elevate) { busy = Promise.resolve().then(() => T.elevate(verb)).finally(() => { busy = null; }); return busy; }
  const ps ="$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath '" + BUNDLED.replace(/'/g, "''") +
    "' -ArgumentList '" + verb + "' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }";
  busy = new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { windowsHide: true }, (err) => done(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  }).finally(() => { busy = null; });
  return busy;
}
// opts.remote: a remote session is on. Windows asks on this PC's secure desktop, where no input from the
// client ever arrives (see the top): an unattended PC would sit on that prompt, its client seeing only a
// notice, until someone at the PC answered it. So never then; the window says to do it at the PC.
async function install(opts) {
  if (opts && opts.remote) return { ok: false, why: 'remote', status: status() };
  if (!supported || !fs.existsSync(BUNDLED)) return { ok: false, why: 'missing', status: status() };
  const code = await elevated('install');
  log(`install: exit ${code}`);
  return { ok: code === 0, why: code === 1223 ? 'declined' : code ? 'failed' : '', status: status() };
}
async function uninstall(opts) {
  if (opts && opts.remote) return { ok: false, why: 'remote', status: status() };
  if (!supported || !fs.existsSync(BUNDLED)) return { ok: false, why: 'missing', status: status() };
  stop();
  const code = await elevated('uninstall');
  log(`uninstall: exit ${code}`);
  return { ok: code === 0, why: code === 1223 ? 'declined' : code ? 'failed' : '', status: status() };
}

// Offered once, at the host's first start (main.js). Chrome Remote Desktop installs its service with the
// program; this app comes as a folder to unpack, so its first start is when the PC is set up: the host
// asks whether to set up the lock screen support too, and on yes Windows asks for an administrator's
// consent at once. Answered either way, it is not asked again (`mark`, a file in the profile); the host
// window's card does it later. Not when the service is there already, nor during a remote session.
//   ask(): -> true to install;  remote(): a remote session is on;  notify({ busy } | { result }): the window
// -> 'asked' | 'installed' | 'declined' | 'failed' | 'later' | 'remote' | why it was not asked
async function offer({ mark, ask, remote, notify }) {
  if (!supported) return 'unsupported';
  if (fs.existsSync(mark)) return 'asked before';
  const st = status();
  if (!st.bundled) return 'not bundled';
  if (st.state !== 'none') return 'installed already';
  if (remote()) return 'remote session';
  const yes = !!(await ask());
  try { fs.writeFileSync(mark, JSON.stringify({ at: new Date().toISOString(), answer: yes ? 'yes' : 'later' })); } catch (e) { log('offer: ' + e.message); }
  if (!yes) return 'later';
  notify({ busy: true });
  const r = await install({ remote: remote() });
  notify({ result: r });
  return r.ok ? 'installed' : r.why;
}

// ---- during a session --------------------------------------------------------------------------
// conn: { send, control, data, state, prev, retry } while a session is live; null otherwise.
let conn = null, ownSession = -1;
function start(send) {
  if (!supported) return;
  stop();
  // told: the page has heard this connection's state (see setState).
  conn = { send, control: null, data: null, state: { secure: false, locked: false, input: false }, told: false, prev: new Map(), retry: 0 };
  connect(conn);
}
function stop() {
  const c = conn;
  conn = null;
  if (!c) return;
  clearTimeout(c.retry);
  input.setSink(null);
  if (c.data) c.data.close();
  if (c.control) c.control.close();
}
function again(c, why) {
  if (conn !== c) return;
  log(why);
  if (c.data) { c.data.close(); c.data = null; }
  if (c.control) { c.control.close(); c.control = null; }
  setState(c, { secure: false, locked: false, input: false });
  clearTimeout(c.retry);
  // The helper restarts with the session (sign-out, user switch): try again, less often each time.
  c.backoff = Math.min(30000, (c.backoff || T.retryMs) * 2);
  c.retry = setTimeout(() => connect(c), c.backoff);
}
async function connect(c) {
  if (conn !== c) return;
  let state = 'none';
  try { state = serviceState(); } catch {}
  if (state !== 'running') return; // not installed (or stopped): the host works as before, the client is told about locks only
  if (ownSession < 0) { const id = [0]; ownSession = win().ProcessIdToSessionId(process.pid, id) ? id[0] : -2; }
  const control = Pipe.open(T.control);
  if (!control) return again(c, 'the service did not answer');
  if (control.serverSession() !== (T.controlSession === 'own' ? ownSession : T.controlSession)) { control.close(); return again(c, 'the control pipe is not the service\'s (not session 0): not used'); }
  c.control = control;
  const reply = await new Promise((done) => {
    let got = Buffer.alloc(0), late = 0;
    const t = setTimeout(() => done(null), 4000);
    const finish = () => { clearTimeout(t); clearTimeout(late); done(got); };
    // Three bytes from a service of before 2026-11-18, four from a newer one (written at once: they come
    // together, but a short wait for the fourth costs nothing).
    control.read((b) => { got = Buffer.concat([got, b]); if (got.length >= 4) finish(); else if (got.length >= 3 && !late) late = setTimeout(finish, 250); }, () => { clearTimeout(t); clearTimeout(late); done(got.length >= 3 ? got : null); });
    if (!control.write(Buffer.from('S'))) { clearTimeout(t); done(null); }
  });
  if (conn !== c) return;
  if (!reply || reply.toString('latin1', 0, 2) !== 'ok') return again(c, 'the service gave no answer');
  if (reply[2] !== PROTOCOL) return again(c, `the service speaks protocol ${reply[2]}, this host ${PROTOCOL}: install it again from this version`);
  const monitors = reply.length >= 4 && reply[3] === CAP_MONITORS;
  // The helper makes the data pipe once it runs in this session: a second or so.
  let data = null;
  for (let i = 0; i < 40 && conn === c && !data; i++) {
    data = Pipe.open(T.data);
    if (!data) await new Promise((r) => setTimeout(r, 250));
  }
  if (conn !== c) { if (data) data.close(); return; }
  if (!data) return again(c, 'the helper did not start');
  if (data.serverSession() !== ownSession) { data.close(); return again(c, 'the data pipe is not the helper\'s in this session: not used'); }
  c.data = data;
  c.backoff = 0;
  // Every monitor's picture, where the helper can (see CAP_MONITORS); before anything else is read.
  if (monitors && !data.write(Buffer.from('V'))) { data.close(); return again(c, 'could not write to the helper'); }
  log('connected to the assist service' + (monitors ? ' (every monitor)' : ' (the primary monitor)'));
  const parse = parser(c);
  data.read(parse, () => again(c, 'the helper went away'));
}
// The helper's messages: 'S' + flags; 'F' + u16 w, u16 h, u32 bytes + BGRA (the primary monitor);
// 'R' + i32 x, i32 y, u16 w, u16 h, u32 bytes + BGRA (one monitor, at x,y on the virtual screen).
const HEAD = { 0x53: 2, 0x46: 9, 0x52: 17 };
function parser(c) {
  let head = Buffer.alloc(0), frame = null;
  return (chunk) => {
    let off = 0;
    while (off < chunk.length && conn === c) {
      if (frame) {
        const n = Math.min(frame.buf.length - frame.filled, chunk.length - off);
        chunk.copy(frame.buf, frame.filled, off, off + n);
        frame.filled += n; off += n;
        if (frame.filled === frame.buf.length) { gotFrame(c, frame); frame = null; }
        continue;
      }
      const need = head.length ? HEAD[head[0]] || -1 : 1;
      if (need < 0) return again(c, 'unexpected data from the helper');
      const take = Math.min(need - head.length, chunk.length - off);
      head = Buffer.concat([head, chunk.subarray(off, off + take)]);
      off += take;
      if (head.length === 1 && !HEAD[head[0]]) return again(c, 'unexpected data from the helper');
      if (head.length < HEAD[head[0]]) continue;
      if (head[0] === 0x53) {
        const f = head[1];
        head = Buffer.alloc(0);
        setState(c, { secure: !!(f & 1), locked: !!(f & 2), input: !!(f & 4) });
        continue;
      }
      const at = head[0] === 0x52 ? { x: head.readInt32LE(1), y: head.readInt32LE(5) } : null;
      const o = at ? 9 : 1;
      const fw = head.readUInt16LE(o), fh = head.readUInt16LE(o + 2), bytes = head.readUInt32LE(o + 4);
      head = Buffer.alloc(0);
      if (!fw || !fh || bytes !== fw * fh * 4 || bytes > 64 * 1024 * 1024) return again(c, 'a picture of the wrong size from the helper');
      frame = { ...(at || {}), w: fw, h: fh, buf: Buffer.allocUnsafe(bytes), filled: 0 };
    }
  };
}
function gotFrame(c, f) {
  if (!c.state.secure) return; // only a secure desktop's pictures are this module's to show
  // The helper repeats an unchanged picture now and then (for a late connection): not passed on again.
  const key = f.x === undefined ? 'primary' : `${f.x},${f.y},${f.w},${f.h}`;
  const prev = c.prev.get(key);
  if (prev && prev.equals(f.buf)) return;
  c.prev.set(key, f.buf);
  c.send(f.x === undefined ? { t: 'frame', w: f.w, h: f.h, data: f.buf } : { t: 'frame', x: f.x, y: f.y, w: f.w, h: f.h, data: f.buf });
}
function setState(c, s) {
  const was = c.state, first = !c.told;
  c.state = s;
  c.told = true;
  // The lock screen: input goes to the helper. Another secure desktop (UAC): it goes nowhere.
  input.setSink(s.input ? (list) => toHelper(c, list) : s.secure ? () => {} : null);
  if (!s.secure) c.prev.clear();
  const changed = was.secure !== s.secure || was.locked !== s.locked || was.input !== s.input;
  if (changed) log(`screen: ${s.secure ? (s.locked ? 'lock screen' : 'secure desktop (UAC or similar)') : 'desktop'}${s.input ? ', input to the helper' : ''}`);
  // A connection's first word goes to the page also when it is the ordinary desktop, the state a connection starts
  // from: the page may still have what the connection before said last. Before 2026-11-20 it did not, and a lock
  // screen that was unlocked at the PC while no session was on stayed "locked" for the next session's client.
  if (changed || first) c.send({ t: 'state', ...s });
}
function toHelper(c, list) {
  if (!c.data) return;
  const parts = [];
  for (const e of list) {
    if (e.mouse) {
      const b = Buffer.alloc(17);
      b[0] = 0x4d; b.writeUInt32LE(e.mouse.flags >>> 0, 1); b.writeInt32LE(e.mouse.dx | 0, 5); b.writeInt32LE(e.mouse.dy | 0, 9); b.writeInt32LE(e.mouse.data | 0, 13);
      parts.push(b);
    } else if (e.key) {
      const b = Buffer.alloc(9);
      b[0] = 0x4b; b.writeUInt16LE(e.key.vk & 0xffff, 1); b.writeUInt16LE(e.key.scan & 0xffff, 3); b.writeUInt32LE(e.key.flags >>> 0, 5);
      parts.push(b);
    }
  }
  for (let i = 0; i < parts.length; i += 200) {
    if (!c.data.write(Buffer.concat(parts.slice(i, i + 200)))) return again(c, 'could not write to the helper');
  }
}
// Ctrl+Alt+Del for a lock screen that asks for it (a policy on many company PCs). Only on the lock screen.
function sas() {
  const c = conn;
  if (c && c.data && c.state.input) c.data.write(Buffer.from('A'));
}
const state = () => (conn ? { ...conn.state } : { secure: false, locked: false, input: false });

module.exports = { supported, status, install, uninstall, offer, start, stop, sas, state, installedPath, BUNDLED, PROTOCOL, _test: T };
