// Builds the native modules in this folder for Windows on a Linux machine and brings the result back.
//
//   node native/build.js user@host[:folder]
//
// The Linux machine needs the mingw-w64 cross-compiler (Ubuntu: `sudo apt install mingw-w64`); the
// sources go to <folder>/native there (default folder: my-remote-dev) and the DLLs come back into
// tools/native here, which is not committed. Nothing else on that machine is touched.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [target, dir = 'my-remote-dev'] = (process.argv[2] || '').split(':');
if (!target) { console.log('usage: node native/build.js user@host[:folder]'); process.exit(2); }
const here = __dirname, out = path.join(here, '..', 'tools', 'native');
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.status !== 0) { console.log(`${cmd} failed (${r.status == null ? r.error : r.status})`); process.exit(1); }
};

// One DLL per .cpp file. Everything is linked in, so the DLL needs nothing but Windows itself.
const sources = fs.readdirSync(here).filter((f) => f.endsWith('.cpp'));
const flags = '-O2 -Wall -shared -static -fno-exceptions -fno-rtti';
const libs = '-ld3d11 -ldxgi -ldxguid -luuid';
run('ssh', [...ssh, target, `mkdir -p ${dir}/native/out`]);
run('scp', [...ssh, ...sources.map((f) => path.join(here, f)), `${target}:${dir}/native/`]);
run('ssh', [...ssh, target, `cd ${dir}/native && ` + sources.map((f) => `x86_64-w64-mingw32-g++ ${flags} -o out/${f.replace(/\.cpp$/, '.dll')} ${f} ${libs}`).join(' && ') + ' && ls -l out']);
fs.mkdirSync(out, { recursive: true });
run('scp', [...ssh, ...sources.map((f) => `${target}:${dir}/native/out/${f.replace(/\.cpp$/, '.dll')}`), out]);
console.log('built into ' + out + ': ' + fs.readdirSync(out).join(', '));
