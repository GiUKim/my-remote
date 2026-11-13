// The installed app's shell, part 2: finding and installing updates. Part of the shell, not of the
// code it runs, so that an update that turns out bad can never take away the means to replace it.
//
// The feed is a folder of plain files anywhere that serves them over https:
//   latest.json       the newest version's manifest (see core.js)
//   latest.json.sig   its signature
//   <bundle file>     that version's code, named in the manifest
// Nothing from the feed is believed: only a manifest signed by a trusted key counts, and a bundle only
// when it is exactly what such a manifest names.
//
// Two kinds of update:
//   optional  the person is told and decides (the host window and the client app ask)
//   required  installed without asking and the app restarted - when the release is marked critical, or
//             the running version is older than the release's `minimum`. The restart waits for a
//             moment that fits (the host: no remote session; canRestart()), but not for ever.
// A release that needs a newer shell than this one (a new Electron) cannot be installed this way; the
// person is told to install the new package.
'use strict';

const HOUR = 3600e3;
const DEFAULTS = { firstCheckMs: 20e3, everyMs: 6 * HOUR, retryMs: 30 * 60e3, restartWaitMs: 30 * 60e3, restartPollMs: 20e3, fetchTimeoutMs: 30e3, bundleTimeoutMs: 10 * 60e3 };

// deps: { core, root, base, keys, feed, running: { version, source }, fetch, log, restart(), timing }
function create(deps) {
  const { core, root, base, keys, running } = deps;
  const T = { ...DEFAULTS, ...(deps.timing || {}) };
  const log = deps.log || (() => {});
  const feed = typeof deps.feed === 'string' && /^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(deps.feed) ? deps.feed.replace(/\/*$/, '/') : '';
  let status = { state: feed ? 'idle' : 'off', running: running.version, source: running.source, available: null, error: '', checkedAt: 0, progress: 0 };
  let found = null; // { manifest, bytes, sig } of the update on offer
  let canRestart = () => true, busy = null, timer = null, stopped = false;
  const listeners = new Set();
  const set = (patch) => { status = { ...status, ...patch }; for (const fn of listeners) { try { fn(status); } catch (e) { log('update listener: ' + e.message); } } };

  // One file of the feed, at most maxBytes of it (read piece by piece: a feed that sends without end is cut off).
  async function get(name, timeoutMs, maxBytes, onProgress) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await deps.fetch(feed + name, { signal: ctl.signal, redirect: 'follow', cache: 'no-store' });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > maxBytes) throw new Error(`${name}: too large`);
      const chunks = [];
      let n = 0;
      for (const reader = res.body.getReader(); ;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > maxBytes) { ctl.abort(); throw new Error(`${name}: too large`); }
        chunks.push(Buffer.from(value));
        if (onProgress) onProgress(n);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? `${name}: timed out` : String((e && e.message) || e));
    } finally { clearTimeout(t); }
  }

  // Looks at the feed. -> the status. Never throws: what went wrong is in status.error.
  async function check() {
    if (!feed || stopped) return status;
    if (busy) return busy;
    busy = (async () => {
      if (status.state !== 'downloading' && status.state !== 'ready') set({ state: 'checking', error: '' });
      try {
        const [bytes, sig] = await Promise.all([get('latest.json', T.fetchTimeoutMs, 512 * 1024), get('latest.json.sig', T.fetchTimeoutMs, 4096)]);
        const m = core.verifyManifest(bytes, sig.toString('utf8'), keys);
        const st = core.readState(root);
        const newer = core.cmp(m.version, running.version) > 0;
        if (status.state === 'downloading' || status.state === 'ready') return status; // an install is under way or done
        if (!newer || st.bad[m.version]) {
          found = null;
          set({ state: 'idle', available: null, checkedAt: Date.now(), error: '', skipped: newer ? { version: m.version, why: st.bad[m.version] } : null });
          return status;
        }
        const required = m.critical === true || (m.minimum ? core.cmp(running.version, m.minimum) < 0 : false);
        const kind = m.needsBase > base ? 'package' : 'bundle';
        const pkg = m.packages && typeof m.packages === 'object' ? m.packages[`${process.platform}-${process.arch}`] : null;
        found = { manifest: m, bytes, sig: sig.toString('utf8') };
        set({
          state: 'available', checkedAt: Date.now(), error: '', skipped: null,
          available: { version: m.version, date: String(m.date || '').slice(0, 20), required, kind, notes: notesOf(m), size: m.bundle.size,
            package: kind === 'package' && pkg && core.safePath(pkg.file) ? { url: feed + pkg.file, file: pkg.file, size: Number(pkg.size) || 0 } : null },
        });
        if (required && kind === 'bundle') install().catch(() => {}); // not asked: see the top of this file
        return status;
      } catch (e) {
        if (status.state === 'checking') set({ state: status.available ? 'available' : 'idle', error: String(e.message || e).slice(0, 200), checkedAt: Date.now() });
        return status;
      } finally { busy = null; }
    })();
    return busy;
  }
  // The release notes as { ko: [...], en: [...] }, each line plain text of a sane length.
  function notesOf(m) {
    const out = {};
    for (const lang of ['ko', 'en']) {
      const list = m.notes && Array.isArray(m.notes[lang]) ? m.notes[lang] : [];
      out[lang] = list.slice(0, 20).map((s) => String(s).slice(0, 300));
    }
    return out;
  }

  // Fetches and installs the update on offer, then restarts (a required one: when canRestart() says so).
  let installing = null;
  function install() {
    if (installing) return installing;
    if (!found || status.state !== 'available' || status.available.kind !== 'bundle') return Promise.reject(new Error('no update to install'));
    const { manifest, bytes, sig } = found, required = status.available.required;
    installing = (async () => {
      set({ state: 'downloading', progress: 0, error: '' });
      try {
        let shown = 0;
        const bundle = await get(manifest.bundle.file, T.bundleTimeoutMs, manifest.bundle.size, (n) => {
          const p = Math.min(0.99, n / manifest.bundle.size);
          if (p - shown >= 0.05) { shown = p; set({ progress: p }); }
        });
        core.installVersion(root, manifest, bytes, sig, bundle);
        core.activate(root, manifest.version, running);
        set({ state: 'ready', progress: 1 });
        log(`update ${manifest.version} installed (${required ? 'required' : 'chosen'}); restarting ${required ? 'when it fits' : 'now'}`);
        if (required) await fits();
        if (!stopped) deps.restart();
      } catch (e) {
        log('update failed: ' + e.message);
        set({ state: 'available', progress: 0, error: String(e.message || e).slice(0, 200) });
        throw e;
      } finally { installing = null; }
    })();
    return installing;
  }
  // A required update restarts the app when the code it runs says the moment fits, at the latest after restartWaitMs.
  async function fits() {
    const until = Date.now() + T.restartWaitMs;
    for (;;) {
      let ok = true;
      try { ok = (await canRestart(status)) !== false; } catch {}
      if (ok || stopped || Date.now() >= until) return;
      await new Promise((r) => setTimeout(r, T.restartPollMs));
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (stopped || !feed) return;
    timer = setTimeout(async () => {
      await check();
      schedule(status.error ? T.retryMs : T.everyMs);
    }, ms);
    if (timer.unref) timer.unref();
  }
  return {
    status: () => status,
    check,
    install,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setCanRestart(fn) { canRestart = typeof fn === 'function' ? fn : () => true; },
    start() { schedule(T.firstCheckMs); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

module.exports = { create };
