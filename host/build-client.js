// Builds the two client pages (signal.js and i18n.js are inlined into both; the loader also carries the texts of
// both pages in every language, host/i18n/page*.json and loader.json, which it hands the page: see i18n.js).
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

// From the texts themselves: release/build.js builds the page from a commit's files, as a host will. `catalog` is the
// loader's (JSON text); the page has none (it must fit the loader's 'app' reply: its texts come from the loader and
// the host, see client.template.html).
// i18n.js goes in without its comment lines (only whole lines: nothing in a string is touched), which keeps the
// page further from the loader's limit. Here, in fillText, so that the host and release/build.js make the same page.
const bare = (js) => js.replace(/^[ \t]*\/\/.*\r?\n/gm, '');
const fillText = (tpl, sig, server, preset = '', i18n = '', catalog = '') => tpl
  .replace('/*__SIGNAL_JS__*/', () => sig)
  .replace('/*__I18N_JS__*/', () => bare(i18n))
  .replace('/*__I18N_CATALOG__*/null', () => catalog || 'null')
  .replace('__SERVER__', () => server)
  .replace('__PRESET__', () => preset);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// The catalogs, merged (host/i18n/<name>.json); a missing one counts as empty.
function catalogOf(names) {
  const out = {};
  for (const n of names) { try { Object.assign(out, JSON.parse(read(path.join('i18n', n + '.json')))); } catch {} }
  return out;
}
// As JSON inside a <script>: "<" escaped, so that no text in it can end the script.
const loaderCatalog = () => JSON.stringify({ page: catalogOf(['page', 'page-report']), loader: catalogOf(['loader']) }).replace(/</g, '\\u003c');
function fill(template, server, preset) {
  return fillText(read(template), read('signal.js'), server, preset, read('i18n.js'), template === 'loader.template.html' ? loaderCatalog() : '');
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
  // The web page on GitHub Pages (docs/index.html) uses the app's own translator and flag picker: a copy, which
  // release/ci-checks.js keeps equal to this one.
  const site = path.join(__dirname, '..', 'docs', 'i18n.js');
  fs.writeFileSync(site, read('i18n.js'));
  console.log('wrote', site);
}
