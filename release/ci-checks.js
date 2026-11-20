// The checks every commit must pass, without Electron, a display or the network: what CI runs first
// (.github/workflows/ci.yml) and the pre-commit hook runs locally (.githooks/pre-commit).
//   node release/ci-checks.js [--staged]
// --staged: the leak scan looks at what is staged for the next commit instead of every tracked file.
//
//  - syntax: every tracked .js file, and the scripts of the built client page and loader;
//  - every tracked .json file parses;
//  - my-remote-client.html is what host/build-client.js makes now (a change to the loader or signal.js
//    must come with the rebuilt file, which users keep);
//  - names: tracked paths are ASCII without spaces (the plain-names rule, see CLAUDE.md);
//  - committed native binaries have a record whose source hash is the source's now (the hash of the
//    binary itself is the self-test's and the native CI job's to check);
//  - leaks: private network addresses, a personal folder (C:\Users\<name>, /home/<name>), e-mail
//    addresses other than GitHub's noreply ones, and strings shaped like an access key (43 characters of
//    base64url) outside the update keys; plus patterns of your own, one regular expression per line, in
//    the environment variable PRIVATE_PATTERNS (a CI secret) or the untracked file .git/info/private-patterns
//    (they are never written into the repository).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const staged = process.argv.includes('--staged');
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
let failed = 0;
const fail = (what, detail) => { failed++; console.log(`FAIL  ${what}${detail ? '\n      ' + detail : ''}`); };
const pass = (what) => console.log(`PASS  ${what}`);

// ---- syntax --------------------------------------------------------------------------------------
{
  const bad = [];
  for (const f of tracked.filter((n) => n.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${f}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`);
  }
  // The pages are templates: check what is built from them, the way a browser gets them.
  const builder = require(path.join(ROOT, 'host', 'build-client.js'));
  const pages = { 'client page': builder.build('https://relay.invalid', '').html || builder.build('https://relay.invalid', ''), loader: builder.buildLoader('https://relay.invalid', '') };
  for (const [name, html] of Object.entries(pages)) {
    const text = typeof html === 'string' ? html : JSON.stringify(html);
    const scripts = [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    scripts.forEach((s, i) => { try { new Function(s); } catch (e) { bad.push(`${name}, script ${i + 1}: ${e.message}`); } });
  }
  for (const f of tracked.filter((n) => /\.html$/.test(n) && !/template/.test(n) && n !== 'my-remote-client.html')) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m, i) => { try { new Function(m[1]); } catch (e) { bad.push(`${f}, script ${i + 1}: ${e.message}`); } });
  }
  if (bad.length) fail('JavaScript parses', bad.join('\n      ')); else pass('JavaScript parses (files, the built client page and loader, other pages)');
}

// ---- JSON -----------------------------------------------------------------------------------------
{
  const bad = [];
  for (const f of tracked.filter((n) => n.endsWith('.json'))) { try { JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { bad.push(`${f}: ${e.message}`); } }
  if (bad.length) fail('JSON files parse', bad.join('\n      ')); else pass('JSON files parse');
}

// ---- the loader users keep ---------------------------------------------------------------------
{
  const builder = require(path.join(ROOT, 'host', 'build-client.js'));
  const want = builder.buildLoader('https://ntfy.sh').replace(/\r\n/g, '\n');
  const have = fs.readFileSync(path.join(ROOT, 'my-remote-client.html'), 'utf8').replace(/\r\n/g, '\n');
  if (want !== have) fail('my-remote-client.html is the loader built from the sources', 'run: cd host && npm run build-client (and give users the new file: see CLAUDE.md)');
  else pass('my-remote-client.html is the loader built from the sources');
  // The web page (docs/index.html on GitHub Pages) uses a copy of the app's translator and flag picker.
  const norm = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  if (!fs.existsSync(path.join(ROOT, 'docs', 'i18n.js')) || norm('docs/i18n.js') !== norm('host/i18n.js')) fail('docs/i18n.js is host/i18n.js', 'run: cd host && npm run build-client');
  else pass('docs/i18n.js is host/i18n.js (the web page\'s translator)');
}

// ---- names --------------------------------------------------------------------------------------
{
  const bad = tracked.filter((n) => /[^\x21-\x7e]/.test(n));
  if (bad.length) fail('tracked names are ASCII without spaces', bad.slice(0, 10).join('\n      ')); else pass('tracked names are ASCII without spaces');
}

// ---- native binaries and their records ---------------------------------------------------------
{
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const bad = [];
  for (const rec of tracked.filter((n) => /^host\/bin\/.+\.(dll|exe)\.json$/.test(n))) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, rec), 'utf8'));
    const bin = rec.replace(/\.json$/, '');
    if (!tracked.includes(bin)) { bad.push(`${rec}: ${bin} is not committed`); continue; }
    const src = path.join(ROOT, r.source || '');
    if (!r.source || !fs.existsSync(src)) { bad.push(`${rec}: its source ${r.source} is missing`); continue; }
    if (r.sourceSha256 !== sha(fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'))) bad.push(`${bin}: ${r.source} changed since it was built: run native/build.js (from PowerShell)`);
    if (r.dllSha256 !== sha(fs.readFileSync(path.join(ROOT, bin)))) bad.push(`${bin} is not the file its record names`);
  }
  for (const bin of tracked.filter((n) => /^host\/bin\/.+\.(dll|exe)$/.test(n))) if (!tracked.includes(bin + '.json')) bad.push(`${bin} has no record (.json)`);
  if (bad.length) fail('committed native binaries match their records and sources', bad.join('\n      ')); else pass('committed native binaries match their records and sources');
}

// ---- leaks --------------------------------------------------------------------------------------
{
  const own = [];
  if (process.env.PRIVATE_PATTERNS) own.push(...process.env.PRIVATE_PATTERNS.split(/\r?\n/));
  // In a worktree .git is a file: git says where info/ is (it is shared by all worktrees of a clone).
  try { own.push(...fs.readFileSync(path.resolve(ROOT, git(['rev-parse', '--git-path', 'info/private-patterns']).trim()), 'utf8').split(/\r?\n/)); } catch {}
  const ownRes = own.map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((s) => new RegExp(s, 'i'));
  const RULES = [
    ['a private network address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
    ['a personal folder', /\b[A-Za-z]:\\+Users\\+(?!<|%|\$|Public\b|Default\b|you\b|name\b)[A-Za-z0-9._-]{2,}|\/home\/(?!<|\$|runner\b|user\b|you\b|name\b)[a-z0-9._-]{2,}\//],
    ['an e-mail address', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|anthropic\.com\b|example\.(?:com|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ];
  const keyShaped = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_=-])/g;
  const allowKeysIn = new Set(['app/update-config.json']);
  let files, contentOf;
  if (staged) {
    files = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']).split('\0').filter(Boolean);
    contentOf = (f) => { try { return git(['show', ':' + f]); } catch { return ''; } };
  } else {
    files = tracked;
    contentOf = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
  }
  const hits = [];
  for (const f of files) {
    if (/\.(dll|exe|png|ico|zip|gz)$/i.test(f)) continue; // binaries: the native records and the self-test cover what matters there
    const text = contentOf(f);
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const [what, re] of RULES) if (re.test(line)) hits.push(`${f}:${i + 1}: ${what}`);
      for (const re of ownRes) if (re.test(line)) hits.push(`${f}:${i + 1}: a private pattern of yours`);
      // A lock file's integrity hashes are base64 (with + and /): a run of 43 between those is no key.
      if (!allowKeysIn.has(f) && !/"integrity":\s*"sha\d+-/.test(line)) for (const m of line.matchAll(keyShaped)) {
        const t = m[0];
        if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t) && !/^[a-f0-9]+$/i.test(t)) hits.push(`${f}:${i + 1}: a string shaped like an access key`);
      }
    });
  }
  // The scan never prints what it found, only where: a real key or address must not land in a CI log either.
  if (hits.length) fail(`no private data in ${staged ? 'the staged files' : 'the tracked files'}`, hits.slice(0, 20).join('\n      ') + (hits.length > 20 ? `\n      ... ${hits.length - 20} more` : ''));
  else pass(`no private data in ${staged ? 'the staged files' : 'the tracked files'}${ownRes.length ? ` (with ${ownRes.length} pattern(s) of your own)` : ''}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
