// Keyboard Lock without stuck modifier keys (reported 2026-11-17, reproduced in the test VM; see CLAUDE.md
// "Keyboard Lock and modifier keys").
//
// Chromium's Keyboard Lock on Windows (ui/events/win/modifier_keyboard_hook_win.cc) swallows Ctrl, Alt and the
// Windows key, presses and releases, while its window is fullscreen and focused: also the release of a key the
// system saw pressed before the hook began, and taking the hook away later does not tell the system either.
// Locked while such a key was held - Ctrl+Alt+Enter, the page's own fullscreen shortcut; or the focus coming back
// to a locked window with one held, as Win+1 does - the system kept it pressed for good, in every program, after
// the window had gone: Esc did Alt+Esc (windows went to the back one by one), a click on the taskbar did
// Ctrl+click, letters did shortcuts, until each key was pressed again.
//
// So the real lock is taken only while nothing of that kind is held: at an event that shows Ctrl, Alt and Meta up
// (their releases have then reached the system), or at once where the app can ask the system (osHeld: a function
// returning a promise of true, false or null = cannot tell; the client app's mrShell.modsHeld). A modifier pressed
// while the lock was being taken (it may have reached the system before the hook) gives the lock up again, and so
// do losing the focus or fullscreen; the next event with nothing held takes it again. The page's lock() and
// unlock() keep their meaning.
//
// safeKeyboardLock(win, osHeld) wraps win.Keyboard.prototype.lock and unlock once (false when that was done
// before, or there is no Keyboard Lock). The client app installs it in every window it shows (client/preload.js,
// with the text from here: pages of any host version); the client page installs it itself where the app did not
// (a browser). client.template.html holds this same function: release/test-keylock.js checks the two texts match.
'use strict';

function safeKeyboardLock(win, osHeld) {
  const P = win.Keyboard && win.Keyboard.prototype;
  if (!P || typeof P.lock !== 'function' || P.__mrSafe) return false;
  const realLock = P.lock, realUnlock = P.unlock;
  const MOD = /^(Control|Alt|Meta|OS)/;
  const st = { want: false, keys: null, locked: false, n: 0, settle: 0, asking: false };
  const kb = () => win.navigator.keyboard;
  const ready = () => st.want && !st.locked && !!win.document.fullscreenElement && win.document.hasFocus();
  const drop = () => {
    if (!st.locked) return;
    st.locked = false;
    st.n++;
    try { realUnlock.call(kb()); } catch (e) { /* the window may be going */ }
  };
  const take = () => {
    const n = ++st.n;
    st.locked = true;
    st.settle = Infinity; // a modifier pressed until 150 ms after the lock is in place gives it up (see onEvent)
    realLock.apply(kb(), st.keys ? [st.keys] : []).then(() => {
      if (st.n !== n) return;
      st.settle = Date.now() + 150;
      if (osHeld) Promise.resolve(osHeld()).then((held) => { if (held === true && st.n === n) drop(); }, () => {});
    }, () => { if (st.n === n) { st.locked = false; st.n++; } });
  };
  const ask = () => {
    if (!osHeld || st.asking || !ready()) return;
    st.asking = true;
    Promise.resolve(osHeld()).then((held) => { st.asking = false; if (held === false && ready()) take(); }, () => { st.asking = false; });
  };
  const onEvent = (ev) => {
    if (st.locked && ev.type === 'keydown' && MOD.test(ev.code || '') && Date.now() < st.settle) { drop(); return; }
    if (ready() && !ev.ctrlKey && !ev.altKey && !ev.metaKey) take();
  };
  const onFocus = (ev) => { if (ev.target !== win) return; if (ev.type === 'blur') drop(); else ask(); };
  const onFull = () => { if (!win.document.fullscreenElement) drop(); else ask(); };
  const listen = () => {
    // Again at every lock(): document.open() (the loader writing the page in its place) takes the window's
    // listeners away. The same listener added twice is there once.
    for (const t of ['keydown', 'keyup', 'pointerdown', 'pointermove']) win.addEventListener(t, onEvent, true);
    win.addEventListener('blur', onFocus, true);
    win.addEventListener('focus', onFocus, true);
    win.document.addEventListener('fullscreenchange', onFull);
  };
  P.lock = function lock(keys) {
    const k = Array.isArray(keys) ? keys.map(String) : null;
    if (st.locked && String(k) !== String(st.keys)) drop();
    st.want = true;
    st.keys = k;
    listen();
    ask();
    return Promise.resolve();
  };
  P.unlock = function unlock() { st.want = false; drop(); };
  Object.defineProperty(P, '__mrSafe', { value: true });
  return true;
}

module.exports = { safeKeyboardLock };
