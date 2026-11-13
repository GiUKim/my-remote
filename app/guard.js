// Stands by while a newly installed version starts for the first time (boot.js starts this as a small
// process of its own, Electron run as plain Node). boot.js itself goes back to the version before when
// the new one throws while starting or does not come up in time; this is for the case it cannot handle:
// the program ending without a word (a crash). Then the program is started again - boot.js counts the
// starts and goes back to the version before after two that did not come up. A remote host must not
// stay down because of an update.
//   guard.js <data folder> <version> <pid> <program> <its arguments as JSON>
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [root, version, pidText, exe, argsJson] = process.argv.slice(2);
const pid = Number(pidText), t0 = Date.now();
const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const onTrial = () => {
  try { const s = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')); return !!(s.trial && s.trial.version === version); } catch { return false; }
};
function tick() {
  if (!onTrial()) return process.exit(0); // it said it is up, or was given up
  if (alive()) {
    if (Date.now() - t0 > 15 * 60e3) return process.exit(0);
    return void setTimeout(tick, 500);
  }
  // Ended while still on trial. On purpose (the person closed it, or it restarts itself)? Then leave it.
  let onPurpose = false;
  try { onPurpose = fs.statSync(path.join(root, 'quit')).mtimeMs >= t0 - 1000; } catch {}
  if (!onPurpose) {
    // As the program itself, not as this: plain Node is what ELECTRON_RUN_AS_NODE made of Electron here.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try { spawn(exe, JSON.parse(argsJson), { env, detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
  process.exit(0);
}
setTimeout(tick, 500);
