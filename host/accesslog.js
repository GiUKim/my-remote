// What came to this host, for the person at it (the host window's "접속 기록"): every connection, with the
// access key or with a device's token (devices.js), when, from which address, how long it lasted and how
// many files went each way; and what was turned away (a blocked device). JSON lines in access.log in the
// host's profile, on this PC only, never sent anywhere. Entries older than 90 days are dropped when the
// host starts, and the file is kept under 2 MB.
//
// Entry: { t (ms), ev: 'connect' | 'end' | 'denied' | 'paired' | 'asked' | 'approved', via: 'key' | 'device' | 'code' (a one-time code),
// dev?, name?, app?, ip?, kind? (the address's ICE candidate type), dur? (s), in?, out? (files), why?, how?
// (how a new device was allowed: 'host', 'otp', 'recovery', 'first', 'again'; a one-time code with 자동 허용 on: 'auto') }
//
// Electron-free (release/test-devices.js runs it under plain Node).
'use strict';
const fs = require('fs');
const path = require('path');

const EVENTS = new Set(['connect', 'end', 'denied', 'paired', 'asked', 'approved']);
const clean = (s, max) => Array.from(String(s == null ? '' : s), (c) => { const n = c.codePointAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').trim().slice(0, max);

// Only known fields, as plain values: the page that asks for an entry is the host's own, but what it
// passes on (a device's name, an address) came from the other side.
function entry(e, t) {
  if (!e || !EVENTS.has(e.ev)) return null;
  const o = { t, ev: e.ev, via: e.via === 'device' || e.via === 'code' ? e.via : 'key' };
  if (/^[0-9a-f]{16}$/.test(String(e.dev || ''))) o.dev = e.dev;
  for (const [k, max] of [['name', 60], ['app', 20], ['ip', 64], ['kind', 12], ['why', 40], ['how', 12]]) if (e[k] != null && clean(e[k], max)) o[k] = clean(e[k], max);
  for (const k of ['dur', 'in', 'out']) if (Number.isFinite(Number(e[k])) && Number(e[k]) >= 0) o[k] = Math.round(Number(e[k]));
  return o;
}

function create({ file, now = () => Date.now(), keepDays = 90, maxBytes = 2 * 1024 * 1024 }) {
  function lines() {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e && Number(e.t) > 0) out.push(e); } catch {}
    }
    return out;
  }
  let added = 0;
  const api = {
    add(e) {
      const o = entry(e, now());
      if (!o) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(o) + '\n', { mode: 0o600 });
        // Kept under its size while the host runs too (someone with a blocked token may keep trying).
        if (++added % 50 === 0 && fs.statSync(file).size > maxBytes) api.prune();
        return true;
      } catch { return false; }
    },
    // The newest first.
    read(limit = 200) { return lines().slice(-Math.max(1, limit)).reverse(); },
    // Entries older than keepDays go; so do the oldest while the file is larger than maxBytes.
    prune() {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return 0; }
      const all = lines(), from = now() - keepDays * 86400e3;
      let keep = all.filter((e) => e.t >= from);
      let text = keep.map((e) => JSON.stringify(e) + '\n').join('');
      while (Buffer.byteLength(text) > maxBytes && keep.length) { keep = keep.slice(Math.ceil(keep.length / 10)); text = keep.map((e) => JSON.stringify(e) + '\n').join(''); }
      if (keep.length === all.length && Buffer.byteLength(text) === size) return 0;
      const tmp = file + '.tmp';
      try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); } catch { return 0; }
      return all.length - keep.length;
    },
  };
  return api;
}

module.exports = { create, entry };
