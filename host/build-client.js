// Builds the two client pages (signal.js and i18n.js are inlined into both; the loader also carries the texts of
// both pages in every language, host/i18n/page*.json and loader.json, which it hands the page: see i18n.js).
//
//   build()        the full client page. The host serves this to loaders, so it is
//                  never handed out as a file and always matches the host's version.
//   buildLoader()  the small file a client PC keeps. It asks for the key, fetches
//                  the full page from the host and runs it.
//
//   node build-client.js [signaling-server-url]   -> ../pangmote-client.html (the loader)
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
// The client page's scripts without their whole-line // comments (2026-11-26: the page was at 36 of the 40 chunks a
// loader takes, and the comments are a fifth of it). Only lines that are nothing but a comment, found by reading the
// scripts the way JavaScript does (strings, template literals with ${} in them, regular expressions, block comments),
// so a line that starts with // inside a string or a template stays. Should the reading lose its way (a script ends
// inside a string, a regular expression runs over a line), the page goes as it is: never a changed text.
function stripComments(html) {
  const drop = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const a = m.index + m[0].indexOf('>') + 1, b = m.index + m[0].length - 9;
    let i = a, last = '';
    const stack = [];
    const regexHere = () => !last || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /^(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(last);
    while (i < b) {
      const c = html[i], d = html[i + 1];
      if (stack[stack.length - 1] === '`') {
        if (c === '\\') i += 2;
        else if (c === '`') { stack.pop(); i++; last = '`'; }
        else if (c === '$' && d === '{') { stack.push('${'); i += 2; last = '{'; }
        else i++;
        continue;
      }
      if (c === '/' && d === '/') {
        const nl = html.indexOf('\n', i), end = nl < 0 || nl > b ? b : nl;
        const from = html.lastIndexOf('\n', i - 1) + 1;
        if (/^[ \t]*$/.test(html.slice(from, i)) && nl >= 0 && nl < b) drop.push([from, nl + 1]);
        i = end;
      } else if (c === '/' && d === '*') {
        const e = html.indexOf('*/', i + 2);
        if (e < 0 || e > b) return html;
        i = e + 2;
      } else if (c === '"' || c === "'") {
        i++;
        while (i < b && html[i] !== c) { if (html[i] === '\n') return html; if (html[i] === '\\') i++; i++; }
        i++; last = 'str';
      } else if (c === '`') { stack.push('`'); i++; }
      else if (c === '{') { if (stack.length) stack.push('{'); i++; last = '{'; }
      else if (c === '}') { if (stack.length) stack.pop(); i++; last = '}'; }
      else if (c === '/' && regexHere()) {
        let cls = false;
        for (i++; i < b && (cls || html[i] !== '/'); i++) {
          if (html[i] === '\n') return html;
          if (html[i] === '\\') i++; else if (html[i] === '[') cls = true; else if (html[i] === ']') cls = false;
        }
        i++;
        while (/[a-z]/.test(html[i])) i++;
        last = 're';
      } else if (/\s/.test(c)) i++;
      else if (/[\w$.]/.test(c)) { let j = i; while (j < b && /[\w$.]/.test(html[j])) j++; last = html.slice(i, j); i = j; }
      else { last = c; i++; }
    }
    if (stack.length) return html;
  }
  let out = '', at = 0;
  for (const [from, to] of drop) { out += html.slice(at, from); at = to; }
  return out + html.slice(at);
}
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
const build = (server, preset = '') => stripComments(fill('client.template.html', server, preset));
const buildLoader = (server, preset = '') => fill('loader.template.html', server, preset);
// The relay a host uses unless its config names another (main.js DEFAULTS): the page a release signs is the
// one built for it (release/build.js; host/page.json in the bundle).
const DEFAULT_SERVER = 'https://ntfy.sh';
module.exports = { build, buildLoader, fillText, stripComments, DEFAULT_SERVER };

if (require.main === module) {
  const out = path.join(__dirname, '..', 'pangmote-client.html');
  fs.writeFileSync(out, buildLoader(process.argv[2] || 'https://ntfy.sh'));
  console.log('wrote', out);
  // The web page on GitHub Pages (docs/index.html) uses the app's own translator and flag picker: a copy, which
  // release/ci-checks.js keeps equal to this one.
  const site = path.join(__dirname, '..', 'docs', 'i18n.js');
  fs.writeFileSync(site, read('i18n.js'));
  console.log('wrote', site);
}
