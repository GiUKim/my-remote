// release/sponsors.js (the README's picture of the sponsors) without GitHub: sponsorships asked page by page with
// private ones dropped, avatars taken only from GitHub's avatar host and only as pictures, the drawing (escaped,
// nothing outside it referenced, rows, the cap, the empty panel), the key (the same sponsors give the same bytes,
// and "unchanged"), --soft, and a token never printed.
//   node release/test-sponsors.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./sponsors');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log('PASS  ' + name); }
  catch (e) { results.push(false); console.log('FAIL  ' + name + ': ' + ((e && e.message) || e)); }
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082', 'hex');
const av = (login) => `https://avatars.githubusercontent.com/u/${login.length}?u=${login}&v=4&s=128`;
const node = (login, privacy = 'PUBLIC', extra = {}) => ({ privacyLevel: privacy, sponsorEntity: { login, avatarUrl: av(login), ...extra } });
const page = (nodes, next) => ({ user: { sponsorshipsAsMaintainer: { pageInfo: { hasNextPage: !!next, endCursor: next || null }, nodes } } });
const okImage = async (url) => ({ status: 200, url, type: 'image/png', bytes: PNG });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangmote-sponsors-'));

(async () => {
  await check('sponsorships are asked page by page; private, unnamed, oddly named and repeated ones are dropped', async () => {
    const asked = [];
    const ask = async (q, v) => {
      asked.push(v);
      assert.ok(/includePrivate: false/.test(q), 'private sponsorships must not be asked for');
      if (!v.after) return page([node('alice'), node('hidden', 'PRIVATE'), { privacyLevel: 'PUBLIC', sponsorEntity: null }, node('bad<name>')], 'c1');
      return page([node('bob'), node('alice'), node('org-x')], null);
    };
    const list = await S.collect(ask, 'owner');
    assert.deepStrictEqual(list.map((s) => s.login), ['alice', 'bob', 'org-x']);
    assert.deepStrictEqual(asked, [{ login: 'owner' }, { login: 'owner', after: 'c1' }]);
    assert.strictEqual(list[0].avatar, av('alice'));
  });

  await check('an answer without the sponsorships is an error, not an empty picture', async () => {
    await assert.rejects(S.collect(async () => ({ user: null }), 'owner'), /no sponsorships/);
  });

  await check("avatars come only from GitHub's avatar host and only as pictures of a sane size", async () => {
    let calls = 0;
    const get = async (url) => { calls++; return okImage(url); };
    assert.strictEqual(await S.avatarOf('https://evil.example/a.png', get), null);
    assert.strictEqual(await S.avatarOf('http://avatars.githubusercontent.com/u/1', get), null);
    assert.strictEqual(calls, 0, 'another host must not even be asked');
    const a = await S.avatarOf(av('alice'), get);
    assert.deepStrictEqual(a, { type: 'image/png', b64: PNG.toString('base64') });
    assert.strictEqual(await S.avatarOf(av('alice'), async (u) => ({ status: 200, url: u, type: 'text/html', bytes: PNG })), null);
    assert.strictEqual(await S.avatarOf(av('alice'), async (u) => ({ status: 200, url: u, type: 'image/svg+xml', bytes: PNG })), null);
    assert.strictEqual(await S.avatarOf(av('alice'), async (u) => ({ status: 200, url: u, type: 'image/png', bytes: Buffer.alloc(300 * 1024) })), null);
    assert.strictEqual(await S.avatarOf(av('alice'), async (u) => ({ status: 404, url: u, type: 'image/png', bytes: PNG })), null);
    assert.strictEqual(await S.avatarOf(av('alice'), async () => ({ status: 200, url: 'https://evil.example/x', type: 'image/png', bytes: PNG })), null, 'a redirect away');
    assert.strictEqual(await S.avatarOf(av('alice'), async () => { throw new Error('offline'); }), null);
  });

  await check('the picture: every sponsor, avatars as data, a letter where none came, nothing outside referenced', async () => {
    const list = [{ login: 'alice', avatar: av('alice') }, { login: 'bob', avatar: av('bob') }];
    const svg = S.draw(list, { alice: { type: 'image/png', b64: 'QUJD' } }, 'k'.repeat(64));
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="880"'));
    assert.ok(svg.endsWith('</svg>\n'));
    assert.ok(svg.includes('>alice</text>') && svg.includes('>bob</text>'));
    assert.strictEqual((svg.match(/<image /g) || []).length, 1);
    assert.ok(svg.includes('href="data:image/png;base64,QUJD"'));
    assert.ok(svg.includes('>B</text>'), 'bob without an avatar is drawn as his letter');
    assert.ok(!/href="(?!data:)/.test(svg) && !/url\((?!#)/.test(svg), 'only data and the picture itself are referenced');
    assert.ok(!/<script|on[a-z]+=/i.test(svg));
    assert.ok(svg.includes('후원해 주신 분들'));
  });

  await check('text is escaped and long names are cut', async () => {
    assert.strictEqual(S.esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
    assert.strictEqual(S.fit('short', 12), 'short');
    assert.strictEqual(S.fit('a-very-long-account-name', 12), 'a-very-long…');
    assert.strictEqual(Array.from(S.fit('a-very-long-account-name', 12)).length, 12);
  });

  await check('rows of nine, and past ninety the rest counted', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ login: `s${i}`, avatar: av(`s${i}`) }));
    const h = (svg) => +/height="(\d+)"/.exec(svg)[1];
    const one = S.draw(many(1), {}, 'k'), nine = S.draw(many(9), {}, 'k'), ten = S.draw(many(10), {}, 'k');
    assert.strictEqual(h(one), h(nine));
    assert.strictEqual(h(ten), h(nine) + 100);
    const lots = S.draw(many(95), {}, 'k');
    assert.strictEqual((lots.match(/font-size="12.5"/g) || []).length, S.MAX_SHOWN);
    assert.ok(lots.includes('외 5명'));
    assert.ok(!S.draw(many(90), {}, 'k').includes('외 '));
  });

  await check('nobody public yet: a panel that asks, true also when every sponsor is private', async () => {
    const svg = S.draw([], {}, 'k'.repeat(64));
    assert.ok(svg.includes('응원해 주세요') && svg.includes('공개로 후원해 주신 분'));
    assert.ok(!svg.includes('<image'));
  });

  await check('the key: the same sponsors and avatars give the same bytes; a new sponsor, avatar or drawing a new key', async () => {
    const list = [{ login: 'alice', avatar: av('alice') }];
    const got = { alice: { type: 'image/png', b64: 'QUJD' } };
    const k = S.keyOf(list, got, 'script');
    assert.strictEqual(S.keyOf(list, got, 'script'), k);
    assert.strictEqual(S.draw(list, got, k), S.draw(list, got, k));
    assert.notStrictEqual(S.keyOf([...list, { login: 'bob', avatar: av('bob') }], got, 'script'), k);
    assert.notStrictEqual(S.keyOf([{ login: 'alice', avatar: av('alice') + 'x' }], got, 'script'), k);
    assert.notStrictEqual(S.keyOf(list, {}, 'script'), k, 'an avatar that did not come is drawn again once it does');
    assert.notStrictEqual(S.keyOf(list, got, 'script 2'), k);
    assert.strictEqual(S.readKey(S.draw(list, got, k)), k);
    assert.strictEqual(S.readKey('<svg/>'), null);
  });

  await check('the run: drawn, then "unchanged" with nothing written; asked with the stand-in only', async () => {
    const out = path.join(tmp, 'a.svg'), lines = [];
    const deps = { ask: async () => page([node('alice')]), get: okImage, log: (s) => lines.push(s), err: (s) => lines.push(s), script: 'x' };
    assert.strictEqual(await S.main(['--login=owner', `--out=${out}`], {}, deps), 0);
    assert.ok(fs.existsSync(out) && /drawn: 1 public sponsor/.test(lines[0]));
    const again = path.join(tmp, 'b.svg');
    assert.strictEqual(await S.main(['--login=owner', `--out=${again}`, `--old=${out}`], {}, deps), 0);
    assert.ok(!fs.existsSync(again) && /unchanged/.test(lines[1]));
    assert.strictEqual(await S.main(['--login=owner', `--out=${again}`, `--old=${path.join(tmp, 'none.svg')}`], {}, deps), 0);
    assert.ok(fs.existsSync(again), 'no old picture: drawn');
  });

  await check('--soft: a failure is a warning and exit 0; without it exit 1; the token never printed', async () => {
    const lines = [], secret = 'ghp_' + 'S3CR3T'.repeat(6);
    const say = (s) => lines.push(s);
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, 'https://api.github.com/graphql', 'the token goes to the API only');
      assert.ok(String(opts.headers.Authorization).endsWith(secret));
      return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) };
    };
    try {
      const out = path.join(tmp, 'c.svg');
      assert.strictEqual(await S.main(['--login=owner', `--out=${out}`, '--soft'], { SPONSORS_TOKEN: secret }, { log: say, err: say }), 0);
      assert.ok(/^::warning title=Sponsors picture::asking GitHub with SPONSORS_TOKEN failed: GitHub answered 401: Bad credentials$/.test(lines[0]), lines[0]);
      assert.strictEqual(await S.main(['--login=owner', `--out=${out}`], { SPONSORS_TOKEN: secret }, { log: say, err: say }), 1);
      assert.strictEqual(await S.main(['--login=owner', `--out=${out}`, '--soft'], { GITHUB_TOKEN: secret }, { log: say, err: say }), 0);
      assert.ok(/set the repository secret SPONSORS_TOKEN/.test(lines[2]), lines[2]);
      assert.strictEqual(await S.main(['--login=owner', `--out=${out}`, '--soft'], {}, { log: say, err: say }), 0);
      assert.ok(/no token/.test(lines[3]));
      assert.ok(!lines.join('\n').includes(secret) && !lines.join('\n').includes('S3CR3T'));
      assert.ok(!fs.existsSync(out));
    } finally { global.fetch = realFetch; }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} FAILED (of ${results.length})` : `\nALL PASS (${results.length})`);
  process.exit(failed ? 1 : 0);
})();
