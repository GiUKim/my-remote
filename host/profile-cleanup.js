// Removes the throwaway browser profile of an isolated run (--selftest, --localtest, --bench, and the
// bench's client side, bench-peer.js) once the run has ended, and the ones earlier runs left behind.
// Each is about 30 MB, and a run cannot remove its own: the browser engine keeps files in it open
// until its processes have ended. So the run starts this file as a tiny process of its own (watch()),
// which waits for the run's process to end and then removes the folder.
// As a process: profile-cleanup.js <pid of the run> <its profile folder>
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE = /^myremote-(local|peer)-/; // directly in the temp folder
const OWNER = 'run.pid';                   // in a profile: the pid of the run that uses it

// Called by the run right after it made its profile folder.
function watch(profile) {
  try {
    fs.writeFileSync(path.join(profile, OWNER), String(process.pid));
    withoutInheritedStdio(() => require('child_process').spawn(process.execPath, [__filename, String(process.pid), profile],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true }).unref());
  } catch (e) { console.error('profile cleanup', e.message); }
}
// Windows gives a new process every handle of this one that may be inherited, and Electron leaves its
// stdin, stdout and stderr so. Holding the pipes of whatever started the run (bench-run.js, a script
// that reads the self-test's output), the helper would make that wait for it as well. So they are
// kept from it while it is started.
function withoutInheritedStdio(start) {
  if (process.platform !== 'win32') return start();
  const changed = [];
  let k32 = null;
  try {
    const koffi = require('koffi'), lib = koffi.load('kernel32.dll');
    k32 = {
      std: lib.func('GetStdHandle', 'intptr_t', ['uint32']),
      get: lib.func('GetHandleInformation', 'bool', ['intptr_t', koffi.out(koffi.pointer('uint32'))]),
      set: lib.func('SetHandleInformation', 'bool', ['intptr_t', 'uint32', 'uint32']),
    };
    for (const which of [-10, -11, -12]) { // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
      const h = k32.std(which >>> 0), flags = [0];
      if (h && h !== -1 && k32.get(h, flags) && flags[0] & 1 && k32.set(h, 1, 0)) changed.push(h); // 1: HANDLE_FLAG_INHERIT
    }
  } catch (e) { console.error('profile cleanup: stdio inheritance', e.message); }
  try { return start(); } finally { for (const h of changed) k32.set(h, 1, 1); }
}
module.exports = { watch };

if (require.main === module) {
  const pid = Number(process.argv[2]);
  const tmp = path.resolve(os.tmpdir());
  const own = path.resolve(String(process.argv[3] || ''));
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const remove = (dir, retries) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 250 }); } catch {} };
  const owner = (dir) => { try { return Number(fs.readFileSync(path.join(dir, OWNER), 'utf8')) || 0; } catch { return 0; } };
  const names = () => { try { return fs.readdirSync(tmp); } catch { return []; } };
  // Another isolated run going on now (one in a series of bench runs, say): removing folders meanwhile
  // would compete with it for the disk, which the bench would measure. Looked at once a second at most.
  let busyAt = 0, busyWas = false;
  const busy = () => {
    if (Date.now() - busyAt < 1000) return busyWas;
    busyAt = Date.now();
    busyWas = names().some((n) => { const dir = path.join(tmp, n), o = PROFILE.test(n) && dir !== own ? owner(dir) : 0; return o > 0 && o !== pid && alive(o); });
    return busyWas;
  };
  // What earlier runs left: runs that were killed, versions before this one. A profile is left alone
  // while it is young (a run that has just made it may not have written its pid yet), while the run it
  // names is alive, and when it is a link. It is first claimed by renaming it: on Windows that fails
  // while any process still has a file in it open, so a profile in use is never half deleted.
  const sweep = (until) => {
    for (const n of names()) {
      if (Date.now() > until) return;
      const dir = path.join(tmp, n);
      if (dir === own) continue;
      if (n.startsWith('myremote-trash-')) { if (busy()) return; remove(dir, 1); continue; } // claimed by a sweep that did not finish
      if (!PROFILE.test(n)) continue;
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || Date.now() - st.mtimeMs < 10 * 60e3) continue;
      } catch { continue; }
      const o = owner(dir);
      if (o && alive(o)) continue;
      if (busy()) return;
      const trash = path.join(tmp, `myremote-trash-${process.pid}-${n}`);
      try { fs.renameSync(dir, trash); } catch { continue; }
      remove(trash, 1);
    }
  };
  // Only ever a profile folder of ours, directly in the temp folder.
  if (pid > 0 && path.dirname(own) === tmp && PROFILE.test(path.basename(own))) {
    try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {}
    const started = Date.now();
    const timer = setInterval(() => {
      if (alive(pid)) {
        if (Date.now() - started > 24 * 3600e3) process.exit(0); // the pid went to another process meanwhile: a later run's sweep removes it
        return;
      }
      clearInterval(timer);
      remove(own, 8); // the engine's helper processes end a moment after the run itself
      if (!busy()) sweep(Date.now() + 5 * 60e3);
    }, 300);
  }
}
