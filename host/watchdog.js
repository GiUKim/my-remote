// Starts the host again when it ends and no host comes back. A remote host that crashed would stay down
// until someone at the PC started it (seen 2026-11-16: the host ended in koffi.node with 0xC0000409 while
// nobody was connected, and was not there any more). Started by host/main.js as a small Node process of its
// own (the app's program with ELECTRON_RUN_AS_NODE), once the host has been up for a while: a host that
// crashes while starting is not started over and over (the shell's guard looks after a new version).
// The host holds the write end of this process's stdin: it closes when the host ends, however it ends.
//
// Before it quits, the host writes the quit marker: { pid, kind, why } (main.js markQuit).
//   quit       the person quit it (the tray's 종료, the key dialog), the system goes down, or a signal asked it
//              to end (SIGTERM, SIGINT: kill, pkill, Ctrl+C; Linux and macOS): left down
//   handover   another program starts it again (the shell swap's script, which needs this program's
//              files free): this steps aside at once
//   restart    anything else (an update, a restart, a quit nobody named): a host must come back; when none
//              did within RESTART_WAIT_MS, this starts one (the user's report of 2026-11-16: the host quit 20 s
//              after an update, the marker of that time said "on purpose" for every quit, and nothing started it)
// No marker of this host: it crashed; started again after a pause. Either way, never when a host already
// runs (running.json in the same folder names a live process): a second one would only show the first's window.
//   watchdog.js <host pid> <quit marker> <state file> <program> <its arguments as JSON> <folder> [pause ms] [restart wait ms]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [pidText, marker, stateFile, program, argsJson, cwd, pauseText, waitText] = process.argv.slice(2);
const pid = Number(pidText), args = JSON.parse(argsJson), pause = Number(pauseText) || 3000;
const RESTART_WAIT_MS = Number(waitText) || 60000;
const LIMIT = 3, WINDOW_MS = 30 * 60e3; // at most 3 restarts in 30 minutes: a host that keeps crashing stays down
const log = (s) => { try { fs.appendFileSync(path.join(path.dirname(stateFile), 'watchdog.log'), `${new Date().toISOString()} ${s}\n`); } catch {} };
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Another host than the one watched runs now (running.json is the host's own: main.js runningMark).
function otherHost() {
  try { const r = JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile), 'running.json'), 'utf8')); const p = Number(r.pid); return p && p !== pid && alive(p) ? p : 0; } catch { return 0; }
}
function readMarker() {
  let text = '';
  try { text = fs.readFileSync(marker, 'utf8').trim(); } catch { return null; }
  try { const m = JSON.parse(text); if (m && typeof m === 'object') return { pid: Number(m.pid), kind: String(m.kind || 'restart'), why: String(m.why || '') }; } catch {}
  return /^\d+$/.test(text) ? { pid: Number(text), kind: 'quit', why: 'a marker of the old form' } : null; // hosts before 0.8.1 wrote only the pid
}
function start(reason) {
  let times = [];
  try { times = JSON.parse(fs.readFileSync(stateFile, 'utf8')).filter((t) => typeof t === 'number' && Date.now() - t < WINDOW_MS); } catch {}
  if (times.length >= LIMIT) { log(`host ${pid} ${reason}; not started again (${times.length} restarts in the last 30 minutes)`); return process.exit(0); }
  times.push(Date.now());
  try { fs.writeFileSync(stateFile, JSON.stringify(times)); } catch {}
  log(`host ${pid} ${reason}; starting it again`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // as the program itself, not as this
  try { spawn(program, args, { cwd, env, detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('starting it failed: ' + e.message); }
  setTimeout(() => process.exit(0), 500);
}

let done = false;
function hostEnded() {
  if (done) return;
  done = true;
  const m = readMarker();
  const mine = m && m.pid === pid;
  if (mine && (m.kind === 'quit' || m.kind === 'handover')) return process.exit(0);
  if (mine) {
    // A restart: the new host (the relaunch of an update, the shell's restart) has that long to show up.
    const until = Date.now() + RESTART_WAIT_MS;
    const look = () => {
      const other = otherHost();
      if (other) return process.exit(0);
      if (Date.now() > until) return start(`quit (${m.why || 'a restart'}) and no host came back in ${Math.round(RESTART_WAIT_MS / 1000)} s`);
      setTimeout(look, 500);
    };
    return look();
  }
  setTimeout(() => {
    if (otherHost()) return process.exit(0); // someone started one meanwhile
    start('ended without quitting');
  }, pause);
}
process.stdin.on('end', hostEnded);
process.stdin.on('close', hostEnded);
process.stdin.on('error', hostEnded);
process.stdin.resume();
