// One-time codes from an authenticator app (RFC 6238: HMAC-SHA1, 6 digits, 30-s steps), for a host whose
// person turned them on (opt-in, the user's wish 2026-11-16): a new device can then be let in from afar
// with the code on the person's phone when nobody is at the host. Nothing here talks to any server: the
// phone and the host each compute the code from the shared secret and the time.
//
// No recovery codes (a review, 2026-11-16): a code typed at a client goes over the relay encrypted with the
// access key, so whoever holds the key reads it, and could even ask for it while posing as the host. A code
// of now is worth nothing a minute later; a recovery code would be worth as much a month later. A person
// who lost their phone allows the new device from a registered one (it sees the host's window), or at the
// host, and sets the app up again there.
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
// The address an authenticator app scans (Google's otpauth:// form, which they all read). The label (the
// computer's name) is cut so that the address fits a QR code (host/qr.js: 213 bytes; a long Korean name
// takes 9 bytes a letter once escaped).
function uri({ secret, label, issuer = 'Pangmote' }) {
  const enc = (s) => encodeURIComponent(String(s));
  let name = Array.from(String(label || 'PC'));
  while (name.length > 1 && enc(name.join('')).length > 60) name = name.slice(0, -1);
  return `otpauth://totp/${enc(issuer)}:${enc(name.join('') || 'PC')}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

module.exports = { base32, unbase32, code, codeAt, verify, newSecret, uri, STEP, DIGITS };
