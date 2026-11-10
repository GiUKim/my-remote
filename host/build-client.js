// Builds the single-file client (signal.js inlined into client.template.html).
//   node build-client.js [signaling-server-url]   -> ../my-remote-client.html
// The output never contains an access key.
const fs = require('fs');
const path = require('path');

function build(server, preset = '') {
  const tpl = fs.readFileSync(path.join(__dirname, 'client.template.html'), 'utf8');
  const sig = fs.readFileSync(path.join(__dirname, 'signal.js'), 'utf8');
  return tpl.replace('/*__SIGNAL_JS__*/', () => sig).replace('__SERVER__', () => server).replace('__PRESET__', () => preset);
}
module.exports = { build };

if (require.main === module) {
  const out = path.join(__dirname, '..', 'my-remote-client.html');
  fs.writeFileSync(out, build(process.argv[2] || 'https://ntfy.sh'));
  console.log('wrote', out);
}
