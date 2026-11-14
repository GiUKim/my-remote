// Runs a test command in CI and turns each of its FAIL lines into a GitHub annotation (::error::), so a
// failure's reason shows on the run's page and through the API without the job's log (which only the
// repository's admins can download). The command's output is passed through unchanged; its exit code is
// this script's.
//   node release/ci-run.js <command> [args...]
'use strict';
const { spawn } = require('child_process');
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.log('usage: node release/ci-run.js <command> [args...]'); process.exit(2); }
const inCI = !!process.env.GITHUB_ACTIONS;
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C'); // a property (the title) also ends at : and ,
let failures = 0;
const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) });
const scan = (stream, out) => {
  let rest = '';
  stream.on('data', (d) => {
    out.write(d);
    const lines = (rest + d.toString('utf8')).split('\n');
    rest = lines.pop();
    for (const line of lines) {
      const m = /^(?:\[\w+\] )?(FAIL|SOME FAILED)\s+(.*)$/.exec(line.trim());
      if (m && inCI && failures++ < 20) console.log(`::error title=${escProp(args.join(' ').slice(0, 80) || cmd)}::${esc(m[2].slice(0, 900))}`);
    }
  });
};
scan(child.stdout, process.stdout);
scan(child.stderr, process.stderr);
child.on('error', (e) => { console.log(`::error::could not run ${cmd}: ${e.message}`); process.exit(1); });
child.on('close', (code) => process.exit(code == null ? 1 : code));
