// QR codes (ISO/IEC 18004), only what the host needs: an authenticator app's setup address (otpauth://,
// about 100 characters) shown in the host window to be scanned with a phone. Byte mode, error correction
// level M, versions 1 to 10 (up to 213 bytes). Written from the standard, no outside code.
//
//   encode(text) -> { size, dark(x, y) }   (throws when the text does not fit)
//   svg(text, { scale, margin }) -> an <svg> element's markup, light quiet zone included
//
// Shared by the host window (a script tag) and plain Node (release/test-qr.js).
(function (root) {
  'use strict';
  // Per version, level M: [total codewords, EC codewords per block, blocks of the first group, their data
  // codewords, blocks of the second group (one more data codeword each)].
  const TABLE_M = [null,
    [26, 10, 1, 16, 0], [44, 16, 1, 28, 0], [70, 26, 1, 44, 0], [100, 18, 2, 32, 0], [134, 24, 2, 43, 0],
    [172, 16, 4, 27, 0], [196, 18, 4, 31, 0], [242, 22, 2, 38, 2], [292, 22, 3, 36, 2], [346, 26, 4, 43, 1]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const LEVEL_M = 0; // the two format bits of level M

  // GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d).
  function gmul(a, b) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((b >>> i) & 1) * a; }
    return z & 0xff;
  }
  // The generator polynomial's coefficients for `n` error correction codewords (highest term left out).
  function generator(n) {
    let g = new Array(n).fill(0);
    g[n - 1] = 1;
    let root = 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) { g[j] = gmul(g[j], root); if (j + 1 < n) g[j] ^= g[j + 1]; }
      root = gmul(root, 2);
    }
    return g;
  }
  function ecBytes(data, n) {
    const g = generator(n), r = new Array(n).fill(0);
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      for (let i = 0; i < n; i++) r[i] ^= gmul(g[i], f);
    }
    return r;
  }

  const utf8 = (s) => (typeof TextEncoder !== 'undefined' ? Array.from(new TextEncoder().encode(s)) : Array.from(Buffer.from(s, 'utf8')));

  // The data codewords of `bytes` for that version: mode, count, the bytes, terminator, pad bytes.
  function dataCodewords(bytes, version) {
    const t = TABLE_M[version], cap = t[2] * t[3] + t[4] * (t[3] + 1);
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); // byte mode
    put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    if (bits.length > cap * 8) return null;
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0; out.length < cap; p++) out.push(p % 2 ? 0x11 : 0xec);
    return out;
  }
  // Data and error correction codewords of every block, interleaved.
  function codewords(data, version) {
    const [total, ecn, g1, d1, g2] = TABLE_M[version];
    const blocks = [];
    let k = 0;
    for (let i = 0; i < g1 + g2; i++) {
      const len = i < g1 ? d1 : d1 + 1;
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: ecBytes(d, ecn) });
    }
    const out = [];
    for (let i = 0; i < d1 + 1; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecn; i++) for (const b of blocks) out.push(b.e[i]);
    if (out.length !== total) throw new Error('qr: codeword count');
    return out;
  }

  // BCH codes of the format (15 bits: level, mask) and version (18 bits) information.
  function formatBits(mask) {
    const data = (LEVEL_M << 3) | mask;
    let r = data;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    return ((data << 10) | r) ^ 0x5412;
  }
  function versionBits(version) {
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    return (version << 12) | r;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  // The matrix of one version with one mask; m[y][x] true = dark.
  function build(cw, version, mask) {
    const size = 17 + 4 * version;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = dark; fixed[y][x] = true; } };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders with their separators
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); }
    }
    const al = ALIGN[version], last = al.length - 1;
    for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // under a finder
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Format information (both copies) and the dark module.
    const f = formatBits(mask), bit = (v, i) => ((v >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
    set(8, 7, bit(f, 6)); set(8, 8, bit(f, 7)); set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
    set(8, size - 8, true);
    if (version >= 7) {
      const v = versionBits(version);
      for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, bit(v, i)); set(b, a, bit(v, i)); }
    }
    // The codewords, two columns at a time from the right, upwards and downwards in turn, around column 6.
    let n = 0;
    const total = cw.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const up = ((right + 1) & 2) === 0;
      for (let k = 0; k < size; k++) {
        const y = up ? size - 1 - k : k;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (fixed[y][x]) continue;
          const dark = n < total ? ((cw[n >>> 3] >>> (7 - (n & 7))) & 1) === 1 : false;
          n++;
          m[y][x] = dark !== MASKS[mask](x, y);
        }
      }
    }
    return m;
  }

  // The standard's penalty of a matrix (runs, 2x2 blocks, finder-like patterns, balance): the lowest wins.
  function penalty(m) {
    const size = m.length;
    let p = 0, dark = 0;
    const line = (get) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
      for (let i = 0; i + 11 <= size; i++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => m[y][x]);
    for (let x = 0; x < size; x++) line((y) => m[y][x]);
    for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    for (const row of m) for (const c of row) if (c) dark++;
    p += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
    return p;
  }

  function encode(text) {
    const bytes = utf8(String(text));
    for (let version = 1; version <= 10; version++) {
      const data = dataCodewords(bytes, version);
      if (!data) continue;
      const cw = codewords(data, version);
      let best = null, score = Infinity;
      for (let mask = 0; mask < 8; mask++) { const m = build(cw, version, mask); const s = penalty(m); if (s < score) { score = s; best = m; } }
      return { size: best.length, version, dark: (x, y) => !!(best[y] && best[y][x]), matrix: best };
    }
    throw new Error('qr: the text is too long');
  }

  function svg(text, { scale = 5, margin = 4 } = {}) {
    const q = encode(text), n = q.size + 2 * margin;
    let d = '';
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  const api = { encode, svg, _test: { ecBytes, formatBits, versionBits, dataCodewords, codewords, generator } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
