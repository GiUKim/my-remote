// How much the app is used, read from GitHub's own download counters of the releases (public, anonymous API): no
// counting in the app, nothing sent by it. node release/downloads.js [--json]
//
// What each file's count means (the feed is releases/latest/download/, see app/update-config.json):
//  - MyRemote-Windows-x64.zip, MyRemote-Linux-x64.tar.gz: someone downloaded the package (README buttons, a shared
//    link) = new installs, plus, for a release whose shell is new, the installed apps that swap their shell (0.9.3).
//  - my-remote-<version>.bundle: installed apps that took this update (about one per PC that updated).
//  - latest.json: every running app looks every 6 hours and 20 s after it starts (app/updater.js), host and client
//    app each: so (fetches per day) / 4 is a rough count of apps running at once - high when apps are started often,
//    low when PCs are off for part of the day. Counted toward whichever release was the latest at the time.
// This PC's own checks count too (release/feed-check.js after publishing fetches every file once).
'use strict';
const REPO = 'GiUKim/my-remote';
const DAY = 86400e3;

async function releases() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers: { 'User-Agent': 'my-remote-downloads', Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const list = await r.json();
    out.push(...list);
    if (list.length < 100) break;
  }
  return out.filter((x) => !x.draft && x.published_at).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
}

(async () => {
  const list = await releases();
  const now = Date.now();
  const rows = list.map((rel, i) => {
    const from = Date.parse(rel.published_at), to = i + 1 < list.length ? Date.parse(list[i + 1].published_at) : now;
    const count = (re) => rel.assets.filter((a) => re.test(a.name)).reduce((n, a) => n + a.download_count, 0);
    const days = Math.max((to - from) / DAY, 1 / 24);
    const checks = count(/^latest\.json$/);
    return {
      version: rel.tag_name.replace(/^v/, ''), date: rel.published_at.slice(0, 10), latestDays: +days.toFixed(1),
      windows: count(/Windows.*\.zip$/), linux: count(/Linux.*\.tar\.gz$/), updates: count(/\.bundle$/),
      checksPerDay: +(checks / days).toFixed(1), appsRunning: Math.round(checks / days / 4),
    };
  });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return; }
  const head = ['version', 'released', 'days latest', 'Windows zip', 'Linux tar', 'updates', 'checks/day', '~apps on'];
  // A release that was the latest for under a day says little per day (app starts and this PC's own checks weigh in).
  const cells = rows.map((r) => [r.version, r.date, r.latestDays, r.windows, r.linux, r.updates, r.checksPerDay, r.appsRunning + (r.latestDays < 1 ? '*' : '')].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((x, i) => (i < 2 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ');
  console.log(line(head));
  for (const c of cells) console.log(line(c));
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  console.log('\n* the latest for under a day: too short to read a daily figure from');
  console.log(`packages downloaded in all: Windows ${sum('windows')}, Linux ${sum('linux')} (new installs, and shell swaps of releases with a new shell)`);
  const cur = rows[rows.length - 1];
  if (cur) console.log(`now (${cur.version}, latest for ${cur.latestDays} days): about ${cur.appsRunning} app(s) running at once (latest.json fetches per day / 4; rough)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
