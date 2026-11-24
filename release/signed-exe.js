// The Windows program (Pangmote.exe) as SignPath signed it (Authenticode, certificate of the SignPath
// Foundation; .github/workflows/sign.yml asks for it), checked before a package takes it in place of the
// unsigned one that release/package.js makes (Electron's electron.exe with its version resource rewritten,
// brandExe). The same Electron gives the same bytes, so one signed copy serves every release until Electron
// changes, and a package takes it only when it is exactly that program with a signature appended:
//   - the bytes before the signature are the unsigned program's, but for the two fields that signing
//     writes in the header (the PE checksum and the certificate table's entry) and at most 7 zero bytes
//     that align the table;
//   - the certificate table is the end of the file;
//   - Windows says that the signature is valid, by the expected signer and timestamped (so it stays valid
//     after the certificate expires): PowerShell's Get-AuthenticodeSignature, the system's own check.
//   node release/signed-exe.js <signed Pangmote.exe> <unsigned Pangmote.exe> [--signer=<name>]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SIGNER = 'SignPath Foundation'; // the certificate's subject (CN or O)

// Where the header fields are that signing changes. -> { checksum, sec, certAt, certSize } (byte offsets)
function peLayout(b) {
  if (b.length < 0x40 || b.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a PE file');
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 + 2 > b.length || b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const opt = pe + 24, magic = b.readUInt16LE(opt);
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1; // PE32+ / PE32
  if (dirs < 0 || dirs + 5 * 8 > b.length) throw new Error('not a PE file (optional header)');
  if (b.readUInt32LE(dirs - 4) < 5) throw new Error('the header has no certificate table entry');
  const sec = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY: a file offset and a size
  return { checksum: opt + 64, sec, certAt: b.readUInt32LE(sec), certSize: b.readUInt32LE(sec + 4) };
}

// -> '' when `signed` is `unsigned` with a signature appended (see the top), else why not.
function sameProgram(unsigned, signed) {
  let u, s;
  try { u = peLayout(unsigned); s = peLayout(signed); } catch (e) { return e.message; }
  if (u.certAt || u.certSize) return 'the unsigned program has a certificate table already';
  if (u.sec !== s.sec || u.checksum !== s.checksum) return 'the two headers are not laid out alike';
  if (!s.certAt || !s.certSize) return 'the signed program has no signature';
  if (s.certAt + s.certSize !== signed.length) return 'the signature is not the end of the file';
  if (s.certAt < unsigned.length || s.certAt - unsigned.length > 7) return 'what comes before the signature is not as long as the unsigned program';
  for (let i = unsigned.length; i < s.certAt; i++) if (signed[i] !== 0) return 'the bytes that align the signature are not zeros';
  const a = Buffer.from(unsigned), b = Buffer.from(signed.subarray(0, unsigned.length));
  for (const x of [a, b]) { x.fill(0, u.checksum, u.checksum + 4); x.fill(0, u.sec, u.sec + 8); }
  if (!a.equals(b)) {
    let i = 0;
    while (a[i] === b[i]) i++;
    return `the signed program differs from the unsigned one at byte ${i}`;
  }
  return '';
}

// Windows' verdict on the file's signature. -> { status, message, signer, thumbprint, timestamped }
function authenticode(file) {
  if (process.platform !== 'win32') throw new Error('only Windows can check an Authenticode signature');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = Get-AuthenticodeSignature -LiteralPath $env:MR_SIGNED_FILE; '
    + '[pscustomobject]@{ status = [string]$s.Status; message = [string]$s.StatusMessage; signer = [string]$s.SignerCertificate.Subject; '
    + 'thumbprint = [string]$s.SignerCertificate.Thumbprint; timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress';
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, MR_SIGNED_FILE: path.resolve(file) }, encoding: 'utf8', windowsHide: true });
  return JSON.parse(out.trim());
}

// The subject names the signer as its CN or O. -> true/false
function signedBy(subject, name) {
  return String(subject || '').split(/,\s*(?=[A-Za-z]+=)/).some((p) => {
    const m = /^(CN|O)=(.*)$/i.exec(p.trim());
    return !!m && m[2].replace(/^"|"$/g, '') === name;
  });
}

// The whole check. -> { ok, why, signer, thumbprint }
function check(signedFile, unsignedFile, { signer = SIGNER } = {}) {
  const why = sameProgram(fs.readFileSync(unsignedFile), fs.readFileSync(signedFile));
  if (why) return { ok: false, why };
  const v = authenticode(signedFile);
  if (v.status !== 'Valid') return { ok: false, why: `Windows says the signature is ${v.status}: ${v.message}` };
  if (!signedBy(v.signer, signer)) return { ok: false, why: `signed by "${v.signer}", not by ${signer}` };
  if (!v.timestamped) return { ok: false, why: 'the signature has no timestamp (it would stop being valid when the certificate expires)' };
  return { ok: true, why: '', signer: v.signer, thumbprint: v.thumbprint };
}

if (require.main === module) {
  const [signed, unsigned] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const opt = process.argv.find((a) => a.startsWith('--signer='));
  if (!signed || !unsigned) { console.error('usage: node release/signed-exe.js <signed exe> <unsigned exe> [--signer=<name>]'); process.exit(2); }
  try {
    const r = check(signed, unsigned, opt ? { signer: opt.slice(9) } : {});
    if (!r.ok) { console.error(`NOT the signed program: ${r.why}`); process.exit(1); }
    console.log(`SIGNED OK: the unsigned program with a valid, timestamped signature of ${r.signer} (${r.thumbprint})`);
  } catch (e) { console.error(`the signature could not be checked: ${e.message}`); process.exit(1); }
}

module.exports = { SIGNER, peLayout, sameProgram, authenticode, signedBy, check };
