// The performance gate: runs the bench (host/bench-run.js: the real host and the real client page on
// this machine, isolated) and fails when a figure leaves the limits in release/bench-thresholds.json.
//   node release/bench-gate.js [--profile=ci|dev] [--secs=24] [--no-sandbox]
// ci: the wide limits for CI machines (the default under CI=true); dev: a development PC. Prints the
// figures beside their limits; exit 1 when one is out. Needs a display (xvfb-run on Linux) and shows a
// test picture on it for the length of the run.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : def; };
const profile = arg('profile', process.env.CI ? 'ci' : 'dev');
const limits = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-thresholds.json'), 'utf8'))[profile];
if (!limits) { console.log(`no limits for profile "${profile}"`); process.exit(2); }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pangmote-benchgate-'));
const runs = Object.keys(limits);
const nets = [...new Set(runs.map((r) => r.split('/')[0]))], tries = [...new Set(runs.map((r) => r.split('/')[1]))];

// bench-run.js is a Node script run by this same program (Node, or Electron as Node where there is no
// Node: ELECTRON_RUN_AS_NODE stays); it clears that variable itself for the Electron it starts.
const env = { ...process.env };
const r = spawnSync(process.execPath, [path.join(ROOT, 'host', 'bench-run.js'), `--net=${nets.join(',')}`, `--try=${tries.join(',')}`, `--secs=${arg('secs', '24')}`, `--out=${out}`, ...process.argv.filter((a) => a === '--no-sandbox')],
  { cwd: path.join(ROOT, 'host'), env, encoding: 'utf8', timeout: 15 * 60 * 1000 });
process.stdout.write(r.stdout || '');
if (r.status !== 0) { process.stdout.write(r.stderr || ''); console.log(`FAIL  the bench did not finish (exit ${r.status})`); process.exit(1); }

const get = (o, key) => key.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
let failed = 0;
console.log(`\nlimits: ${profile} (release/bench-thresholds.json)`);
for (const run of runs) {
  let res = null;
  try { res = JSON.parse(fs.readFileSync(path.join(out, run.replace(/[\/#]/g, '_') + '.json'), 'utf8')); } catch {}
  if (!res || !res.ok) { failed++; console.log(`FAIL  ${run}: no result${res && res.error ? ' (' + res.error + ')' : ''}`); continue; }
  for (const [key, lim] of Object.entries(limits[run])) {
    const v = Number(get(res, key));
    const bad = !Number.isFinite(v) || (lim.min != null && v < lim.min) || (lim.max != null && v > lim.max);
    if (bad) failed++;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${run} ${key} = ${Number.isFinite(v) ? v : 'missing'}  (${lim.min != null ? 'min ' + lim.min : ''}${lim.min != null && lim.max != null ? ', ' : ''}${lim.max != null ? 'max ' + lim.max : ''})`);
  }
}
console.log(failed ? `\n${failed} OUT OF LIMITS (results in ${out})` : `\nALL WITHIN LIMITS (results in ${out})`);
process.exit(failed ? 1 : 0);
