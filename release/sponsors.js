// The picture of Pangmote's sponsors for the README (the user's wish, 2026-11-27: the avatars of the sponsors shown
// by themselves): the avatar and name of every person or organisation that sponsors the account on GitHub
// Sponsors, on a dark panel of its own like the README's other pictures (so it reads on a light and a dark page),
// the avatars inside it as data (a picture shown through <img> loads nothing else). The Sponsors workflow
// (.github/workflows/sponsors.yml) draws it every day, with a badge of the count (--badge), and publishes the two as
// the files of the branch `sponsors`, in one commit that replaces the one before: never on main, where every commit
// wants CI and a pull in every clone, and whose history would keep the picture of someone who has since stopped or
// turned private. Only public sponsorships are drawn: private ones are not asked for (includePrivate: false), and
// are dropped if they come all the same.
//
//   node release/sponsors.js --login=<account> --out=<file.svg> [--badge=<file.svg>] [--old=<file.svg>] [--gh=<gh>] [--soft]
//
// Asked with SPONSORS_TOKEN when it is set (a classic personal access token of the sponsored account: the user's,
// a repository secret; never read, print or set it for them), else, with --gh, through GitHub CLI and its own login
// (drawing it on a PC), else with GITHUB_TOKEN (the workflow's own, which reads public sponsorships: tried
// 2026-11-27, so no secret is needed). A token goes to api.github.com and nowhere else and is never printed; avatars
// are fetched from GitHub's avatar host only, without a token. --old: when that picture was drawn by this same
// script from the same sponsors and avatars, nothing is written ("unchanged"). --soft: a failure is a warning (an
// annotation on GitHub) with exit code 0, since the workflow runs on main's head commit and release/build.js wants
// every check run of a commit to have passed.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const QUERY = `query($login: String!, $after: String) {
  user(login: $login) {
    sponsorshipsAsMaintainer(first: 100, after: $after, includePrivate: false, activeOnly: true, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        sponsorEntity {
          ... on User { login avatarUrl(size: 128) }
          ... on Organization { login avatarUrl(size: 128) }
        }
      }
    }
  }
}`;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub's own rule for account names
const AVATAR_HOST = /^https:\/\/avatars\.githubusercontent\.com\//;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_AVATAR = 200 * 1024; // bytes; a larger one is drawn as a letter
const MAX_SHOWN = 90; // ten rows; the rest are counted below them
const W = 880, CELL = 88, PER_ROW = 9, AV = 64, TOP = 60, ROW = 100;
const FONT = `"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;

// Every public sponsorship of `login`, oldest first: [{ login, avatar }]. ask(query, variables) -> data.
async function collect(ask, login) {
  const out = [], seen = new Set();
  let after = null;
  for (let page = 0; page < 50; page++) {
    const data = await ask(QUERY, after ? { login, after } : { login });
    const conn = data && data.user && data.user.sponsorshipsAsMaintainer;
    if (!conn) throw new Error(`GitHub gave no sponsorships of ${login}`);
    for (const node of conn.nodes || []) {
      const e = node && node.sponsorEntity;
      if (!node || (node.privacyLevel && node.privacyLevel !== 'PUBLIC') || !e || typeof e.login !== 'string' || !LOGIN.test(e.login) || seen.has(e.login)) continue;
      seen.add(e.login);
      out.push({ login: e.login, avatar: typeof e.avatarUrl === 'string' ? e.avatarUrl : '' });
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function askApi(token, query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'User-Agent': 'pangmote-sponsors', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30e3),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${j && j.message ? ': ' + j.message : ''}`);
  if (j.errors && j.errors.length) throw new Error(j.errors.map((e) => e && e.message).join('; '));
  return j.data;
}

function askGh(gh, query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push('-f', `${k}=${v}`);
  const r = spawnSync(gh, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`GitHub CLI: ${String(r.stderr || (r.error && r.error.message) || 'failed').trim().split('\n')[0]}`);
  const j = JSON.parse(r.stdout);
  if (j.errors && j.errors.length) throw new Error(j.errors.map((e) => e && e.message).join('; '));
  return j.data;
}

async function getImage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'pangmote-sponsors' }, signal: AbortSignal.timeout(20e3) });
  return { status: r.status, url: r.url, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
}

// An avatar as { type, b64 }, or null: only from GitHub's avatar host (also after redirects), only a picture.
async function avatarOf(url, get = getImage) {
  if (!AVATAR_HOST.test(url)) return null;
  try {
    const r = await get(url);
    const type = String(r.type || '').split(';')[0].trim().toLowerCase();
    if (r.status !== 200 || (r.url && !AVATAR_HOST.test(r.url)) || !IMAGE.test(type) || !r.bytes || !r.bytes.length || r.bytes.length > MAX_AVATAR) return null;
    return { type, b64: Buffer.from(r.bytes).toString('base64') };
  } catch { return null; }
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const fit = (s, n) => (Array.from(s).length <= n ? s : Array.from(s).slice(0, n - 1).join('') + '…');
const heart = (x, y, fill) => `<path transform="translate(${x} ${y})" d="M12 21C12 21 3 14.5 3 8.6C3 5.5 5.4 3 8.4 3C10 3 11.3 3.8 12 5C12.7 3.8 14 3 15.6 3C18.6 3 21 5.5 21 8.6C21 14.5 12 21 12 21Z" fill="${fill}"/>`;

// What a picture was drawn from: this script's own text and, per sponsor, the avatar's address and whether it
// came. The same key means the same picture; it is kept in the picture's second line.
function keyOf(list, avatars, script) {
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  return h(JSON.stringify({ script: h(script), sponsors: list.map((s) => [s.login, s.avatar, !!avatars[s.login]]) }));
}
const readKey = (svg) => { const m = /<!-- sponsors-key: ([0-9a-f]{64}) -->/.exec(String(svg)); return m ? m[1] : null; };

// The picture (the same input gives the same bytes).
function draw(list, avatars, key) {
  const shown = list.slice(0, MAX_SHOWN), more = list.length - shown.length;
  const rows = Math.ceil(shown.length / PER_ROW);
  const H = shown.length ? TOP + rows * ROW + (more ? 30 : 0) + 10 : 124;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>`,
    `<!-- sponsors-key: ${key} -->`,
    `  <title>${shown.length ? 'Pangmote를 후원해 주신 분들' : 'Pangmote 후원'}</title>`,
    `  <rect width="${W}" height="${H}" rx="18" fill="#14171c"/>`,
    `  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="17" fill="none" stroke="#2c333d" stroke-width="2"/>`,
  ];
  if (!shown.length) {
    out.push(`  ${heart(W / 2 - 12, 14, '#4a8dff')}`); // above the text, whose width depends on the reader's fonts
    out.push(`  <text x="${W / 2}" y="68" text-anchor="middle" font-size="17" font-weight="600" fill="#e6e8eb">GitHub Sponsors로 Pangmote를 응원해 주세요</text>`);
    out.push(`  <text x="${W / 2}" y="96" text-anchor="middle" font-size="13" fill="#aeb9c6">공개로 후원해 주신 분의 프로필 사진이 여기에 나옵니다</text>`);
  } else {
    out.push(`  ${heart(26, 19, '#4a8dff')}`);
    out.push(`  <text x="56" y="38" font-size="17" font-weight="600" fill="#e6e8eb">후원해 주신 분들</text>`);
    out.push(`  <text x="${W - 28}" y="38" text-anchor="end" font-size="14" fill="#4a8dff">후원하기 ›</text>`);
    shown.forEach((s, i) => {
      const r = Math.floor(i / PER_ROW), inRow = Math.min(PER_ROW, shown.length - r * PER_ROW), c = i - r * PER_ROW;
      const cx = (W - inRow * CELL) / 2 + c * CELL + CELL / 2, cy = TOP + r * ROW + AV / 2 + 4;
      const a = avatars[s.login];
      if (a) {
        out.push(`  <clipPath id="a${i}"><circle cx="${cx}" cy="${cy}" r="${AV / 2}"/></clipPath>`);
        out.push(`  <image x="${cx - AV / 2}" y="${cy - AV / 2}" width="${AV}" height="${AV}" preserveAspectRatio="xMidYMid slice" clip-path="url(#a${i})" href="data:${a.type};base64,${a.b64}"/>`);
      } else {
        out.push(`  <circle cx="${cx}" cy="${cy}" r="${AV / 2}" fill="#1e3152"/>`);
        out.push(`  <text x="${cx}" y="${cy + 9}" text-anchor="middle" font-size="26" font-weight="600" fill="#e6e8eb">${esc(s.login[0].toUpperCase())}</text>`);
      }
      out.push(`  <circle cx="${cx}" cy="${cy}" r="${AV / 2 + 1}" fill="none" stroke="#2c333d" stroke-width="2"/>`);
      out.push(`  <text x="${cx}" y="${cy + AV / 2 + 22}" text-anchor="middle" font-size="12.5" fill="#aeb9c6">${esc(fit(s.login, 12))}</text>`);
    });
    if (more) out.push(`  <text x="${W / 2}" y="${TOP + rows * ROW + 22}" text-anchor="middle" font-size="13" fill="#aeb9c6">외 ${more}명</text>`);
  }
  out.push('</svg>', '');
  return out.join('\n');
}

// The count as a small badge for the top of the README, drawn here too: shields.io's badge of it took 2 to 10 s to
// answer and GitHub's image proxy gives up after about 4, so the README showed it broken (tried 2026-11-27).
// Public sponsorships, as in the picture. The texts are fitted to fixed widths (textLength), whatever the font.
function badge(count) {
  const value = String(count), LW = 61, RW = 14 + 7 * value.length, BW = LW + RW;
  const text = (x, w, s) => `<text x="${x}" y="15" fill="#010101" fill-opacity=".3" textLength="${w}" lengthAdjust="spacingAndGlyphs">${s}</text><text x="${x}" y="14" fill="#fff" textLength="${w}" lengthAdjust="spacingAndGlyphs">${s}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="20" viewBox="0 0 ${BW} 20" role="img" aria-label="후원자: ${value}">`,
    `  <title>GitHub Sponsors 후원자: ${value}</title>`,
    '  <linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>',
    `  <clipPath id="r"><rect width="${BW}" height="20" rx="3"/></clipPath>`,
    `  <g clip-path="url(#r)"><rect width="${LW}" height="20" fill="#555"/><rect x="${LW}" width="${RW}" height="20" fill="#ea4aaa"/><rect width="${BW}" height="20" fill="url(#g)"/></g>`,
    `  ${heart(4, 3.5, '#ea4aaa').replace('translate(4 3.5)', 'translate(4 3.5) scale(0.55)')}`,
    `  <g font-family="Verdana,Geneva,'DejaVu Sans','Malgun Gothic','Apple SD Gothic Neo',sans-serif" font-size="11" text-anchor="middle">`,
    `    ${text(37.5, 33, '후원자')}`,
    `    ${text(LW + RW / 2, 7 * value.length, esc(value))}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log || ((s) => console.log(s)), err = deps.err || ((s) => console.error(s));
  const arg = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
  const soft = argv.includes('--soft');
  try {
    const login = arg('login'), out = arg('out'), gh = arg('gh'), badgeOut = arg('badge');
    if (!login || !LOGIN.test(login) || !out) throw new Error('usage: node release/sponsors.js --login=<account> --out=<file.svg> [--badge=<file.svg>] [--old=<file.svg>] [--gh=<gh>] [--soft]');
    let ask, via;
    if (deps.ask) { ask = deps.ask; via = 'a stand-in'; }
    else if (env.SPONSORS_TOKEN) { ask = (q, v) => askApi(env.SPONSORS_TOKEN, q, v); via = 'SPONSORS_TOKEN'; }
    else if (gh) { ask = (q, v) => askGh(gh, q, v); via = 'GitHub CLI'; }
    else if (env.GITHUB_TOKEN) { ask = (q, v) => askApi(env.GITHUB_TOKEN, q, v); via = "the workflow's own token"; }
    else throw new Error('no token: neither SPONSORS_TOKEN nor GITHUB_TOKEN is set, and no --gh (see the header of release/sponsors.js)');
    let list;
    try { list = await collect(ask, login); }
    catch (e) {
      const hint = via === "the workflow's own token" ? ' - set the repository secret SPONSORS_TOKEN (a classic personal access token of the account, made by its owner)' : '';
      throw new Error(`asking GitHub with ${via} failed: ${e.message}${hint}`);
    }
    const avatars = {};
    for (const s of list.slice(0, MAX_SHOWN)) avatars[s.login] = await avatarOf(s.avatar, deps.get);
    const key = keyOf(list, avatars, deps.script !== undefined ? deps.script : fs.readFileSync(__filename, 'utf8'));
    const old = arg('old') && fs.existsSync(arg('old')) ? readKey(fs.readFileSync(arg('old'), 'utf8')) : null;
    if (old === key) { log(`unchanged: ${list.length} public sponsor(s)`); return 0; }
    fs.writeFileSync(out, draw(list, avatars, key));
    if (badgeOut) fs.writeFileSync(badgeOut, badge(list.length));
    const missing = list.slice(0, MAX_SHOWN).filter((s) => !avatars[s.login]).length;
    log(`drawn: ${list.length} public sponsor(s)${missing ? `, ${missing} drawn as a letter (no avatar)` : ''}, asked with ${via}`);
    return 0;
  } catch (e) {
    const msg = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
    if (soft) { log(`::warning title=Sponsors picture::${msg}`); return 0; }
    err('sponsors: ' + msg);
    return 1;
  }
}

if (require.main === module) main().then((code) => process.exit(code));

module.exports = { QUERY, LOGIN, MAX_SHOWN, PER_ROW, collect, avatarOf, draw, badge, keyOf, readKey, esc, fit, main };
