// UDP link emulator for the bench (bench.js). It sits between the two WebRTC peers on this PC
// and applies, per direction: a fixed delay, random jitter, random loss and a rate limit with a
// bounded queue (packets that would wait longer than the queue allows are dropped, like a router).
//
//   electron.exe (ELECTRON_RUN_AS_NODE=1) netem.js '<json options>'
//   options: { delay, jitter, loss, rate, queue, toClient: {...}, toHost: {...}, spin }
//     delay/jitter/queue in ms (delay is one way), loss in %, rate in Mbps (0 = unlimited)
//
// Parent <-> this process over the Node IPC channel: sends { port } once listening,
// accepts { target: { address, port } } (the host's real ICE candidate) and { stats: true }.
const dgram = require('dgram');

const opts = JSON.parse(process.argv[2] || '{}');
// Timers on Windows tick every 15.6 ms unless a process asks for 1 ms; a link emulator that
// released packets in 15 ms bursts would look like a congested link to the bandwidth estimator.
try { require('koffi').load('winmm.dll').func('timeBeginPeriod', 'uint', ['uint'])(1); } catch {}
const now = () => Number(process.hrtime.bigint()) / 1e6;

function shaper(o) {
  const q = [];
  let head = 0, busyUntil = 0, lastOut = 0;
  const st = { packets: 0, bytes: 0, lost: 0, overflow: 0, maxQueueMs: 0 };
  return {
    st,
    push(buf, out) {
      st.packets++;
      if (o.loss && Math.random() * 100 < o.loss) { st.lost++; return; }
      const t = now();
      let depart = t;
      if (o.rate) {
        const wait = Math.max(0, busyUntil - t);
        if (wait > (o.queue || 100)) { st.overflow++; return; }
        if (wait > st.maxQueueMs) st.maxQueueMs = wait;
        depart = Math.max(t, busyUntil) + (buf.length * 8) / (o.rate * 1000);
        busyUntil = depart;
      }
      let at = depart + (o.delay || 0) + (o.jitter ? Math.random() * o.jitter : 0);
      if (at < lastOut) at = lastOut; // a queue does not reorder
      lastOut = at;
      st.bytes += buf.length;
      q.push({ at, buf, out });
    },
    pump(t) {
      while (head < q.length && q[head].at <= t) { const p = q[head++]; p.out(p.buf); }
      if (head > 2048) { q.splice(0, head); head = 0; }
    },
  };
}

const toHost = shaper({ ...opts, ...(opts.toHost || {}) });
const toClient = shaper({ ...opts, ...(opts.toClient || {}) });
let target = null;

// The client sends to `front`. Each client address gets its own socket towards the host (like a
// NAT mapping), so the host's replies find their way back.
const front = dgram.createSocket('udp4');
const backs = new Map();
front.on('message', (buf, r) => {
  const key = r.address + ':' + r.port;
  let back = backs.get(key);
  if (!back) {
    back = dgram.createSocket('udp4');
    back.on('message', (b) => toClient.push(b, (x) => front.send(x, r.port, r.address)));
    back.on('error', () => {});
    back.bind(0);
    backs.set(key, back);
  }
  toHost.push(buf, (x) => { if (target) back.send(x, target.port, target.address); });
});
front.on('error', () => {});

let last = now(), ticks = 0, worst = 0, sum = 0;
const tick = () => {
  const t = now(), gap = t - last;
  last = t; ticks++; sum += gap;
  if (gap > worst) worst = gap;
  toHost.pump(t); toClient.pump(t);
};
if (opts.spin) { const loop = () => { tick(); setImmediate(loop); }; loop(); }
else setInterval(tick, 1);

process.on('message', (m) => {
  if (m.target) target = m.target;
  if (m.stats) process.send({ stats: { toHost: toHost.st, toClient: toClient.st, tickAvgMs: sum / Math.max(1, ticks), tickWorstMs: worst } });
});
process.on('disconnect', () => process.exit(0));
front.bind(0, () => process.send({ port: front.address().port }));
