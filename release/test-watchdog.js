// The host's watchdog (host/watchdog.js) in plain Node: a fake host starts it as host/main.js does (its stdin a
// pipe the host holds) and then quits on purpose (marker written: not started again), ends without a word
// (started again, once), aborts (a real crash: started again), or crashes when it was already started again
// three times in half an hour (left down, and said so in watchdog.log).
//   node release/test-watchdog.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-watchdog-'));
const watchdogJs = path.join(__dirname, '..', 'host', 'watchdog.js');

// The program the watchdog starts again: notes that it ran.
const restarted = path.join(tmp, 'restarted.js');
fs.writeFileSync(restarted, "require('fs').appendFileSync(process.argv[2], 'ran\\n');\n");
// A fake host: starts the watchdog like host/main.js, then ends the way it is told.
const host = path.join(tmp, 'host.js');
fs.writeFileSync(host, `const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const [dir, how] = process.argv.slice(2);
const w = spawn(process.execPath, [${JSON.stringify(watchdogJs)}, String(process.pid), path.join(dir, 'quit-on-purpose'), path.join(dir, 'watchdog.json'),
  process.execPath, JSON.stringify([${JSON.stringify(restarted)}, path.join(dir, 'ran.log')]), dir, '300'],
  { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
w.stdin.on('error', () => {}); w.unref();
setTimeout(() => {
  if (how === 'quit') { fs.writeFileSync(path.join(dir, 'quit-on-purpose'), String(process.pid)); process.exit(0); }
  if (how === 'crash') process.exit(3);
  if (how === 'abort') process.abort();
}, 500);
`);

async function run(name, how, before) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (before) before(dir);
  await new Promise((r) => spawn(process.execPath, [host, dir, how], { stdio: 'ignore', windowsHide: true }).on('exit', r));
  await sleep(2500);
  const ran = (() => { try { return fs.readFileSync(path.join(dir, 'ran.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const log = (() => { try { return fs.readFileSync(path.join(dir, 'watchdog.log'), 'utf8'); } catch { return ''; } })();
  return { ran, log };
}

(async () => {
  const quit = await run('quit', 'quit');
  ok('a host that quits on purpose (its pid in the marker) is not started again', quit.ran === 0 && !quit.log, JSON.stringify(quit));
  const crash = await run('crash', 'crash');
  ok('a host that ends without a word is started again, once, and that is noted', crash.ran === 1 && /starting it again/.test(crash.log), JSON.stringify(crash));
  const abort = await run('abort', 'abort');
  ok('a host that aborts (a real crash) is started again', abort.ran === 1, JSON.stringify({ ran: abort.ran }));
  const stale = await run('stale', 'crash', (dir) => fs.writeFileSync(path.join(dir, 'quit-on-purpose'), '1')); // an older host's marker
  ok('a marker another (older) host left does not count', stale.ran === 1, JSON.stringify({ ran: stale.ran }));
  const limit = await run('limit', 'crash', (dir) => fs.writeFileSync(path.join(dir, 'watchdog.json'), JSON.stringify([Date.now() - 60e3, Date.now() - 30e3, Date.now() - 10e3])));
  ok('after three restarts in half an hour a crashed host is left down, and that is noted', limit.ran === 0 && /not started again/.test(limit.log), JSON.stringify(limit));
  const old = await run('old', 'crash', (dir) => fs.writeFileSync(path.join(dir, 'watchdog.json'), JSON.stringify([Date.now() - 3600e3, Date.now() - 3000e3, Date.now() - 2400e3])));
  ok('restarts longer ago than half an hour do not count', old.ran === 1, JSON.stringify({ ran: old.ran }));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
