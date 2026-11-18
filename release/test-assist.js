// The host's side of the Windows assist service (host/assist.js) against a fake service and helper in
// this process: the pipes, the protocol and its version, the check of which session serves a pipe, where
// input goes in each state and how it is encoded, pictures put together from pieces, Ctrl+Alt+Del,
// connecting again after the helper went away, and installing: never during a remote session, and the
// offer at the host's first start. Plain Node, Windows only (named pipes, session ids).
// Nothing is installed (a stand-in runs instead of the elevated winassist.exe), and no input can reach
// this PC: input.setSink is replaced by a recorder before anything starts, so the platform layer never
// sees the sink.
//   node release/test-assist.js
'use strict';
if (process.platform !== 'win32') { console.log('SKIP  test-assist runs on Windows only'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const input = require('../host/input');
const assist = require('../host/assist');

let failed = 0, passed = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (cond) passed++; else failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await sleep(15); } return true; }

// The sink assist.js hands to input.js, recorded here and never passed on.
let sink = 'unset';
input.setSink = (fn) => { sink = fn; };

const T = assist._test, tag = 'mrtest-assist-' + process.pid;
T.control = `\\\\.\\pipe\\${tag}-control`;
T.data = `\\\\.\\pipe\\${tag}-data`;
T.controlSession = 'own'; // the fake service runs in this test's session
T.serviceState = () => 'running';
T.retryMs = 100;

// The fake service: answers 'S' with "ok" and a protocol byte, and `caps` as a fourth byte when set (a
// service of 2026-11-18 on: 'M', every monitor; one from before answers three bytes).
let protocolByte = assist.PROTOCOL, caps = null, controlConnections = 0, controlAsked = 0;
const controlServer = net.createServer((sock) => {
  controlConnections++;
  sock.on('data', (d) => { if (d[0] === 0x53) { controlAsked++; sock.write(Buffer.from(caps == null ? [0x6f, 0x6b, protocolByte] : [0x6f, 0x6b, protocolByte, caps])); } });
  sock.on('error', () => {});
});
// The fake helper: records what the host sends; the test writes states and pictures through it.
let helper = null, helperConnections = 0, received = Buffer.alloc(0), helperEnded = false;
const dataServer = net.createServer((sock) => {
  helper = sock; helperConnections++; helperEnded = false;
  sock.on('data', (d) => { received = Buffer.concat([received, d]); });
  sock.on('end', () => { helperEnded = true; });
  sock.on('close', () => { helperEnded = true; });
  sock.on('error', () => {});
});

const toPage = [];
const pageSend = (m) => toPage.push(m);
const lastState = () => [...toPage].reverse().find((m) => m.t === 'state');
const frames = () => toPage.filter((m) => m.t === 'frame');

(async () => {
  await new Promise((r) => controlServer.listen(T.control, r));
  await new Promise((r) => dataServer.listen(T.data, r));

  // 1. connecting
  assist.start(pageSend);
  ok('connects to the service and then to its helper', await until(() => helper && controlConnections === 1, 4000));
  await sleep(150);
  ok('a service of before 2026-11-18 (three bytes) is not asked for every monitor (its helper would end on it)', received.length === 0, `${received.length} bytes`);

  // 2. the lock screen: input to the helper
  helper.write(Buffer.from([0x53, 1 | 2 | 4]));
  ok('the lock screen is reported to the page', await until(() => { const s = lastState(); return s && s.secure && s.locked && s.input; }, 2000));
  ok('on the lock screen input goes to the helper (a sink is set)', typeof sink === 'function');
  received = Buffer.alloc(0);
  sink([{ key: { vk: 0, scan: 0x1e, flags: 0x8 } }, { mouse: { flags: 0x8001 | 0x4000, dx: 1000, dy: 64000, data: 0 } }, { mouse: { flags: 0x800, dx: 0, dy: 0, data: -120 } }, { key: { vk: 0, scan: 0x1e, flags: 0x8 | 0x2 } }]);
  await until(() => received.length >= 9 + 17 + 17 + 9, 2000);
  const r = received;
  const encoded = r.length === 52 && r[0] === 0x4b && r.readUInt16LE(1) === 0 && r.readUInt16LE(3) === 0x1e && r.readUInt32LE(5) === 0x8 &&
    r[9] === 0x4d && r.readUInt32LE(10) === (0x8001 | 0x4000) && r.readInt32LE(14) === 1000 && r.readInt32LE(18) === 64000 && r.readInt32LE(22) === 0 &&
    r[26] === 0x4d && r.readUInt32LE(27) === 0x800 && r.readInt32LE(39) === -120 &&
    r[43] === 0x4b && r.readUInt16LE(46) === 0x1e && r.readUInt32LE(48) === 0xa;
  ok('keys and mouse go as SendInput records, in order (a wheel turn keeps its sign)', encoded, `${r.length} bytes`);

  // 3. pictures: put together from pieces, an unchanged one not passed on again
  const w = 4, h = 2, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7) & 0xff;
  const head = Buffer.alloc(9); head[0] = 0x46; head.writeUInt16LE(w, 1); head.writeUInt16LE(h, 3); head.writeUInt32LE(px.length, 5);
  const whole = Buffer.concat([head, px]);
  helper.write(whole.subarray(0, 5)); await sleep(30); helper.write(whole.subarray(5, 20)); await sleep(30); helper.write(whole.subarray(20));
  ok('a picture sent in pieces reaches the page whole', await until(() => frames().length === 1, 2000) && Buffer.from(frames()[0].data).equals(px) && frames()[0].w === w && frames()[0].h === h);
  helper.write(whole); await sleep(150);
  ok('the same picture again (the helper repeats it once a second) is not passed on', frames().length === 1);
  const px2 = Buffer.from(px); px2[0] ^= 0xff;
  helper.write(Buffer.concat([head, px2]));
  ok('a changed picture is', await until(() => frames().length === 2, 2000));

  // 4. Ctrl+Alt+Del
  received = Buffer.alloc(0);
  assist.sas();
  ok('Ctrl+Alt+Del is sent on the lock screen', await until(() => received.length === 1 && received[0] === 0x41, 1500));

  // 5. a UAC prompt: shown, never answered
  helper.write(Buffer.from([0x53, 1]));
  ok('another secure desktop (UAC) is reported as view only', await until(() => { const s = lastState(); return s && s.secure && !s.locked && !s.input; }, 2000));
  received = Buffer.alloc(0);
  if (typeof sink === 'function') sink([{ key: { vk: 0, scan: 0x1c, flags: 0x8 } }]);
  assist.sas();
  await sleep(200);
  ok('on it, input and Ctrl+Alt+Del go nowhere', typeof sink === 'function' && received.length === 0);

  // 6. the ordinary desktop: SendInput as always, and the helper's pictures are not its business
  helper.write(Buffer.from([0x53, 0]));
  ok('the ordinary desktop gives input back to SendInput', await until(() => sink === null, 2000));
  const before = frames().length;
  helper.write(Buffer.concat([head, px])); await sleep(150);
  ok('pictures that arrive then are not shown', frames().length === before);

  // 7. the helper goes away (a sign-out, a user switch): connected again
  helper.destroy();
  ok('when the helper goes away, the page is told the desktop is back', await until(() => { const s = lastState(); return s && !s.secure; }, 2000));
  ok('and the host connects again by itself', await until(() => helperConnections === 2, 5000));

  // 8. a service of another protocol version is not used
  assist.stop();
  await until(() => helperEnded, 2000);
  protocolByte = assist.PROTOCOL + 1;
  const conns = helperConnections;
  assist.start(pageSend);
  await sleep(900);
  ok('a service that speaks another protocol version is not used', helperConnections === conns);
  assist.stop();
  protocolByte = assist.PROTOCOL;

  // 9. a control pipe served from another session (someone else's pipe of that name) is refused
  T.controlSession = 999999;
  const c2 = controlConnections, asked = controlAsked;
  assist.start(pageSend);
  await sleep(900);
  ok('a control pipe whose server runs in another session is refused before anything is sent',
    controlConnections > c2 && controlAsked === asked && helperConnections === conns, `${controlConnections - c2} tries, ${controlAsked - asked} requests`);
  assist.stop();
  T.controlSession = 'own';

  // 10. stopping lets go of the helper
  assist.start(pageSend);
  await until(() => helperConnections === conns + 1, 4000);
  assist.stop();
  ok('stopping closes the connection to the helper', await until(() => helperEnded, 2000) && sink === null);

  // 10b. a service that can send every monitor: asked at once ('V'), and its pictures ('R') carry their place
  caps = 0x4d;
  received = Buffer.alloc(0);
  const c3 = helperConnections;
  assist.start(pageSend);
  ok('a service that can send every monitor is asked to at once, before anything else is sent',
    await until(() => helperConnections === c3 + 1 && received.length >= 1, 4000) && received[0] === 0x56 && received.length === 1, `${received.length} bytes, first ${received[0]}`);
  helper.write(Buffer.from([0x53, 1 | 2 | 4]));
  await until(() => { const s = lastState(); return s && s.secure && s.locked; }, 2000);
  const rf = (x, y, pw, ph, p) => { const hd = Buffer.alloc(17); hd[0] = 0x52; hd.writeInt32LE(x, 1); hd.writeInt32LE(y, 5); hd.writeUInt16LE(pw, 9); hd.writeUInt16LE(ph, 11); hd.writeUInt32LE(p.length, 13); return Buffer.concat([hd, p]); };
  const n0 = frames().length;
  const two = Buffer.concat([rf(0, 0, w, h, px), rf(-1920, -200, w, h, px)]); // two monitors showing the same pixels
  helper.write(two.subarray(0, 10)); await sleep(30); helper.write(two.subarray(10));
  const f2 = () => frames().slice(n0);
  ok('each monitor\'s picture reaches the page with its place, also the same pixels at another place',
    await until(() => f2().length === 2, 2000) && f2()[0].x === 0 && f2()[0].y === 0 && f2()[1].x === -1920 && f2()[1].y === -200 && f2()[1].w === w && Buffer.from(f2()[1].data).equals(px),
    JSON.stringify(f2().map((f) => [f.x, f.y, f.w, f.h])));
  helper.write(rf(-1920, -200, w, h, px)); await sleep(150);
  ok('an unchanged picture of a monitor is not passed on again; a changed one is', f2().length === 2 && (helper.write(rf(-1920, -200, w, h, px2)), await until(() => f2().length === 3, 2000)));
  assist.stop();
  await until(() => helperEnded, 2000);
  caps = null;

  // 11. installing and removing: never during a remote session (Windows' consent prompt cannot be answered
  // from the client); the offer at the host's first start asks once, and only where the service is not
  // there yet. Nothing runs elevated here: T.elevate stands in for winassist.exe.
  {
    const calls = [];
    T.elevate = (verb) => { calls.push(verb); return 0; };
    const mark = path.join(os.tmpdir(), tag + '-offered.json');
    fs.rmSync(mark, { force: true });
    const r1 = await assist.install({ remote: true }), r2 = await assist.uninstall({ remote: true });
    ok('installing or removing is refused during a remote session, before anything runs elevated', r1.why === 'remote' && r2.why === 'remote' && calls.length === 0, JSON.stringify(calls));
    const asked = [], notes = [];
    const offer = (answer, remote) => assist.offer({ mark, remote: () => !!remote, ask: async () => { asked.push(answer); return answer; }, notify: (m) => notes.push(m.busy ? 'busy' : m.result && m.result.ok ? 'done' : 'not done') });
    T.serviceState = () => 'none';
    const a = await offer(false); // "later"
    const b = await offer(true); // asked before: not again
    fs.rmSync(mark, { force: true });
    const c = await offer(true, true); // a remote session is on: not asked
    const d = await offer(true); // yes: installed at once
    fs.rmSync(mark, { force: true });
    T.serviceState = () => 'running';
    const e = await offer(true); // the service is there already
    ok('the first start offers the lock screen support once and installs it on yes; not during a remote session, not when it is there',
      a === 'later' && b === 'asked before' && c === 'remote session' && d === 'installed' && e === 'installed already' && asked.join() === 'false,true' && calls.join() === 'install' && notes.join() === 'busy,done',
      JSON.stringify({ a, b, c, d, e, asked, calls, notes }));
    fs.rmSync(mark, { force: true });
    T.elevate = null;
  }

  // 12. the service manager is read (this PC's state is whatever it is: only that it answers)
  const fake = T.serviceState;
  T.serviceState = null;
  const st = assist.status();
  T.serviceState = fake;
  ok('status answers from the service manager', st.supported === true && typeof st.state === 'string' && st.bundled === true, JSON.stringify(st));

  controlServer.close(); dataServer.close();
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  setTimeout(() => process.exit(failed ? 1 : 0), 600); // let a pending wait on a worker thread end
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
