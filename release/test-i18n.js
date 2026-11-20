// The translations and the code that uses them (2026-11-20), in plain Node:
//   node release/test-i18n.js
//  - every Korean text each part of the app shows has its entry in host/i18n (release/i18n-sources.js reads them
//    from the code), and the catalogs hold nothing else;
//  - every entry has all the languages (the diagnostics report's English only), no Hangul, the same {n} holes and
//    tags as its source, only the tags safeHtml lets through, plural forms where the language has them;
//  - a name quoted in a text ("키 복사", <b>모니터 배치</b>) reads in each language as that button or card itself;
//  - host/i18n.js (tags, fallbacks, plurals, escaping) and host/settings.js (the PC's one setting).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const I = require(path.join(ROOT, 'host', 'i18n.js'));
const S = require(path.join(ROOT, 'release', 'i18n-sources.js'));
const settings = require(path.join(ROOT, 'host', 'settings.js'));

let failed = 0;
const check = (ok, what, detail) => { if (ok) console.log('PASS  ' + what); else { failed++; console.log('FAIL  ' + what + (detail ? '\n      ' + String(detail).split('\n').slice(0, 12).join('\n      ') : '')); } };
const LANGS = I.CODES.filter((c) => c !== 'ko');
const PLURAL = { en: ['one', 'other'], es: ['one', 'other'], fr: ['one', 'other'], de: ['one', 'other'], 'pt-BR': ['one', 'other'], ru: ['one', 'few', 'many', 'other'] };
const ALLOWED_TAGS = /^<\/?(b|i|kbd|small|code)>$|^<br>$/;
const tags = (s) => (String(s).match(/<[^>]*>/g) || []).map((t) => t.toLowerCase()).sort();
const holes = (s) => [...new Set(String(s).match(/\{\d+\}/g) || [])].sort().join(' ');
const forms = (v) => (v && typeof v === 'object' ? Object.entries(v) : [['', v]]);
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'host', 'i18n', name + '.json'), 'utf8'));
const CATALOGS = { host: read('host'), page: read('page'), 'page-report': read('page-report'), client: read('client'), loader: read('loader') };

// ---- every text in the code has its entry, and nothing else is there ----------------------------------------------
for (const name of Object.keys(S.SURFACES)) {
  const { strings, problems } = S.readSurface(name);
  check(!problems.length, `${name}: no text put together in code or left unmarked in markup`, problems.join('\n'));
  const cat = S.catalog(name);
  const missing = [...strings].filter((s) => !cat[s]);
  check(!missing.length, `${name}: all ${strings.size} texts have an entry`, missing.map((s) => JSON.stringify(s)).join('\n'));
  const unused = Object.keys(cat).filter((k) => !strings.has(k));
  check(!unused.length, `${name}: the catalogs hold no text the code no longer has`, unused.map((s) => JSON.stringify(s)).join('\n'));
}

// ---- each entry ----------------------------------------------------------------------------------------------------
{
  const bad = [];
  for (const [cname, cat] of Object.entries(CATALOGS)) {
    const langs = cname === 'page-report' ? ['en'] : LANGS;
    for (const [src, e] of Object.entries(cat)) {
      if (S.HANGUL.test(src) === false) bad.push(`${cname}: a source without Korean: ${src}`);
      for (const t of tags(src)) if (!ALLOWED_TAGS.test(t)) bad.push(`${cname}: tag ${t} that safeHtml would show as text: ${src}`);
      for (const l of Object.keys(e)) if (!langs.includes(l)) bad.push(`${cname}: language ${l} not offered: ${src}`);
      for (const l of langs) {
        const v = e[l];
        if (v == null) { bad.push(`${cname}: no ${l}: ${src}`); continue; }
        if (typeof v === 'object') {
          if (!PLURAL[l]) bad.push(`${cname}: ${l} has plural forms, which it does not use: ${src}`);
          for (const c of PLURAL[l] || []) if (v[c] == null) bad.push(`${cname}: ${l} lacks the "${c}" form: ${src}`);
        }
        for (const [c, s] of forms(v)) {
          const at = `${cname} ${l}${c ? '.' + c : ''}`;
          if (typeof s !== 'string' || !s.trim()) { bad.push(`${at} empty: ${src}`); continue; }
          if (S.HANGUL.test(s)) bad.push(`${at} has Korean in it: ${src}`);
          if (holes(s) !== holes(src)) bad.push(`${at} has holes ${holes(s) || '-'} where the source has ${holes(src) || '-'}: ${src}`);
          if (tags(s).join() !== tags(src).join()) bad.push(`${at} has tags ${tags(s).join('') || '-'} where the source has ${tags(src).join('') || '-'}: ${src}`);
          if (s !== s.trim()) bad.push(`${at} begins or ends with a space: ${src}`);
          if (l === 'fr' && / [:;!?»]|« /.test(s.replace(/<[^>]*>/g, ''))) bad.push(`${at}: an ordinary space where French takes a no-break one: ${src}`);
        }
      }
    }
  }
  check(!bad.length, 'every entry: all languages, no Korean left, the same {n} holes and tags, plural forms complete', bad.join('\n'));
}

// ---- names quoted in a text are the names the buttons and cards show -----------------------------------------------
// The Korean quotes a button or card by its label ("키 복사", <b>모니터 배치</b>, '다시 시도'); the translation of the
// sentence must hold that label's own translation, or the person is sent to look for a button that does not exist.
{
  const label = (k, l) => {
    // The label's translations in the catalogs that have it (the same Korean may be a host and a page text).
    const out = [];
    for (const cat of Object.values(CATALOGS)) if (cat[k] && cat[k][l] != null) for (const [, s] of forms(cat[k][l])) out.push(s);
    return out;
  };
  const bad = [];
  let seen = 0;
  for (const [cname, cat] of Object.entries(CATALOGS)) {
    for (const [src, e] of Object.entries(cat)) {
      const quoted = [...src.matchAll(/"([^"]+)"|'([^']+)'|<b>([^<]+)<\/b>/g)].map((m) => m[1] || m[2] || m[3]);
      for (const q of quoted.flatMap((x) => x.split(' → '))) {
        for (const l of Object.keys(e)) {
          const names = label(q, l);
          if (!names.length) continue;
          seen++;
          const texts = forms(e[l]).map(([, s]) => s.toLowerCase());
          if (!texts.every((t) => names.some((n) => t.includes(n.toLowerCase())))) bad.push(`${cname} ${l}: "${q}" should read ${names.map((n) => JSON.stringify(n)).join(' or ')} in: ${src}`);
        }
      }
    }
  }
  check(seen > 100 && !bad.length, `a name quoted in a text reads as that button or card (${seen} quotes)`, bad.join('\n'));
}

// ---- host/i18n.js ----------------------------------------------------------------------------------------------------
{
  const n = I.normalize;
  check(n('en-US') === 'en' && n('ko-KR') === 'ko' && n('ja') === 'ja' && n('fr_CA') === 'fr' && n('DE-at') === 'de',
    'normalize: a language with a region is the language');
  check(n('zh') === 'zh-CN' && n('zh-Hans-SG') === 'zh-CN' && n('zh-Hant') === 'zh-TW' && n('zh-HK') === 'zh-TW' && n('zh-TW') === 'zh-TW' && n('zh-MO') === 'zh-TW',
    'normalize: Chinese by script and region (Traditional for Hant, Taiwan, Hong Kong, Macau)');
  check(n('pt-PT') === 'pt-BR' && n('in') === 'id' && n('nb-NO') === '' && n('ar') === '' && n('') === '' && n(null) === '',
    'normalize: Portuguese, the old code for Indonesian, and languages not offered');
  check(I.pick(['ar-EG', 'he', 'fr-CA', 'en']) === 'fr' && I.pick([]) === 'en' && I.pick(undefined) === 'en',
    'pick: the first offered of the preferred languages, else English');
  check(new Set(I.LANGS.map((x) => x.code)).size === I.LANGS.length && new Set(I.LANGS.map((x) => x.name)).size === I.LANGS.length && I.LANGS.every((x) => x.name && !/^\s|\s$/.test(x.name)),
    'the languages offered have distinct codes and names of their own');
  const cat = { '파일 {0}개': { en: { one: '{0} file', other: '{0} files' }, ru: { one: '{0} файл', few: '{0} файла', many: '{0} файлов', other: '{0} файла' }, ja: 'ファイル {0} 個' }, '닫기': { en: 'Close' }, '<b>위</b>는 {0}': { en: '<b>Top</b> is {0}' } };
  const en = I.translator('en', I.table(cat, 'en')), ru = I.translator('ru', I.table(cat, 'ru')), ja = I.translator('ja', I.table(cat, 'ja')), ko = I.translator('ko', I.table(cat, 'ko')), de = I.translator('de', I.table(cat, 'de'));
  check(en('파일 {0}개', 1) === '1 file' && en('파일 {0}개', 3) === '3 files' && en('파일 {0}개', 0) === '0 files',
    'plural forms by the first argument (English)');
  check(ru('파일 {0}개', 1) === '1 файл' && ru('파일 {0}개', 3) === '3 файла' && ru('파일 {0}개', 5) === '5 файлов' && ru('파일 {0}개', 21) === '21 файл' && ru('파일 {0}개', 'x') === 'x файла',
    'plural forms by the first argument (Russian: one, few, many; not a number: other)');
  check(ja('파일 {0}개', 2) === 'ファイル 2 個' && ko('파일 {0}개', 2) === '파일 2개' && ko('닫기') === '닫기',
    'Japanese has one form; Korean is the source');
  check(de('닫기') === 'Close' && de('없는 글') === '없는 글' && en('{0}와 {1}', 'a') === 'a와 {1}',
    'a language without the entry falls back to English, a text without one to the source; a hole without its argument stays');
  check(I.safeHtml('<b>A</b><br><kbd>Ctrl</kbd><script>x</script><b onclick="x">y</b><img src=x>&') === '<b>A</b><br><kbd>Ctrl</kbd>&lt;script&gt;x&lt;/script&gt;&lt;b onclick=&quot;x&quot;&gt;y</b>&lt;img src=x&gt;&amp;',
    'safeHtml lets bare b/br/kbd through and escapes everything else');
  const el = { innerHTML: '' };
  I.withName(el, '<b>Top</b> {0}', '<img src=x onerror=alert(1)>');
  check(el.innerHTML === '<b>Top</b> <b>&lt;img src=x onerror=alert(1)&gt;</b>', 'withName puts the name in bold, as text');
  check(/:lang\(ja\)[^}]*Yu Gothic/.test(I.FONT_CSS) && /:lang\(zh-CN\)[^}]*YaHei/.test(I.FONT_CSS) && /:lang\(zh-TW\)[^}]*JhengHei/.test(I.FONT_CSS) && /:not\(:lang\(ko\)\)/.test(I.FONT_CSS),
    'Japanese and Chinese text get fonts of their own (not the Korean font\'s Han shapes)');
}

// ---- the loader carries the page's texts -------------------------------------------------------------------------------
{
  const b = require(path.join(ROOT, 'host', 'build-client.js'));
  const loader = b.buildLoader('https://relay.invalid');
  const m = /const CATALOG = (\{[\s\S]*?\}) \|\| \{ page: null/.exec(loader);
  let ok = false, detail = 'no catalog in the loader';
  if (m) {
    try {
      const c = JSON.parse(m[1]);
      const page = { ...CATALOGS.page, ...CATALOGS['page-report'] };
      ok = Object.keys(c.page).length === Object.keys(page).length && Object.keys(c.loader).length === Object.keys(CATALOGS.loader).length && !/<\/script/i.test(m[1]);
      detail = `page ${Object.keys(c.page).length}/${Object.keys(page).length}, loader ${Object.keys(c.loader).length}/${Object.keys(CATALOGS.loader).length}`;
    } catch (e) { detail = e.message; }
  }
  check(ok, 'the loader carries the page\'s and its own texts, and nothing in them can end its script', detail);
  const page = b.build('https://relay.invalid');
  const probe = ['모니터 배치', '연결 끊기', '진단'].flatMap((k) => LANGS.map((l) => CATALOGS.page[k][l])).filter((s) => !/^[\x20-\x7e]+$/.test(s));
  check(/MRI18N/.test(page) && probe.length > 10 && !probe.some((s) => page.includes(s)), 'the page carries the translator but no catalog (its size is the loader\'s reply)');
}

// ---- host/settings.js ------------------------------------------------------------------------------------------------
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-i18n-'));
  try {
    const file = path.join(dir, 'sub', 'settings.json');
    const s = settings.create(file);
    check(JSON.stringify(s.get()) === '{}', 'settings: no file reads as nothing set');
    s.set({ lang: 'ja' });
    check(s.get().lang === 'ja' && JSON.parse(fs.readFileSync(file, 'utf8')).lang === 'ja' && !fs.readdirSync(path.dirname(file)).some((f) => f !== 'settings.json'),
      'settings: written (folder made, no temporary file left)');
    s.set({ other: 1 });
    check(s.get().lang === 'ja' && s.get().other === 1, 'settings: a change keeps the rest');
    fs.writeFileSync(file, '{ broken');
    check(JSON.stringify(settings.create(file).get()) === '{}', 'settings: a broken file reads as nothing set');
    const s2 = settings.create(file);
    let heard = null;
    const stop = s2.watch((v) => { heard = v; });
    await new Promise((r) => setTimeout(r, 300));
    settings.create(file).set({ lang: 'de' });
    for (let i = 0; i < 40 && !heard; i++) await new Promise((r) => setTimeout(r, 100));
    if (typeof stop === 'function') stop();
    check(heard && heard.lang === 'de', 'settings: a change written by another process is heard', JSON.stringify(heard));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
