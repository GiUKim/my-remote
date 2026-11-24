// The check of a signed MyRemote.exe (release/signed-exe.js) before a package takes it: the same program with
// only a signature appended, a valid and timestamped Authenticode signature, the expected signer. Plain Node.
// The byte rules run everywhere on a committed DLL with a made-up signature table; on Windows the whole check
// also runs on this Node's own node.exe, whose builds carry a real embedded signature (the OpenJS
// Foundation's): its signature taken off gives "the unsigned program", which must then pass, and fail when
// one byte of it is changed. Nothing is signed here and no certificate is needed.
//   node release/test-signed-exe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const se = require('./signed-exe');

let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (cond) passed++; else failed++; };
const info = (s) => console.log(`INFO  ${s}`);

// `b` with a made-up signature: zeros up to a multiple of 8, a WIN_CERTIFICATE-shaped table, the header's
// table entry and checksum written as signing writes them.
function fakeSign(b, { pad = 0, tail = 0, padByte = 0 } = {}) {
  const L = se.peLayout(b), at = Math.ceil(b.length / 8) * 8 + pad * 8;
  const table = Buffer.alloc(64, 7); table.writeUInt32LE(64, 0); table.writeUInt16LE(0x0200, 4); table.writeUInt16LE(0x0002, 6);
  const out = Buffer.concat([b, Buffer.alloc(at - b.length, padByte), table, Buffer.alloc(tail, 1)]);
  out.writeUInt32LE(at, L.sec); out.writeUInt32LE(table.length, L.sec + 4); out.writeUInt32LE(0x12345678, L.checksum);
  return out;
}

(async () => {
  const dll = fs.readFileSync(path.join(__dirname, '..', 'host', 'bin', 'capture.dll'));
  // An odd length, so that signing has to align the table (the DLL itself may happen to be aligned).
  const unsigned = dll.length % 8 ? dll : Buffer.concat([dll, Buffer.from([1, 2, 3])]);
  ok('a committed DLL reads as a PE file without a signature', (() => { const L = se.peLayout(unsigned); return L.certAt === 0 && L.certSize === 0; })());
  ok('the program with a signature appended is the same program', se.sameProgram(unsigned, fakeSign(unsigned)) === '');
  {
    const s = fakeSign(unsigned); const at = 0x400 + 17; s[at] ^= 1;
    const why = se.sameProgram(unsigned, s);
    ok('one byte changed anywhere else is caught, and where', why === `the signed program differs from the unsigned one at byte ${at}`, why);
  }
  ok('something after the signature is refused', /not the end of the file/.test(se.sameProgram(unsigned, fakeSign(unsigned, { tail: 1 }))));
  ok('more than the alignment before the signature is refused', /not as long/.test(se.sameProgram(unsigned, fakeSign(unsigned, { pad: 1 }))));
  ok('alignment bytes that are not zeros are refused', /not zeros/.test(se.sameProgram(unsigned, fakeSign(unsigned, { padByte: 9 }))));
  ok('a "signed" file without a signature is refused', /no signature/.test(se.sameProgram(unsigned, Buffer.concat([unsigned, Buffer.alloc(5)]))));
  ok('an unsigned file that has a signature already is refused', /certificate table already/.test(se.sameProgram(fakeSign(unsigned), fakeSign(fakeSign(unsigned)))));
  ok('a file that is no program is refused', se.sameProgram(Buffer.from('MZ not really'), unsigned) !== '' && se.sameProgram(unsigned, Buffer.alloc(200)) === 'not a PE file');

  const subject = 'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US';
  ok('the signer is read from the certificate\'s CN or O',
    se.signedBy(subject, 'SignPath Foundation') && se.signedBy('O=SignPath Foundation, C=US', 'SignPath Foundation') && se.signedBy('CN="SignPath Foundation"', 'SignPath Foundation'));
  ok('a name that only looks like the signer is not taken',
    !se.signedBy('CN=SignPath Foundation Ltd, O=Other', 'SignPath Foundation') && !se.signedBy('CN=Evil, OU=SignPath Foundation', 'SignPath Foundation') && !se.signedBy('', 'SignPath Foundation'));

  if (process.platform !== 'win32') info('the Authenticode part runs on Windows only (Get-AuthenticodeSignature)');
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-signcheck-'));
    try {
      const real = fs.readFileSync(process.execPath), L = se.peLayout(real), v = se.authenticode(process.execPath);
      if (!L.certAt || v.status !== 'Valid' || !v.timestamped) info(`this node.exe carries no valid, timestamped embedded signature (${v.status}): the real-signature checks are skipped`);
      else {
        // Take the signature off: what remains is the program as it was before it was signed (its checksum aside).
        const bare = Buffer.from(real.subarray(0, L.certAt)); bare.fill(0, L.sec, L.sec + 8);
        const fSigned = path.join(tmp, 'signed.exe'), fBare = path.join(tmp, 'unsigned.exe'), fBad = path.join(tmp, 'tampered.exe');
        fs.writeFileSync(fSigned, real); fs.writeFileSync(fBare, bare);
        const cn = /(?:^|,\s*)CN=([^,]+)/.exec(v.signer)[1];
        const r = se.check(fSigned, fBare, { signer: cn });
        ok('a real signed program passes: same program, valid, timestamped, by its signer', r.ok, r.ok ? `${cn}, Windows: Valid` : r.why);
        const other = se.check(fSigned, fBare);
        ok('the same file is refused when another signer is expected', !other.ok && /not by SignPath Foundation/.test(other.why), other.why);
        // A program changed after it was signed, given with the same change as "the unsigned program": the
        // byte rules cannot tell, the signature's hash must. (A byte changed inside the signature's own
        // certificates is no test: Windows builds the chain from its store and still said Valid.)
        const t = Buffer.from(real); t[0x400 + 17] ^= 1; fs.writeFileSync(fBad, t);
        const tBare = Buffer.from(t.subarray(0, L.certAt)); tBare.fill(0, L.sec, L.sec + 8);
        const fBadBare = path.join(tmp, 'tampered-unsigned.exe'); fs.writeFileSync(fBadBare, tBare);
        const bad = se.check(fBad, fBadBare, { signer: cn });
        ok('a program changed after it was signed is refused by Windows\' own check', !bad.ok && /^Windows says the signature is (?!Valid)/.test(bad.why), bad.why);
        const fake = path.join(tmp, 'fake.dll'), fakeBare = path.join(tmp, 'fake-unsigned.dll');
        fs.writeFileSync(fake, fakeSign(unsigned)); fs.writeFileSync(fakeBare, unsigned);
        const made = se.check(fake, fakeBare);
        ok('a made-up signature table is refused by Windows\' own check', !made.ok && /^Windows says the signature is (?!Valid)/.test(made.why), made.why);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS (${passed})`);
  process.exit(failed ? 1 : 0);
})();
