// The host's side of the Windows assist service (host/assist.js) against a fake service and helper in
// this process: the pipes, the protocol and its version, the check of which session serves a pipe, where
// input goes in each state and how it is encoded, pictures put together from pieces, Ctrl+Alt+Del, and
// connecting again after the helper went away. Plain Node, Windows only (named pipes, session ids).
// Nothing is installed, and no input can reach this PC: input.setSink is replaced by a recorder before
// anything starts, so the platform layer never sees the sink.
//   node release/test-assist.js
'use strict';
if (process.platform !== 'win32') { console.log('SKIP  test-assist runs on Windows only'); process.exit(0); }
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

// The fake service: answers 'S' with "ok" and a protocol byte.
let protocolByte = assist.PROTOCOL, controlConnections = 0, controlAsked = 0;
const controlServer = net.createServer((sock) => {
  controlConnections++;
  sock.on('data', (d) => { if (d[0] === 0x53) { controlAsked++; sock.write(Buffer.from([0x6f, 0x6b, protocolByte])); } });
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

  // 11. the service manager is read (this PC's state is whatever it is: only that it answers)
  const st = assist.status();
  ok('status answers from the service manager', st.supported === true && typeof st.state === 'string' && st.bundled === true, JSON.stringify(st));

  controlServer.close(); dataServer.close();
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  setTimeout(() => process.exit(failed ? 1 : 0), 600); // let a pending wait on a worker thread end
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
