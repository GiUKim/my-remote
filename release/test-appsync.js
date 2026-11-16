// The installed app's two faces kept one app (host/appsync.js), in plain Node: a face follows a newer
// version only once it has come up in the face that installed it; the one entry takes the place of the
// two shortcuts of older packages (Windows and Linux layouts, in folders of the test's own).
//   node release/test-appsync.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../app/core');
const appsync = require('../host/appsync');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-appsync-'));

(async () => {
  // 1. watch(): the other face's newer version, once it came up
  {
    const root = path.join(tmp, 'data'), calls = [];
    const set = (s) => core.writeState(root, { current: null, previous: null, trial: null, bad: {}, ...s });
    set({});
    const stop = appsync.watch({ running: '0.6.0', parts: { core, root }, everyMs: 30, onNewer: (v) => calls.push(v) });
    await sleep(100);
    const none = calls.length === 0;
    set({ current: '0.6.1', trial: { version: '0.6.1', starts: 1, pid: 1 } }); // installed, still on trial in the other face
    await sleep(100);
    const notOnTrial = calls.length === 0;
    set({ current: '0.6.1' }); // it said it is up
    await sleep(100);
    const followed = calls.join() === '0.6.1';
    await sleep(100);
    const once = calls.length === 1;
    set({ current: '0.6.2', bad: { '0.6.2': 'did not come up' } });
    await sleep(100);
    const notBad = calls.length === 1;
    set({ current: '0.5.9' }); // older than what runs (a going back)
    await sleep(100);
    const notOlder = calls.length === 1;
    stop();
    ok('a face follows a newer version once it came up in the other face; not on trial, not a bad one, not an older one, once',
      none && notOnTrial && followed && once && notBad && notOlder, JSON.stringify({ none, notOnTrial, followed, once, notBad, notOlder, calls }));
    const noShell = appsync.watch({ running: '0.6.0', parts: null, onNewer: () => calls.push('x') });
    ok('from a source folder (no shell) there is nothing to watch', typeof noShell === 'function' && !calls.includes('x'));
  }

  // 2. unifyShortcuts(), Linux: the app menu's two entries become one
  {
    const dataHome = path.join(tmp, 'share'), apps = path.join(dataHome, 'applications');
    const o = { platform: 'linux', dataHome, execPath: '/opt/MyRemote/my-remote', iconDir: '/opt/MyRemote/resources/app' };
    const nothing = appsync.unifyShortcuts(o);
    fs.mkdirSync(apps, { recursive: true });
    // A source folder's setup.sh makes entries of the same names (they start start-host.sh): not the app's.
    for (const n of ['host', 'client']) fs.writeFileSync(path.join(apps, `my-remote-${n}.desktop`), `[Desktop Entry]\nExec="/home/u/my-remote/start-${n}.sh"\n`);
    const sourceKept = appsync.unifyShortcuts(o).made.length === 0 && fs.existsSync(path.join(apps, 'my-remote-host.desktop'));
    for (const n of ['host', 'client']) fs.writeFileSync(path.join(apps, `my-remote-${n}.desktop`), `[Desktop Entry]\nExec="/opt/MyRemote/my-remote.sh" --${n}\n`);
    const r = appsync.unifyShortcuts(o);
    const entry = path.join(apps, 'my-remote.desktop'), text = fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '';
    const again = appsync.unifyShortcuts(o);
    ok('Linux: the host and client entries become one "My Remote" entry that opens the start screen; none made where there were none; a source folder\'s entries stay',
      nothing.made.length === 0 && sourceKept && r.made.length === 1 && r.removed.length === 2 && /Exec="\/opt\/MyRemote\/my-remote\.sh" --client --launcher/.test(text) && /Name=My Remote\n/.test(text)
        && !fs.existsSync(path.join(apps, 'my-remote-host.desktop')) && again.made.length === 0 && appsync.hasEntry(o),
      JSON.stringify({ nothing: nothing.made.length, made: r.made.length, removed: r.removed.length, again: again.made.length, exec: (/Exec=.*/.exec(text) || [''])[0] }));
  }

  // 3. unifyShortcuts(), Windows layout (a stand-in for Electron's shell.writeShortcutLink): the Start menu's
  // MyRemote folder holds one shortcut; those of 0.3.0-0.5.x go
  {
    const appData = path.join(tmp, 'roaming'), programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const links = [];
    const writeLink = (f, op, opts) => { fs.writeFileSync(f, JSON.stringify(opts)); links.push([path.basename(f), op, opts.args, opts.appUserModelId]); return true; };
    const o = { platform: 'win32', appData, execPath: 'C:\\MyRemote\\MyRemote.exe', iconDir: 'C:\\MyRemote\\resources\\app', writeLink };
    fs.mkdirSync(path.join(programs, 'MyRemote'), { recursive: true });
    fs.mkdirSync(path.join(programs, 'My Remote'), { recursive: true });
    for (const f of [path.join(programs, 'MyRemote', 'MyRemote-Host.lnk'), path.join(programs, 'MyRemote', 'MyRemote-Client.lnk'), path.join(programs, 'My Remote', 'My Remote 호스트.lnk')]) fs.writeFileSync(f, 'old');
    const r = appsync.unifyShortcuts(o);
    const left = fs.readdirSync(path.join(programs, 'MyRemote'));
    const created = appsync.unifyShortcuts({ ...o, create: true }); // the start screen's "바로가기 만들기": updated in place
    ok('Windows: one MyRemote shortcut (--client --launcher) in place of the host and client ones; the old folder goes',
      r.made.length === 1 && r.removed.length === 3 && left.join() === 'MyRemote.lnk' && !fs.existsSync(path.join(programs, 'My Remote'))
        && links[0][2] === '--client --launcher' && links[0][3] === 'kr.myremote.client' && created.made.length === 1 && links[1][1] === 'update',
      JSON.stringify({ made: r.made.length, removed: r.removed.length, left, links }));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
