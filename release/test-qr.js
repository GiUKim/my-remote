// The host's QR codes (host/qr.js), without Electron: node release/test-qr.js
// Checked against values of the standard and its worked examples: the Reed-Solomon codewords of
// "HELLO WORLD" at 1-M, the format information of level M with each mask, the version information of
// versions 7 to 10, and the layout every code must have (finders, timing, the dark module, the format
// information read back the same from both copies).
'use strict';
const QR = require('../host/qr');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const T = QR._test;

// "HELLO WORLD" in alphanumeric mode at version 1-M: its 16 data codewords and their 10 EC codewords.
const hello = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const ec = T.ecBytes(hello, 10);
check('Reed-Solomon codewords of the standard\'s worked example', JSON.stringify(ec) === JSON.stringify([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]), JSON.stringify(ec));

const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
const fm = FORMAT_M.map((_, mask) => T.formatBits(mask).toString(2).padStart(15, '0'));
check('format information of level M with each mask', fm.every((s, i) => s === FORMAT_M[i]), fm.join(' '));

const VERSION = { 7: '000111110010010100', 8: '001000010110111100', 9: '001001101010011001', 10: '001010010011010011' };
const vb = Object.keys(VERSION).map((v) => T.versionBits(Number(v)).toString(2).padStart(18, '0'));
check('version information of versions 7 to 10', vb.every((s, i) => s === Object.values(VERSION)[i]), vb.join(' '));

const data = T.dataCodewords([...Buffer.from('hello')], 1);
check('data codewords: byte mode, count, data, terminator, pad bytes', JSON.stringify(data.slice(0, 8)) === JSON.stringify([0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0, 0xec]) && data.length === 16 && data[7] === 0xec && data[8] === 0x11, JSON.stringify(data));

// The layout of a code: what every reader looks for first.
function layout(q) {
  const s = q.size, d = q.dark;
  const finder = (cx, cy) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const k = Math.max(Math.abs(dx), Math.abs(dy)); if (d(cx + dx, cy + dy) !== (k !== 2)) return false; } return true; };
  let timing = true;
  for (let i = 8; i < s - 8; i++) if (d(i, 6) !== (i % 2 === 0) || d(6, i) !== (i % 2 === 0)) timing = false;
  // The format information, read from both copies, must be the same and one of level M's.
  let a = 0, b = 0;
  const bitsA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  bitsA.forEach(([x, y], i) => { if (d(x, y)) a |= 1 << i; });
  for (let i = 0; i < 8; i++) if (d(s - 1 - i, 8)) b |= 1 << i;
  for (let i = 8; i < 15; i++) if (d(8, s - 15 + i)) b |= 1 << i;
  const mask = FORMAT_M.indexOf(a.toString(2).padStart(15, '0'));
  return { finders: finder(3, 3) && finder(s - 4, 3) && finder(3, s - 4), timing, darkModule: d(8, s - 8), format: a === b && mask >= 0, mask };
}
for (const [text, version] of [['hello', 1], ['otpauth://totp/Pangmote:HOST-PC?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Pangmote', 6], ['x'.repeat(150), 8], ['가'.repeat(60), 9]]) {
  const q = QR.encode(text), l = layout(q);
  check(`a code of ${Buffer.byteLength(text)} bytes: version ${q.version}, size ${q.size}, finders, timing, dark module, format information`,
    q.version === version && q.size === 17 + 4 * version && l.finders && l.timing && l.darkModule && l.format, JSON.stringify(l));
}
let threw = false;
try { QR.encode('x'.repeat(214)); } catch { threw = true; }
check('a text too long for version 10 is refused', threw && QR.encode('x'.repeat(213)).version === 10);
const svg = QR.svg('hello');
check('as an SVG picture with a light margin', /^<svg [^>]*viewBox="0 0 29 29"/.test(svg) && svg.includes('fill="#fff"') && svg.includes('M4 4h1v1h-1z'));

console.log(failed ? `\n${failed} FAILED (of ${n})` : `\nALL PASS (${n})`);
process.exit(failed ? 1 : 0);
