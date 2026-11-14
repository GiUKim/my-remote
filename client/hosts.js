// The PCs this app can connect to (the list in home.html): for each, the name the person gave it, what
// it said it is at its last connection (operating system, computer name), when that was, and its
// access key. Kept in hosts.json in the app's profile. A key is in that file only as the operating
// system's store made it (Electron's safeStorage: DPAPI on Windows, the desktop's keyring on Linux,
// there only obscured without one), never as text, and no function here hands a key to a page: only
// client/main.js asks for one, for the window it opens for that PC.
//
// Electron-free, so it runs under plain Node in release/test-hosts.js: the encryption comes in as
// `crypt` = { ready(): Promise<bool>, encrypt(text): Promise<base64>, decrypt(base64): Promise<text> }.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const validKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k); // 32 bytes, base64url, as the host makes them
// Tells two entries with the same key apart from two different ones without decrypting anything. The
// key is 256 random bits, so 64 bits of a hash of it say nothing about it.
const fingerprint = (key) => crypto.createHash('sha256').update('my-remote host\n' + key).digest('hex').slice(0, 16);
// What a host says about itself and what a person types are shown as text; they are cut to a length
// and freed of control characters here, once, on the way in.
const clean = (s, max) => Array.from(String(s == null ? '' : s), (c) => { const n = c.codePointAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').trim().slice(0, max);
const OSES = new Set(['windows', 'linux', 'mac']);

function create({ file, crypt, now = () => Date.now() }) {
  let hosts = []; // { id, name, fp, keyEnc, addedAt, lastAt, os, osName, pc, monitors }
  let loaded = false, note = '';

  function load() {
    loaded = true;
    hosts = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') note = 'unreadable'; return; }
    try {
      const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!j || !Array.isArray(j.hosts)) throw new Error('no list');
      for (const h of j.hosts) {
        if (!h || typeof h.id !== 'string' || !/^[0-9a-f]{12}$/.test(h.id) || typeof h.keyEnc !== 'string' || !h.keyEnc) continue;
        if (hosts.some((x) => x.id === h.id)) continue;
        hosts.push({
          id: h.id, name: clean(h.name, 40), fp: typeof h.fp === 'string' ? h.fp.slice(0, 16) : '', keyEnc: h.keyEnc,
          addedAt: Number(h.addedAt) || 0, lastAt: Number(h.lastAt) || 0,
          os: OSES.has(h.os) ? h.os : '', osName: clean(h.osName, 60), pc: clean(h.pc, 60), monitors: Math.max(0, Math.min(64, Number(h.monitors) | 0)),
        });
      }
    } catch {
      // Not what this program wrote. It holds keys, so it is kept under another name, once, and not written over.
      note = 'broken';
      try { fs.copyFileSync(file, file + '.bad-' + now(), fs.constants.COPYFILE_EXCL); } catch {}
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, hosts }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const find = (id) => { if (!loaded) load(); return hosts.find((h) => h.id === id) || null; };
  // What a page may know of an entry: everything but the key.
  const pub = (h) => ({ id: h.id, name: h.name, pc: h.pc, os: h.os, osName: h.osName, monitors: h.monitors, addedAt: h.addedAt, lastAt: h.lastAt });

  async function seal(key) {
    if (!(await crypt.ready())) throw new Error('nostore');
    const enc = await crypt.encrypt(key);
    if ((await crypt.decrypt(enc)) !== key) throw new Error('nostore'); // never keep what cannot be read back
    return enc;
  }

  return {
    validKey,
    // 'broken' / 'unreadable' when the file could not be used (it is kept, see load), else ''.
    note() { if (!loaded) load(); return note; },
    list() { if (!loaded) load(); return hosts.map(pub); },
    get(id) { const h = find(id); return h ? pub(h) : null; },
    // -> { ok: true, id } | { ok: false, why: 'badkey' | 'exists' (with id) | 'nostore' }
    async add({ key, name }) {
      if (!loaded) load();
      key = String(key || '').trim();
      if (!validKey(key)) return { ok: false, why: 'badkey' };
      const fp = fingerprint(key), same = hosts.find((h) => h.fp === fp);
      if (same) return { ok: false, why: 'exists', id: same.id };
      let keyEnc;
      try { keyEnc = await seal(key); } catch { return { ok: false, why: 'nostore' }; }
      let id;
      do { id = crypto.randomBytes(6).toString('hex'); } while (hosts.some((h) => h.id === id));
      hosts.push({ id, name: clean(name, 40), fp, keyEnc, addedAt: now(), lastAt: 0, os: '', osName: '', pc: '', monitors: 0 });
      save();
      return { ok: true, id };
    },
    rename(id, name) {
      const h = find(id);
      if (!h) return false;
      h.name = clean(name, 40);
      save();
      return true;
    },
    // The host was given a new key (its "새 키 발급"): the entry stays, with its name and its history.
    async setKey(id, key) {
      const h = find(id);
      if (!h) return { ok: false, why: 'gone' };
      key = String(key || '').trim();
      if (!validKey(key)) return { ok: false, why: 'badkey' };
      const fp = fingerprint(key), same = hosts.find((x) => x.fp === fp && x !== h);
      if (same) return { ok: false, why: 'exists', id: same.id };
      try { h.keyEnc = await seal(key); } catch { return { ok: false, why: 'nostore' }; }
      h.fp = fp;
      save();
      return { ok: true, id };
    },
    remove(id) {
      const h = find(id);
      if (!h) return false;
      hosts = hosts.filter((x) => x !== h);
      save();
      return true;
    },
    // The key itself, for the window that connects to that PC. null when it cannot be read (another
    // user's file, a keyring that is gone): the entry is kept, the person can give the key again.
    async key(id) {
      const h = find(id);
      if (!h) return null;
      try { const k = await crypt.decrypt(h.keyEnc); return validKey(k) ? k : null; } catch { return null; }
    },
    // A connection to that PC is up: when, and what the PC said it is (its page tells the app).
    seen(id, info, at) {
      const h = find(id);
      if (!h) return false;
      h.lastAt = Number(at) > 0 ? Number(at) : now();
      if (info && typeof info === 'object') {
        if (OSES.has(info.os)) h.os = info.os;
        if (info.name != null) h.osName = clean(info.name, 60);
        if (info.pc != null && clean(info.pc, 60)) h.pc = clean(info.pc, 60);
        if (Number(info.monitors) > 0) h.monitors = Math.min(64, Number(info.monitors) | 0);
      }
      save();
      return true;
    },
  };
}

module.exports = { create, validKey, fingerprint, clean };
