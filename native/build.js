// Builds the native modules in this folder for Windows on a Linux machine and brings the result back.
//
//   node native/build.js user@host[:folder]
//
// The Linux machine needs the mingw-w64 cross-compiler (Ubuntu: `sudo apt install mingw-w64`); the
// sources go to <folder>/native there (default folder: my-remote-dev). Nothing else on that machine
// is touched. What comes back:
//   host/bin/<name>.dll        the modules the host and the client app load (COMMITTED below). They
//                              are committed, so that a host has them after a plain clone
//   host/bin/<name>.dll.json   what each was built from (the self-test compares it with the source)
//   tools/native/*.dll         the rest (the bench's probe); not committed
// The DLLs carry no build time and no symbols, so the same source and compiler give the same file.
// After a change in one of the committed sources, commit the source, its DLL and its record together.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const [target, dir = 'my-remote-dev'] = (process.argv[2] || '').split(':');
if (!target) { console.log('usage: node native/build.js user@host[:folder]'); process.exit(2); }
const here = __dirname, bin = path.join(here, '..', 'host', 'bin'), tools = path.join(here, '..', 'tools', 'native');
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.status !== 0) { console.log(`${cmd} failed (${r.status == null ? r.error : r.status})`); process.exit(1); }
  return r.stdout || '';
};
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

// One output per .cpp file: a DLL the host loads through koffi, or - for winassist.cpp - a standalone
// .exe (the LocalSystem service for the secure desktop; see native/winassist.cpp). Everything is linked
// in, so each needs nothing but Windows itself.
const CXX = 'x86_64-w64-mingw32-g++';
const COMMITTED = new Set(['capture.cpp', 'shellops.cpp', 'winassist.cpp']);
const EXES = new Set(['winassist.cpp']); // built as .exe (wmain), not a DLL
const LIBS = {
  'capture.cpp': '-ld3d11 -ldxgi -ldxguid -luuid',
  'capprobe.cpp': '-ld3d11 -ldxgi -ldxguid -luuid',
  'shellops.cpp': '-lole32 -loleaut32 -lshell32 -luuid',
  'winassist.cpp': '-lwtsapi32 -luserenv -ladvapi32 -lgdi32 -luser32',
};
const sources = fs.readdirSync(here).filter((f) => f.endsWith('.cpp'));
const out = (f) => f.replace(/\.cpp$/, EXES.has(f) ? '.exe' : '.dll');
const dll = out; // kept name for the record logic below
// The DLLs' flags exactly as before winassist.exe was added: their order changes the file (with -shared
// later, capture.dll came out 1.5 KB smaller), and a committed DLL must stay what its record says.
const flagsFor = (f) => (EXES.has(f)
  ? '-O2 -Wall -municode -static -s -fno-exceptions -fno-rtti -Wl,--no-insert-timestamp'
  : '-O2 -Wall -shared -static -s -fno-exceptions -fno-rtti -Wl,--no-insert-timestamp');
const command = (f) => `${CXX} ${flagsFor(f)} -o ${out(f)} ${f} ${LIBS[f] || ''}`.trim();
// Output into out/ (the command below gets `-o out/<file>`): GNU ld puts the output path into a DLL, so
// that path is part of a reproducible build. release/ci-native.js rebuilds the same way in CI.
run('ssh', [...ssh, target, `mkdir -p ${dir}/native/out`]);
run('scp', [...ssh, ...sources.map((f) => path.join(here, f)), `${target}:${dir}/native/`]);
run('ssh', [...ssh, target, `cd ${dir}/native && ` + sources.map((f) => command(f).replace(` -o ${out(f)} `, ` -o out/${out(f)} `)).join(' && ') + ' && ls -l out']);
const compiler = run('ssh', [...ssh, target, `${CXX} --version`]).split('\n')[0].trim();
for (const f of sources) {
  const to = COMMITTED.has(f) ? bin : tools;
  fs.mkdirSync(to, { recursive: true });
  run('scp', [...ssh, `${target}:${dir}/native/out/${dll(f)}`, to]);
  if (!COMMITTED.has(f)) continue;
  // The record the self-test checks: the source as it is here (line ends as LF) and the file built from it.
  const record = {
    source: 'native/' + f,
    sourceSha256: sha(fs.readFileSync(path.join(here, f), 'utf8').replace(/\r\n/g, '\n')),
    dllSha256: sha(fs.readFileSync(path.join(bin, dll(f)))),
    compiler,
    command: command(f),
  };
  fs.writeFileSync(path.join(bin, dll(f) + '.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`host/bin/${dll(f)}  sha256 ${record.dllSha256}`);
}
console.log(`compiler: ${compiler}`);
console.log('tools/native: ' + (fs.existsSync(tools) ? fs.readdirSync(tools).join(', ') : '-'));
