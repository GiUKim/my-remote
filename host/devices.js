// The client apps this host has given a device token: a secret of their own, made here, with which each
// reaches this host without the access key (signal.js derives its keys and topics with RD.DEVICE). The
// app keeps only its token (the user's wish, 2026-11-16: "잃어버린 기기만 끊을 수 있습니다"), so a lost or
// stolen PC is blocked or removed here and its token no longer gets in, while the access key and every
// other device stay as they are.
//
// Kept in devices.json in the host's profile: what the app said it is (computer name, system, version),
// when it was added and last seen, from where, how often, whether it is blocked, and its token only as the
// operating system's store made it (Electron's safeStorage, as the access key in config.json). The same
// app pairing again (its own random `install` id: its list of PCs was removed and added again) replaces
// its entry and token, and stays blocked when it was.
//
// Electron-free, so that release/test-devices.js runs it under plain Node: the encryption comes in as
// `crypt` = { ready(): Promise<bool>, encrypt(text): Promise<base64>, decrypt(base64): Promise<text> }.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Each token is one more topic on the host's one subscription to the relay; ntfy.sh limits what a
// visitor may hold open, and a person has a few PCs.
const MAX = 30;
const validSecret = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k); // 32 bytes, base64url
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
const validInstall = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
// What an app says about itself and what a person types are shown as text; cut to a length and freed of
// control characters on the way in.
const clean = (s, max) => Array.from(String(s == null ? '' : s), (c) => { const n = c.codePointAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').trim().slice(0, max);
const OSES = new Set(['windows', 'linux', 'mac']);

// A read refused for a moment (a virus scanner holding the file) is tried again a few times; a file that
// still cannot be read is never written over: every app with a token in it would lose its way in (its key
// is gone), so the host listens on none of them until the file can be read again (tried every 10 s).
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function readText(file) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i < 4 && BUSY.has(e.code)) { pause(100); continue; }
      throw e;
    }
  }
}

function create({ file, crypt, now = () => Date.now() }) {
  let devices = []; // { id, secretEnc, name, pc, os, osName, app, install, added, last, lastIp, n, blocked }
  let loaded = false, note = '', unreadableAt = 0;
  const plain = new Map(); // id -> its token, once decrypted (asked for at every new subscription)

  function load() {
    loaded = true;
    devices = [];
    note = '';
    let text;
    try { text = readText(file); } catch { note = 'unreadable'; unreadableAt = now(); return; }
    if (text === null) return;
    try {
      const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (!j || !Array.isArray(j.devices)) throw new Error('no list');
      for (const d of j.devices) {
        if (!d || !validId(d.id) || typeof d.secretEnc !== 'string' || !d.secretEnc || devices.some((x) => x.id === d.id)) continue;
        devices.push({
          id: d.id, secretEnc: d.secretEnc, name: clean(d.name, 40), pc: clean(d.pc, 60), os: OSES.has(d.os) ? d.os : '', osName: clean(d.osName, 60),
          app: clean(d.app, 20), install: validInstall(d.install) ? d.install : '', added: Number(d.added) || 0, last: Number(d.last) || 0,
          lastIp: clean(d.lastIp, 64), n: Math.max(0, Number(d.n) | 0), blocked: d.blocked === true,
        });
      }
    } catch {
      // Not what this program wrote. It holds tokens, so it is kept under another name, once, and not written over.
      note = 'broken';
      try { fs.copyFileSync(file, file + '.bad-' + now(), fs.constants.COPYFILE_EXCL); } catch {}
    }
  }
  function save() {
    if (note === 'unreadable') throw new Error('unreadable'); // never over a file that could not be read
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, devices }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  // Read when first asked, and again while the file could not be read (at most every 10 s).
  const ensure = () => { if (!loaded || (note === 'unreadable' && now() - unreadableAt > 10000)) load(); };
  const find = (id) => { ensure(); return devices.find((d) => d.id === id) || null; };
  const writable = () => { ensure(); return note !== 'unreadable'; };
  // What the host's window shows: everything but the token.
  const pub = (d) => ({ id: d.id, name: d.name || d.pc || '', pc: d.pc, os: d.os, osName: d.osName, app: d.app, added: d.added, last: d.last, lastIp: d.lastIp, n: d.n, blocked: d.blocked });

  async function seal(secret) {
    if (!(await crypt.ready())) throw new Error('nostore');
    const enc = await crypt.encrypt(secret);
    if ((await crypt.decrypt(enc)) !== secret) throw new Error('nostore'); // never keep what cannot be read back
    return enc;
  }

  return {
    MAX,
    // 'broken' / 'unreadable' when the file could not be used (it is kept, see load), else ''.
    note() { ensure(); return note; },
    list() { ensure(); return devices.map(pub); },
    get(id) { const d = find(id); return d ? pub(d) : null; },
    // Every device's token, for the host's page to listen on its topic and read what it sends. A token
    // that cannot be decrypted here (another user's file) is left out: that device cannot get in.
    async secrets() {
      ensure();
      const out = [];
      for (const d of devices) {
        let s = plain.get(d.id);
        if (!s) { try { s = await crypt.decrypt(d.secretEnc); } catch { s = null; } if (validSecret(s)) plain.set(d.id, s); else continue; }
        out.push({ id: d.id, secret: s, name: d.name || d.pc || '', blocked: d.blocked });
      }
      return out;
    },
    // An app connected with the access key asks for a token of its own. -> { ok, id, secret, again } |
    // { ok: false, why: 'full' | 'nostore' | 'unreadable' }.
    async add(info = {}) {
      if (!writable()) return { ok: false, why: 'unreadable' };
      const install = validInstall(info.install) ? info.install : '';
      let d = install ? devices.find((x) => x.install === install) : null;
      if (!d && devices.length >= MAX) return { ok: false, why: 'full' };
      const secret = crypto.randomBytes(32).toString('base64url');
      let secretEnc;
      try { secretEnc = await seal(secret); } catch { return { ok: false, why: 'nostore' }; }
      if (!writable()) return { ok: false, why: 'unreadable' };
      const again = !!d && devices.includes(d);
      if (!again) {
        if (devices.length >= MAX) return { ok: false, why: 'full' }; // filled up while the token was being sealed
        let id;
        do { id = crypto.randomBytes(8).toString('hex'); } while (devices.some((x) => x.id === id));
        d = { id, name: '', added: now(), last: 0, lastIp: '', n: 0, blocked: false };
        devices.push(d);
      }
      Object.assign(d, { secretEnc, pc: clean(info.pc, 60), os: OSES.has(info.os) ? info.os : '', osName: clean(info.osName, 60), app: clean(info.app, 20), install });
      plain.set(d.id, secret);
      save();
      return { ok: true, id: d.id, secret, again };
    },
    // A connection with that token is up: when, from where.
    seen(id, { ip } = {}) {
      const d = find(id);
      if (!d || !writable()) return false;
      d.last = now();
      d.n += 1;
      if (ip) d.lastIp = clean(ip, 64);
      save();
      return true;
    },
    rename(id, name) { const d = find(id); if (!d || !writable()) return false; d.name = clean(name, 40); save(); return true; },
    block(id, on) { const d = find(id); if (!d || !writable()) return false; d.blocked = !!on; save(); return true; },
    remove(id) {
      const d = find(id);
      if (!d || !writable()) return false;
      devices = devices.filter((x) => x !== d);
      plain.delete(id);
      save();
      return true;
    },
    // Every token gone (a new access key was issued because the old one leaked: a device paired with it may be someone else's).
    clear() { if (!writable()) return 0; const n = devices.length; devices = []; plain.clear(); if (n) save(); return n; },
  };
}

module.exports = { create, validSecret, clean, MAX };
