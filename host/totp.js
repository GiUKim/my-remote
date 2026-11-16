// One-time codes from an authenticator app (RFC 6238: HMAC-SHA1, 6 digits, 30-s steps), for a host whose
// person turned them on (opt-in, the user's wish 2026-11-16): a new device can then be let in from afar
// with the code on the person's phone when nobody is at the host. And recovery codes for a lost phone.
// Nothing here talks to any server: the phone and the host each compute the code from the shared secret
// and the time.
//
// Electron-free (release/test-totp.js runs it under plain Node).
'use strict';
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]*$/.test(clean)) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const STEP = 30, DIGITS = 6;
const stepAt = (ms) => Math.floor(ms / 1000 / STEP);
// The code of one 30-s step (RFC 4226's dynamic truncation).
function codeAt(secret, step, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
const code = (secret, ms = Date.now(), digits = DIGITS) => codeAt(secret, stepAt(ms), digits);

// A code typed in: this step's, or the one before or after (a phone's clock may be a little off). A step
// whose code was taken already does not count again (`lastStep`, kept by the caller), so a code seen over
// someone's shoulder or on its way is no use once it has been used. -> { ok, step }
function verify(secret, typed, { now = Date.now(), lastStep = -1, window = 1 } = {}) {
  const t = String(typed || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return { ok: false, step: -1 };
  const at = stepAt(now);
  for (let d = -window; d <= window; d++) {
    const s = at + d;
    if (s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(t))) return { ok: true, step: s };
  }
  return { ok: false, step: -1 };
}

// A new secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32 as authenticator apps take it.
const newSecret = () => base32(crypto.randomBytes(20));
// The address an authenticator app scans (Google's otpauth:// form, which they all read).
function uri({ secret, label, issuer = 'MyRemote' }) {
  const enc = (s) => encodeURIComponent(String(s));
  return `otpauth://totp/${enc(issuer)}:${enc(label || 'PC')}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// Recovery codes: ten of 10 characters (about 50 bits each), each good once. Kept only as SHA-256 hashes.
const RC = '23456789abcdefghjkmnpqrstuvwxyz'; // no 0/o, 1/l/i
function recoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    let s = '';
    for (const b of crypto.randomBytes(10)) s += RC[b % RC.length];
    codes.push(s.slice(0, 5) + '-' + s.slice(5));
  }
  return codes;
}
const normRecovery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (s) => crypto.createHash('sha256').update('my-remote recovery\n' + normRecovery(s)).digest('hex');
// -> the index of the hash it matches in `hashes`, or -1.
function matchRecovery(hashes, typed) {
  const n = normRecovery(typed);
  if (n.length !== 10) return -1;
  const h = hashRecovery(n);
  return (hashes || []).findIndex((x) => typeof x === 'string' && x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
}

module.exports = { base32, unbase32, code, codeAt, verify, newSecret, uri, recoveryCodes, hashRecovery, matchRecovery, STEP, DIGITS };
