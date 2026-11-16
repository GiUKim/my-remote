// The PCs this app can connect to (the list in home.html): for each, the name the person gave it, what
// it said it is at its last connection (operating system, computer name), when that was, and its
// access key - or, once that host gave this app a token of its own (a "device", from 2026-11-16 on; see
// host/devices.js), that token instead: the key is let go as soon as the token has been seen to work, so
// that a lost PC can be cut off at the host without a new key for everyone. Kept in hosts.json in the
// app's profile, the tokens in tokens.json next to it (by entry; with `install`, this app's own random
// name, which the hosts are told when they give it a token: a host replaces the token of an app that
// pairs again instead of listing it twice). A version from before tokens, which the app goes back to when
// a newer one does not come up, rewrites hosts.json with only the fields it knows: tokens there would be
// lost, and an entry with no key would vanish. So tokens.json is a file it never touches, and a key let
// go leaves NO_KEY in `keyEnc`, which it keeps and cannot decrypt (it then asks for the key again).
// A key or token is in these files only as the operating system's store made it (Electron's safeStorage:
// DPAPI on Windows, the desktop's keyring on Linux, there only obscured without one), never as text, and
// no function here hands one to a page: only client/main.js asks, for the window it opens for that PC.
//
// Electron-free, so it runs under plain Node in release/test-hosts.js: the encryption comes in as
// `crypt` = { ready(): Promise<bool>, encrypt(text): Promise<base64>, decrypt(base64): Promise<text> }.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NO_KEY = 'none'; // the key was let go (see above); not base64 of anything a store makes
const validKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k); // 32 bytes, base64url, as the host makes them
// Tells two entries with the same key apart from two different ones without decrypting anything. The
// key is 256 random bits, so 64 bits of a hash of it say nothing about it.
const fingerprint = (key) => crypto.createHash('sha256').update('my-remote host\n' + key).digest('hex').slice(0, 16);
// What a host says about itself and what a person types are shown as text; they are cut to a length
// and freed of control characters here, once, on the way in.
const clean = (s, max) => Array.from(String(s == null ? '' : s), (c) => { const n = c.codePointAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').trim().slice(0, max);
const OSES = new Set(['windows', 'linux', 'mac']);
const validDevId = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
const validServer = (s) => typeof s === 'string' && s.length <= 200 && /^https?:\/\/[^\s"'<>]+$/.test(s);

function create({ file, crypt, now = () => Date.now() }) {
  const tokFile = path.join(path.dirname(file), 'tokens.json');
  let hosts = []; // { id, name, fp, keyEnc, addedAt, lastAt, os, osName, pc, monitors }
  let tokens = {}; // entry id -> { id, secretEnc, server }: that host's token for this app
  let install = ''; // this app's own name for the hosts (see above)
  let loaded = false, note = '';
  // A file that is not what this program wrote holds keys or tokens: it is kept under another name, once,
  // and not written over until something changes.
  const keepBroken = (f) => { try { fs.copyFileSync(f, f + '.bad-' + now(), fs.constants.COPYFILE_EXCL); } catch {} };
  const readJson = (f) => { const t = fs.readFileSync(f, 'utf8'); return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); };

  function load() {
    loaded = true;
    hosts = [];
    tokens = {};
    let j = null;
    try { j = readJson(file); if (!j || !Array.isArray(j.hosts)) throw new Error('no list'); } catch (e) {
      if (e.code === 'ENOENT') j = null; else if (e.code) note = 'unreadable'; else { note = 'broken'; keepBroken(file); }
      j = null;
    }
    for (const h of (j && j.hosts) || []) {
      if (!h || typeof h.id !== 'string' || !/^[0-9a-f]{12}$/.test(h.id) || typeof h.keyEnc !== 'string' || !h.keyEnc) continue;
      if (hosts.some((x) => x.id === h.id)) continue;
      hosts.push({
        id: h.id, name: clean(h.name, 40), fp: typeof h.fp === 'string' ? h.fp.slice(0, 16) : '', keyEnc: h.keyEnc,
        addedAt: Number(h.addedAt) || 0, lastAt: Number(h.lastAt) || 0,
        os: OSES.has(h.os) ? h.os : '', osName: clean(h.osName, 60), pc: clean(h.pc, 60), monitors: Math.max(0, Math.min(64, Number(h.monitors) | 0)),
      });
    }
    let t = null;
    try { t = readJson(tokFile); if (!t || typeof t !== 'object') throw new Error('not ours'); } catch (e) { if (e.code !== 'ENOENT' && !e.code) keepBroken(tokFile); t = null; }
    if (t && typeof t.install === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t.install)) install = t.install;
    for (const [hid, d] of Object.entries((t && t.tokens) || {})) {
      // Only for an entry that is there (an older version may have removed it meanwhile).
      if (hosts.some((h) => h.id === hid) && d && validDevId(d.id) && typeof d.secretEnc === 'string' && d.secretEnc && validServer(d.server)) tokens[hid] = { id: d.id, secretEnc: d.secretEnc, server: d.server };
    }
  }
  const write = (f, obj) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  const save = () => write(file, { v: 1, hosts });
  const saveTokens = () => write(tokFile, { v: 1, install: install || undefined, tokens });
  const find = (id) => { if (!loaded) load(); return hosts.find((h) => h.id === id) || null; };
  const hasKey = (h) => !!h.keyEnc && h.keyEnc !== NO_KEY;
  // What a page may know of an entry: everything but the key and the token. `paired`: it connects with a
  // token of its own; `hasKey`: the key is still kept (until the token has been seen to work).
  const pub = (h) => ({ id: h.id, name: h.name, pc: h.pc, os: h.os, osName: h.osName, monitors: h.monitors, addedAt: h.addedAt, lastAt: h.lastAt, paired: !!tokens[h.id], hasKey: hasKey(h) });

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
    // The host was given a new key (its "새 키 발급"), or forgot this app's token: the entry stays, with its
    // name and its history, and connects with the key again (and is given a new token then).
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
      if (tokens[id]) { delete tokens[id]; saveTokens(); }
      return { ok: true, id };
    },
    // This app's own name for the hosts, made once.
    install() {
      if (!loaded) load();
      if (!install) { install = crypto.randomBytes(16).toString('base64url'); saveTokens(); }
      return install;
    },
    // The host gave this app a token of its own: kept like the key, and used from now on.
    async setDevice(id, dev) {
      const h = find(id);
      if (!h || !dev || !validDevId(dev.id) || !validKey(dev.secret) || !validServer(dev.server)) return false;
      let secretEnc;
      try { secretEnc = await seal(dev.secret); } catch { return false; }
      if (!hosts.includes(h)) return false; // removed meanwhile
      tokens[id] = { id: dev.id, secretEnc, server: dev.server };
      saveTokens();
      return true;
    },
    hasDevice(id) { return !!(find(id) && tokens[id]); },
    // The token, for the window that connects to that PC. null when there is none or it cannot be read here.
    async device(id) {
      const h = find(id), d = h && tokens[id];
      if (!d) return null;
      try { const s = await crypt.decrypt(d.secretEnc); return validKey(s) ? { id: d.id, secret: s, server: d.server } : null; } catch { return null; }
    },
    // The token worked: the key is not needed any more and is let go (a lost PC then holds only its token,
    // which the host can block). `devId`: only for that token (a newer pairing may have replaced it).
    dropKey(id, devId) {
      const h = find(id), d = h && tokens[id];
      if (!d || !hasKey(h) || (devId && d.id !== devId)) return false;
      h.keyEnc = NO_KEY;
      save();
      return true;
    },
    remove(id) {
      const h = find(id);
      if (!h) return false;
      hosts = hosts.filter((x) => x !== h);
      save();
      if (tokens[id]) { delete tokens[id]; saveTokens(); }
      return true;
    },
    // The key itself, for the window that connects to that PC. null when it cannot be read (another
    // user's file, a keyring that is gone) or was let go: the entry is kept, the person can give the key again.
    async key(id) {
      const h = find(id);
      if (!h || !hasKey(h)) return null;
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
