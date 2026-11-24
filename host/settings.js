// What this PC keeps for Pangmote as a whole, whichever face changed it (the host window, the client app's list,
// its start screen, a remote session's toolbar): for now the language of the user interface (host/i18n.js).
// A file of its own beside the faces' profiles, <appData>/my-remote/settings.json, so that the host and the client
// app, two programs with two profiles, share it; each watches it and follows a change the other made. (The folder
// keeps the program's old name, as the profiles do: see app/boot.js.)
// Isolated runs (the self-test, the local trial, the bench, a client app on --loader) keep one inside their own
// throwaway profile and never touch this PC's.
'use strict';
const fs = require('fs');
const path = require('path');

function create(file) {
  let cache = null;
  const read = () => {
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
  };
  const get = () => cache || (cache = read());
  // Written to a temporary file and renamed over the old one: the other face may read it at any moment.
  const set = (patch) => {
    const next = { ...read(), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n');
    fs.renameSync(tmp, file);
    cache = next;
    return next;
  };
  // cb(now, before) when another program changed the file (polled once a second: fs.watch misses a rename on
  // some systems, and nothing here needs it faster).
  const watch = (cb) => {
    get(); // what the file says now: a change is told against it (with nothing read yet, the first change was not)
    fs.watchFile(file, { interval: 1000 }, () => {
      const was = get(), now = read();
      cache = now;
      if (JSON.stringify(was) !== JSON.stringify(now)) cb(now, was);
    });
    return () => fs.unwatchFile(file);
  };
  return { file, get, set, watch };
}

// A test's setting from the environment: PANGMOTE_<name>, or MY_REMOTE_<name> (its name before the program was
// renamed in 0.10.0, which scripts and CI set up before may still give). '' when neither is set.
const env = (name) => process.env['PANGMOTE_' + name] || process.env['MY_REMOTE_' + name] || '';
// The language the automated runs show (they read Korean unless this names another).
const testLang = () => env('LANG');

// The file for this run: `isolatedDir` (a throwaway profile) when the run is isolated, else the PC's.
// PANGMOTE_SETTINGS names another file (tests).
function fileFor(app, isolatedDir) {
  if (env('SETTINGS')) return path.resolve(env('SETTINGS'));
  if (isolatedDir) return path.join(isolatedDir, 'pangmote-settings.json');
  return path.join(app.getPath('appData'), 'my-remote', 'settings.json');
}

module.exports = { create, fileFor, env, testLang };
