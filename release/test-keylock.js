// Keyboard Lock without stuck modifier keys (client/keylock.js), in plain Node with a stand-in window: the real
// lock only while Ctrl, Alt and Meta are up, given up on blur, fullscreen's end, a modifier pressed while it was
// being taken, or the system saying one is held; listeners back after a document.open(); the page's copy the
// same text; no bare keyboard.lock() left in the page or the client app.
//   node release/test-keylock.js
'use strict';
const fs = require('fs');
const path = require('path');
const { safeKeyboardLock } = require('../client/keylock');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A window with listeners that a document.open() could take away (erase), and a Keyboard that records.
class Target {
  constructor() { this.l = new Map(); }
  addEventListener(t, f, cap) { const k = `${t}|${!!(cap === true || (cap && cap.capture))}`; if (!this.l.has(k)) this.l.set(k, new Set()); this.l.get(k).add(f); }
  removeEventListener(t, f, cap) { const s = this.l.get(`${t}|${!!(cap === true || (cap && cap.capture))}`); if (s) s.delete(f); }
  emit(type, props = {}) { const ev = { target: this, ctrlKey: false, altKey: false, metaKey: false, code: '', ...props, type }; for (const [k, s] of this.l) if (k.split('|')[0] === type) for (const f of [...s]) f(ev); }
  erase() { this.l.clear(); }
}
function fakeWindow(lockDelay = 0) {
  const calls = [];
  class Keyboard {
    lock(keys) { calls.push(keys === undefined ? 'lock' : 'lock ' + keys.join('+')); return lockDelay ? tick(lockDelay) : Promise.resolve(); }
    unlock() { calls.push('unlock'); }
  }
  const win = new Target(), doc = new Target();
  doc.fullscreenElement = {};
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  Object.assign(win, { Keyboard, navigator: { keyboard: new Keyboard() }, document: doc });
  return { win, doc, calls, kb: win.navigator.keyboard };
}

(async () => {
  {
    const { win, doc, calls, kb } = fakeWindow();
    ok('installed once (a second call leaves it as it is)', safeKeyboardLock(win) === true && safeKeyboardLock(win) === false && win.Keyboard.prototype.__mrSafe === true);
    // Ctrl+Alt+Enter: the page asks for the lock while both are held; nothing happens until both are up.
    await kb.lock();
    win.emit('keyup', { code: 'Enter', ctrlKey: true, altKey: true });
    win.emit('keyup', { code: 'AltLeft', ctrlKey: true });
    await tick();
    const held = calls.length;
    win.emit('keyup', { code: 'ControlLeft' });
    await tick();
    ok('Ctrl+Alt+Enter: no lock while Ctrl or Alt is held, the lock once both are up', held === 0 && calls.join() === 'lock', calls.join());
    // The focus goes and comes back with Alt held (Alt+Tab): given up at once, taken again only once it is up.
    win.emit('blur');
    win.emit('focus');
    win.emit('pointermove', { altKey: true });
    await tick();
    const afterBlur = calls.join();
    win.emit('keyup', { code: 'AltLeft' });
    await tick();
    ok('blur gives the lock up; back with a modifier held, it waits for it to be up', afterBlur === 'lock,unlock' && calls.join() === 'lock,unlock,lock', calls.join());
    // An element losing the focus inside the window is no blur of the window.
    win.emit('blur', { target: {} });
    ok('a blur inside the window keeps the lock', calls.join() === 'lock,unlock,lock');
    // Fullscreen ends: given up; back in fullscreen, taken at the next event with nothing held.
    doc.fullscreenElement = null;
    doc.emit('fullscreenchange');
    win.emit('pointermove');
    await tick();
    const outside = calls.join();
    doc.fullscreenElement = {};
    doc.emit('fullscreenchange');
    win.emit('pointermove');
    await tick();
    ok('fullscreen ends: given up and not taken outside it; back in it, taken again', outside === 'lock,unlock,lock,unlock' && calls.join() === 'lock,unlock,lock,unlock,lock', calls.join());
    // The page's unlock: given up, and no event takes it again.
    kb.unlock();
    win.emit('pointermove');
    await tick();
    ok('the page\'s unlock() gives it up for good', calls.join() === 'lock,unlock,lock,unlock,lock,unlock', calls.join());
    // The keys the page names are passed on.
    calls.length = 0;
    await kb.lock(['KeyW', 'Escape']);
    win.emit('keydown', { code: 'KeyA' });
    await tick();
    ok('the keys the page names go to the real lock', calls.join() === 'lock KeyW+Escape', calls.join());
    // A document.open() took the listeners away: the next lock() puts them back.
    kb.unlock();
    calls.length = 0;
    win.erase(); doc.erase();
    await kb.lock();
    win.emit('pointerdown');
    await tick();
    ok('after a document.open() took the listeners, lock() puts them back', calls.join() === 'lock', calls.join());
  }
  {
    // A modifier pressed while the lock was being taken may have reached the system first: given up, taken again
    // once it is up. Pressed after the lock settled, it is the lock's (the hook has its press and its release).
    const { win, calls, kb } = fakeWindow(40);
    safeKeyboardLock(win);
    await kb.lock();
    win.emit('pointermove');
    win.emit('keydown', { code: 'AltLeft', altKey: true });
    await tick(60);
    const raced = calls.join();
    win.emit('keyup', { code: 'AltLeft' });
    await tick(250);
    win.emit('keydown', { code: 'ControlLeft', ctrlKey: true });
    await tick(10);
    ok('a modifier pressed while the lock was taken gives it up; one pressed after it settled does not', raced === 'lock,unlock' && calls.join() === 'lock,unlock,lock', `${raced} -> ${calls.join()}`);
  }
  {
    // The client app can ask the system: nothing held -> at once, without waiting for an event.
    const { win, calls, kb } = fakeWindow();
    let answers = [false, false];
    safeKeyboardLock(win, () => Promise.resolve(answers.length ? answers.shift() : false));
    await kb.lock();
    await tick(5);
    ok('the system says nothing is held: locked at once', calls.join() === 'lock', calls.join());
    // Held (Ctrl+Alt+Enter still down): waits; and a modifier the system reports right after the lock gives it up.
    const b = fakeWindow();
    const said = [true, true];
    safeKeyboardLock(b.win, () => Promise.resolve(said.length ? said.shift() : false));
    await b.kb.lock();
    await tick(5);
    const waited = b.calls.join();
    b.win.emit('keyup', { code: 'ControlLeft' });
    await tick(5);
    ok('the system says one is held: no lock; the lock taken at an event is given up when the system still says so',
      waited === '' && b.calls.join() === 'lock,unlock', `${waited || 'none'} -> ${b.calls.join()}`);
    // Cannot tell (null): events decide.
    const c = fakeWindow();
    safeKeyboardLock(c.win, () => Promise.resolve(null));
    await c.kb.lock();
    await tick(5);
    const none = c.calls.join();
    c.win.emit('pointermove');
    await tick(5);
    ok('the system cannot tell: the next event with nothing held decides', none === '' && c.calls.join() === 'lock', c.calls.join());
  }
  {
    // One text: the page's copy is client/keylock.js's function, and nothing locks the keyboard without it.
    const root = path.join(__dirname, '..');
    const tpl = fs.readFileSync(path.join(root, 'host', 'client.template.html'), 'utf8').replace(/\r\n/g, '\n');
    const start = tpl.indexOf('function safeKeyboardLock(win, osHeld) {');
    const end = start < 0 ? -1 : tpl.indexOf('\n}\n', start);
    const pageCopy = start < 0 || end < 0 ? '' : tpl.slice(start, end + 2);
    const mine = safeKeyboardLock.toString().replace(/\r\n/g, '\n');
    ok('the client page holds the same function as client/keylock.js', pageCopy === mine, pageCopy ? `${pageCopy.length} and ${mine.length} characters` : 'not found in the page');
    const bare = [];
    for (const f of ['host/client.template.html', 'client/shell.js', 'client/preload.js', 'host/loader.template.html']) {
      const lines = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => { if (/keyboard\.lock\(/.test(l) && !/__mrSafe/.test(l)) bare.push(`${f}:${i + 1}`); });
    }
    ok('no keyboard.lock() without the wrapper in the page, the loader or the client app', bare.length === 0, bare.join(', '));
  }
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})();
