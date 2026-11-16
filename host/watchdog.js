// Starts the host again when it ends without quitting: a crash. A remote host that crashed would stay
// down until someone at the PC started it (seen 2026-11-16: the host ended in koffi.node with 0xC0000409
// while nobody was connected, and was not there any more). Started by host/main.js as a small Node process
// of its own (the app's program with ELECTRON_RUN_AS_NODE), once the host has been up for a while: a host
// that crashes while starting is not started over and over (the shell's guard looks after a new version).
// The host holds the write end of this process's stdin: it closes when the host ends, however it ends.
// The host writes its pid into the quit marker when it quits on purpose (the tray, an update, a shell swap).
//   watchdog.js <host pid> <quit marker> <state file> <program> <its arguments as JSON> <folder> [pause ms]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [pidText, marker, stateFile, program, argsJson, cwd, pauseText] = process.argv.slice(2);
const pid = Number(pidText), args = JSON.parse(argsJson), pause = Number(pauseText) || 3000;
const LIMIT = 3, WINDOW_MS = 30 * 60e3; // at most 3 restarts in 30 minutes: a host that keeps crashing stays down
const log = (s) => { try { fs.appendFileSync(path.join(path.dirname(stateFile), 'watchdog.log'), `${new Date().toISOString()} ${s}\n`); } catch {} };

let done = false;
function hostEnded() {
  if (done) return;
  done = true;
  let onPurpose = false;
  try { onPurpose = Number(fs.readFileSync(marker, 'utf8').trim()) === pid; } catch {}
  if (onPurpose) return process.exit(0);
  let times = [];
  try { times = JSON.parse(fs.readFileSync(stateFile, 'utf8')).filter((t) => typeof t === 'number' && Date.now() - t < WINDOW_MS); } catch {}
  if (times.length >= LIMIT) { log(`host ${pid} ended without quitting; not started again (${times.length} restarts in the last 30 minutes)`); return process.exit(0); }
  times.push(Date.now());
  try { fs.writeFileSync(stateFile, JSON.stringify(times)); } catch {}
  log(`host ${pid} ended without quitting; starting it again in ${pause} ms`);
  setTimeout(() => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // as the program itself, not as this
    try { spawn(program, args, { cwd, env, detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('starting it failed: ' + e.message); }
    setTimeout(() => process.exit(0), 500);
  }, pause);
}
process.stdin.on('end', hostEnded);
process.stdin.on('close', hostEnded);
process.stdin.on('error', hostEnded);
process.stdin.resume();
