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

  // 2. unifyShortcuts(), Linux: the app menu's entries of the program's old name (0.3.0-0.5.x: host and client;
  // 0.6.0-0.9.x: "My Remote") become the one "Pangmote" entry; once a package of the new name took the folder's
  // place (host/shellswap.js), the entry starts pangmote.sh. App folders of the test's own (launcherOf looks).
  {
    const dataHome = path.join(tmp, 'share'), apps = path.join(dataHome, 'applications');
    const A = path.join(tmp, 'linux-app').replace(/\\/g, '/'); // the paths inside are the Linux program's: forward slashes
    fs.mkdirSync(A, { recursive: true });
    fs.writeFileSync(path.join(A, 'my-remote.sh'), '#!/bin/sh\n'); // an app folder of a package before 0.10.0
    const o = { platform: 'linux', dataHome, execPath: A + '/my-remote', iconDir: A + '/resources/app' };
    const nothing = appsync.unifyShortcuts(o);
    fs.mkdirSync(apps, { recursive: true });
    // A source folder's setup.sh makes entries of the same names (they start start-host.sh): not the app's.
    for (const n of ['host', 'client']) fs.writeFileSync(path.join(apps, `my-remote-${n}.desktop`), `[Desktop Entry]\nExec="/home/u/my-remote/start-${n}.sh"\n`);
    const sourceKept = appsync.unifyShortcuts(o).made.length === 0 && fs.existsSync(path.join(apps, 'my-remote-host.desktop'));
    for (const n of ['host', 'client']) fs.writeFileSync(path.join(apps, `my-remote-${n}.desktop`), `[Desktop Entry]\nExec="${A}/my-remote.sh" --${n}\n`);
    fs.writeFileSync(path.join(apps, 'my-remote.desktop'), `[Desktop Entry]\nName=My Remote\nExec="${A}/my-remote.sh" --client --launcher\n`);
    const r = appsync.unifyShortcuts(o);
    const entry = path.join(apps, 'pangmote.desktop'), read = () => (fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '');
    const text = read();
    const again = appsync.unifyShortcuts(o);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    ok('Linux: the old entries become one "Pangmote" entry that opens the start screen (my-remote.sh while the folder has only that); none made where there were none; a source folder\'s entries stay',
      nothing.made.length === 0 && sourceKept && r.made.length === 1 && r.removed.length === 3 && new RegExp(`Exec="${esc(A)}/my-remote\\.sh" --client --launcher`).test(text) && /Name=Pangmote\n/.test(text)
        && !fs.existsSync(path.join(apps, 'my-remote-host.desktop')) && !fs.existsSync(path.join(apps, 'my-remote.desktop')) && again.made.length === 0 && appsync.hasEntry(o),
      JSON.stringify({ nothing: nothing.made.length, made: r.made.length, removed: r.removed.length, again: again.made.length, exec: (/Exec=.*/.exec(text) || [''])[0] }));
    // The swap: the folder now holds the package of the new name (pangmote, pangmote.sh) and the my-remote.sh that
    // starts it; the entry is made anew for pangmote.sh, once.
    fs.writeFileSync(path.join(A, 'pangmote.sh'), '#!/bin/sh\n');
    const swapped = { ...o, execPath: A + '/pangmote' };
    const after = appsync.unifyShortcuts(swapped), text2 = read(), then = appsync.unifyShortcuts(swapped);
    ok('Linux: after a swap to the new name the entry starts pangmote.sh (made anew once)',
      after.made.length === 1 && new RegExp(`Exec="${esc(A)}/pangmote\\.sh" --client --launcher`).test(text2) && then.made.length === 0,
      JSON.stringify({ after: after.made.length, then: then.made.length, exec: (/Exec=.*/.exec(text2) || [''])[0] }));
    ok('Linux: the start script beside the program is pangmote.sh, else my-remote.sh (a folder of an older package), else none; none on Windows',
      appsync.launcherOf(A + '/pangmote', 'linux') === A + '/pangmote.sh' && appsync.launcherOf(A + '/x', 'win32') === ''
        && (fs.rmSync(path.join(A, 'pangmote.sh')), appsync.launcherOf(A + '/pangmote', 'linux') === A + '/my-remote.sh')
        && (fs.rmSync(path.join(A, 'my-remote.sh')), appsync.launcherOf(A + '/pangmote', 'linux') === ''));
  }

  // 3. unifyShortcuts(), Windows layout (stand-ins for Electron's shell.writeShortcutLink, which changes only the
  // fields it is given on 'update', and shell.readShortcutLink): the Start menu's Pangmote folder holds one
  // shortcut; the MyRemote folder's (0.6.0-0.9.x, and those of 0.3.0-0.5.x) and the My Remote folder go.
  {
    const appData = path.join(tmp, 'roaming'), programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const links = [];
    const writeLink = (f, op, opts) => {
      const was = op === 'update' && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
      fs.writeFileSync(f, JSON.stringify({ ...was, ...opts })); links.push([path.basename(f), op, opts.args, opts.appUserModelId]); return true;
    };
    const readLink = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const o = { platform: 'win32', appData, execPath: 'C:\\Apps\\MyRemote\\MyRemote.exe', iconDir: 'C:\\Apps\\MyRemote\\resources\\app', writeLink, readLink };
    fs.mkdirSync(path.join(programs, 'MyRemote'), { recursive: true });
    fs.mkdirSync(path.join(programs, 'My Remote'), { recursive: true });
    for (const f of [path.join(programs, 'MyRemote', 'MyRemote.lnk'), path.join(programs, 'MyRemote', 'MyRemote-Host.lnk'), path.join(programs, 'MyRemote', 'MyRemote-Client.lnk'), path.join(programs, 'My Remote', 'My Remote 호스트.lnk')]) fs.writeFileSync(f, 'old');
    const r = appsync.unifyShortcuts(o);
    const left = fs.readdirSync(path.join(programs, 'Pangmote'));
    const created = appsync.unifyShortcuts({ ...o, create: true }); // the start screen's "바로가기 만들기": updated in place
    ok('Windows: one Pangmote shortcut (--client --launcher) in place of the MyRemote ones and the host and client ones; the old folders go',
      r.made.length === 1 && r.removed.length === 4 && left.join() === 'Pangmote.lnk' && !fs.existsSync(path.join(programs, 'My Remote')) && !fs.existsSync(path.join(programs, 'MyRemote'))
        && links[0][2] === '--client --launcher' && created.made.length === 1 && links[1][1] === 'update',
      JSON.stringify({ made: r.made.length, removed: r.removed.length, left, links }));
    // The swap to a package of the new name: the entry the code made before still names MyRemote.exe; it is made
    // anew for Pangmote.exe, once.
    const swapped = { ...o, execPath: 'C:\\Apps\\MyRemote\\Pangmote.exe' };
    const after = appsync.unifyShortcuts(swapped), then = appsync.unifyShortcuts(swapped);
    ok('Windows: after a swap to the new name the entry starts Pangmote.exe (made anew once); its arguments and id stay',
      after.made.length === 1 && readLink(path.join(programs, 'Pangmote', 'Pangmote.lnk')).target === swapped.execPath && then.made.length === 0
        && readLink(path.join(programs, 'Pangmote', 'Pangmote.lnk')).args === '--client --launcher' && readLink(path.join(programs, 'Pangmote', 'Pangmote.lnk')).appUserModelId === appsync.APP_ID,
      JSON.stringify({ after: after.made.length, then: then.made.length }));
    // A second copy of the app in another folder does not take the entry over while the program it names is there.
    const other = path.join(tmp, 'other-copy', 'Pangmote.exe');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'a program');
    const entryFile = path.join(programs, 'Pangmote', 'Pangmote.lnk');
    writeLink(entryFile, 'update', { target: other });
    const kept = appsync.unifyShortcuts(swapped), keptTarget = readLink(entryFile).target;
    fs.rmSync(other);
    const gone = appsync.unifyShortcuts(swapped);
    ok('Windows: an entry naming another copy\'s program that is there stays; one naming a program that is gone is made anew',
      kept.made.length === 0 && keptTarget === other && gone.made.length === 1 && readLink(entryFile).target === swapped.execPath,
      JSON.stringify({ kept: kept.made.length, keptTarget, gone: gone.made.length }));
    fs.mkdirSync(path.join(programs, 'MyRemote'), { recursive: true });
    // The taskbar and Windows' notifications go by the id a Start-menu shortcut carries: the entry, whether
    // the code makes it or the shell (app/boot.js makeShortcuts, --shortcuts), carries the one id both faces
    // take (host/main.js and client/main.js set appsync.APP_ID).
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const shellId = (/appUserModelId: '([^']+)'/.exec(src('app/boot.js')) || [])[1];
    const faces = ['host/main.js', 'client/main.js'].filter((f) => /app\.setAppUserModelId\(appsync\.APP_ID\)/.test(src(f)));
    ok('Windows: the entry carries the id both faces take, the same whether the code or the shell made it',
      links[0][3] === appsync.APP_ID && links[1][3] === appsync.APP_ID && shellId === appsync.APP_ID && faces.length === 2,
      JSON.stringify({ code: links[0][3], shell: shellId, faces }));
    // An older shell's first-start dialog makes the two shortcuts again (its box is ticked by default) and then
    // starts a face that only brings the running one forward: that one, asked again, puts the entry back alone.
    for (const f of ['MyRemote-Host.lnk', 'MyRemote-Client.lnk']) fs.writeFileSync(path.join(programs, 'MyRemote', f), 'made again');
    const back = appsync.unifyShortcuts(swapped);
    ok('Windows: the two shortcuts an older shell makes again go once more, the entry stays',
      back.removed.length === 2 && !fs.existsSync(path.join(programs, 'MyRemote')) && fs.readdirSync(path.join(programs, 'Pangmote')).join() === 'Pangmote.lnk', JSON.stringify(back));
  }

  // 4. retarget(): the person's own shortcuts to MyRemote.exe of this folder (desktop, Startup, taskbar and Start
  // pins) start Pangmote.exe once a package of the new name took the folder's place; nothing else is touched.
  {
    const appData = path.join(tmp, 'roaming2'), desktop = path.join(tmp, 'desktop'), appDir = path.join(tmp, 'win-app');
    const ql = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch');
    const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), taskbar = path.join(ql, 'User Pinned', 'TaskBar');
    for (const d of [desktop, startup, taskbar, appDir]) fs.mkdirSync(d, { recursive: true });
    const oldExe = path.join(appDir, 'MyRemote.exe'), newExe = path.join(appDir, 'Pangmote.exe'), other = path.join(tmp, 'elsewhere', 'MyRemote.exe');
    const put = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
    put(path.join(desktop, 'Remote.lnk'), { target: oldExe, args: '--host', icon: oldExe, iconIndex: 0 });
    put(path.join(desktop, 'Other.lnk'), { target: other, args: '--host' });
    put(path.join(startup, 'Host at sign-in.lnk'), { target: oldExe.toUpperCase(), args: '--host' });
    put(path.join(taskbar, 'MyRemote.lnk'), { target: oldExe, args: '--client --launcher', icon: 'C:\\icons\\x.ico' });
    fs.writeFileSync(path.join(desktop, 'notes.txt'), 'not a shortcut');
    const changes = [];
    const writeLink = (f, op, opts) => { const was = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...was, ...opts })); changes.push([path.basename(f), op]); return true; };
    const readLink = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const mark = path.join(tmp, 'retargeted.json');
    fs.writeFileSync(oldExe, 'still here');
    const notYet = appsync.retarget({ platform: 'win32', appData, desktop, execPath: newExe, readLink, writeLink, mark });
    fs.rmSync(oldExe);
    const asOld = appsync.retarget({ platform: 'win32', appData, desktop, execPath: oldExe, readLink, writeLink, mark });
    const onLinux = appsync.retarget({ platform: 'linux', appData, desktop, execPath: newExe, readLink, writeLink, mark });
    const done = appsync.retarget({ platform: 'win32', appData, desktop, execPath: newExe, readLink, writeLink, mark });
    const twice = appsync.retarget({ platform: 'win32', appData, desktop, execPath: newExe, readLink, writeLink, mark });
    const d = readLink(path.join(desktop, 'Remote.lnk')), s = readLink(path.join(startup, 'Host at sign-in.lnk')), t = readLink(path.join(taskbar, 'MyRemote.lnk'));
    ok('Windows: shortcuts to this folder\'s MyRemote.exe start Pangmote.exe once it is gone (desktop, Startup, taskbar; arguments kept, the old icon too); another folder\'s and other files stay; once',
      notYet.length === 0 && asOld.length === 0 && onLinux.length === 0 && done.length === 3 && twice.length === 0
        && d.target === newExe && d.icon === newExe && d.args === '--host' && s.target === newExe && t.target === newExe && t.icon === 'C:\\icons\\x.ico'
        && readLink(path.join(desktop, 'Other.lnk')).target === other && changes.every((c) => c[1] === 'update'),
      JSON.stringify({ notYet: notYet.length, asOld: asOld.length, onLinux: onLinux.length, done: done.map((f) => path.basename(f)), twice: twice.length }));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
