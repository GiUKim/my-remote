// `electron . --selftest`: runs the real client page against this host, entirely
// on this machine. Signaling goes through a relay on 127.0.0.1, no STUN is used,
// the client is view-only (no input is injected) and a throwaway key/profile is
// used. Nothing is sent to the internet. Output is English on purpose: Korean is
// garbled when PowerShell 5.1 pipes it.
const { BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const input = require('./input');

// --cursor-check: additionally verify, on the real screen, that hiding the host
// cursor removes it from the video. The cursor on this PC disappears for a few
// seconds while it runs, so it is not part of the default self-test.
const CURSOR_CHECK = process.argv.includes('--cursor-check');
// --shell-check: additionally run the client app's one-click layout on the real screens.
// Fullscreen windows cover every monitor of this PC for a few seconds.
const SHELL_CHECK = process.argv.includes('--shell-check');
// --input-check (Linux): real input through XTest into windows and a program the check opens itself
// (inputcheck.js). Meant for a virtual display (Xvfb): it moves the pointer, clicks and types.
const INPUT_CHECK = process.argv.includes('--input-check');
// --client-app-check: at the end, start the client app (client/main.js) as a program of its own on a
// loader that talks to this test's relay only, and wait until it shows the host's picture.
const CLIENT_APP_CHECK = process.argv.includes('--client-app-check');

// Minimal ntfy-compatible pub/sub: POST /topic, GET /topic/sse, GET /topic1,topic2/sse (several topics
// on one subscription, as ntfy.sh does: each message says the topic it came on).
exports.startRelay = () => new Promise((resolve) => {
  const subs = new Map();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  const srv = http.createServer((req, res) => {
    const parts = req.url.split('?')[0].split('/').filter(Boolean);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); }
    else if (req.method === 'GET' && parts[1] === 'sse') {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      const topics = parts[0].split(',').filter(Boolean);
      for (const t of topics) { if (!subs.has(t)) subs.set(t, new Set()); subs.get(t).add(res); }
      req.on('close', () => { for (const t of topics) subs.get(t).delete(res); });
    } else if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        for (const s of subs.get(parts[0]) || []) s.write(`data: ${JSON.stringify({ event: 'message', topic: parts[0], message: body })}\n\n`);
        res.writeHead(200, cors); res.end('{}');
      });
    } else { res.writeHead(404, cors); res.end(); }
  });
  srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A client app the test started, ended as a person ends it (its windows closed: Windows' taskkill without
// /F; SIGTERM elsewhere), not killed. On Windows Chromium writes the profile's "Local State", which holds
// the key safeStorage encrypts with, only then: a first run that is killed leaves no such file, and the
// next start cannot read what it stored (found when the second start could not read the token the first
// had been given). Killed only when it has not ended in 10 s.
async function quitGently(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  try {
    if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
  if (!(await Promise.race([gone.then(() => true), sleep(10000).then(() => false)]))) {
    try { child.kill(); } catch {}
    await Promise.race([gone, sleep(3000)]);
  }
  await sleep(500);
}
// The clipboard's text as it is, to be put back after a check that uses the clipboard: { mime: text },
// {} when it is empty, null when it holds anything but the allowed text types (the check is skipped
// then: that would be lost). Electron's clipboard is promise-based since Electron 44.
async function keepTextClipboard(allowed) {
  const { clipboard } = require('electron');
  try {
    const items = await clipboard.read();
    if (items.length > 1 || items.some((i) => i.types.some((t) => !allowed.includes(t)))) return null;
    const rec = {};
    for (const i of items) for (const t of i.types) rec[t] = await (await i.getType(t)).text();
    return rec;
  } catch { return null; }
}
async function restoreClipboard(rec) {
  const { clipboard, ClipboardItem } = require('electron');
  try { if (rec && Object.keys(rec).length) await clipboard.write([new ClipboardItem(rec)]); else clipboard.clear(); } catch (e) { console.error('putting the clipboard back', e.message); }
}
module.exports.keepTextClipboard = keepTextClipboard; // also for dragcheck.js
module.exports.restoreClipboard = restoreClipboard;

exports.run = async ({ cfg, buildClientHtml, buildLoaderHtml, app, offerFile, dragOut, closeDragFiles, listFolder, devices, deviceStore, accessLog, devicesChanged, pageKey, getClientApp, inputGuardHb }) => {
  const results = [];
  const check = (name, ok, detail) => { results.push(!!ok); console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
  const info = (text) => console.log(`[selftest] INFO  ${text}`);

  // --frame-check: only presses from the client onto the host window's own frame (framecheck.js), then exit.
  // It injects input onto the host window for about fifteen seconds: the test VM, or with the person's agreement.
  if (process.argv.includes('--frame-check')) {
    if (process.platform !== 'win32') { info('--frame-check is Windows-only (elsewhere a window manager of its own runs the frames)'); return app.exit(0); }
    await sleep(1500);
    await require('./framecheck').run({ check, info, guardHb: inputGuardHb ? inputGuardHb() : null });
    const pass = results.length > 0 && results.every(Boolean);
    console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
    return app.exit(pass ? 0 : 1);
  }

  // --dragout-check: only a real drag out of a real Explorer window (dragcheck.js), then exit.
  // It injects input on this PC for about ten seconds, so it is opt-in and the user must agree first.
  if (process.argv.includes('--dragout-check') || process.argv.includes('--dropin-check')) {
    await sleep(2500); // let the host subscribe before a client window connects
    if (process.platform !== 'win32') {
      info('--dragout-check and --dropin-check are Windows-only (they drive real Explorer windows); on Linux see --input-check');
      return app.exit(0);
    }
    const dc = require('./dragcheck');
    if (process.argv.includes('--dragout-check')) await dc.run({ check, info, dragOut, closeDragFiles, cfg, buildClientHtml });
    if (process.argv.includes('--dropin-check')) await dc.runIn({ check, info, cfg, buildClientHtml });
    const pass = results.length > 0 && results.every(Boolean);
    console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
    return app.exit(pass ? 0 : 1);
  }

  // What keeps a remote host usable when something goes wrong (0.8.1): its messages in a file of its own, and
  // (Windows) the worker that frees the input thread from a window loop (inputguard.js; --frame-check tries it).
  { const f = path.join(app.getPath('userData'), 'host.log'), text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    check('the host keeps its messages in host.log', /\[host\] start: version/.test(text), `${text.split('\n').length - 1} lines`); }
  if (process.platform === 'win32') {
    const hb = inputGuardHb ? inputGuardHb() : null, t1 = hb ? Atomics.load(hb, 0) : 0;
    await sleep(300);
    check('the input guard watches the input thread (Windows)', !!hb && Atomics.load(hb, 0) > t1, hb ? `heartbeat ${t1} -> ${Atomics.load(hb, 0)} ms` : 'not started');
  }

  // The DLLs (and winassist.exe, which runs as LocalSystem) in host/bin are built files that are
  // committed: each must be the one built from its source in native/ as it is now (native/build.js
  // records both). Not there in a packaged copy. Only Windows loads them, but the check is about the
  // repository and runs everywhere.
  for (const file of ['capture.dll', 'shellops.dll', 'winassist.exe']) {
    const name = file.replace(/\.\w+$/, '');
    const dll = path.join(__dirname, 'bin', file), src = path.join(__dirname, '..', 'native', name + '.cpp');
    if (!fs.existsSync(dll) || !fs.existsSync(src)) continue;
    const sha = (data) => require('crypto').createHash('sha256').update(data).digest('hex');
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(dll + '.json', 'utf8')); } catch {}
    const sameSrc = rec.sourceSha256 === sha(fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
    const sameDll = rec.dllSha256 === sha(fs.readFileSync(dll));
    check(`host/bin/${file} is the one built from native/${name}.cpp`, sameSrc && sameDll,
      !sameSrc ? `native/${name}.cpp differs from what host/bin/${file} was built from: run native/build.js`
        : !sameDll ? `host/bin/${file} is not the file native/build.js recorded` : '');
  }

  // Pure coordinate mapping (no input is injected): two monitors side by side, 1080p then 1440p.
  {
    const virt = { x: 0, y: 0, width: 4480, height: 1440 };
    input.setMonitors([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 2560, height: 1440 }]);
    const inside = input.target(1, 0.5, 0.5, virt), past = input.target(0, 1.25, 0.5, virt), far = input.target(0, -3, 0.5, virt);
    check('coordinates: drag continues onto the next monitor',
      inside && Math.abs(inside.px - (1920 + 0.5 * 2559)) < 1 && past && past.px > 1920 && past.px < 4480 && far && far.px === 0 && input.target(0, NaN, 0, virt) === null && input.target(5, 0.5, 0.5, virt) === null,
      `x=1.25 on monitor 1 -> desktop x ${past && Math.round(past.px)}`);
  }

  // Every loader handed out takes the client page in one 'app' reply of at most 40 signaling chunks
  // (signal.js: 3000 characters each, of the deflated and encrypted message). A page that grew past
  // that would leave every client unable to start, so stay well below it.
  {
    const html = buildClientHtml();
    const msg = JSON.stringify({ t: 'app', sid: 'x'.repeat(22), ts: Date.now(), hash: 'h'.repeat(20), html });
    const sealed = require('zlib').deflateRawSync(Buffer.from(msg, 'utf8')).length + 28; // + IV and tag
    const chunks = Math.ceil(Math.ceil((sealed * 4) / 3) / 3000);
    check('the client page fits in what every handed-out loader accepts (40 chunks), with room to spare', chunks <= 36,
      `${(html.length / 1024).toFixed(0)} KB, ${chunks} of 40 chunks`);
  }

  // Keys: a numpad key goes as what the client's NumLock made of it (a digit, or End/an arrow), keys
  // of Japanese and Brazilian keyboards and F17-F24 exist, shortcuts the host presses itself go as
  // virtual keys (layout-independent), and a modifier the person holds is lifted around them.
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const seq = (r) => r.log.filter((e) => e.key).map((e) => (e.up ? '-' : '+') + e.key).join(' ');
    const tapped = input.simulate(R, [{ t: 'kd', c: 'ShiftLeft', k: 'Shift' }], () => input.tap(['ControlLeft', 'KeyC']));
    const ctrlHeld = input.simulate(R, [{ t: 'kd', c: 'ControlLeft', k: 'Control' }], () => input.tap(['ControlLeft', 'KeyV']));
    let keys = 'not Windows';
    if (process.platform === 'win32') {
      const w = require('./platform/win32');
      const k = (c, n, s) => { const x = w.keyOf(c, n, s); return x ? (x.vk ? 'vk' + x.vk.toString(16) : 'sc' + x.scan.toString(16) + (x.flags & 1 ? 'e' : '')) : 'none'; };
      keys = [k('Numpad1', '1'), k('Numpad1', 'End'), k('Numpad5', 'Clear'), k('NumpadDecimal', ','), k('IntlRo', '/'), k('F20', 'F20'), k('KeyC', 'c', true), k('Escape', '', true)].join(' ');
    }
    check('keys: numpad as the client meant it, the extra keys, shortcuts the host presses and modifiers held around them',
      seq(tapped) === '+ShiftLeft -ShiftLeft +ControlLeft +KeyC -KeyC -ControlLeft +ShiftLeft' && seq(ctrlHeld) === '+ControlLeft +KeyV -KeyV'
        && (process.platform !== 'win32' || keys === 'vk61 sc4fe vkc vk6e sc73 vk83 vk43 vk1b'),
      `${seq(tapped)} | ${seq(ctrlHeld)} | ${keys}`);
  }

  // Mouse buttons: a release that got lost on the way is made up for by the next move, which says
  // what the client's pointer really holds. Nothing is injected: input.simulate records what would be.
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }], MF = input.MF;
    const count = (r, bits) => r.log.filter((e) => e.mouse & bits).length, UP = MF.LU | MF.RU | MF.MU | MF.XU, DOWN = MF.LD | MF.RD | MF.MD | MF.XD;
    const at = (t, x, extra) => ({ t, d: 0, x, y: 0.5, ...extra });
    const lost = input.simulate(R, [at('md', 0.5, { b: 0 }), at('mm', 0.6, { h: 1 }), at('mm', 0.7, { h: 0 }), at('mm', 0.8, { h: 0 })]);
    const normal = input.simulate(R, [at('md', 0.5, { b: 0 }), at('mm', 0.6, { h: 1 }), at('mu', 0.6, { b: 0 }), at('mm', 0.7, { h: 0 })]);
    const right = input.simulate(R, [at('md', 0.5, { b: 2 }), at('mm', 0.6), at('mm', 0.7, { h: 1 })]);
    const never = input.simulate(R, [at('mm', 0.5, { h: 7 })]);
    check('a lost button release is made up for by the next move, nothing is ever pressed by it',
      count(lost, UP) === 1 && lost.held === 0 && lost.released === 1 && count(normal, UP) === 1 && normal.released === 0 &&
      count(right, MF.RU) === 1 && right.held === 0 && count(never, DOWN) === 0,
      `lost: ${count(lost, UP)} up, normal: ${count(normal, UP)} up, right button: ${count(right, MF.RU)} up, presses from a move: ${count(never, DOWN)}`);
  }

  // A press on the host's own window frame is never injected (Windows would hold the injecting thread in a loop
  // until a release only that thread could inject: remote control stopped, 2026-11-16); what it means is done
  // instead. A stand-in for the frame: the right fifth of the screen is a window's title bar (x 0.8-0.9),
  // its minimize button (0.9-0.95) and its close button (above 0.95); the rest is a page.
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }], MF = input.MF;
    const at = (t, x, extra) => ({ t, d: 0, x, y: 0.5, ...extra });
    const frame = (px) => (px < 0.8 * 1919 ? null : { hwnd: 7, hit: px < 0.9 * 1919 ? 'caption' : px < 0.95 * 1919 ? 'min' : 'close' });
    const run = (msgs) => input.simulate(R, msgs, null, { ownFrame: frame });
    const pressed = (r) => r.log.filter((e) => e.mouse & (MF.LD | MF.LU | MF.RD | MF.RU | MF.MD | MF.MU)).length;
    const acts = (r) => r.log.filter((e) => e.frame).map((e) => e.frame).join(',');
    const min = run([at('md', 0.92, { b: 0 }), at('mu', 0.92, { b: 0 })]);
    const away = run([at('md', 0.92, { b: 0 }), at('mm', 0.5, { h: 1 }), at('mu', 0.5, { b: 0 })]);
    const drag = run([at('md', 0.85, { b: 0 }), at('mm', 0.86, { h: 1 }), at('mm', 0.87, { h: 1 }), at('mu', 0.87, { b: 0 })]);
    const dbl = run([at('md', 0.85, { b: 0 }), at('mu', 0.85, { b: 0 }), at('md', 0.85, { b: 0 }), at('mu', 0.85, { b: 0 })]);
    const right = run([at('md', 0.85, { b: 2 }), at('mu', 0.85, { b: 2 })]);
    const both = run([at('md', 0.85, { b: 0 }), at('md', 0.85, { b: 2 }), at('mu', 0.85, { b: 2 }), at('mu', 0.85, { b: 0 })]);
    const lost = run([at('md', 0.97, { b: 0 }), at('mm', 0.97, { h: 0 }), at('md', 0.5, { b: 0 }), at('mu', 0.5, { b: 0 })]);
    const page = run([at('md', 0.5, { b: 0 }), at('mu', 0.5, { b: 0 })]);
    const moved = drag.log.filter((e) => e.frame === 'move').map((e) => e.dx);
    check('a press on the host\'s own window frame is not injected: its buttons, title bar and double click act instead',
      pressed(min) + pressed(away) + pressed(drag) + pressed(dbl) + pressed(right) + pressed(both) === 0 && acts(min) === 'activate,min' && acts(away) === 'activate' &&
      acts(drag) === 'activate,move,move' && moved[1] > moved[0] && acts(dbl) === 'activate,activate,max' && acts(right) === '' && acts(both) === 'activate' &&
      pressed(lost) === 2 && acts(lost) === 'activate' && pressed(page) === 2 && acts(page) === '' && [min, drag, both, lost, page].every((r) => r.held === 0),
      `min: ${acts(min)}; let go elsewhere: ${acts(away)}; title bar drag: ${acts(drag)} (${moved.join(',')} px); double click: ${acts(dbl)}; right button: '${acts(right)}'; both: ${acts(both)}; ` +
      `injected presses and releases on the frame: ${pressed(min) + pressed(away) + pressed(drag) + pressed(dbl) + pressed(right) + pressed(both)}; a click in the page after a lost release: ${pressed(lost)}; in the page: ${pressed(page)}`);
  }

  // Input that runs away (input.js stormed): a connection that comes back on itself, which a browser cannot be
  // told of, sends the same key or click again and again, as fast as the connection carries it. A person typing
  // fast, a held key (it repeats without being let go) and a phone's keyboard (a word deleted as many Backspaces at
  // once) must not trip it; 45 presses of one key or 30 clicks within 3 s do: input stops for 5 s (30 s the next
  // time within a minute), what is held is let go, moves still go. The dry run has a clock of its own ('wait').
  {
    const R = [{ x: 0, y: 0, width: 1920, height: 1080 }], MF = input.MF;
    const at = (t, x, extra) => ({ t, d: 0, x, y: 0.5, ...extra });
    const pair = (c, extra) => [{ t: 'kd', c, k: c, ...extra }, { t: 'ku', c, k: c, ...extra }];
    const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).flat();
    const downs = (r, c) => r.log.filter((e) => e.key && !e.up && (!c || e.key === c)).length;
    const ups = (r, c) => r.log.filter((e) => e.key && e.up && e.key === c).length;
    const count = (r, bits) => r.log.filter((e) => e.mouse & bits).length;
    const typing = input.simulate(R, rep(300, (i) => [...pair('Key' + String.fromCharCode(65 + (i % 26))), { t: 'wait', ms: 10 }])); // 100 keys a second
    const held = input.simulate(R, [...rep(200, () => [{ t: 'kd', c: 'KeyA', k: 'a' }, { t: 'wait', ms: 15 }]), { t: 'ku', c: 'KeyA', k: 'a' }]);
    const phone = input.simulate(R, rep(120, () => pair('Backspace', { s: 1 })));
    const fastKey = input.simulate(R, rep(40, () => [...pair('KeyA'), { t: 'wait', ms: 70 }]));
    const fastClicks = input.simulate(R, rep(25, () => [at('md', 0.5, { b: 0 }), at('mu', 0.5, { b: 0 }), { t: 'wait', ms: 100 }]));
    const people = [typing, held, phone, fastKey, fastClicks];
    const keyStorm = input.simulate(R, [{ t: 'kd', c: 'ShiftLeft', k: 'Shift' }, ...rep(60, () => [...pair('KeyA'), { t: 'wait', ms: 5 }]), at('mm', 0.3), ...pair('KeyB')]);
    const clickStorm = input.simulate(R, [...rep(40, () => [at('md', 0.5, { b: 0 }), at('mu', 0.5, { b: 0 }), { t: 'wait', ms: 5 }]), at('md', 0.5, { b: 0 })]);
    const again = input.simulate(R, [...rep(45, () => pair('KeyA')), { t: 'wait', ms: 6000 }, ...pair('KeyB'), ...rep(45, () => pair('KeyA'))]);
    check('input that runs away (the same key or click again and again) stops input for a while; a person\'s typing, a held key, a phone\'s keyboard and fast clicking do not',
      people.every((r) => r.said.length === 0) && downs(typing) === 300 && downs(held) === 200 && downs(phone) === 120 && downs(fastKey) === 40 && count(fastClicks, MF.LD) === 25 &&
      keyStorm.said.join() === 'storm' && keyStorm.pause === 5000 && downs(keyStorm, 'KeyA') === 45 && downs(keyStorm, 'KeyB') === 0 && ups(keyStorm, 'ShiftLeft') === 1 && ups(keyStorm, 'KeyA') === 45 && count(keyStorm, MF.MOVE) === 1 &&
      clickStorm.said.join() === 'storm' && count(clickStorm, MF.LD) === 30 && count(clickStorm, MF.LU) === 30 && clickStorm.held === 0 &&
      again.said.join() === 'storm,storm' && again.pause === 30000 && downs(again, 'KeyB') === 1,
      `a person: ${people.map((r) => r.said.length).join('/')} trips (typing ${downs(typing)} keys, held ${downs(held)}, phone ${downs(phone)}, one key 40 times ${downs(fastKey)}, clicks ${count(fastClicks, MF.LD)}); ` +
      `key storm: ${keyStorm.said.join() || 'none'}, ${keyStorm.pause} ms, KeyA pressed ${downs(keyStorm, 'KeyA')} and let go ${ups(keyStorm, 'KeyA')}, KeyB ${downs(keyStorm, 'KeyB')}, Shift let go ${ups(keyStorm, 'ShiftLeft')}, moves ${count(keyStorm, MF.MOVE)}; ` +
      `click storm: ${clickStorm.said.join() || 'none'}, ${count(clickStorm, MF.LD)} down/${count(clickStorm, MF.LU)} up; again within a minute: ${again.said.join()}, ${again.pause} ms, a key between ${downs(again, 'KeyB')}`);
  }

  // Picture of an app-specific cursor (read-only; uses the standard arrow as a stand-in).
  if (process.platform === 'linux') {
    // X11: the picture of the cursor shown right now, through XFixes (named or not).
    const st = input.cursorState(), b = input.cursorBitmap(st.handle != null ? st.handle : Number(st.key));
    const url = b ? nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL() : '';
    check('cursor picture extraction (X11, XFixes)', b && b.width > 0 && b.height > 0 && b.hx < b.width && b.hy < b.height && url.startsWith('data:image/png;base64,'),
      b ? `${b.width}x${b.height}, hotspot ${b.hx},${b.hy}, ${st.name ? 'named "' + st.name + '"' : 'no standard name (sent as a picture)'}` : `none (${input.viewOnlyReason() || 'no XFixes cursor image'})`);
  } else if (process.platform !== 'win32') {
    info('cursor picture extraction skipped: Windows and Linux only');
  } else {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // 32x32, opaque white, hotspot (3,4)
    const made = user32.func('CreateCursor', 'uintptr_t', ['uintptr_t', 'int', 'int', 'int', 'int', 'uint8*', 'uint8*'])(0, 3, 4, 32, 32, Buffer.alloc(128, 0x00), Buffer.alloc(128, 0xff));
    const b = made ? input.cursorBitmap(made) : null;
    if (made) user32.func('DestroyCursor', 'bool', ['uintptr_t'])(made);
    const url = b ? nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).toDataURL() : '';
    check('cursor picture extraction', b && b.width === 32 && b.hx === 3 && b.hy === 4 && b.bgra[3] === 255 && b.bgra[0] > 200 && url.startsWith('data:image/png;base64,'), b ? `${b.width}x${b.height}, hotspot ${b.hx},${b.hy}` : 'null');
    const dump = process.argv.find((a) => a.startsWith('--dump-cursor='));
    if (dump && b) fs.writeFileSync(dump.split('=')[1], nativeImage.createFromBitmap(b.bgra, { width: b.width, height: b.height }).resize({ width: b.width * 6, quality: 'nearest' }).toPNG());
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-client-'));
  const file = path.join(dir, 'client.html');
  fs.writeFileSync(file, buildClientHtml());
  await sleep(2500); // let the host subscribe first
  const hostWin = BrowserWindow.getAllWindows()[0];
  // The native capturer sends a picture only when the screen changes (and then repeats it for about a
  // second). A display where nothing moves - a virtual one (Xvfb) with this test's windows hidden, or a
  // real monitor nobody is working on while the test runs - gives no frames at all, and the checks that
  // count frames failed now and then (seen on a PC with two monitors, one of them idle). So a small
  // counter in a corner of every display keeps each picture moving, as a person's screen would. It
  // takes no focus and no clicks.
  const ticks = [];
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds;
    const tick = new BrowserWindow({ x: b.x + b.width - 70, y: b.y + b.height - 34, width: 64, height: 28, frame: false, focusable: false, skipTaskbar: true,
      resizable: false, alwaysOnTop: true, show: false, backgroundColor: '#202830', webPreferences: { backgroundThrottling: false } });
    tick.setIgnoreMouseEvents(true);
    await tick.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;font:16px monospace;color:#9cf;background:#202830;overflow:hidden">'
      + '<span id="n"></span><script>let i = 0; setInterval(() => { n.textContent = String(i++ % 10000).padStart(4, "0"); }, 50);</script></body>'));
    tick.showInactive();
    ticks.push(tick);
  }
  const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
  await w.loadFile(file, { hash: `k=${cfg.key}&auto&ro` });
  const js = (code) => w.webContents.executeJavaScript(code);
  const state = () => js(`({ ...window.__rd, sel: mainView.sel, fit: mainView.fit, view: lastView, panes: mainView.panes.length, empty: document.getElementById('empty').style.display === 'flex',
    mons: monitors.map((m) => ({ w: m.width, h: m.height })),
    cursorCss: mainView.panes[0] ? mainView.panes[0].video.style.cursor : '' })`);
  const until = async (pred, secs) => {
    let s;
    for (let i = 0; i < secs; i++) { await sleep(1000); s = await state(); try { if (pred(s)) return [true, s]; } catch {} }
    return [false, s];
  };
  const key = (code) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })),
    window.dispatchEvent(new KeyboardEvent('keyup', { code: '${code}', key: '${code}', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`);
  const width = (res) => Number(String(res || '').split('x')[0]) || 0;
  const onlyFps = (x, idx) => Object.entries(x.fps).every(([i, f]) => (Number(i) === idx ? f > 0 : f === 0));

  try {
    let [ok, s] = await until((x) => x.state === 'connected' && x.frames > 60, 40);
    check('connect and receive video', ok, ok ? `${s.monitors} monitor(s): ${s.mons.map((m) => m.w + 'x' + m.h).join(', ')}` : JSON.stringify(s));
    if (!ok) throw new Error('no connection');
    const N = s.monitors;

    // The host window's word on updates of the installed app (showUpdate in host.js), with made-up ones:
    // one on offer can be put off, a required one cannot, one that needs a new package says so.
    {
      const r = await hostWin.webContents.executeJavaScript(`(() => {
        const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none', text = (id) => document.getElementById(id).textContent;
        const base = { version: '1.0.0', installed: true, rolledBack: [], error: '', checkedAt: 0, progress: 0 }, notes = { ko: ['고친 것 하나'], en: [] };
        const offer = (version, required, kind) => showUpdate({ ...base, state: 'available', available: { version, required, kind, notes, size: 500000 } });
        const out = {};
        showUpdate({ ...base, state: 'idle', available: null });
        out.none = !vis('upd') && text('ver') === 'v1.0.0';
        offer('1.0.1', false, 'bundle');
        out.offered = vis('upd') && /1\\.0\\.1/.test(text('updTitle')) && vis('updGo') && vis('updLater') && text('updNotes').includes('고친 것 하나');
        document.getElementById('updLater').click();
        offer('1.0.1', false, 'bundle');
        out.putOff = !vis('upd');
        offer('1.0.2', true, 'bundle');
        out.required = vis('upd') && /중요/.test(text('updTitle')) && !vis('updGo') && !vis('updLater');
        offer('2.0.0', false, 'package');
        out.newPackage = vis('upd') && vis('updGo') && /내려받기/.test(text('updGo'));
        // "업데이트 확인" (the answer of a check the person asked for, without the feed): up to date, the
        // feed not reached, and an update that was put off shown again.
        showUpdate({ ...base, state: 'idle', available: null });
        out.checkButton = vis('updCheck');
        updateChecked({ ...base, state: 'idle', available: null, checkedAt: 1 });
        out.upToDate = /최신/.test(text('updMsg')) && !vis('upd');
        updateChecked({ ...base, state: 'idle', available: null, error: 'latest.json: HTTP 404' });
        out.checkFailed = /확인하지 못했습니다/.test(text('updMsg'));
        offer('1.0.3', false, 'bundle');
        document.getElementById('updLater').click();
        updateChecked({ ...base, state: 'available', available: { version: '1.0.3', required: false, kind: 'bundle', notes, size: 500000 } });
        out.putOffShownWhenAsked = vis('upd') && /1\\.0\\.3/.test(text('updTitle')) && text('updMsg') === '';
        showUpdate({ ...base, installed: false, state: 'none', available: null });
        out.fromSource = !vis('upd') && /소스/.test(text('ver')) && !vis('updCheck');
        // "나가기" (back to the start screen): shown where main says there is one, never in an isolated run.
        showUpdate({ ...base, state: 'idle', available: null, startScreen: true });
        out.exitShown = vis('exitStart');
        showUpdate({ ...base, state: 'idle', available: null, startScreen: false });
        out.exitHidden = !vis('exitStart');
        updateLater = '';
        document.getElementById('updMsg').textContent = '';
        return api.update.status().then((u) => { showUpdate(u); out.isolatedNoExit = u.startScreen === false && !vis('exitStart'); return api.startScreen(); })
          .then((opened) => { out.isolatedOpensNothing = opened === false; return out; });
      })()`);
      check('the host window shows an update on offer, lets it be put off, says when one is required or needs a new package, and checks when asked (its check-for-updates button); its "나가기" shows only where there is a start screen, never in an isolated run', Object.values(r).every(Boolean), JSON.stringify(r));
    }

    // --soak=<minutes>: a long session instead of the rest, to find what grows (no input injected).
    // The client keeps switching monitors and going to the overview and back, and every minute the
    // host drops the session so that the client connects again. Memory of every process and the two
    // pages' script heaps are sampled every 20 s; growth after the first three minutes is the result.
    const soakArg = process.argv.find((a) => a.startsWith('--soak='));
    if (soakArg) {
      const minutes = Math.max(3, Number(soakArg.split('=')[1]) || 15), end = Date.now() + minutes * 60e3, t0 = Date.now();
      const mb = (kb) => Math.round(kb / 1024);
      // Garbage is collected in every process before a sample (the pages through the debugger protocol,
      // this process through V8's gc()), so a sample shows what is kept, not what has not been collected
      // yet. Without that, the samples swing by tens of MB with the collector's timing.
      let gcMain = null;
      try { require('v8').setFlagsFromString('--expose-gc'); gcMain = require('vm').runInNewContext('gc'); } catch {}
      const gcPage = async (wc) => { try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('HeapProfiler.collectGarbage'); } catch {} };
      // --soak-heap=<folder>: heap snapshots of this (the main) process after the first 3 minutes and at
      // the end, to see what it keeps (compare them in Chrome's DevTools, Memory tab).
      const heapArg = process.argv.find((a) => a.startsWith('--soak-heap='));
      const heapDir = heapArg ? heapArg.slice('--soak-heap='.length) : '';
      // --soak-no-audio: the sessions after the first capture no system sound (then the engine's
      // capturer is not started at all while native capture is in use), to tell its share apart.
      if (process.argv.includes('--soak-no-audio')) await hostWin.webContents.executeJavaScript('cfg.audio = false; 1');
      // Windows: the handles (kernel, GDI, USER) of this process and the host page's, which grow when
      // something is opened per session and never closed.
      let handles = () => null;
      if (process.platform === 'win32') {
        try {
          const koffi = require('koffi'), k32 = koffi.load('kernel32.dll'), u32 = koffi.load('user32.dll');
          const OpenProcess = k32.func('OpenProcess', 'void *', ['uint32', 'bool', 'uint32']);
          const CloseHandle = k32.func('CloseHandle', 'bool', ['void *']);
          const GetProcessHandleCount = k32.func('GetProcessHandleCount', 'bool', ['void *', koffi.out(koffi.pointer('uint32'))]);
          const GetGuiResources = u32.func('GetGuiResources', 'uint32', ['void *', 'uint32']);
          handles = (pid) => {
            const h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (!h) return null;
            try { const n = [0]; GetProcessHandleCount(h, n); return { k: n[0], gdi: GetGuiResources(h, 0), user: GetGuiResources(h, 1) }; } finally { CloseHandle(h); }
          };
        } catch (e) { info(`soak: handle counts not available (${e.message})`); }
      }
      const sample = async () => {
        await gcPage(hostWin.webContents); await gcPage(w.webContents);
        if (gcMain) { gcMain(); gcMain(); }
        await sleep(500);
        const by = {}, hostPid = hostWin.webContents.getOSProcessId(), clientPid = w.webContents.getOSProcessId();
        for (const p of app.getAppMetrics()) {
          const k = p.pid === hostPid ? 'hostPage' : p.pid === clientPid ? 'clientPage' : p.type === 'Tab' ? 'renderer' : p.type.toLowerCase();
          by[k] = (by[k] || 0) + (p.memory.privateBytes || p.memory.workingSetSize || 0);
        }
        const heap = async (wc) => { try { return Math.round((await wc.executeJavaScript('performance.memory ? performance.memory.usedJSHeapSize : 0')) / 1048576); } catch { return -1; } };
        const m = process.memoryUsage(), r1 = (b) => Math.round(b / 104857.6) / 10; // MB with one decimal
        const hm = handles(process.pid) || {}, hh = handles(hostPid) || {};
        return { min: +((Date.now() - t0) / 60e3).toFixed(1), browser: mb(by.browser || 0), gpu: mb(by.gpu || 0), hostPage: mb(by.hostPage || 0), clientPage: mb(by.clientPage || 0),
          utility: mb(by.utility || 0), hostHeap: await heap(hostWin.webContents), clientHeap: await heap(w.webContents),
          mainHeap: r1(m.heapUsed), mainHeapTotal: r1(m.heapTotal), mainExt: r1(m.external), mainK: hm.k, mainGdi: hm.gdi, mainUser: hm.user, hostK: hh.k, hostGdi: hh.gdi, hostUser: hh.user, sessions: 0 };
      };
      let snapped = false;
      const snapshot = (name) => { if (!heapDir) return; try { fs.mkdirSync(heapDir, { recursive: true }); info(`soak heap snapshot ${require('v8').writeHeapSnapshot(path.join(heapDir, name))}`); } catch (e) { info(`soak heap snapshot failed: ${e.message}`); } };
      const rows = [];
      let n = 0, reconnects = 0;
      while (Date.now() < end) {
        await sleep(5000);
        n++;
        if (n % 3 === 0) await key('ArrowRight');                                   // every 15 s: another monitor
        if (n % 12 === 6) { await key('ArrowUp'); await sleep(2500); await key('Digit1'); } // every minute: the overview and back
        if (n % 12 === 0) {                                                           // every minute: the host drops the session
          await hostWin.webContents.executeJavaScript(`teardown('soak', true); 1`);
          const [back] = await until((x) => x.state === 'connected' && x.frames > 0, 30);
          if (back) reconnects++;
        }
        // 15, 35 and 55 s after each reconnect: right after one, the main process holds the new
        // session's start-up allocations for a few seconds, and such samples skewed the medians.
        if (n % 4 === 3) {
          const r = await sample(); r.sessions = reconnects; rows.push(r);
          if (!snapped && r.min >= 3) { snapped = true; snapshot('main-early.heapsnapshot'); }
        }
      }
      snapshot('main-late.heapsnapshot');
      for (const r of rows) info(`soak ${String(r.min).padStart(5)} min  browser ${r.browser} MB  gpu ${r.gpu} MB  host page ${r.hostPage} MB  client page ${r.clientPage} MB  utility ${r.utility} MB  heaps host ${r.hostHeap} / client ${r.clientHeap} / main ${r.mainHeap} (of ${r.mainHeapTotal}) MB  main external ${r.mainExt} MB` +
        (r.mainK != null ? `  handles main ${r.mainK}/${r.mainGdi}/${r.mainUser} host ${r.hostK}/${r.hostGdi}/${r.hostUser}` : '') + `  reconnects ${r.sessions}`);
      // Growth: the median of the samples in the last third against the median of those in the first
      // third after the first 3 minutes (a reconnect makes a sample spike now and then), per reconnect.
      const after = rows.filter((r) => r.min >= 3), third = Math.max(1, Math.floor(after.length / 3));
      const median = (list, k) => { const v = list.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] || 0; };
      const first = after.slice(0, third), lastRows = after.slice(-third);
      const done = lastRows.length ? lastRows[lastRows.length - 1].sessions - first[0].sessions : 0;
      const per = (k) => (done > 0 ? +((median(lastRows, k) - median(first, k)) / done).toFixed(1) : 0);
      const growth = { browser: per('browser'), gpu: per('gpu'), hostPage: per('hostPage'), clientPage: per('clientPage'), hostHeap: per('hostHeap'), clientHeap: per('clientHeap'), mainHeap: per('mainHeap'), mainHeapTotal: per('mainHeapTotal'), mainExt: per('mainExt'),
        ...(rows.some((r) => r.mainK != null) ? { mainHandles: per('mainK'), mainGdi: per('mainGdi'), hostHandles: per('hostK'), hostGdi: per('hostGdi') } : {}) };
      const sum = growth.browser + growth.hostPage + growth.clientPage;
      check(`soak: ${minutes} min, ${reconnects} reconnects, what each session leaves behind stays under 2 MB`, sum < 2 && reconnects >= Math.floor(minutes * 0.6),
        `MB per reconnect (median of the last third minus the first): ${JSON.stringify(growth)}`);
      const pass = results.every(Boolean);
      console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(pass ? 0 : 1);
    }

    // --dump-phone=<file.png>: pictures of the phone layout (a client window of a phone's size, 915x412
    // and 412x915, with '#touch'), with the key row open, then exit. No window is shown.
    const dumpPhone = process.argv.find((a) => a.startsWith('--dump-phone='));
    if (dumpPhone) {
      const out = dumpPhone.split('=')[1];
      for (const [name, width, height] of [['-landscape', 915, 412], ['-portrait', 412, 915]]) {
        const pw = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { backgroundThrottling: false } });
        await pw.loadFile(file, { hash: `k=${cfg.key}&auto&ro&touch` });
        const pjs = (code) => pw.webContents.executeJavaScript(code);
        for (let i = 0; i < 30; i++) { await sleep(1000); if (await pjs(`window.__rd.state === 'connected' && window.__rd.frames > 20`)) break; }
        await pjs(`document.getElementById('keyBtn').click(); [...document.getElementById('keyrow').children].find((b) => b.dataset.code === 'ControlLeft').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); 1`);
        await sleep(1500);
        fs.writeFileSync(out.replace(/\.png$/, name + '.png'), (await pw.webContents.capturePage()).toPNG());
        pw.destroy();
      }
      console.log('[selftest] INFO  phone pictures written next to ' + out);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(0);
    }

    // --dump-panel=<file.png>: pictures of the arrangement panel for checking its design, then exit.
    // It is drawn as if this PC had two 2560x1440 screens; nothing is applied and no window is opened.
    const dumpPanel = process.argv.find((a) => a.startsWith('--dump-panel='));
    if (dumpPanel) {
      const out = dumpPanel.split('=')[1], shot = async (name) => fs.writeFileSync(out.replace(/\.png$/, name + '.png'), (await w.webContents.capturePage()).toPNG());
      await js(`mainView.layoutSig = 'demo'; arr.snap = true; document.head.appendChild(document.createElement('style')).textContent = '* { transition: none !important; }'; arrOpen().then(() => { const s = { left: 0, top: 0, width: 2560, height: 1440, availLeft: 0, availTop: 0, availWidth: 2560, availHeight: 1440 };
        arr.cs = { list: [s, { ...s, left: 2560, availLeft: 2560 }], cur: 0 }; arr.A = monitors.map((_, h) => (h < 2 ? h : null)); arr.prev = arr.A.slice(); arrBuild(); arrPaint(arr.A); })`);
      await sleep(3500);
      await shot('');
      await js(`document.getElementById('arrHelp').click(); 1`);
      await sleep(400);
      await shot('-help');
      await js(`document.getElementById('arrHelp').click(); 1`);
      const dbg = await js(`(() => { const t = arr.host[1], r = t.lcd.getBoundingClientRect(), b = arr.host[2] || arr.host[0], q = b.lcd.getBoundingClientRect(), el = document.getElementById('arr');
        const fire = (type, target, x, y, ctrl) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX: x, clientY: y, ctrlKey: !!ctrl }));
        fire('pointerdown', t.lcd, r.left + 30, r.top + 30); fire('pointermove', el, r.left + 60, r.top + 40); fire('pointermove', el, q.left + q.width / 2, q.top + q.height / 2, true);
        return JSON.stringify({ drag: !!arr.drag, moved: arr.drag && arr.drag.moved, aim: arr.drag && arr.drag.aim && arr.drag.aim.i, shown: arr.shown }); })()`);
      console.log('[selftest] INFO  panel drag state: ' + dbg);
      await sleep(1500);
      await shot('-ctrl-drag');
      await js(`(() => { const el = document.getElementById('arr'), q = arr.host[0].lcd.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: q.left + q.width / 2, clientY: q.top + q.height / 2, pointerId: 7 })); })()`);
      await sleep(1500);
      await shot('-swap-drag');
      await js(`arrDragEnd(false); arrPaint([null, 0, 0].slice(0, monitors.length)); 1`);
      await sleep(1500);
      await shot('-together');
      console.log('[selftest] INFO  panel pictures written next to ' + out);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return app.exit(0);
    }

    [ok, s] = await until((x) => !!x.cursor, 5);
    // A standard cursor arrives as its CSS name, any other as a picture (e.g. X11's own cursor under Xvfb).
    check('cursor shape sync', ok && (s.cursor === 'image' ? s.cursorCss.startsWith('url(') : s.cursorCss === s.cursor), `host cursor = ${s.cursor}`);

    // The browser must not be able to take a drag over (its own drag-and-drop or text selection),
    // and when it does end the pointer's events, the button held on the host is let go.
    {
      const r = await js(`(() => {
        const v = mainView.panes[0].video, b = v.getBoundingClientRect(), before = { ...window.__rd.ptr };
        const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true }), sel = new Event('selectstart', { bubbles: true, cancelable: true });
        v.dispatchEvent(drag); v.dispatchEvent(sel);
        const o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
        v.dispatchEvent(new PointerEvent('pointerdown', o));
        const heldAfterDown = held;
        v.dispatchEvent(new PointerEvent('pointercancel', { ...o, buttons: 0 }));
        return { drag: drag.defaultPrevented, sel: sel.defaultPrevented, heldAfterDown, held, cancel: window.__rd.ptr.cancel - before.cancel, released: window.__rd.ptr.released - before.released,
          noSelect: getComputedStyle(document.body).userSelect === 'none' };
      })()`);
      check('the browser cannot take a drag over; a cancelled pointer lets go of the host button',
        r.drag && r.sel && r.noSelect && r.heldAfterDown === 1 && r.held === 0 && r.cancel === 1 && r.released === 1, JSON.stringify(r));
    }
    [ok, s] = await until((x) => !!x.others, 12);
    check('the host says whether another remote session is connected', ok,
      ok ? `Chrome Remote Desktop ${s.others.crd ? 'connected' : 'not connected'}, windows dragged ${s.others.outline ? 'as an outline' : 'with their contents'}` : 'no message');

    // The client window is smaller than the monitor, so the host must send fewer pixels - but never fewer than
    // shown. It scales by steps (SCALE_STEPS in host.js): the largest step that still covers the shown size.
    // Shown at 828 of 1024 (a factor 1.24, as on GitHub's 1024x768 Windows runners) no step fits and the
    // full size is right; the check expected "fewer" whenever the window was smaller, which a 1920-wide
    // monitor always made true, and failed there.
    const main = s.sel;
    const STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];
    const expectW = (x, need) => {
      const m = x.mons[main], f = need.w > 0 && need.h > 0 ? Math.max(m.w / need.w, m.h / need.h) : 1;
      return m.w / (STEPS.filter((st) => st <= f + 0.01).pop() || 1);
    };
    [ok, s] = await until((x) => {
      const need = JSON.parse(x.view).find((e) => e.i === main), got = width(x.res[main]);
      return need && got > 0 && got >= need.w - 2 && Math.abs(got - expectW(x, need)) <= 2;
    }, 15);
    const encOf = (x) => (x.host && x.host.mons ? Object.entries(x.host.mons).map(([i, m]) => `monitor ${Number(i) + 1} ${m.res} ${m.impl}`).join('; ') : '?');
    const nativeName = process.platform === 'linux' ? 'native (X11: XDamage and MIT-SHM, platform/x11capture.js)' : 'native (native/capture.cpp)';
    info('screen capture: ' + (await hostWin.webContents.executeJavaScript(`session && session.native ? ${JSON.stringify(nativeName)} : "the browser engine's"`)));
    // The page's process finds the shell's modules (koffi) too: code an update put into the data folder did not
    // before 0.8.1 (the page's process does not search NODE_PATH by itself), and ran on the engine's capturer.
    { const why = await hostWin.webContents.executeJavaScript('window.hostApi && window.hostApi.nativeWhy ? window.hostApi.nativeWhy() : "?"');
      check('the native capturer loads in the host page (no module missing)', !/cannot find module|^\?$/i.test(why), why ? `not loaded: ${why}` : 'loaded'); }
    await sleep(4500); s = await state(); info('video encoder: ' + encOf(s) + ' (libaom = AV1 on the CPU, MediaFoundation = H.264 on the graphics card, OpenH264 = H.264 on the CPU)');
    { const hs = await hostWin.webContents.executeJavaScript('session && session.lastHs ? { cap: session.lastHs.cap, capWhy: session.lastHs.capWhy || "" } : null');
      check('the host says which capturer it uses, and why not natively (hs.cap, kept in the diagnostics log)', hs && (hs.cap === 'native' || (hs.cap === 'engine' && hs.capWhy)),
        hs ? hs.cap + (hs.capWhy ? ': ' + hs.capWhy : '') : 'no host statistics'); }
    { const need = JSON.parse(s.view).find((e) => e.i === main);
      check('sends only as many pixels as are shown', ok, `monitor ${main + 1} is ${s.mons[main].w}x${s.mons[main].h}, shown at ${need ? need.w + 'x' + need.h : '?'}, received ${s.res[main]}, expected width ${need ? Math.round(expectW(s, need)) : '?'}`); }

    await js(`setFit(mainView, '1:1')`);
    [ok, s] = await until((x) => width(x.res[main]) === x.mons[main].w, 15);
    check('1:1 mode receives the full resolution', ok, `received ${s.res[main]}`);
    await js(`setFit(mainView, 'fit')`);

    // A window the client app reports minimized (its preload marks the document, client/preload.js) is
    // not asked for, and is again once it is back.
    {
      const mark = (on) => js(`${on ? "document.documentElement.dataset.mrHidden = '1'" : 'delete document.documentElement.dataset.mrHidden'}; document.dispatchEvent(new Event('mrshown')); 1`);
      await mark(true);
      const [paused, sp] = await until((x) => x.view === '[]' && !(x.fps[main] > 0), 12);
      await mark(false);
      const [back, sb] = await until((x) => JSON.parse(x.view || '[]').some((e) => e.i === main) && x.fps[main] > 0, 12);
      check('a window the client app reports minimized is not sent, and is again when it is back', paused && back, `minimized: requested ${sp.view}, ${sp.fps[main]} fps; back: ${sb.fps[main]} fps`);
    }

    if (N > 1) {
      [ok, s] = await until((x) => onlyFps(x, main), 12);
      check('only viewed monitors are sent', ok, `fps per monitor ${JSON.stringify(s.fps)}`);

      const next = (main + 1) % N;
      await key('ArrowRight');
      [ok, s] = await until((x) => x.sel === next && onlyFps(x, next), 12);
      check('Ctrl+Alt+Right switches the monitor', ok, `now showing monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}, fps ${JSON.stringify(s.fps)}`);

      await key('ArrowUp');
      [ok, s] = await until((x) => x.sel === 'all' && Object.values(x.fps).every((f) => f > 0) && Object.keys(x.res).every((i) => width(x.res[i]) > 0 && width(x.res[i]) < x.mons[i].w), 15);
      check('overview shows every monitor, scaled down', ok, `received ${Object.values(s.res).join(', ')}`);

      await key('Digit1');
      [ok, s] = await until((x) => x.sel === 0, 5);
      check('Ctrl+Alt+1 selects monitor 1', ok);

      const plan = await js(`JSON.stringify([planLayout(3, 3, 1, 0), planLayout(3, 2, 0, 1), planLayout(2, 3, 2, 0)].map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.sel]))))`);
      check('layout plan keeps left-to-right order', plan === JSON.stringify([{ 0: 0, 1: 1, 2: 2 }, { 0: 1, 1: 2 }, { 1: 0, 2: 1 }]), plan);

      // Arrangement panel. First the rules for dragging one tile onto another (host monitors 1..3, this PC's screens 1..2).
      const ops = await js(`JSON.stringify([
        arrOp([0, 1, null], { kind: 'host', i: 1 }, { kind: 'host', i: 2 }, false),
        arrOp([0, 1, null], { kind: 'host', i: 1 }, { kind: 'host', i: 2 }, true),
        arrOp([0, 1, null], { kind: 'host', i: 0 }, { kind: 'host', i: 1 }, false),
        arrOp([0, 1, null], { kind: 'client', i: 1 }, { kind: 'host', i: 2 }, false),
        arrOp([0, 1, null], { kind: 'client', i: 1 }, { kind: 'host', i: 0 }, false),
        arrOp([0, 1, null], { kind: 'host', i: 2 }, { kind: 'client', i: 0 }, true),
        arrOp([0, 1, null], { kind: 'client', i: 0 }, { kind: 'client', i: 1 }, false),
      ])`);
      check('arrangement: move swaps, Ctrl adds, onto an unused monitor takes over',
        ops === JSON.stringify([[0, null, 1], [0, 1, 1], [1, 0, null], [0, null, 1], [1, 0, null], [0, 1, 0], [1, 0, null]]), ops);

      // Applying an arrangement (with a single screen of this PC, so no window is opened here).
      const one = `{ list: [{ left: 0, top: 0, width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 }], cur: 0 }`;
      await js(`applyAssign(monitors.map((_, h) => (h < 2 ? 0 : null)), ${one})`);
      [ok, s] = await until((x) => x.panes === 2 && x.fps[0] > 0 && x.fps[1] > 0 && Object.keys(x.fps).every((i) => Number(i) < 2 || x.fps[i] === 0), 15);
      check('arrangement: one screen shows two monitors together', ok, `showing ${JSON.stringify(s.sel)}, fps ${JSON.stringify(s.fps)}`);
      await js(`applyAssign(monitors.map(() => null), ${one})`);
      [ok, s] = await until((x) => x.sel === 'none' && x.empty && Object.values(x.fps).every((f) => f === 0), 12);
      check('arrangement: a screen can be left empty (nothing is sent)', ok, `fps ${JSON.stringify(s.fps)}`);

      // The panel itself: every monitor is shown small while it is open, and a drag changes what the window shows.
      await js(`arrOpen().then(() => { arr.cs = ${one}; arr.A = monitors.map((_, h) => (h === 0 ? 0 : null)); arr.prev = arr.A.slice(); arrBuild(); arrPaint(arr.A); applyAssign(arr.A, arr.cs); })`);
      [ok, s] = await until((x) => x.sel === 0 && JSON.parse(x.view).length === x.monitors, 12);
      const tiles = await js(`({ host: arr.host.length, client: arr.client.length, shown: document.getElementById('arr').style.display, live: arr.host.every((t) => t.videos.size === 1),
        os: [document.getElementById('arrHostOs').textContent, document.getElementById('arrClientOs').textContent, document.querySelectorAll('.osTag svg').length] })`);
      // Each PC's operating system next to its name: the host's from its offer (the computer's name
      // before it), this one's from the browser. The computer's name is compared here, not printed.
      const osName = process.platform === 'win32' ? /^Windows 1[01]$/ : process.platform === 'linux' ? /\S/ : /^macOS/;
      const hostTag = [cfg.hostOs.pc, cfg.hostOs.name].filter(Boolean).join(' · '), tagOk = tiles.os[0] === hostTag && osName.test(cfg.hostOs.name);
      tiles.os[0] = tagOk ? `(the computer's name and ${cfg.hostOs.name})` : '(not what the host sent)';
      check('arrangement panel: shows every host monitor live, and each PC\'s operating system', ok && tiles.host === N && tiles.client === 1 && tiles.shown === 'flex' && tiles.live
        && tagOk && osName.test(tiles.os[1]) && tiles.os[2] === 2, JSON.stringify(tiles) + ' requested ' + s.view);
      await js(`(() => {
        const at = (t) => { const r = t.lcd.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
        const fire = (type, target, pos, extra) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos, ...extra }));
        const a = at(arr.host[0]), b = at(arr.host[1]);
        fire('pointerdown', arr.host[0].lcd, a);
        fire('pointermove', document.getElementById('arr'), { clientX: (a.clientX + b.clientX) / 2, clientY: a.clientY });
        fire('pointermove', document.getElementById('arr'), b);
        fire('pointerup', document.getElementById('arr'), b);
      })()`);
      [ok, s] = await until((x) => x.sel === 1, 10);
      const after = await js(`JSON.stringify(arr.A)`);
      check('arrangement panel: dragging one monitor onto another swaps them', s.sel === 1 && JSON.parse(after)[0] === null && JSON.parse(after)[1] === 0, `window shows monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}, arrangement ${after}`);
      await js(`(() => { const t = arr.host[1].lcd, r = t.getBoundingClientRect(), pos = { clientX: r.left + 20, clientY: r.top + 20 };
        for (const type of ['pointerdown', 'pointerup']) (type === 'pointerdown' ? t : document.getElementById('arr')).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos })); })()`);
      const offA = await js(`JSON.stringify(arr.A)`);
      await js(`(() => { const t = arr.host[1].lcd, r = t.getBoundingClientRect(), pos = { clientX: r.left + 20, clientY: r.top + 20 };
        for (const type of ['pointerdown', 'pointerup']) (type === 'pointerdown' ? t : document.getElementById('arr')).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, ...pos })); })()`);
      const onA = await js(`JSON.stringify(arr.A)`);
      check('arrangement panel: a click turns a monitor off, another click brings it back', JSON.parse(offA).every((x) => x === null) && JSON.parse(onA)[1] === 0, `${offA} then ${onA}`);
      await js(`arrClose(); applyAssign(monitors.map((_, h) => (h === 0 ? 0 : null)), ${one})`);
      [ok, s] = await until((x) => x.sel === 0 && onlyFps(x, 0), 12);
      check('arrangement: back to one monitor', ok, `fps ${JSON.stringify(s.fps)}`);
    } else {
      info('single monitor host: monitor switching, overview and arrangement checks skipped');
    }

    // Things dragged out of the remote picture. No drag is started here and nothing is clicked or typed:
    // the file channel is driven directly and the remaining pieces are checked one by one.
    {
      const crypto = require('crypto');
      const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragsrc-')), dst = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-dragdst-'));
      const big = path.join(src, 'big file \ud55c\uae00.bin'), small = path.join(src, 'note.txt');
      fs.writeFileSync(big, crypto.randomBytes(3 * 1024 * 1024 + 123));
      fs.writeFileSync(small, 'hello drag\n');
      // A file inside a dragged folder travels with its path in it; an empty folder as a 'dir' entry.
      const offered = await Promise.all([offerFile(big), offerFile(small), { id: '', name: 'proj/empty', size: 0, dir: true }, offerFile(small, 'proj/sub/note.txt')]);
      await js(`window.__rd.keepFiles = true; window.__rd.files = []; 1`);
      await hostWin.webContents.executeJavaScript(`sendFiles(session, ${JSON.stringify(offered)}); 1`);
      [ok, s] = await until((x) => x.files.length === 3, 25);
      check('dragged-out files arrive intact, with their folders', ok && s.files[0].sha === sha(big) && s.files[1].sha === sha(small) && s.files[0].name === path.basename(big)
        && s.files[2].name === 'proj/sub/note.txt' && s.files[2].sha === sha(small),
        ok ? s.files.map((f) => `${f.name}: ${f.size} bytes`).join(', ') : JSON.stringify(s.files));
      await js(`window.__rd.keepFiles = false; 1`);

      // What a dragged folder becomes on the host: its files with their paths, its empty folders,
      // and nothing behind a link (a junction pointing at the folder itself must not loop).
      {
        const tree = path.join(src, 'tree');
        fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'empty'));
        fs.writeFileSync(path.join(tree, 'a', 'b', 'x.txt'), 'x');
        fs.writeFileSync(path.join(tree, 'top.txt'), 't');
        let linked = false;
        try { fs.symlinkSync(tree, path.join(tree, 'a', 'loop'), 'junction'); linked = true; } catch {}
        const list = [], room = { left: 100, cut: false };
        await listFolder(tree, 'tree', list, room);
        const rels = list.map((e) => (e.dir ? 'dir:' : '') + e.rel).sort();
        check('a dragged folder is listed with its paths, links are not followed', JSON.stringify(rels) === JSON.stringify(['dir:tree/empty', 'tree/a/b/x.txt', 'tree/top.txt']) && !room.cut,
          `${rels.join(', ')}${linked ? ' (a junction back to the folder was skipped)' : ' (no junction could be made here)'}`);
      }

      // Letting go outside every window with a button held. The host's pointer must wait while the
      // host is asked whether a drag-and-drop is under way (a program may take ~0.35 s to start one),
      // then: carry it out when there is one, otherwise let go where it waited, and only after the
      // wait carry on past the edge (a window moved onto a monitor not shown here).
      {
        const leave = await js(`(async () => {
          const v = mainView.panes[0].video, b = v.getBoundingClientRect(), w = window, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const inside = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, screenX: w.screenX + 40, screenY: w.screenY + 40 };
          const outside = { clientX: -300, clientY: b.top + b.height / 2, screenX: w.screenX - 300, screenY: w.screenY + 40 };
          const fire = (type, at, buttons) => v.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons, ...at }));
          const sent = (t) => window.__rd.trace.filter((m) => m.t === t);
          const res = {};
          // While tracing nothing is sent at all, so the view-only lock can be lifted for the test.
          window.__rd.trace = []; READONLY = false;
          try {
          hostDrag = false; window.__rd.trace = [];
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          res.heldBack = sent('mm').length === 0 && sent('dragq').length === 1;
          fire('pointerup', outside, 0);
          await sleep(${700 + 450});
          res.letGoWhereItWaited = sent('mu').length === 1 && sent('mu')[0].x >= 0 && sent('mu')[0].x <= 1 && sent('dragout').length === 0;
          // (outPending = 0 below stands for the host's answer to a dragout, which never comes while tracing)
          window.__rd.trace = []; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          hostDrag = true; fire('pointermove', outside, 1);
          res.outMode = mainView.dragOut === true;
          fire('pointerup', outside, 0);
          res.carriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          // Back into the window before the host has ended its drag: no move (one without the button would
          // have the host let go where its pointer waited, a drop there), until the host answers.
          fire('pointermove', inside, 0);
          res.noMoveUntilTheHostAnswers = sent('mm').length === 0;
          gotDragData({ t: 'dragdata', kind: 'none', why: 'nodrag' }); drop = null;
          fire('pointermove', inside, 0);
          res.movesAgainAfterTheAnswer = sent('mm').length === 1;
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1); fire('pointerup', outside, 0);
          setTimeout(() => { hostDrag = true; }, 200);
          await sleep(550);
          res.lateDragCarriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', outside, 1);
          await sleep(${700 + 100});
          fire('pointermove', outside, 1);
          res.pastTheEdgeAfterTheWait = sent('mm').length === 1 && sent('mm')[0].x < 0;
          fire('pointerup', outside, 0);
          await sleep(50);
          // Ctrl held: off the picture - here onto this window's own bar above it - the pointer is over at
          // this PC at once: no moves, not even after the wait, also when Ctrl is let go meanwhile; let go
          // there with no drag on the host: the host lets go where its pointer waited.
          window.__rd.trace = []; hostDrag = false; drop = null; outPending = 0;
          const off = b.left > 10 ? { clientX: b.left - 8, clientY: b.top + b.height / 2 } : b.top > 10 ? { clientX: b.left + 30, clientY: b.top - 8 } : { clientX: b.left + 30, clientY: Math.min(innerHeight - 2, b.bottom + 8) };
          const bar = { ...off, screenX: w.screenX + 40, screenY: w.screenY + 40 }; // in this window, off its picture
          fire('pointerdown', inside, 1); fire('pointermove', { ...bar, ctrlKey: true }, 1);
          await sleep(${700 + 100});
          fire('pointermove', bar, 1);
          res.ctrlCrossedAtOnce = mainView.crossed === true && sent('mm').length === 0 && sent('dragq').length === 1;
          fire('pointerup', bar, 0);
          await sleep(1150);
          res.ctrlLetGoWhereItWaited = sent('mu').length === 1 && sent('mu')[0].x >= 0 && sent('mu')[0].x <= 1 && sent('dragout').length === 0;
          // ... and with a drag on the host, carried out to where it is let go.
          window.__rd.trace = []; drop = null; outPending = 0;
          fire('pointerdown', inside, 1); fire('pointermove', { ...bar, ctrlKey: true }, 1);
          hostDrag = true; fire('pointermove', { ...bar, ctrlKey: true }, 1); fire('pointerup', { ...bar, ctrlKey: true }, 0);
          res.ctrlCarriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          // The browser did not give the pointer to the picture (Chromium 156 in a page the loader wrote
          // in place, see hold in the page): what follows the press arrives at whatever is under the
          // pointer, outside the window at the root element. It must reach the picture's handlers, once.
          gotDragData({ t: 'dragdata', kind: 'none', why: 'nodrag' }); drop = null;
          window.__rd.trace = []; hostDrag = false; outPending = 0;
          const fireAt = (el, type, at, buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons, ...at }));
          const root = document.documentElement;
          fire('pointerdown', inside, 1); fireAt(root, 'pointermove', outside, 1);
          hostDrag = true; fireAt(root, 'pointermove', outside, 1);
          res.notGrantedOutMode = mainView.dragOut === true;
          fireAt(root, 'pointerup', outside, 0);
          res.notGrantedCarriedOut = sent('dragout').length === 1 && sent('mu').length === 0;
          // ... a plain press let go over this window's bar: the button goes up on the host, and the
          // pointer moving over the bar afterwards, no button held, sends nothing.
          gotDragData({ t: 'dragdata', kind: 'none', why: 'nodrag' }); drop = null;
          window.__rd.trace = []; hostDrag = false; outPending = 0;
          fire('pointerdown', inside, 1); fireAt($('bar'), 'pointermove', bar, 1); fireAt($('bar'), 'pointerup', bar, 0);
          res.notGrantedLetGo = sent('md').length === 1 && sent('mm').length === 1 && sent('mu').length === 1;
          fireAt($('bar'), 'pointermove', bar, 0);
          res.notGrantedNoStrayMoves = sent('mm').length === 1;
          } finally { READONLY = true; window.__rd.trace = null; hostDrag = false; drop = null; outPending = 0; }
          return res;
        })()`);
        check('drag out: the host pointer waits to learn whether a drag started, then carries it out or lets go where it waited; with Ctrl it is over at this PC at once', Object.values(leave).every(Boolean), JSON.stringify(leave));
      }

      const out = await js(`(() => { const w = window, at = (x, y) => leftAll({ screenX: x, screenY: y });
        return [at(w.screenX + 50, w.screenY + 50), at(w.screenX - 200, w.screenY + 50), at(w.screenX + w.outerWidth + 30, w.screenY + 50)]; })()`);
      const hd = await hostWin.webContents.executeJavaScript(`api.dragOut(0)`);
      check('drag out: leaving every window is recognised; the host injects nothing in a local trial',
        JSON.stringify(out) === '[false,true,true]' && typeof input.captureClass() === 'string' && hd.kind === 'none', `outside ${JSON.stringify(out)}, host says "${hd.why}"`);

      // The client app's part: received files end up in the folder they were dropped on, never over an existing file.
      const drop = require('../client/shell')._drop;
      const stage = (name, from) => { const d = fs.mkdtempSync(path.join(src, 's')), f = path.join(d, name); fs.copyFileSync(from, f); return f; };
      fs.writeFileSync(path.join(dst, 'note.txt'), 'already here');
      const placed = await drop.placeFiles([stage('note.txt', small), stage(path.basename(big), big)], { at: Date.now(), own: false, cls: 'CabinetWClass', folder: Promise.resolve(dst) });
      // Windows' clipboard file list (CF_HDROP); other platforms have their own format (see --clip-check).
      const buf = input.dropFilesBuffer(['C:\\a.txt', 'D:\\b c.txt']), hdrop = process.platform !== 'win32' ||
        (buf.readUInt32LE(0) === 20 && buf.readUInt32LE(16) === 1 && buf.toString('utf16le', 20) === 'C:\\a.txt\0D:\\b c.txt\0\0');
      if (process.platform !== 'win32') info('CF_HDROP buffer check skipped: that clipboard format is Windows-only (the Linux formats are in --clip-check)');
      check('drop into a folder: files are saved there under a free name',
        placed.how === 'saved' && fs.readFileSync(path.join(dst, 'note.txt'), 'utf8') === 'already here' && fs.readFileSync(path.join(dst, 'note (2).txt'), 'utf8') === 'hello drag\n'
        && sha(path.join(dst, path.basename(big))) === sha(big) && drop.safeName('..\\..\\evil:na|me?.txt') === '.._.._evil_na_me_.txt' && drop.safeName('CON') === 'file' && hdrop,
        `${fs.readdirSync(dst).length} files in the folder`);
      // A received folder: names from the other side can never climb out of the staging folder, and
      // the folder (with an empty sub-folder) lands in the target under a free name.
      {
        const g = fs.mkdtempSync(path.join(src, 'g'));
        const escaped = drop.stagedPath(g, '../..\\evil/./sub/..\\CON');
        fs.mkdirSync(path.join(g, 'proj', 'sub'), { recursive: true });
        fs.mkdirSync(path.join(g, 'proj', 'empty'));
        fs.writeFileSync(path.join(g, 'proj', 'sub', 'a.txt'), 'x');
        fs.mkdirSync(path.join(dst, 'proj'));
        const r = await drop.placeFiles([path.join(g, 'proj')], { at: Date.now(), own: false, cls: 'CabinetWClass', folder: Promise.resolve(dst) });
        check('drop of a folder: it keeps its inside and never overwrites; received names cannot leave the staging folder',
          r.how === 'saved' && escaped.startsWith(g + path.sep) && path.relative(g, escaped) === path.join('evil', 'sub', 'file')
          && fs.readFileSync(path.join(dst, 'proj (2)', 'sub', 'a.txt'), 'utf8') === 'x' && fs.statSync(path.join(dst, 'proj (2)', 'empty')).isDirectory(),
          `staged as ${path.relative(g, escaped)}, placed as ${fs.readdirSync(dst).filter((n) => n.startsWith('proj')).join(', ')}`);
      }

      if (process.argv.includes('--clip-check')) {
        // Opt-in: puts two files on this PC's clipboard and reads them back. Only when the clipboard
        // holds nothing or plain text, which is put back afterwards.
        const { clipboard, ClipboardItem } = require('electron');
        const keep = await keepTextClipboard(['text/plain']);
        if (keep) {
          const set = await input.setClipboardFiles([big, small]), back = await input.clipboardFiles();
          // Linux: what a file manager that writes text/uri-list alone (KDE's Dolphin) puts there is read as well.
          let uriList = [big, small];
          if (process.platform === 'linux') {
            await clipboard.write([new ClipboardItem({ 'text/uri-list': [big, small].map((f) => require('url').pathToFileURL(f).href).join('\r\n') + '\r\n' })]);
            uriList = await input.clipboardFiles();
          }
          await restoreClipboard(keep);
          const after = await keepTextClipboard(['text/plain']);
          check('files can be put on the clipboard', set && JSON.stringify(back) === JSON.stringify([big, small]) && JSON.stringify(uriList) === JSON.stringify([big, small]) && JSON.stringify(after) === JSON.stringify(keep),
            `${back.length} read back${process.platform === 'linux' ? `, ${uriList.length} from text/uri-list` : ''}, the text put back`);
        } else info('clipboard check skipped: the clipboard holds more than plain text');
      }
      for (const d of [src, dst]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // Files dragged or pasted in, onto the host: they travel over an 'upload' channel and are written
    // under the host's inbox (a local trial never drops or pastes them). Names from the client can
    // never leave the transfer's folder, a file that sends more than it announced is refused.
    {
      const inbox = path.join(os.tmpdir(), 'my-remote-in');
      const shaOf = (file) => require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = new Set(fs.existsSync(inbox) ? fs.readdirSync(inbox) : []);
      const r = await js(`(async () => {
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const bytes = new Uint8Array(1500000); for (let i = 0; i < bytes.length; i += 4096) crypto.getRandomValues(bytes.subarray(i, Math.min(bytes.length, i + 4096)));
        const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
        const a = new File([bytes], 'a.bin'), b = new File(['hello in\\n'], 'b.txt'), evil = new File(['x'], 'evil.txt');
        const x0 = { ...window.__rd.xfer };
        READONLY = false;
        try {
          await upload(mainView, 'drop', null, { files: [{ file: a, rel: 'a.bin' }, { file: b, rel: 'proj/sub/b.txt' }, { file: evil, rel: '../../evil.txt' }], dirs: ['proj/empty'] });
          for (let i = 0; i < 60 && window.__rd.xfer.inDone === x0.inDone && window.__rd.xfer.inFailed === x0.inFailed; i++) await sleep(250);
          const dropped = { how: window.__rd.xfer.inHow, done: window.__rd.xfer.inDone - x0.inDone };
          // paste with files on the clipboard: a synthetic paste event carrying them
          const dt = new DataTransfer(); dt.items.add(new File(['pasted'], 'p.txt'));
          document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          for (let i = 0; i < 40 && window.__rd.xfer.inDone === x0.inDone + 1; i++) await sleep(250);
          const pasted = { how: window.__rd.xfer.inHow, done: window.__rd.xfer.inDone - x0.inDone };
          // a file that sends more than it announced
          const ch = pc.createDataChannel('upload', { ordered: true }); ch.binaryType = 'arraybuffer';
          await new Promise((res) => { ch.onopen = res; setTimeout(res, 5000); });
          const failed0 = window.__rd.xfer.inFailed;
          ch.send(JSON.stringify({ t: 'begin', mode: 'drop', at: null })); ch.send(JSON.stringify({ t: 'file', name: 'liar.bin', size: 3 })); ch.send(new Uint8Array(10).buffer);
          for (let i = 0; i < 40 && window.__rd.xfer.inFailed === failed0; i++) await sleep(100);
          return { dropped, pasted, liarRefused: window.__rd.xfer.inFailed > failed0, sha: await hex(bytes) };
        } finally { READONLY = true; }
      })()`);
      const fresh = (fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).filter((n) => !before.has(n)).map((n) => path.join(inbox, n));
      const withA = fresh.find((d) => fs.existsSync(path.join(d, 'a.bin')));
      const withP = fresh.find((d) => fs.existsSync(path.join(d, 'p.txt')));
      const ok = r.dropped.how === 'staged' && r.dropped.done === 1 && r.pasted.done === 2 && r.liarRefused && withA && withP
        && shaOf(path.join(withA, 'a.bin')) === r.sha && fs.readFileSync(path.join(withA, 'proj', 'sub', 'b.txt'), 'utf8') === 'hello in\n'
        && fs.statSync(path.join(withA, 'proj', 'empty')).isDirectory() && fs.existsSync(path.join(withA, 'evil.txt'))
        && !fresh.some((d) => fs.existsSync(path.join(d, 'liar.bin')) && fs.statSync(path.join(d, 'liar.bin')).size > 3);
      check('files dragged or pasted in reach the host intact, inside their folder; a lying file is refused', ok,
        JSON.stringify({ ...r, sha: undefined, staged: withA ? fs.readdirSync(withA) : null }));
      for (const d of fresh) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // --clip-check: files copied on the host (put on this PC's clipboard the way Explorer's Copy
    // does) are announced to the client, and fetched when it leaves its windows. Only when the
    // clipboard holds nothing or text (plain, HTML), which is put back.
    if (process.argv.includes('--clip-check')) {
      const keep = await keepTextClipboard(['text/plain', 'text/html']);
      if (keep) {
        const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-clipfiles-'));
        const a = path.join(cdir, 'copied-a.bin'), b = path.join(cdir, 'copied-b.txt');
        fs.writeFileSync(a, require('crypto').randomBytes(200000)); fs.writeFileSync(b, 'copied on the host\n');
        const shaOf = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        let idir = null;
        try {
          await js(`window.__rd.keepFiles = true; window.__rd.files = []; 1`);
          const notes0 = (await state()).xfer.clipNotes;
          await input.setClipboardFiles([a, b]);
          const [noted] = await until((x) => x.xfer.clipNotes > notes0, 8);
          await js(`READONLY = false; try { maybeFetchClipFiles(); } finally { READONLY = true; } 1`);
          const [got, s2] = await until((x) => x.files.length === 2, 20);
          const files = got ? s2.files : [];
          check('files copied on the host are announced and fetched when the client leaves its windows', noted && got
            && files.some((f) => f.name === 'copied-a.bin' && f.sha === shaOf(a)) && files.some((f) => f.name === 'copied-b.txt' && f.sha === shaOf(b)),
            `announced ${!!noted}, received ${files.map((f) => f.name).join(', ') || 'nothing'}`);
          // Files the client sent itself (a paste: they lie in the host's inbox) are not announced back.
          fs.mkdirSync(path.join(os.tmpdir(), 'my-remote-in'), { recursive: true });
          idir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-remote-in', 'selftest-'));
          const c = path.join(idir, 'from-client.txt');
          fs.writeFileSync(c, 'sent by the client\n');
          const notes1 = (await state()).xfer.clipNotes;
          await input.setClipboardFiles([c]);
          const [echoed] = await until((x) => x.xfer.clipNotes > notes1, 3);
          check('files the client sent are not announced back to it', !echoed);
          // Files pasted into the picture: read like a drop; a folder the browser hands over as an
          // unreadable file is left out and named, the file goes (staged here: a local trial drops nothing).
          const pdir = path.join(cdir, 'pasted-folder'), pfile = path.join(cdir, 'pasted.txt');
          fs.mkdirSync(pdir); fs.writeFileSync(path.join(pdir, 'inner.txt'), 'inside\n'); fs.writeFileSync(pfile, 'pasted file\n');
          await input.setClipboardFiles([pfile, pdir]);
          const px0 = (await state()).xfer;
          await js(`READONLY = false; window.__rd.lastDrop = null; 1`);
          w.webContents.focus(); w.webContents.paste();
          const [pasted, ps] = await until((x) => x.xfer.inDone > px0.inDone || x.xfer.inFailed > px0.inFailed, 8);
          const pl = await js(`(() => { READONLY = true; const l = window.__rd.lastDrop; return l && { plain: l.plain, skipped: l.skipped || [], files: l.files, error: l.error }; })()`);
          info(`pasted a file and a folder: the browser listed ${pl ? pl.plain : '?'}, ${pl && pl.files === 2 ? 'the folder went whole (its file inside)' : 'left out ' + (pl ? JSON.stringify(pl.skipped) : '?')}`);
          check('files pasted into the picture: the file goes, and the folder whole (or, where the browser hands it over as a file, left out and named)', pasted && ps.xfer.inHow === 'staged' && pl
            && (pl.files === 2 || pl.skipped.includes('pasted-folder')), JSON.stringify({ how: ps.xfer.inHow, ...pl }));
          // Text from the client is on the clipboard before the input that follows it is injected: the
          // paste shortcut comes right after the text, and since Electron 44 a write completes later.
          if (process.platform === 'win32') {
            // The input is only looked at, never injected: nothing reaches this PC's keyboard.
            const seen = [], handle = input.handle;
            input.handle = (t) => { if (/"t":"kd"/.test(t)) seen.push(input.clipSeq()); };
            try {
              const seq0 = input.clipSeq();
              await hostWin.webContents.executeJavaScript(`api.writeClip('self-test paste'); api.input(JSON.stringify({ t: 'kd', c: 'F24', k: 'F24' })); api.input(JSON.stringify({ t: 'ku', c: 'F24', k: 'F24' })); 1`);
              await sleep(1200);
              await js(`pendingClip = null; 1`); // the host passed the text on: not to be written here later
              check('text from the client is on the clipboard before the next input is injected', seen.length === 1 && seen[0] !== seq0, `clipboard change count ${seq0} before, ${seen.join(', ') || 'no key seen'} at the key`);
            } finally { input.handle = handle; }
          }
        } finally {
          await js(`window.__rd.keepFiles = false; 1`);
          await restoreClipboard(keep);
          try { fs.rmSync(cdir, { recursive: true, force: true }); } catch {}
          if (idir) try { fs.rmSync(idir, { recursive: true, force: true }); } catch {}
        }
      } else info('copied-files check skipped: the clipboard holds more than text');
    }

    // Pasting must reach the page through the browser's paste event (no clipboard-read permission).
    w.webContents.focus();
    w.webContents.paste();
    [ok, s] = await until((x) => x.pastes > 0, 5);
    check('paste event is handled without clipboard permission', ok);

    [ok, s] = await until((x) => x.host && x.host.codec && Object.keys(x.host.mons || {}).length > 0, 8);
    check('host statistics reach the client', ok, ok ? `${s.host.codec} via ${s.host.enc}, available ${s.host.availMbps} Mbps` : '');
    // Real stutter (see watchFrames in the page): shown frames whose capture times came with them.
    const late = s.hitch || {};
    // The self-test's client window is hidden and draws seldom, so most late frames here are drawn late, not received late.
    if (late.frames > 0) info(`frames late compared with when they were captured (hidden window): shown late ${late.n} of ${late.frames} (worst ${Math.round(late.worst)} ms), received late ${late.rn}`);
    else info('frames shown late: not measured (the client window is hidden in the self-test)');

    info(`audio track: ${s.audio ? 'received' : 'none (normal on a PC without an audio output device)'}`);
    // The host sends the text on its clipboard when a session starts: when there is some, it must have
    // arrived (with Electron 45 an unawaited clipboard read once sent nothing, and only an INFO line said so).
    {
      const { clipboard } = require('electron');
      const text = String((await Promise.resolve().then(() => clipboard.readText()).catch(() => '')) || ''); // a promise since Electron 44
      if (text && text.length <= 60000 && !input.clipboardPrivate()) check('text on the host\'s clipboard reaches the client', s.clipRx, s.clipRx ? 'received' : 'not received');
      else info(`clipboard host->client: ${s.clipRx ? 'received' : 'not checked (the clipboard holds no text)'}`);
    }

    // Host monitors changed (simulated): the session is renegotiated and the client comes back by itself.
    let before = s.connects;
    hostWin.webContents.send('displays-changed');
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 20, 40);
    check('renegotiates when the host monitors change', ok, ok ? `still showing monitor ${typeof s.sel === 'number' ? s.sel + 1 : s.sel}` : JSON.stringify(s));
    // With native capture the new session takes the system sound over from the one before instead of
    // starting the engine's capture again (each start leaves handles behind in the main process).
    {
      const h = await hostWin.webContents.executeJavaScript(`({ reused: typeof audioReuses === 'number' ? audioReuses : -1, native: !!(session && session.native), audio: !!(session && session.streams.some((st) => st.getAudioTracks().some((t) => t.readyState === 'live'))) })`);
      if (!s.audio) info('sound take-over not checked: no audio track (normal on a PC without an audio output device)');
      else if (!h.native) info('sound take-over not checked: native capture is not in use');
      else check('a new session takes the system sound over instead of capturing again', h.reused > 0 && h.audio, JSON.stringify(h));
    }
    // X11: the session before let go of its capturers (each holds two X connections and the shared
    // memory of a whole screen). They are closed while a read is under way, which once freed nothing.
    {
      await sleep(600);
      const open = await hostWin.webContents.executeJavaScript('session && session.native && api.nativeOpen ? api.nativeOpen() : -1');
      if (open >= 0) check('X11: the capturers of the session before are let go', open === s.monitors, `${open} open for ${s.monitors} monitor(s)`);
    }
    // An encoder that stops taking frames (stalled() in host.js; what CI saw on Linux, where the engine took
    // every frame for one out of order and dropped it), acted out: the encoder is given an empty track of its
    // own, so the frames the capturer goes on writing reach it no more. The host notices within a few seconds
    // and makes the session anew; the picture comes back.
    if (await hostWin.webContents.executeJavaScript('!!(session && session.native && session.native[0] && session.videoSenders && session.videoSenders[0])')) {
      const framesNow = () => js(`(async () => { let n = 0; if (pc) (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') n += r.framesDecoded || 0; }); return n; })()`);
      const before2 = s.connects, r0 = await hostWin.webContents.executeJavaScript('stallRenews');
      await hostWin.webContents.executeJavaScript(`session.videoSenders[0].replaceTrack(new MediaStreamTrackGenerator({ kind: 'video' })).then(() => 1)`);
      let back2 = false, f0 = -1, f1 = -1;
      for (let i = 0; i < 25 && !back2; i++) {
        await sleep(1000);
        s = await state();
        if (s.connects > before2 && s.state === 'connected') { if (f0 < 0) f0 = await framesNow(); else { f1 = await framesNow(); back2 = f1 > f0 + 5; } }
      }
      const r1 = await hostWin.webContents.executeJavaScript('stallRenews');
      check('an encoder that stops taking frames is noticed: the host makes the session anew and the picture comes back',
        back2 && r1 === r0 + 1, `stall renews ${r0} -> ${r1}; reconnected ${s.connects > before2}; frames decoded after ${f0 < 0 || f1 < 0 ? '-' : f1 - f0}`);
    }
    // The host's screen locked and unlocked (what main sends on Windows' lock events), and a screen the
    // native capturer cannot read for a while (a UAC prompt): the client says so over the picture.
    {
      const lockShown = () => js(`!!(mainView.lockEl && mainView.lockEl.style.display === 'flex')`);
      hostWin.webContents.send('host-lock', true);
      const [on] = await until((x) => x.lock === 'lock', 6);
      const shown = await lockShown();
      hostWin.webContents.send('host-lock', false);
      const [off] = await until((x) => x.lock === '', 6);
      const gone = !(await lockShown());
      let secure = 'not checked (native capture not in use)';
      if (await hostWin.webContents.executeJavaScript('!!(session && session.native && session.native[0])')) {
        await hostWin.webContents.executeJavaScript(`nativePort.onmessage({ data: { t: 'paused', i: 0, on: true, error: 'self-test' } }); 1`);
        const [sec] = await until((x) => x.lock === 'secure', 6);
        await hostWin.webContents.executeJavaScript(`nativePort.onmessage({ data: { t: 'paused', i: 0, on: false, error: '' } }); 1`);
        const [back] = await until((x) => x.lock === '', 6);
        secure = sec && back ? 'secure prompt shown and cleared' : `secure prompt ${sec ? 'shown' : 'not shown'}, ${back ? 'cleared' : 'not cleared'}`;
      }
      check('the client says when the host screen is locked or behind a secure prompt, and when it is back', on && shown && off && gone && !/not (shown|cleared)/.test(secure),
        `lock ${on && shown ? 'shown' : 'not shown'}, ${off && gone ? 'cleared' : 'not cleared'}; ${secure}`);
    }
    // The lock screen through the Windows assist service on every monitor (a service of 2026-11-18 on): the
    // helper's picture of each monitor, by its place, goes into that monitor's video, and the client shows the
    // lock screen live (its bar, no cover) on every window that shows one of them. Acted out with what main
    // passes on (assist.js has its own test, the helper was checked on a real lock screen in the test VM).
    if (await hostWin.webContents.executeJavaScript('!!(session && session.native && session.sources.every((src, i) => session.native[i]))')) {
      const n = await hostWin.webContents.executeJavaScript(`(() => {
        assistState({ secure: true, locked: true, input: true });
        for (const src of session.sources) assistFrame({ x: src.x, y: src.y, w: src.width, h: src.height, data: new Uint8Array(src.width * src.height * 4).fill(70) });
        return session.sources.length; })()`);
      const [live, s1] = await until((x) => x.lock === 'lock' && x.lockLive && x.lockLive.ds.length === n, 6);
      const ui = await js(`({ bar: !!(mainView.lockBar && mainView.lockBar.style.display === 'flex'), cover: !!(mainView.lockEl && mainView.lockEl.style.display === 'flex') })`);
      // The still picture goes again once a second after its repeats (the keep-alive): a client that gets
      // nothing for 3 s asks for a key frame, and the next dot of a typed password would come as one.
      await sleep(2500);
      const kept = await hostWin.webContents.executeJavaScript(`(() => { const now = performance.now(), k = keepAliveMs();
        return { keep: k, ages: [...assist.mons.values()].map((e) => Math.round(now - e.at)), left: [...assist.mons.values()].map((e) => e.left), timer: !!assist.timer }; })()`);
      const keptOk = kept.keep > 0 && kept.ages.length === n && kept.ages.every((a) => a < kept.keep + 400) && kept.left.every((l) => l === 0) && kept.timer;
      await hostWin.webContents.executeJavaScript(`assistState({ secure: false, locked: false, input: false }); 1`);
      const [back] = await until((x) => x.lock === '', 6);
      const barGone = !(await js(`!!(mainView.lockBar && mainView.lockBar.style.display === 'flex')`));
      const stopped = await hostWin.webContents.executeJavaScript('!assist.timer && assist.mons.size === 0');
      check('the lock screen through the assist service: every monitor\'s picture reaches its own video and the client shows it live (bar, no cover), still pictures are kept alive once a second; cleared after',
        live && ui.bar && !ui.cover && keptOk && back && barGone && stopped, JSON.stringify({ monitors: n, lockLive: s1 && s1.lockLive, ui, kept, back, barGone, stopped }));
    } else info('the lock screen on every monitor not checked: native capture is not in use on every monitor');
    // A session that starts while the screen cannot be read (the PC locked; acted out by the native
    // capturer, mc_test_elsewhere): it comes up all the same (before 0.5.1 it ended with "Could not start
    // video source", so a locked PC could not be reached at all), the client is told why the picture
    // waits, and the picture, and the sound fetched only then, follow once the screen can be read.
    if (await hostWin.webContents.executeJavaScript('!!(session && session.native && api.nativeTestElsewhere(false))')) {
      const hadSound = s.audio;
      const audioIn = () => js(`(async () => { let n = 0; if (pc) (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.packetsReceived || 0; }); return n; })()`);
      // Frames decoded on this very connection. The page's own count (__rd.frames, from its stats every few
      // seconds) still has the connection before for a moment after a reconnect, and taken then as the
      // count to beat it made this check fail now and then (2026-11-18, in the packaged app: the picture
      // was back and the notice gone, but "9 frames fewer" than the old connection's last count).
      const videoIn = () => js(`(async () => { let n = 0; if (pc) (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') n += r.framesDecoded || 0; }); return n; })()`);
      // No sound for the next session to take over, as when nobody was connected before the PC locked.
      await hostWin.webContents.executeJavaScript('session.streams.forEach((st) => st.getAudioTracks().forEach((t) => t.stop())); api.nativeTestElsewhere(true); 1');
      const before = s.connects;
      hostWin.webContents.send('displays-changed');
      let up = false, waits = false, h = {};
      try {
        [up, s] = await until((x) => x.connects > before && x.state === 'connected', 40);
        if (up) [waits, s] = await until((x) => x.lock === 'secure', 8);
        h = await hostWin.webContents.executeJavaScript('({ waiting: !!(session && session.native && session.native.some((n) => n.waiting)), soundLater: !!(session && session.soundLater) })');
      } finally { await hostWin.webContents.executeJavaScript('api.nativeTestElsewhere(false); 1'); }
      const f0 = await videoIn(), a0 = await audioIn();
      let back = false, f1 = f0;
      for (let i = 0; i < 12 && !back; i++) { await sleep(1000); s = await state(); f1 = await videoIn(); back = s.lock === '' && f1 > f0 + 5; }
      // Why not, when not: what the client has and what the host counts as unreadable, and which monitors the client shows.
      const why = back ? null : await hostWin.webContents.executeJavaScript(`({ lock: screenGone.lock, from: screenGone.lockFrom, paused: [...screenGone.paused], timers: [...screenGone.timers.keys()],
        sinceUnlock: Math.round(performance.now() - screenGone.unlockedAt), assist: assist.secure, sent: screenGone.sent, shown: session ? [...session.need.keys()] : null })`).then((g) => ({ client: { lock: s.lock, frames: f1 - f0 }, host: g }), (e) => String(e));
      let sound = 'sound not checked (no audio output device)';
      if (hadSound) {
        let a1 = a0;
        for (let i = 0; i < 8 && a1 <= a0 + 20; i++) { await sleep(1000); a1 = await audioIn(); }
        sound = !h.soundLater ? 'no sound: the offer had no place for it' : a1 > a0 + 20 ? 'the sound follows' : `no sound after the screen came back (${a0} -> ${a1} packets)`;
      }
      check('a session started while the screen cannot be read (PC locked) comes up, says so, and the picture and sound follow',
        up && waits && h.waiting && back && !/^no sound/.test(sound),
        `${up ? 'connected' : 'did not connect'}; ${waits ? 'the client was told the screen waits' : 'the client was not told'}; capturer ${h.waiting ? 'opened waiting' : 'not waiting'}; ${back ? 'picture back' : 'picture not back ' + JSON.stringify(why)}; ${sound}`);
    } else info('session start on a locked PC not checked: Windows native capture is not in use');
    // Installing or removing the lock screen support during a remote session is refused before anything
    // runs elevated: Windows' consent prompt could not be answered from the client. A stand-in runs in
    // place of the elevated winassist.exe here, so a broken refusal shows as a call, never as a real prompt.
    if (require('./assist').supported) {
      const A = require('./assist')._test, calls = [];
      A.elevate = (verb) => { calls.push(verb); return 1223; };
      let r = null;
      try { r = await hostWin.webContents.executeJavaScript('Promise.all([api.assist.install(), api.assist.uninstall()]).then((all) => all.map((x) => x.why))'); }
      finally { A.elevate = null; }
      check('the lock screen support is never installed or removed during a remote session (Windows would ask at the host)',
        Array.isArray(r) && r.every((w) => w === 'remote') && !calls.length, JSON.stringify({ why: r, elevated: calls }));
    }
    // A phone (attachTouch, the phone keyboard): fingers on the picture made of synthetic touch pointer
    // events, traced (nothing is sent), and what the host makes of the characters a phone types.
    {
      const t = await js(`(async () => {
        if (typeof mainView.sel !== 'number') setSel(mainView, 0);
        if (mainView.fit !== 'fit') setFit(mainView, 'fit');
        const v = mainView.panes[0].video, r = v.getBoundingClientRect();
        const P = (type, id, fx, fy) => v.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: id === 11, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, cancelable: true }));
        const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
        const INPUT = new Set(['mm', 'md', 'mu', 'mw', 'kd', 'ku', 'text']);
        const out = {};
        const run = async (name, fn) => {
          window.__rd.trace = []; await fn(); await wait(80);
          out[name] = window.__rd.trace.filter((m) => INPUT.has(m.t)).map((m) => m.t + (m.b != null ? m.b : '') + (m.t === 'mw' ? (m.dy > 0 ? '+' : m.dy < 0 ? '-' : '0') : ''));
        };
        await run('tap', async () => { P('pointerdown', 11, .5, .5); await wait(60); P('pointerup', 11, .5, .5); });
        await run('long', async () => { P('pointerdown', 11, .3, .3); await wait(700); P('pointerup', 11, .3, .3); });
        await run('drag', async () => { P('pointerdown', 11, .4, .4); await wait(420); P('pointermove', 11, .45, .4); P('pointermove', 11, .5, .4); P('pointerup', 11, .5, .4); });
        await run('swipe', async () => { P('pointerdown', 11, .5, .6); await wait(30); P('pointermove', 11, .5, .55); P('pointermove', 11, .5, .45); await wait(40); P('pointerup', 11, .5, .45); });
        await run('pinch', async () => { P('pointerdown', 11, .45, .5); P('pointerdown', 12, .55, .5); P('pointermove', 11, .35, .5); P('pointermove', 12, .65, .5); P('pointerup', 12, .65, .5); P('pointerup', 11, .35, .5); });
        out.zoom = +(mainView.zoom || 1).toFixed(2);
        document.getElementById('zoomBtn').click();
        // The phone keyboard: what changes in the hidden field goes over; Backspace also when only the
        // kept space is left; a key-row Ctrl makes the next letter a shortcut.
        const k = document.getElementById('kbd'), type = (val, inputType) => { k.value = val; k.dispatchEvent(new InputEvent('input', { inputType })); };
        await run('kbd', async () => { type(' 한글a', 'insertText'); type(' 한글', 'deleteContentBackward'); type(' 한', 'deleteContentBackward'); type(' ', 'deleteContentBackward'); type('', 'deleteContentBackward'); });
        out.kept = JSON.stringify(k.value);
        await run('ctrl', async () => {
          const ctrl = [...document.getElementById('keyrow').children].find((b) => b.dataset.code === 'ControlLeft');
          ctrl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          type(' c', 'insertText');
        });
        out.kbdTrace = window.__rd.trace;
        window.__rd.trace = null;
        return out;
      })()`);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const typed = input.simulate([{ x: 0, y: 0, width: 1920, height: 1080 }], [{ t: 'text', s: '한글 a' }]).log.find((e) => e.text);
      const ok = same(t.tap, ['md0', 'mu0']) && same(t.long, ['md2', 'mu2']) && t.drag[0] === 'md0' && t.drag.includes('mm') && t.drag[t.drag.length - 1] === 'mu0'
        && t.swipe.includes('mw+') && !t.swipe.some((x) => /^m[du]/.test(x)) && !t.pinch.some((x) => /^m[du]/.test(x)) && t.zoom > 1.2
        && same(t.kbd, ['text', 'kd', 'ku', 'kd', 'ku', 'kd', 'ku', 'kd', 'ku']) && t.kept === '" "' && same(t.ctrl, ['kd', 'kd', 'ku', 'ku']) && typed && typed.text === '한글 a';
      // The first rule: in a window this PC's system shortcuts stay here, in fullscreen they go to the
      // host; a key whose press went keeps its release. The clipboard is shared either way.
      const r = await js(`(() => {
        const K = (type, code, o = {}) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...o }));
        const sent = () => window.__rd.trace.filter((m) => m.t === 'kd' || m.t === 'ku').map((m) => m.t + ':' + m.c);
        const out = {};
        window.__rd.trace = []; window.__rd.forceFull = false;
        K('keydown', 'MetaLeft', { metaKey: true }); K('keydown', 'KeyS', { metaKey: true, shiftKey: true }); K('keyup', 'KeyS', { metaKey: true }); K('keyup', 'MetaLeft');
        K('keydown', 'PrintScreen'); K('keyup', 'PrintScreen'); K('keydown', 'KeyA'); K('keyup', 'KeyA');
        out.window = sent();
        window.__rd.trace = []; window.__rd.forceFull = true;
        K('keydown', 'MetaLeft', { metaKey: true }); K('keydown', 'KeyD', { metaKey: true }); K('keyup', 'KeyD', { metaKey: true });
        window.__rd.forceFull = false; K('keyup', 'MetaLeft'); // fullscreen left with the key still held: its release still goes
        out.full = sent();
        // In a window Alt+Space stays here, but Alt went first: the host lets go of everything (masked);
        // the releases of Alt and of a key never pressed here are not sent.
        window.__rd.trace = [];
        K('keydown', 'AltLeft', { altKey: true }); K('keydown', 'Space', { altKey: true }); K('keyup', 'Space', { altKey: true }); K('keyup', 'AltLeft'); K('keyup', 'KeyB');
        out.altSpace = window.__rd.trace.filter((m) => ['kd', 'ku', 'reset'].includes(m.t)).map((m) => m.t + (m.c ? ':' + m.c : ''));
        // The client app's clipboard: what was there before the session is never sent, a copy made here is,
        // once; text from the host that both have already is not written again.
        window.__rd.trace = [];
        const keepLast = lastClip;
        clipSeqSeen = null; lastClip = null;
        gotClientClip({ seq: 101, text: 'before the session' }); gotClientClip({ seq: 102, text: 'before the session' });
        gotClientClip({ seq: 103, text: 'copied here' }); gotClientClip({ seq: 104, text: 'copied here' });
        out.clip = window.__rd.trace.filter((m) => m.t === 'clip').map((m) => m.s);
        lastClip = 'the same text'; pendingClip = null; gotClip('the same text'); out.sameKept = pendingClip === null;
        clipSeqSeen = null; lastClip = keepLast; pendingClip = null; window.__rd.trace = null; window.__rd.forceFull = false;
        return out;
      })()`);
      const masked = input.simulate([{ x: 0, y: 0, width: 1920, height: 1080 }], [{ t: 'kd', c: 'AltLeft', k: 'Alt' }, { t: 'reset' }]).log.map((e) => e.key + (e.up ? '-up' : ''));
      check('fullscreen is the host: in a window the system keys stay here (Alt+Space lets go of the Alt already sent), in fullscreen they go; the clipboard is shared; a lone Alt let go is masked', same(r.window, ['kd:KeyA', 'ku:KeyA'])
        && same(r.full, ['kd:MetaLeft', 'kd:KeyD', 'ku:KeyD', 'ku:MetaLeft']) && same(r.altSpace, ['kd:AltLeft', 'reset']) && same(r.clip, ['copied here']) && r.sameKept
        && same(masked, ['AltLeft', 'mask', 'AltLeft-up']),
        `window ${r.window} | fullscreen ${r.full} | Alt+Space in a window ${r.altSpace} | clipboard ${JSON.stringify(r.clip)}${r.sameKept ? '' : ', the same text written again'} | reset ${masked}`);
      // Keyboard Lock without stuck modifier keys (client/keylock.js; release/test-keylock.js has its rules): a lock
      // taken while Ctrl, Alt or the Windows key was held left that key pressed for the whole client PC (2026-11-17).
      // This page runs as in a browser: it puts the wrapper in itself, once.
      const kl = await js(`(() => { const had = !!(window.Keyboard && Keyboard.prototype.__mrSafe); const put = safeKeyboardLock(window, null); return { had, put, safe: !!(window.Keyboard && Keyboard.prototype.__mrSafe), again: safeKeyboardLock(window, null) }; })()`);
      check('Keyboard Lock only through the wrapper that waits for Ctrl, Alt and the Windows key to be up: the page puts it in where the client app did not',
        kl.safe && kl.again === false && (kl.put === true || kl.had), JSON.stringify(kl));
      // Fullscreen: resting the pointer at the very top brings the bar back over the picture (attachPeek); a quick
      // visit, a held button or a finger does not; it goes once the pointer has left it. (This hidden window cannot
      // go fullscreen: forceFull stands in for it, as for the key rule above.)
      const pk = await js(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const P = (y, o = {}) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: y, buttons: 0, pointerType: 'mouse', bubbles: true, ...o }));
        const bar = document.getElementById('bar'), on = () => bar.classList.contains('peek'), out = {};
        const peeks = () => window.__rd.peeks || 0;
        window.__rd.forceFull = true;
        P(0); await wait(PEEK_DWELL + 150); out.rest = on(); out.label = document.getElementById('fs').textContent;
        // On it for longer than PEEK_LEAVE: it stays; away and back within PEEK_LEAVE: it stays; away: it goes.
        P(20); await wait(PEEK_LEAVE + 250); out.onIt = on();
        P(500); await wait(300); P(20); await wait(PEEK_LEAVE + 250); out.back = on();
        // The focus left in it (a select of the bar) goes back to the picture when it goes.
        document.getElementById('mode').focus();
        P(500); await wait(PEEK_LEAVE + 250); out.left = on();
        out.focusBack = document.activeElement === (mainView.panes[0] && mainView.panes[0].video);
        const n0 = peeks();
        P(0); await wait(150); P(200); await wait(PEEK_DWELL + 150); out.quick = peeks() - n0;
        // Along the edge (the host's tabs): never; then at rest: yes.
        for (let x = 100; x <= 900; x += 40) { window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: 0, buttons: 0, pointerType: 'mouse', bubbles: true })); await wait(60); }
        out.along = peeks() - n0;
        await wait(PEEK_DWELL + 150); out.restAfter = on(); P(500); await wait(PEEK_LEAVE + 250);
        const n1 = peeks();
        // Left the window (relatedTarget null) while it waited: nothing.
        P(0); window.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null, bubbles: true })); await wait(PEEK_DWELL + 150); out.leftWindow = peeks() - n1;
        P(0, { buttons: 1 }); await wait(PEEK_DWELL + 150); P(300); out.held = peeks() - n1;
        P(0, { pointerType: 'touch' }); await wait(PEEK_DWELL + 150); P(300); out.finger = peeks() - n1;
        // The lock screen's bar in this window (its Ctrl+Alt+Del button is at the top): nothing.
        const keepLock = mainView.lockBar; mainView.lockBar = { style: { display: 'flex' } };
        P(0); await wait(PEEK_DWELL + 150); P(300); out.lockBar = peeks() - n1;
        mainView.lockBar = keepLock;
        // 1:1 with the picture still able to pan up (the top edge pans it): nothing.
        const v = mainView.panes[0] && mainView.panes[0].video, keepFit = mainView.fit, keepSel = mainView.sel;
        if (v) { mainView.fit = '1:1'; if (typeof mainView.sel !== 'number') mainView.sel = 0; v.getBoundingClientRect = () => ({ top: -400, bottom: 2000, left: 0, right: 3000, width: 3000, height: 2400 }); }
        P(0); await wait(PEEK_DWELL + 150); P(300); out.panning = v ? peeks() - n1 : 'no picture';
        if (v) { delete v.getBoundingClientRect; mainView.fit = keepFit; mainView.sel = keepSel; }
        window.__rd.forceFull = false;
        P(0); await wait(PEEK_DWELL + 150); out.window = peeks() - n1;
        document.getElementById('fs').textContent = '전체화면';
        // The small menu of a window of its own (no other window is opened here: built for a stand-in view).
        const fake = { win: window, sel: 0, panes: [], peek: { hide() {} } };
        const box = peekMenu(fake);
        fillPeek(fake, box);
        out.child = [...box.children].map((b) => b.textContent);
        out.monitors = monitors.length;
        box.remove();
        // A key whose press went to the host has its release sent, also with the focus moved to a field here.
        const K = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
        window.__rd.trace = [];
        K('keydown', 'KeyA'); document.getElementById('mode').focus(); K('keyup', 'KeyA'); K('keydown', 'KeyB'); K('keyup', 'KeyB');
        document.getElementById('mode').blur();
        out.release = window.__rd.trace.filter((m) => m.t === 'kd' || m.t === 'ku').map((m) => m.t + ':' + m.c);
        window.__rd.trace = null;
        return out;
      })()`);
      const wantChild = [...Array.from({ length: pk.monitors }, (_, i) => `모니터 ${i + 1}`), ...(pk.monitors > 1 ? ['전체 보기'] : []), '전체화면', '창 닫기', '연결 끊기'];
      check('fullscreen: resting the pointer at the very top brings the bar over the picture and it stays while the pointer is on it (a window of its own: a small menu); a pass along the edge, a quick visit, leaving the window, a held button, a finger, the lock screen\'s bar, a picture still panning up or a window do not',
        pk.rest && pk.label === '전체화면 끝내기' && pk.onIt && pk.back && !pk.left && pk.focusBack && pk.quick === 0 && pk.along === 0 && pk.restAfter && pk.leftWindow === 0 &&
        pk.held === 0 && pk.finger === 0 && pk.lockBar === 0 && pk.panning === 0 && pk.window === 0 && JSON.stringify(pk.child) === JSON.stringify(wantChild), JSON.stringify(pk));
      check('a key whose press went to the host has its release sent, also when the focus moved to a field of the page meanwhile (and keys typed into the field stay here)',
        JSON.stringify(pk.release) === JSON.stringify(['kd:KeyA', 'ku:KeyA']), JSON.stringify(pk.release));
      check('a phone: tap, long press, hold and drag, swipe, pinch; its keyboard (Hangul, Backspace, key-row Ctrl); the host types the characters', ok,
        `tap ${t.tap} | long ${t.long} | drag ${t.drag} | swipe ${t.swipe} | pinch ${t.pinch.join(',') || 'nothing sent'}, zoom ${t.zoom} | kbd ${t.kbd} kept ${t.kept} | ctrl ${t.ctrl} | host typed ${typed ? 'yes' : 'no'}`);
    }

    if (INPUT_CHECK) {
      if (process.platform === 'linux') {
        const native = await hostWin.webContents.executeJavaScript('!!(session && session.native)');
        await require('./inputcheck').run({ check, info, js, until, dragOut, native });
      }
      else info('--input-check is for Linux (X11); on Windows input injection was verified separately');
      s = await state();
    }

    if (CURSOR_CHECK && !input.hidesCursors) info('--cursor-check skipped: hiding the host cursor is Windows-only');
    else if (CURSOR_CHECK) {
      // Compare the pixels under the cursor with the cursor shown and hidden.
      const pt = screen.getCursorScreenPoint();
      const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
      const d = screen.getDisplayNearestPoint(pt), idx = displays.findIndex((x) => x.id === d.id);
      const lx = Math.round((pt.x - d.bounds.x) * d.scaleFactor), ly = Math.round((pt.y - d.bounds.y) * d.scaleFactor);
      // A small always-on-top window under the cursor gives the comparison a static background
      // (and a standard arrow cursor) whatever happens to be on screen.
      const pad = new BrowserWindow({ x: pt.x - 60, y: pt.y - 60, width: 120, height: 120, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, resizable: false, backgroundColor: '#6a7f96', show: false });
      pad.setAlwaysOnTop(true, 'screen-saver');
      pad.showInactive();
      const grab = async () => {
        await sleep(2500);
        return js(`(() => { const v = mainView.panes[0].video, c = document.createElement('canvas'); c.width = c.height = 64;
          const g = c.getContext('2d'); g.drawImage(v, ${lx} - 8, ${ly} - 8, 64, 64, 0, 0, 64, 64); return Array.from(g.getImageData(0, 0, 64, 64).data); })()`);
      };
      const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++; return n; };
      const renegotiate = async () => {
        const c = (await state()).connects;
        hostWin.webContents.send('displays-changed');
        return (await until((x) => x.connects > c && x.state === 'connected' && Number(String(x.res[idx]).split('x')[0]) === x.mons[idx].w, 40))[0];
      };
      await js(`setSel(mainView, ${idx}); setFit(mainView, '1:1')`);
      await until((x) => Number(String(x.res[idx]).split('x')[0]) === x.mons[idx].w, 15);
      const shown1 = await grab(), shown2 = await grab();
      cfg.hideHostCursor = true;
      const okA = await renegotiate();
      const hidden = await grab();
      cfg.hideHostCursor = false;
      const okB = await renegotiate();
      const shown3 = await grab();
      const noise = diff(shown1, shown2), gone = diff(shown1, hidden), back = diff(shown1, shown3);
      check('hiding the host cursor removes it from the video', okA && okB && gone > 30 && gone > noise * 3 && back < gone / 2,
        `pixels changed under the cursor: noise ${noise}, hidden ${gone}, restored ${back}`);
      pad.destroy();
      await js(`setFit(mainView, 'fit')`);
      s = await state();
    }

    // Host program restarted: same.
    before = s.connects;
    hostWin.reload();
    [ok, s] = await until((x) => x.connects > before && x.state === 'connected' && x.frames > 20, 60);
    check('auto reconnect after host restart', ok, ok ? '' : JSON.stringify(s));
    // The loader file: fetches the client page from the host, runs it, and skips the download next time.
    {
      const lf = path.join(dir, 'loader.html');
      fs.writeFileSync(lf, buildLoaderHtml());
      w.destroy();
      const lw = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
      const ljs = (code) => lw.webContents.executeJavaScript(code);
      const lstate = () => ljs(`({ boot: window.__mrBoot ? { updated: window.__mrBoot.updated } : null, state: window.__rd ? window.__rd.state : '', frames: window.__rd ? window.__rd.frames : 0, cached: !!localStorage.getItem('mr_app_html'), hasKeyInStore: !!localStorage.getItem('mr_key') })`);
      const luntil = async (pred, secs) => { let x; for (let i = 0; i < secs; i++) { await sleep(1000); try { x = await lstate(); if (pred(x)) return [true, x]; } catch {} } return [false, x]; };
      await lw.loadFile(lf, { hash: `k=${cfg.key}&auto&ro` });
      let [ok1, a] = await luntil((x) => x.boot && x.state === 'connected' && x.frames > 20, 45);
      check('loader fetches the client page from the host and connects', ok1 && a.boot.updated === true && a.cached, JSON.stringify(a));
      await lw.loadFile(lf, { query: { again: '1' }, hash: `k=${cfg.key}&auto&ro` }); // a different URL forces a real reload
      let [ok2, b] = await luntil((x) => x.boot && x.state === 'connected' && x.frames > 20, 45);
      check('loader reuses the cached page when the host version is unchanged', ok2 && b.boot.updated === false, JSON.stringify(b));

      // The host was updated while this page is open: the page must notice and fetch the new one by itself.
      await ljs(`localStorage.setItem('mr_app_hash', 'stale')`);
      hostWin.webContents.send('displays-changed'); // any new offer carries the host's page version
      let [ok3, c] = await luntil((x) => x.boot && x.boot.updated === true && x.state === 'connected' && x.frames > 20, 60);
      check('an open client updates itself when the host version changes', ok3, JSON.stringify(c));
      lw.destroy();

      // New devices confirmed at the host (host.js ask, main.js 'gate'): a hello with the key waits until the
      // person allows it, or the client gives the authenticator app's code (opt-in). Pages of their own, like
      // a browser's (no device token); the host's card is pressed here as the person would.
      {
        const hjs = (code) => hostWin.webContents.executeJavaScript(code);
        await sleep(1500);
        const on = await hjs('hostApi.gate.set(true)');
        const page = async (k = cfg.key) => {
          const gw = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
          await gw.loadFile(file, { hash: `k=${k}&auto&ro` });
          const g = (code) => gw.webContents.executeJavaScript(code);
          const gstate = () => g(`({ state: window.__rd.state, frames: window.__rd.frames, connects: window.__rd.connects, asked: window.__rd.asked || null, denied: window.__rd.denied || '', askMsg: document.getElementById('askMsg').textContent })`);
          const guntil = async (pred, secs) => { let x; for (let i = 0; i < secs * 2; i++) { await sleep(500); try { x = await gstate(); if (pred(x)) return [true, x]; } catch {} } return [false, x]; };
          // Closed as a person closes it (연결 끊기, then the window): the host hears its channel close at once,
          // where a window destroyed with its connection up is noticed only when the connection times out.
          const close = async () => { try { await g('disconnect("")'); } catch {} await sleep(800); gw.destroy(); };
          return { gw, g, guntil, close };
        };
        // Until no session is on (the settings that loosen this refuse while one is).
        const idle = async () => { for (let i = 0; i < 40; i++) { if (!(await hjs('!!(typeof session !== "undefined" && session)'))) return true; await sleep(500); } return false; };
        const card = () => hjs(`({ shown: getComputedStyle(document.getElementById('ask')).display !== 'none', code: document.getElementById('askCode').textContent, who: document.getElementById('askWho').textContent })`);
        // Allowed at the host.
        const p1 = await page();
        let [asked1, a1] = await p1.guntil((x) => !!x.asked, 20);
        const c1 = await card();
        await hjs(`document.getElementById('askYes').click()`);
        let [in1, b1] = await p1.guntil((x) => x.state === 'connected' && x.frames > 10, 30);
        check('new devices confirmed: a connection with the key waits, the host shows its request with the number the client shows, and 허용 lets it in',
          on && on.ok && asked1 && c1.shown && c1.code === a1.asked.code && /^\d{4}$/.test(c1.code) && in1 && !(await card()).shown,
          `asked: ${asked1}, card ${JSON.stringify(c1)}, client ${JSON.stringify(a1 && a1.asked)}; then ${JSON.stringify(b1)}`);
        // The same page comes back (a renegotiation) without being asked again.
        const before1 = b1 ? b1.connects : 0;
        hostWin.webContents.send('displays-changed');
        let [again1, c1b] = await p1.guntil((x) => x.connects > before1 && x.state === 'connected', 30);
        check('new devices confirmed: the page allowed comes back without being asked again', again1 && !(await card()).shown, JSON.stringify(c1b));
        await p1.close();
        await idle();
        // Refused at the host.
        const p2 = await page();
        let [asked2] = await p2.guntil((x) => !!x.asked, 20);
        await hjs(`document.getElementById('askNo').click()`);
        let [out2, b2] = await p2.guntil((x) => x.denied === 'refused', 15);
        check('new devices confirmed: 거부 turns the client away and it is told so', asked2 && out2 && b2.state !== 'connected' && !(await card()).shown, JSON.stringify(b2));
        await p2.close();
        // The authenticator app, set up at the host (its code typed there), then a wrong code and a recovery code from a client.
        const T = require('./totp');
        await idle();
        await sleep(3500); // settings are refused for 3 s after a session ended (main.js remoteNow)
        const setup = await hjs('hostApi.otp.begin()');
        const secret = setup && setup.ok ? T.unbase32(setup.secret) : null;
        const conf = secret ? await hjs(`hostApi.otp.confirm(${JSON.stringify(T.code(secret))})`) : null;
        const p3 = await page();
        let [asked3, a3] = await p3.guntil((x) => x.asked && x.asked.otp, 20);
        await p3.g(`document.getElementById('askIn').value = '000000'; document.getElementById('askGo').click()`);
        let [wrong3, w3] = await p3.guntil((x) => /맞지 않습니다/.test(x.askMsg), 15);
        // The code of the next 30-s step (the setup used this one's; the host takes the step after too). First
        // sent by someone else who holds the key but not the page's own key: not taken, and not used up.
        const next = secret ? T.codeAt(secret, Math.floor(Date.now() / 30000) + 1) : '';
        const forged = await hjs(`(async () => { const p = pending; if (!p) return 'no request'; await onMessage({ t: 'otp', sid: p.m.sid, ts: Date.now(), code: ${JSON.stringify(next)}, sig: btoa('x'.repeat(64)) }, master); return pending === p ? 'still waiting' : 'taken'; })()`);
        await p3.g(`document.getElementById('askIn').value = ${JSON.stringify(next)}; document.getElementById('askGo').click()`);
        let [in3, b3] = await p3.guntil((x) => x.state === 'connected' && x.frames > 10, 30);
        check('new devices confirmed: with the authenticator app set up, a wrong code is refused, the right one unsigned by the page is not taken, and signed it lets the client in',
          !!conf && conf.ok && asked3 && a3.asked.otp && wrong3 && forged === 'still waiting' && in3,
          `setup ${!!(conf && conf.ok)}, asked with code ${!!(a3 && a3.asked && a3.asked.otp)}, wrong refused ${wrong3} (${w3 && w3.askMsg}), forged: ${forged}, in ${in3}`);
        // A hello with the key of a page allowed before but not signed by it (someone else who read that key on
        // the relay): neither let in as that page nor asked about; the session on stays as it is.
        const pkSeen = await p3.g('pageKey.pub');
        const forgedHello = await hjs(`(async () => { const s = session; await onMessage({ t: 'hello', sid: RD.rand(16), ts: Date.now(), mode: 'sharp', pk: ${JSON.stringify(pkSeen)}, hsig: btoa('x'.repeat(64)) }, master); await new Promise((r) => setTimeout(r, 1500)); return { same: session === s, asking: !!pending }; })()`);
        check('new devices confirmed: a hello in an allowed page\'s name but not signed by it gets nothing', forgedHello.same && !forgedHello.asking, JSON.stringify(forgedHello));
        // Loosening it is refused while someone is connected; done once nobody is.
        const offLive = await hjs('hostApi.gate.set(false)');
        await p3.close();
        await idle();
        const offJustAfter = await hjs('hostApi.gate.set(false)'); // a click a session's end lets go of lands here
        await sleep(3500);
        const off = await hjs('hostApi.gate.set(false)');
        const otpOff = await hjs('hostApi.otp.off()');
        check('new devices confirmed: turning it off is refused during a remote session and for a moment after, and works then',
          offLive && !offLive.ok && offLive.why === 'remote' && offJustAfter && !offJustAfter.ok && off && off.ok && !off.confirmNew && otpOff && otpOff.ok,
          JSON.stringify({ offLive: offLive && offLive.why, offJustAfter: offJustAfter && (offJustAfter.ok || offJustAfter.why), off: off && off.ok, otpOff: otpOff && otpOff.ok }));

        // One-time codes (host.js oneTime): a code the host window makes lets one page in, after 허용 here even
        // with "새 기기 확인" off, gives it no device token and no way past the key's gate; another page with
        // the same code is turned away; ending the code ends its session, and the code is no good afterwards.
        await idle();
        const devicesBefore = await hjs('hostApi.devices.list().then((r) => (r && r.list ? r.list : []).length)');
        await hjs('makeOneTimeCode()');
        const code = await hjs('oneTime ? oneTime.code : ""');
        const otShown = await hjs(`document.getElementById('otCode').textContent`);
        const q1 = await page(code.toLowerCase().replace(/(.{4})(?=.)/g, '$1 ')); // as typed by someone reading it out: lower case, spaces
        let [askedQ, aq] = await q1.guntil((x) => !!x.asked, 30);
        const cq = await card(), titleQ = await hjs(`document.getElementById('askTitle').textContent`);
        await hjs(`document.getElementById('askYes').click()`);
        let [inQ, bq] = await q1.guntil((x) => x.state === 'connected' && x.frames > 10, 30);
        const q2 = await page(code);
        let [usedQ, uq] = await q2.guntil((x) => x.denied === 'used', 25);
        await q2.close();
        const viaCode = await hjs('hostApi.accessLog().then((l) => (Array.isArray(l) ? l : []).filter((e) => e.via === "code").map((e) => e.ev).join(","))');
        await hjs('endOneTime("ended")');
        let [outQ, oq] = await q1.guntil((x) => x.state !== 'connected', 15);
        await q1.close();
        await idle();
        const q3 = await page(code);
        await sleep(9000);
        const s3 = await q3.g('({ state: window.__rd.state, asked: !!window.__rd.asked, connects: window.__rd.connects })');
        await q3.close();
        const devicesAfter = await hjs('hostApi.devices.list().then((r) => (r && r.list ? r.list : []).length)');
        check('one-time code: it waits for 허용 even with new devices off, lets one page in without a device token, turns a second away, ends with its session and is no good after',
          /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(otShown) && askedQ && cq.shown && cq.code === aq.asked.code && /1회용/.test(titleQ) && inQ && usedQ &&
          /approved/.test(viaCode) && outQ && !s3.asked && s3.state !== 'connected' && devicesAfter === devicesBefore,
          `shown ${otShown}; asked ${askedQ} (card ${JSON.stringify(cq)}, title "${titleQ}"); in ${inQ}; second page: ${uq && uq.denied}; access log (code): ${viaCode}; ended: ${outQ} (${oq && oq.state}); ` +
          `after: ${JSON.stringify(s3)}; devices ${devicesBefore} -> ${devicesAfter}`);
      }

      if (SHELL_CHECK) {
        // The client app: one call to spread() must put one fullscreen window on every screen, in order.
        const shell = require('../client/shell');
        const sw = new BrowserWindow({ width: 1280, height: 720, webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false, partition: 'shell-check' } });
        const st = shell.attach(sw, { trust: true }); // the page loaded as it is (no loader, nothing signed)
        const sjs = (code, gesture) => sw.webContents.executeJavaScript(code, !!gesture);
        await sw.loadFile(lf, { query: { app: '1' }, hash: `k=${cfg.key}&auto&ro` });
        let okc = false;
        for (let i = 0; i < 45 && !okc; i++) { await sleep(1000); try { okc = await sjs(`!!window.__rd && window.__rd.state === 'connected' && !!window.mrShell`); } catch {} }
        await sjs('spread()', true);
        await sleep(5000);
        const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
        const wins = [sw, ...st.children].filter((x) => !x.isDestroyed());
        const placed = wins.map((x) => ({ display: displays.findIndex((d) => d.id === screen.getDisplayMatching(x.getBounds()).id), fullscreen: x.isFullScreen() }));
        const views = await sjs(`liveViews().map((v) => ({ sel: v.sel, x: v.win.screenX, fs: !!v.win.document.fullscreenElement })).sort((a, b) => a.x - b.x)`);
        const mons = await sjs('monitors.length');
        const want = Math.min(mons, displays.length);
        const sels = views.map((v) => v.sel);
        check('client app: one click puts a fullscreen window on every screen, left to right',
          okc && wins.length === want && new Set(placed.map((x) => x.display)).size === want && placed.every((x) => x.fullscreen) && views.every((v) => v.fs) && sels.every((s, i) => i === 0 || s === sels[i - 1] + 1),
          `${wins.length} window(s) on displays ${JSON.stringify(placed.map((x) => x.display))}, fullscreen ${JSON.stringify(placed.map((x) => x.fullscreen))}, host monitors left to right ${JSON.stringify(sels)}`);
        for (const x of wins) if (!x.isDestroyed()) x.destroy();
      }
    }

    // The client app's check of a page (client/shell.js shell:pageCheck), in a window of this process: the
    // first word counts, once per load (the loader's, before the page runs); a page that then runs cannot
    // name another page's hash for its own code. The page this host serves passes with its key.
    {
      const shell = require('../client/shell');
      shell.setTestPageKey(pageKey());
      const pw = new BrowserWindow({ show: false, webPreferences: { preload: shell.PRELOAD, partition: 'page-check' } });
      shell.attach(pw);
      const ca = getClientApp(), good = { statement: ca.sig && ca.sig.statement, sig: ca.sig && ca.sig.sig, sha256: require('crypto').createHash('sha256').update(ca.html).digest('hex') };
      const ask = (o) => pw.webContents.executeJavaScript(`window.mrShell.pageCheck(${JSON.stringify(o)})`);
      await pw.loadURL('data:text/html,<p>page check</p>');
      const first = await ask({ statement: 'x', sig: 'y', sha256: '0'.repeat(64) }), second = await ask(good);
      await pw.loadURL('data:text/html,<p>page check, again</p>');
      const fresh = await ask(good), forged = await ask({ ...good, sha256: '1'.repeat(64) });
      await pw.loadURL('data:text/html,<p>page check, a third time</p>');
      const other = await ask({ ...good, sha256: '1'.repeat(64) });
      // Keyboard Lock without stuck modifier keys (client/keylock.js): the preload puts the wrapper into every page's
      // own world, whatever the host's version, and it stays when a page is written in place (the loader); a window
      // without the focus is not told which modifier keys are held. A file of its own: Keyboard Lock exists only in a
      // secure context, which a file:// page (the loader) is and a data: page is not.
      const kbFile = path.join(dir, 'keylock-check.html');
      fs.writeFileSync(kbFile, '<!doctype html><meta charset="utf-8"><p>keyboard lock check</p>');
      await pw.loadFile(kbFile);
      const kbSafe = await pw.webContents.executeJavaScript('!!(window.Keyboard && Keyboard.prototype.__mrSafe)');
      const kbKept = await pw.webContents.executeJavaScript(`new Promise((res) => { document.open(); document.write('<p>written in place, as the loader does</p>'); document.close(); setTimeout(() => res(!!(window.Keyboard && Keyboard.prototype.__mrSafe)), 50); })`);
      const kbHeld = await pw.webContents.executeJavaScript('window.mrShell.modsHeld()');
      pw.destroy();
      check('client app: every window gets the safe Keyboard Lock, kept when a page is written in place; an unfocused window is not told which keys are held',
        kbSafe && kbKept && kbHeld === null, JSON.stringify({ wrapper: kbSafe, afterDocumentOpen: kbKept, modsHeldUnfocused: kbHeld }));
      check('client app: a page is taken as signed only by the first check of its load, with its own hash',
        !!ca.sig && first === false && second === false && fresh === true && forged === true && other === false,
        JSON.stringify({ signedHere: !!ca.sig, first, secondWithAGoodOne: second, freshLoad: fresh, askedAgain: forged, otherPage: other }));
    }

    // Linux (and macOS): a signal asking the host to end is a quit on purpose, which the watchdog leaves down
    // (main.js, taken at ready: a handler set up earlier is never called, and Electron quits naming nobody; then the
    // watchdog had a host running again a minute later, 2026-11-17). A local trial host of its own, ended with
    // SIGTERM once it is up, must say so. (What the watchdog does with each kind: release/test-watchdog.js.)
    if (process.platform !== 'win32') {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const hostArgs = [global.__mrApp ? '--host' : __dirname, '--localtest', '--no-client', ...process.argv.filter((a) => a === '--no-sandbox' || a === '--disable-gpu')];
      const child = require('child_process').spawn(process.execPath, hostArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { out += b; });
      const ended = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
      const running = () => child.exitCode === null && child.signalCode === null; // a signal's end sets only signalCode
      for (let i = 0; i < 60 && !/시그널링 서버|signaling/i.test(out) && running(); i++) await sleep(500);
      await sleep(1500);
      const up = running();
      if (up) child.kill('SIGTERM');
      const how = await Promise.race([ended, sleep(15000).then(() => null)]);
      if (!how) { try { child.kill('SIGKILL'); } catch {} }
      const said = (/\[host\] quitting \(([^)]*)\)/.exec(out) || [])[1] || '';
      const pass = up && !!how && said === 'quit: SIGTERM';
      // Its last lines when it failed (the trial's output names no key).
      const tail = pass ? '' : '; its last lines: ' + out.trim().split('\n').slice(-3).map((l) => l.slice(0, 120)).join(' | ');
      check('a signal asking the host to end is a quit on purpose (the watchdog leaves it down)', pass,
        `up: ${up}; ended: ${how ? JSON.stringify(how) : 'no, killed'}; the host said: ${said || 'nothing'}${tail}`);
    }

    if (CLIENT_APP_CHECK) {
      // The client app as a program of its own, on a loader that knows this test's relay and key (view-only).
      // It counts as working when its measurements (sent to the host every 2 s, kept in the diagnostics
      // log) say it runs in the app's shell and shows the host's picture.
      const loader = path.join(dir, 'client-app-loader.html'), diag = path.join(app.getPath('userData'), 'diag.log');
      fs.writeFileSync(loader, buildLoaderHtml('k=' + cfg.key + '&auto&ro'));
      const from = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      // The installed app: one program, told which face. --trust-page-key: this host signs its page with a key of
      // its own (main.js pageSig), as a release does with the release key.
      const args = [global.__mrApp ? '--client' : path.join(__dirname, '..', 'client'), '--loader=' + loader, '--trust-page-key=' + pageKey(), ...process.argv.filter((a) => a === '--no-sandbox' || a === '--disable-gpu')];
      // This first one is not told the host's key: to it the page is one no release signed (see below).
      const child = require('child_process').spawn(process.execPath, args.filter((a) => !a.startsWith('--trust-page-key=')), { env, stdio: 'ignore' });
      let seen = null;
      for (let i = 0; i < 60 && !seen; i++) {
        await sleep(1000);
        let text = '';
        try { text = fs.readFileSync(diag, 'utf8').slice(from); } catch {}
        for (const line of text.split('\n')) {
          let e = null;
          try { e = JSON.parse(line); } catch {}
          if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen = e.client;
        }
      }
      check('client app (client/main.js, a program of its own) connects and shows the host\'s picture', !!seen,
        seen ? `fps ${JSON.stringify(seen.fps)}, decoder ${seen.dec}, windows ${JSON.stringify(seen.views)}` : 'no measurements from the app arrived');
      check('client app: a page signed by no key it trusts runs as in a browser (without the app\'s powers)', !!seen && seen.signed === false, seen ? `signed: ${seen.signed}` : 'no measurements');
      await quitGently(child); // before its profile (inside `dir`) is removed

      // The same through the app's list of PCs (--list): a profile of its own, and this test's key handed
      // to it as a PC to add and open (home-import.json). The loader in that PC's window has no key in it
      // and does not connect by itself: the app gives it the key. Passes when the app's measurements
      // arrive again, and its list then says what this host is, with the key in its file only encrypted.
      {
        const ldir = path.join(dir, 'list'), lloader = path.join(ldir, 'loader.html'), imp = path.join(ldir, 'home-import.json');
        fs.mkdirSync(ldir);
        fs.writeFileSync(lloader, buildLoaderHtml('ro'));
        fs.writeFileSync(imp, JSON.stringify([{ name: 'self-test', key: cfg.key, open: true }]));
        const from2 = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
        const child2 = require('child_process').spawn(process.execPath, [args[0], '--loader=' + lloader, '--list', ...args.slice(2)], { env, stdio: 'ignore' });
        let seen2 = null, entry = null, text = '';
        for (let i = 0; i < 60 && !(seen2 && entry && entry.lastAt); i++) {
          await sleep(1000);
          let log = '';
          try { log = fs.readFileSync(diag, 'utf8').slice(from2); } catch {}
          for (const line of log.split('\n')) {
            let e = null;
            try { e = JSON.parse(line); } catch {}
            if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen2 = e.client;
          }
          try { text = fs.readFileSync(path.join(ldir, 'client-app-profile', 'hosts.json'), 'utf8'); entry = JSON.parse(text).hosts[0] || null; } catch {}
        }
        const os0 = cfg.hostOs || {};
        check('client app: the page its host signed (this test\'s key standing in for a release\'s) is taken as signed', !!seen2 && seen2.signed === true, seen2 ? `signed: ${seen2.signed}` : 'no measurements');
        check('client app: a PC of its list opens in a window of its own with the key from the app; the list notes when and what the host is',
          !!seen2 && !!entry && entry.lastAt > 0 && entry.os === os0.os && entry.osName === os0.name && entry.pc === os0.pc && typeof entry.keyEnc === 'string' && entry.keyEnc.length > 0 && !text.includes(cfg.key) && !fs.existsSync(imp),
          seen2 ? `fps ${JSON.stringify(seen2.fps)}; entry ${entry ? JSON.stringify({ name: entry.name, os: entry.os, osName: entry.osName, pc: !!entry.pc, lastAt: entry.lastAt > 0, monitors: entry.monitors }) : 'none'}; key as text in the file: ${text.includes(cfg.key)}` : 'no measurements from the app arrived');

        // Devices (host/devices.js): connected with the key, the app was given a token of its own over that
        // connection, keeps it like the key, and lets the key go once the token has been seen to work.
        // The token is kept in tokens.json (by entry), and the key let go leaves 'none' in hosts.json.
        const prof = path.join(ldir, 'client-app-profile');
        const readEntry = () => {
          try {
            const t = fs.readFileSync(path.join(prof, 'hosts.json'), 'utf8'), e = JSON.parse(t).hosts[0] || null;
            let tt = '', d = null;
            try { tt = fs.readFileSync(path.join(prof, 'tokens.json'), 'utf8'); d = e ? (JSON.parse(tt).tokens || {})[e.id] || null : null; } catch {}
            return { text: t + tt, e, d };
          } catch { return { text: '', e: null, d: null }; }
        };
        let got = readEntry();
        for (let i = 0; i < 45 && !(got.e && got.d && got.e.keyEnc === 'none'); i++) { await sleep(1000); got = readEntry(); }
        const devList = devices.list(), secrets = await devices.secrets();
        const dev0 = devList[0], tok = secrets[0] ? secrets[0].secret : '';
        // The same token read back from devices.json by a store of its own (as the next start of the host
        // does), and the app's record of which token it keeps (its hash).
        const again = tok ? (await deviceStore().secrets())[0] : null;
        const fp = tok ? require('crypto').createHash('sha256').update('my-remote token\n' + tok).digest('hex').slice(0, 16) : '';
        check('devices: the app connected with the key is given a token of its own, keeps it encrypted, and lets go of the key once the token works',
          devList.length === 1 && !!got.e && !!got.d && got.d.id === dev0.id && got.d.fp === fp && got.e.keyEnc === 'none' && !!tok && !got.text.includes(tok) && !got.text.includes(cfg.key) && dev0.pc === os.hostname().slice(0, 60) && !!again && again.secret === tok,
          `host lists ${devList.length} device(s)${dev0 ? ` (${JSON.stringify({ pc: dev0.pc === os.hostname().slice(0, 60), osName: dev0.osName, app: dev0.app })})` : ''}; read back from devices.json: ${!!again && again.secret === tok}; app entry ${got.e ? JSON.stringify({ token: !!got.d, sameId: !!(got.d && dev0 && got.d.id === dev0.id), sameToken: !!(got.d && got.d.fp === fp), keyKept: got.e.keyEnc !== 'none' }) : 'none'}; token or key as text in the files: ${!!tok && got.text.includes(tok)}/${got.text.includes(cfg.key)}`);
        await quitGently(child2); // so that what it stored can be read by the next start (see quitGently)

        // Started again, the PC opens with its token: no key anywhere (the loader gets the token from the
        // app), on the token's own topics. The host notes the device and logs where it came from.
        const startList = () => require('child_process').spawn(process.execPath, [args[0], '--loader=' + lloader, '--list', '--open-all', ...args.slice(2)], { env, stdio: 'ignore' });
        const accessSince = (t0, f) => accessLog.read(100).filter((e) => e.t >= t0 && f(e));
        const t3 = Date.now(), from3 = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
        const child3 = startList();
        let seen3 = null;
        for (let i = 0; i < 60 && !seen3; i++) {
          await sleep(1000);
          let log = '';
          try { log = fs.readFileSync(diag, 'utf8').slice(from3); } catch {}
          for (const line of log.split('\n')) { let e = null; try { e = JSON.parse(line); } catch {} if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen3 = e.client; }
        }
        await sleep(1500); // the host notes the device once the connection is up
        const conn3 = accessSince(t3, (e) => e.ev === 'connect' && e.via === 'device' && e.dev === (dev0 && dev0.id));
        const dev3 = dev0 ? devices.get(dev0.id) : null;
        check('devices: started again, the app connects with its token alone, and the host logs the device and where it came from',
          !!seen3 && conn3.length >= 1 && !!dev3 && dev3.n >= 1 && dev3.last >= t3,
          `${seen3 ? 'picture shown' : 'no measurements from the app arrived'}; access log ${JSON.stringify(conn3.map((e) => ({ ev: e.ev, via: e.via, ip: !!e.ip, kind: e.kind })))}; device seen ${dev3 ? dev3.n : '-'} time(s)`);

        // Blocked at the host: the session under way ends, and the token no longer gets in (the host says so).
        const t4 = Date.now();
        devices.block(dev0 ? dev0.id : '', true);
        devicesChanged(true);
        let ended = [];
        for (let i = 0; i < 10 && !ended.length; i++) { await sleep(500); ended = accessSince(t4, (e) => e.ev === 'end' && e.via === 'device'); }
        await quitGently(child3);
        const t5 = Date.now();
        const child4 = startList();
        let denied = [];
        for (let i = 0; i < 40 && !denied.length; i++) { await sleep(1000); denied = accessSince(t5, (e) => e.ev === 'denied' && e.why === 'blocked'); }
        check('devices: a device blocked at the host is cut off at once and turned away when it comes again; the key was never needed for it',
          ended.length >= 1 && ended[0].why === '기기 차단' && denied.length >= 1 && accessSince(t5, (e) => e.ev === 'connect').length === 0,
          `session ended: ${ended.length ? ended[0].why : 'no'}; turned away: ${denied.length}; connected anyway: ${accessSince(t5, (e) => e.ev === 'connect').length}`);
        await quitGently(child4);

        // Removed at the host: its topic is not listened to any more, so the app hears nothing (and, with its
        // key let go, has nothing else to try: the person gives the key again to pair anew).
        devices.remove(dev0 ? dev0.id : '');
        devicesChanged(true);
        await sleep(1500);
        const t6 = Date.now();
        const child5 = startList();
        await sleep(20000); // the loader gives up after 15 s
        const heard = accessSince(t6, () => true);
        check('devices: a device removed at the host is not heard any more (no session, no answer)', devices.list().length === 0 && heard.length === 0, `access log since: ${JSON.stringify(heard.map((e) => e.ev))}`);
        await quitGently(child5);

        // A one-time code given to the app's "1회용 코드로 접속" (home.html; the app types it into the loader of a
        // window of its own, not in its list): the host asks, 허용 lets it in, the app shows the picture, no device.
        {
          const hjs = (code) => hostWin.webContents.executeJavaScript(code);
          await hjs('makeOneTimeCode()');
          const code = await hjs('oneTime ? oneTime.code : ""');
          const t7 = Date.now(), from7 = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
          const child6 = require('child_process').spawn(process.execPath, [args[0], '--loader=' + lloader, '--list', `--home-js=mrHome.oneTime(${JSON.stringify(code.replace(/(.{4})(?=.)/g, '$1-'))})`, ...args.slice(2)], { env, stdio: 'ignore' });
          let asked7 = false;
          for (let i = 0; i < 40 && !asked7; i++) { await sleep(1000); asked7 = await hjs('!!(pending && pending.route.kind === "code")'); }
          if (asked7) await hjs(`document.getElementById('askYes').click()`);
          let seen7 = null;
          for (let i = 0; i < 40 && !seen7; i++) {
            await sleep(1000);
            let log = '';
            try { log = fs.readFileSync(diag, 'utf8').slice(from7); } catch {}
            for (const line of log.split('\n')) { let e = null; try { e = JSON.parse(line); } catch {} if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen7 = e.client; }
          }
          const viaCode7 = accessSince(t7, (e) => e.via === 'code').map((e) => e.ev);
          const live7 = await hjs('!!(session && session.route.kind === "code" && session.connectedAt)');
          await hjs('endOneTime("ended")');
          await sleep(1000);
          check('one-time code in the client app ("1회용 코드로 접속"): the host asks, 허용 lets it in, the picture is shown, and no device is made',
            asked7 && !!seen7 && live7 && viaCode7.includes('approved') && devices.list().length === 0,
            `asked: ${asked7}; ${seen7 ? 'picture shown' : 'no measurements from the app arrived'}; live on the code: ${live7}; access log (code): ${viaCode7.join(',')}; devices: ${devices.list().length}`);
          await quitGently(child6);
        }
      }

      // Connections that come back on themselves (host/cycle.js). The client app names the host of its own PC in
      // its hello (--local-host=: a stand-in for that host's running.json), and this host reads the client app's
      // live.json of this PC (a test: client-live.json in its own profile). Three runs of the app on the key:
      //  1. its PC's host is another one (A), and this PC's client app controls a third (B): it connects, and its
      //     own live.json says it controls this host (the case of everyone who runs both faces);
      //  2. its PC's host is B, the PC this PC's client app controls: turned away ('loop');
      //  3. its PC's host is this one: turned away ('self').
      {
        const A = 'SelfTestPCA_' + require('crypto').randomBytes(6).toString('hex'), B = 'SelfTestPCB_' + require('crypto').randomBytes(6).toString('hex');
        const liveHere = path.join(app.getPath('userData'), 'client-live.json'), stand = path.join(dir, 'local-host.json');
        const appLive = path.join(dir, 'client-app-profile', 'live.json');
        fs.writeFileSync(liveHere, JSON.stringify({ pid: process.pid, at: Date.now(), hosts: [B] }));
        const keepFresh = setInterval(() => { try { fs.writeFileSync(liveHere, JSON.stringify({ pid: process.pid, at: Date.now(), hosts: [B] })); } catch {} }, 5000);
        const accessSince = (t0, f) => accessLog.read(100).filter((e) => e.t >= t0 && f(e));
        const runAs = (instance) => {
          fs.writeFileSync(stand, JSON.stringify({ pid: process.pid, instance }));
          return require('child_process').spawn(process.execPath, [...args, '--local-host=' + stand], { env, stdio: 'ignore' });
        };
        try {
          const t1 = Date.now(), from1 = fs.existsSync(diag) ? fs.statSync(diag).size : 0;
          const c1 = runAs(A);
          let seen = null, live = null;
          for (let i = 0; i < 45 && !(seen && live); i++) {
            await sleep(1000);
            let log = '';
            try { log = fs.readFileSync(diag, 'utf8').slice(from1); } catch {}
            for (const line of log.split('\n')) { let e = null; try { e = JSON.parse(line); } catch {} if (e && e.client && e.client.shell === true && Object.values(e.client.fps || {}).some((f) => f > 0)) seen = e.client; }
            try { live = JSON.parse(fs.readFileSync(appLive, 'utf8')); } catch { live = null; }
          }
          const liveOk = !!live && Array.isArray(live.hosts) && live.hosts.length === 1 && live.hosts[0] === cfg.instance && live.pid === c1.pid && Date.now() - live.at < 30000;
          await quitGently(c1);
          // Removed when its windows close (Windows' taskkill closes them); where the end comes as a signal the
          // file may stay, and then counts for nothing: its process is gone (cycle.js).
          let alive1 = false;
          try { process.kill(c1.pid, 0); alive1 = true; } catch (e) { alive1 = !!e && e.code === 'EPERM'; }
          const gone = !fs.existsSync(appLive) || (process.platform !== 'win32' && !alive1);
          check('connections back on themselves: a client app whose PC runs another host connects, and keeps the host it controls in its live.json (gone when it quits)',
            !!seen && liveOk && gone && accessSince(t1, (e) => e.ev === 'denied').length === 0,
            `${seen ? 'picture shown' : 'no measurements from the app arrived'}; live.json while connected: ${live ? JSON.stringify({ hosts: (live.hosts || []).map((h) => (h === cfg.instance ? 'this host' : 'other')), itsPid: live.pid === c1.pid, fresh: Date.now() - live.at < 30000 }) : 'none'}; after quitting: ${gone ? 'removed' : 'still there'}; refusals: ${accessSince(t1, (e) => e.ev === 'denied').length}`);

          const turnedAway = async (instance, why) => {
            const t0 = Date.now();
            const c = runAs(instance);
            let d = [];
            for (let i = 0; i < 40 && !d.length; i++) { await sleep(1000); d = accessSince(t0, (e) => e.ev === 'denied' && e.why === why); }
            await sleep(4000); // a page that tried again would be heard meanwhile
            const said = await hostWin.webContents.executeJavaScript(`cycleN.get(${JSON.stringify(why)}) || 0`);
            const conn = accessSince(t0, (e) => e.ev === 'connect' || e.ev === 'asked').length;
            await quitGently(c);
            return { d: d.length, said, conn };
          };
          const before = await hostWin.webContents.executeJavaScript('({ loop: cycleN.get("loop") || 0, self: cycleN.get("self") || 0 })');
          const loop = await turnedAway(B, 'loop'), self = await turnedAway(cfg.instance, 'self');
          check('connections back on themselves: the client app of the PC this PC\'s client app controls is turned away (loop), and so is one on this very PC (self), once, without asking',
            loop.d === 1 && loop.conn === 0 && loop.said - before.loop === 1 && self.d === 1 && self.conn === 0 && self.said - before.self === 1,
            `loop: logged ${loop.d}, hellos ${loop.said - before.loop}, connected or asked ${loop.conn}; self: logged ${self.d}, hellos ${self.said - before.self}, connected or asked ${self.conn}`);
        } finally {
          clearInterval(keepFresh);
          fs.rmSync(liveHere, { force: true });
        }
      }
    }
  } catch (e) {
    console.log('[selftest] aborted:', e.message);
    results.push(false);
  }
  const pass = results.every(Boolean);
  console.log(pass ? '[selftest] ALL PASS' : '[selftest] SOME FAILED');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(pass ? 0 : 1);
};
