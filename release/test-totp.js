// The host's one-time codes (host/totp.js), without Electron: node release/test-totp.js
// Checked against RFC 6238's own test values (SHA-1) and RFC 4648's base32 examples.
'use strict';
const T = require('../host/totp');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };

// RFC 6238, appendix B: the secret "12345678901234567890", 8 digits, SHA-1.
const rfc = Buffer.from('12345678901234567890');
const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
const got = vectors.map(([t]) => T.code(rfc, t * 1000, 8));
check('the codes of RFC 6238\'s test values', got.every((c, i) => c === vectors[i][1]), got.join(' '));
check('six digits are the last six of them', T.code(rfc, 59000) === '287082' && T.code(rfc, 1111111109000) === '081804');

const b32 = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
check('base32 as RFC 4648 has it (no padding)', b32.every(([a, b]) => T.base32(Buffer.from(a)) === b && T.unbase32(b).toString() === a));
check('base32 read back ignores case, spaces and padding, and refuses what is none', T.unbase32('mzxw 6ytb oi======').toString() === 'foobar' && T.unbase32('MZ1!') === null);

const secret = T.newSecret(), key = T.unbase32(secret);
check('a new secret is 160 random bits in base32', /^[A-Z2-7]{32}$/.test(secret) && key.length === 20 && T.newSecret() !== secret);
const now = 1_800_000_000_000, step = Math.floor(now / 30000);
const c = T.code(key, now);
const v = T.verify(key, c, { now });
check('the code of now is taken, and says its step', v.ok && v.step === step);
check('so are the steps just before and after (a clock a little off), not two away',
  T.verify(key, T.code(key, now - 30000), { now }).ok && T.verify(key, T.code(key, now + 30000), { now }).ok && !T.verify(key, T.code(key, now - 60000), { now }).ok);
check('a step taken once does not count again', !T.verify(key, c, { now, lastStep: step }).ok && T.verify(key, T.code(key, now + 30000), { now, lastStep: step }).ok);
check('what is not six digits is refused', ['', '12345', '1234567', 'abcdef', null].every((x) => !T.verify(key, x, { now }).ok) && T.verify(key, c.slice(0, 3) + ' ' + c.slice(3), { now }).ok);

const u = T.uri({ secret, label: '김기우 PC' });
check('the address an authenticator app scans', u.startsWith('otpauth://totp/MyRemote:%EA%B9%80') && u.includes('secret=' + secret) && u.includes('&issuer=MyRemote') && u.includes('period=30') && !/\s/.test(u));
const QR = require('../host/qr');
const long = T.uri({ secret, label: '가'.repeat(40) });
let fits = true;
try { QR.encode(long); } catch { fits = false; }
check('a long name (Korean, 40 letters) is cut so that the address still fits a QR code', fits && long.includes('secret=' + secret) && Buffer.byteLength(long) <= 213, `${Buffer.byteLength(long)} bytes`);
check('no recovery codes: a code typed at a client is worth nothing a minute later', !('recoveryCodes' in T) && !('matchRecovery' in T));

console.log(failed ? `\n${failed} FAILED (of ${n})` : `\nALL PASS (${n})`);
process.exit(failed ? 1 : 0);
