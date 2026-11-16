// Builds the two client pages (signal.js is inlined into both).
//
//   build()        the full client page. The host serves this to loaders, so it is
//                  never handed out as a file and always matches the host's version.
//   buildLoader()  the small file a client PC keeps. It asks for the key, fetches
//                  the full page from the host and runs it.
//
//   node build-client.js [signaling-server-url]   -> ../my-remote-client.html (the loader)
// Neither output ever contains an access key.
const fs = require('fs');
const path = require('path');

// From the texts themselves: release/build.js builds the page from a commit's files, as a host will.
const fillText = (tpl, sig, server, preset = '') => tpl.replace('/*__SIGNAL_JS__*/', () => sig).replace('__SERVER__', () => server).replace('__PRESET__', () => preset);
function fill(template, server, preset) {
  return fillText(fs.readFileSync(path.join(__dirname, template), 'utf8'), fs.readFileSync(path.join(__dirname, 'signal.js'), 'utf8'), server, preset);
}
const build = (server, preset = '') => fill('client.template.html', server, preset);
const buildLoader = (server, preset = '') => fill('loader.template.html', server, preset);
// The relay a host uses unless its config names another (main.js DEFAULTS): the page a release signs is the
// one built for it (release/build.js; host/page.json in the bundle).
const DEFAULT_SERVER = 'https://ntfy.sh';
module.exports = { build, buildLoader, fillText, DEFAULT_SERVER };

if (require.main === module) {
  const out = path.join(__dirname, '..', 'my-remote-client.html');
  fs.writeFileSync(out, buildLoader(process.argv[2] || 'https://ntfy.sh'));
  console.log('wrote', out);
}
