// Rebuilds every committed native binary (host/bin/*.dll, *.exe) from its source with the command its
// record names, and compares the result with the committed file: proof that what users run as part of
// the app (winassist.exe even as LocalSystem) is exactly what the sources in native/ make. CI runs it on
// Ubuntu 22.04 with the distribution's mingw-w64, the same compiler as the build server's.
//   node release/ci-native.js
// A different compiler version (the record says which) gives different bytes: that is reported as such
// and fails only with --strict.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const strict = process.argv.includes('--strict');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let compiler = '';
try { compiler = execSync('x86_64-w64-mingw32-g++ --version', { encoding: 'utf8' }).split('\n')[0].trim(); } catch { console.log('FAIL  x86_64-w64-mingw32-g++ is not installed (apt install mingw-w64)'); process.exit(1); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pangmote-native-'));
let failed = 0;
for (const rec of fs.readdirSync(path.join(ROOT, 'host', 'bin')).filter((n) => /\.(dll|exe)\.json$/.test(n))) {
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'host', 'bin', rec), 'utf8'));
  const bin = rec.replace(/\.json$/, '');
  const src = path.basename(r.source);
  // Line ends make no difference to the bytes (checked); the output path does: GNU ld puts it into a
  // DLL (`-o out/x.dll` and `-o x.dll` give different files). native/build.js writes into out/, so this
  // does too, with the same substitution it makes in the recorded command.
  fs.writeFileSync(path.join(work, src), fs.readFileSync(path.join(ROOT, r.source), 'utf8').replace(/\r\n/g, '\n'));
  fs.mkdirSync(path.join(work, 'out'), { recursive: true });
  const cmd = r.command.replace(` -o ${bin} `, ` -o out/${bin} `);
  try { execSync(cmd, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { failed++; console.log(`FAIL  ${bin}: the recorded command failed\n      ${String(e.stderr || e.message).split('\n').slice(0, 4).join('\n      ')}`); continue; }
  const built = sha(fs.readFileSync(path.join(work, 'out', bin)));
  const same = built === r.dllSha256 && built === sha(fs.readFileSync(path.join(ROOT, 'host', 'bin', bin)));
  const sameCompiler = r.compiler === compiler;
  if (same) console.log(`PASS  ${bin} rebuilt from ${r.source} is byte for byte the committed file`);
  else if (!sameCompiler) { console.log(`${strict ? 'FAIL' : 'INFO'}  ${bin} differs, but the compiler does too (recorded "${r.compiler}", here "${compiler}")`); if (strict) failed++; }
  else { failed++; console.log(`FAIL  ${bin} rebuilt from ${r.source} with the same compiler is NOT the committed file (built ${built.slice(0, 16)}, committed ${String(r.dllSha256).slice(0, 16)})`); }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
