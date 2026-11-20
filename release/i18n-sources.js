// The Korean texts each part of the app shows, read from the code itself: the source strings of the catalogs in
// host/i18n (see host/i18n.js). Used by release/test-i18n.js (every text has its translations, and the catalogs hold
// nothing else) and to list what a new text needs (node release/i18n-sources.js [surface]).
//
// Read: every string literal with Hangul in it (comments, regular expressions and the parts of a template inside
// ${} aside: those are code), and in HTML the elements marked data-i18n (their text), data-i18n-html (their markup,
// as the browser gives innerHTML, spaces collapsed) and data-i18n-title / -placeholder / -aria (the attribute).
// Reported as problems: a template literal with ${} and Hangul in its text (a sentence put together in code, which no
// translation can follow), and Hangul in markup that no data-i18n marks.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SURFACES = {
  host: { catalogs: ['host'], files: ['host/host.html', 'host/host.js', 'host/main.js'] },
  page: { catalogs: ['page', 'page-report'], files: ['host/client.template.html'] },
  client: { catalogs: ['client'], files: ['client/launcher.html', 'client/home.html', 'client/main.js', 'client/shell.js'] },
  loader: { catalogs: ['loader'], files: ['host/loader.template.html'] },
  // The web page on GitHub Pages: its catalog lives next to it (docs/site.json), not in the app.
  site: { catalogs: ['site'], dir: 'docs', files: ['docs/index.html'] },
};
// Keys used without being literals in the code (host.js whoText takes them out of a stored name), and literals that
// are only pieces of such a name.
const EXTRA = { host: ['키', '앱'] };
const IGNORE = { host: [' (키)', ' (앱)'] };
const HANGUL = /[가-힣ㄱ-ㆎ]/;

// ---- JavaScript: string literals -------------------------------------------------------------------------------
function jsStrings(src) {
  const out = [], problems = [];
  let i = 0, last = '';
  const word = () => { const m = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(Math.max(0, i - 12), i)); return m ? m[1] : ''; };
  const regexHere = () => !last || '(,=:[!&|?{};+-*%<>~^'.includes(last) || ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else'].includes(word());
  const unescape = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] != null ? { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] : e;
  });
  function quoted(q) {
    let j = i + 1, raw = '';
    while (j < src.length && src[j] !== q) { if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; } else raw += src[j++]; }
    i = j + 1;
    return unescape(raw);
  }
  // A template literal: its text, with each ${...} scanned as code (strings inside it count on their own).
  function template() {
    let j = i + 1, text = '', exprs = 0;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { text += src[j] + src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { i = j + 2; scan(true); j = i; text += '${}'; exprs++; continue; }
      text += src[j++];
    }
    i = j + 1;
    return { text: unescape(text), exprs };
  }
  function regex() {
    let j = i + 1, cls = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') break;
      j++;
    }
    j++;
    while (j < src.length && /[a-z]/i.test(src[j])) j++;
    i = j;
  }
  // Scans code from i; inside ${} (inner) it stops after the matching }.
  function scan(inner) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === '\'' || c === '"') { const v = quoted(c); if (HANGUL.test(v)) out.push(v); last = 'a'; continue; }
      if (c === '`') {
        const at = i, tpl = template();
        if (HANGUL.test(tpl.text)) {
          if (tpl.exprs) problems.push(`a template with \${} and Korean text: ${JSON.stringify(src.slice(at, Math.min(i, at + 120)))}`);
          else out.push(tpl.text);
        }
        last = 'a';
        continue;
      }
      if (c === '/' && regexHere()) { regex(); last = 'a'; continue; }
      if (inner) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { i++; return; } depth--; } }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  scan(false);
  return { strings: out, problems };
}

// ---- HTML: the marked elements, and the scripts in it ------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] != null ? ENT[e] : m));
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'col', 'area', 'base', 'embed', 'param', 'track']);
function htmlParts(src) {
  const strings = [], problems = [], scripts = [];
  // The scripts (their code is read as JavaScript), then the markup without them and without comments.
  let markup = src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, code) => { scripts.push(code); return ''; }).replace(/<!--[\s\S]*?-->/g, '');
  markup = markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? decode(m[2] != null ? m[2] : m[3]) : null; };
  const has = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag);
  // The element's inner markup from the end of its start tag: to its matching end tag.
  const inner = (from, name) => {
    const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
    re.lastIndex = from;
    let depth = 1, m;
    while ((m = re.exec(markup))) { if (m[1]) { if (--depth === 0) return { html: markup.slice(from, m.index), end: re.lastIndex }; } else depth++; }
    return { html: markup.slice(from), end: markup.length };
  };
  const covered = []; // [start, end) of marked text, and the marked attributes, left out of the check below
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  let m;
  while ((m = tagRe.exec(markup))) {
    const tag = m[0], name = m[1].toLowerCase();
    for (const [flag, a] of [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria', 'aria-label']]) {
      if (has(tag, flag)) { const v = attr(tag, a); if (v) strings.push(v); }
    }
    if (VOID.has(name)) continue;
    const text = has(tag, 'data-i18n'), html = has(tag, 'data-i18n-html');
    if (!text && !html) continue;
    const { html: body, end } = inner(tagRe.lastIndex, name);
    if (html) strings.push(body.trim().replace(/\s+/g, ' '));
    else strings.push(decode(body.replace(/<[^>]+>/g, '')).trim());
    covered.push([tagRe.lastIndex, end]);
  }
  // Hangul left in the markup: in text no data-i18n marks, or in an attribute no data-i18n-* marks.
  let rest = '';
  let at = 0;
  for (const [s, e] of covered.sort((a, b) => a[0] - b[0])) { if (s >= at) { rest += markup.slice(at, s); at = e; } }
  rest += markup.slice(at);
  rest = rest.replace(/<[^>]*>/g, (tag) => tag.replace(/\s(title|placeholder|aria-label)\s*=\s*("[^"]*"|'[^']*')/gi, (x, a) => (new RegExp(`\\sdata-i18n-${a === 'aria-label' ? 'aria' : a}(\\s|=|>|/)`, 'i').test(tag) ? '' : x)));
  for (const line of rest.split('\n')) if (HANGUL.test(line)) problems.push(`Korean in markup that nothing marks: ${JSON.stringify(line.trim().slice(0, 120))}`);
  for (const code of scripts) { const r = jsStrings(code); strings.push(...r.strings); problems.push(...r.problems); }
  return { strings, problems };
}

function readSurface(name) {
  const s = SURFACES[name], strings = new Set(EXTRA[name] || []), problems = [];
  for (const f of s.files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    const r = /\.html$/.test(f) ? htmlParts(src) : jsStrings(src);
    for (const v of r.strings) if (!(IGNORE[name] || []).includes(v)) strings.add(v);
    for (const p of r.problems) problems.push(`${f}: ${p}`);
  }
  return { strings, problems };
}
function catalog(name) {
  const out = {};
  for (const c of SURFACES[name].catalogs) {
    const file = SURFACES[name].dir ? path.join(ROOT, SURFACES[name].dir, c + '.json') : path.join(ROOT, 'host', 'i18n', c + '.json');
    if (fs.existsSync(file)) Object.assign(out, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return out;
}
module.exports = { SURFACES, readSurface, catalog, jsStrings, htmlParts, HANGUL };

if (require.main === module) {
  const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
  for (const name of Object.keys(SURFACES)) {
    if (only && only !== name) continue;
    const { strings, problems } = readSurface(name);
    const cat = catalog(name);
    const missing = [...strings].filter((s) => !cat[s]);
    console.log(`== ${name}: ${strings.size} texts, ${missing.length} not in the catalog, ${problems.length} problems`);
    for (const p of problems) console.log('  PROBLEM ' + p);
    if (process.argv.includes('--missing')) for (const s of missing) console.log('  ' + JSON.stringify(s));
  }
}
