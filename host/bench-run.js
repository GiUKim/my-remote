// Runs the bench (bench.js) for a set of link conditions and settings and prints one table.
//
//   node bench-run.js [--net=direct,fiber,...] [--try=base,smooth,...] [--secs=24] [--repeat=1]
//                     [--picture=1280x720] [--display=N] [--out=<dir>] [--set=<json>]
//
// Every run starts its own isolated host (local relay, throwaway key, nothing leaves this PC).
// --set merges a JSON object into every run's config (see bench.js for the fields).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { format } = require('./bench');

// Link conditions. delay is one way, in ms; rate in Mbps; queue = how many ms of traffic the bottleneck holds.
const NETS = {
  direct: null,                                                                  // no emulator at all
  lan: { delay: 0 },                                                             // through the emulator, unchanged (checks the emulator itself)
  fiber: { delay: 2, jitter: 1, rate: 200, queue: 50 },                          // same-city fibre on both ends
  home: { delay: 8, jitter: 3, loss: 0.05, toClient: { rate: 40, queue: 100 }, toHost: { rate: 40, queue: 100 } },
  narrow: { delay: 8, jitter: 3, loss: 0.05, toClient: { rate: 6, queue: 150 }, toHost: { rate: 20, queue: 100 } }, // host uplink of ~6 Mbps
  wifi: { delay: 4, jitter: 12, loss: 1, rate: 60, queue: 80 },                  // client on a busy wireless network
};
// Settings to compare. Each is merged into the run's config.
const TRIES = {
  base: {},                                  // what the host does by default
  smooth: { mode: 'smooth' },                // the client's "smooth" picture mode
  h264: { codec: 'H264' },
  av1: { codec: 'AV1' },
  // How it was before these were tuned: the engine's own transport settings, H.264, no upper probing limit.
  old: { codec: 'H264', trials: '', hostJs: '{ const h = hintBitrate; hintBitrate = (sdp, a, b) => h(sdp, a, b, 0); }' },
};

const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : def; };
const nets = arg('net', 'direct').split(',');
const tries = arg('try', 'base').split(',');
const repeat = Number(arg('repeat', 1));
const extra = JSON.parse(arg('set', '{}'));
const outDir = arg('out', path.join(os.tmpdir(), 'myremote-bench', new Date().toISOString().replace(/[:.]/g, '-')));
fs.mkdirSync(outDir, { recursive: true });
// More settings can be kept in a file next to the results instead of editing this one: { "name": { ...config } }
const triesFile = arg('tries-file', '');
if (triesFile) Object.assign(TRIES, JSON.parse(fs.readFileSync(triesFile, 'utf8')));

const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const rows = [];
for (const n of nets) for (const t of tries) for (let i = 0; i < repeat; i++) {
  if (!(n in NETS)) { console.log('unknown --net: ' + n); process.exit(2); }
  if (!(t in TRIES)) { console.log('unknown --try: ' + t); process.exit(2); }
  const name = `${n}/${t}${repeat > 1 ? '#' + (i + 1) : ''}`;
  const file = path.join(outDir, name.replace(/[\/#]/g, '_'));
  const config = { name, net: NETS[n], secs: Number(arg('secs', 24)), ...TRIES[t], ...extra, out: file + '.json' };
  if (arg('picture', '')) { const [w, h] = arg('picture', '').split('x').map(Number); config.pattern = { ...(config.pattern || {}), w, h }; }
  if (arg('display', '')) config.display = Number(arg('display', '')) - 1;
  if (process.argv.includes('--snapshot')) config.snapshot = file; // <file>.scroll.png and <file>.still.png: what the client showed
  fs.writeFileSync(file + '.config.json', JSON.stringify(config));
  const r = spawnSync(electron, [__dirname, '--bench', '--bench-config=' + file + '.config.json'], { env, encoding: 'utf8', timeout: (config.secs + 160) * 1000 });
  fs.writeFileSync(file + '.log', (r.stdout || '') + '\n' + (r.stderr || ''));
  let res = null;
  try { res = JSON.parse(fs.readFileSync(file + '.json', 'utf8')); } catch {}
  if (!res) res = { name, ok: false, error: 'no result (exit ' + r.status + '), see ' + file + '.log' };
  for (const l of format(res)) console.log(l);
  rows.push(res);
}

const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
console.log('');
console.log(pad('run', 22) + pad('fps shown', 11) + pad('scroll delay', 15) + pad('start', 7) + pad('gaps>50/100', 13) + pad('typing delay', 15) + pad('Mbps', 6) + pad('QP', 5) + pad('est.Mbps', 10) + pad('pacer', 7) + pad('jbuf', 6) + 'cap/enc fps');
for (const r of rows) {
  if (!r.ok) { console.log(pad(r.name, 22) + 'FAILED'); continue; }
  const s = r.scroll, sp = r.sparse, hs = r.host.scroll || {};
  console.log(pad(r.name, 22) + pad(`${s.shownFps}/${s.drawnFps}`, 11) + pad(`${s.lat.p50}/${s.lat.p95}/${s.lat.max}`, 15) + pad(s.latHead.p50, 7) + pad(`${s.gap.over50}/${s.gap.over100}`, 13)
    + pad(`${sp.lat.p50}/${sp.lat.p95}/${sp.lat.max}`, 15) + pad(hs.mbps, 6) + pad(hs.qp, 5) + pad(r.host.bwe.p50, 10) + pad(hs.pacerMs, 7) + pad((r.client || {}).jitterBufferMs, 6) + `${hs.captureFps}/${hs.encodeFps}`);
}
console.log('\ndelays are ms, p50/p95/max, from "drawn on the host" to "on the client screen"; results in ' + outDir);
