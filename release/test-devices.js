// The host's device tokens (host/devices.js) and its access log (host/accesslog.js), without Electron:
// node release/test-devices.js
// The store is given a stand-in for the operating system's encryption (reversible, marked), so the test
// can see that a token is in the file only as that made it, and what happens when it cannot be read.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Devices = require('../host/devices');
const AccessLog = require('../host/accesslog');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-devices-test-'));
const file = path.join(dir, 'devices.json');
const crypt = (opts = {}) => ({
  ready: async () => opts.ready !== false,
  encrypt: async (t) => Buffer.from('sealed:' + [...t].reverse().join('')).toString('base64'),
  decrypt: async (b) => { if (opts.locked) throw new Error('locked'); const t = Buffer.from(b, 'base64').toString(); if (!t.startsWith('sealed:')) throw new Error('not ours'); return [...t.slice(7)].reverse().join(''); },
});
const install = () => crypto.randomBytes(16).toString('base64url');

(async () => {
  let clock = 1000;
  const mk = (c) => Devices.create({ file, crypt: c || crypt(), now: () => clock });
  let d = mk();
  check('no devices where there is no file', d.list().length === 0 && d.note() === '' && (await d.secrets()).length === 0);

  const instA = install(), instB = install();
  const a = await d.add({ pc: '  AI-PC ', os: 'windows', osName: 'Windows 10', app: '0.8.0', install: instA });
  check('an app is given a token of its own (32 random bytes) and an id', a.ok && /^[A-Za-z0-9_-]{43}$/.test(a.secret) && /^[0-9a-f]{16}$/.test(a.id) && !a.again);
  const text = fs.readFileSync(file, 'utf8');
  check('the token is not in the file as text', !text.includes(a.secret) && /"secretEnc"/.test(text));
  check('what the host window gets has no token; the name is what the app said',
    !JSON.stringify(d.list()).includes(a.secret) && !('secretEnc' in d.list()[0]) && d.list()[0].name === 'AI-PC' && d.list()[0].osName === 'Windows 10' && d.list()[0].app === '0.8.0');
  const s1 = await d.secrets();
  check('the host page gets every token to listen on', s1.length === 1 && s1[0].id === a.id && s1[0].secret === a.secret && s1[0].blocked === false);

  clock = 2000;
  const again = await d.add({ pc: 'AI-PC', os: 'windows', install: instA });
  check('the same app pairing again gets a new token in the same entry; the old token no longer works',
    again.ok && again.again && again.id === a.id && again.secret !== a.secret && d.list().length === 1 && (await d.secrets())[0].secret === again.secret && d.get(a.id).added === 1000);
  const b = await d.add({ pc: 'laptop', os: 'linux', install: instB });
  const c = await d.add({ pc: 'no install id' });
  const c2 = await d.add({ pc: 'no install id' });
  check('other apps get entries of their own; apps that name no install are never taken for one another',
    b.ok && c.ok && c2.ok && d.list().length === 4 && new Set([a.id, b.id, c.id, c2.id]).size === 4);

  clock = 3000;
  check('a connection notes when and from where', d.seen(b.id, { ip: '192.0.2.7' }) && d.get(b.id).last === 3000 && d.get(b.id).lastIp === '192.0.2.7' && d.get(b.id).n === 1 && !d.seen('0000000000000000'));
  check('a device is renamed (cut to 40), blocked, and the page learns it is blocked',
    d.rename(b.id, 'L'.repeat(60)) && d.get(b.id).name.length === 40 && d.block(b.id, true) && d.get(b.id).blocked && (await d.secrets()).find((x) => x.id === b.id).blocked === true);
  const bAgain = await d.add({ pc: 'laptop', install: instB });
  check('a blocked app that pairs again stays blocked', bAgain.ok && bAgain.id === b.id && d.get(b.id).blocked);

  d = mk();
  check('the same after reading the file again', d.list().length === 4 && d.get(b.id).blocked && (await d.secrets()).length === 4 && d.get(b.id).lastIp === '192.0.2.7');
  check('a device is removed with its token', d.remove(c.id) && !d.get(c.id) && (await d.secrets()).every((x) => x.id !== c.id) && !d.remove(c.id) && !fs.readFileSync(file, 'utf8').includes(c.id));
  check('unblocked, it gets in again', d.block(b.id, false) && !(await d.secrets()).find((x) => x.id === b.id).blocked);

  const locked = mk(crypt({ locked: true }));
  check('a token that cannot be decrypted here is left out: that device cannot get in', (await locked.secrets()).length === 0 && locked.list().length === 3);
  const none = mk(crypt({ ready: false }));
  const r = await none.add({ pc: 'x' });
  check('without a store for secrets no token is given, and nothing is written as text', !r.ok && r.why === 'nostore' && none.list().length === 3);

  const full = Devices.create({ file: path.join(dir, 'full.json'), crypt: crypt() });
  for (let i = 0; i < Devices.MAX; i++) await full.add({ pc: 'pc' + i });
  const over = await full.add({ pc: 'one more' });
  check(`at most ${Devices.MAX} devices (each is one more topic on the relay)`, !over.ok && over.why === 'full' && full.list().length === Devices.MAX);
  check('all removed at once (a new key, because the old one leaked)', full.clear() === Devices.MAX && full.list().length === 0 && (await full.secrets()).length === 0);

  fs.writeFileSync(file, '{ not json');
  const broken = mk();
  check('a file that is not ours is kept under another name and not written over',
    broken.list().length === 0 && broken.note() === 'broken' && fs.readdirSync(dir).some((f) => f.startsWith('devices.json.bad-')) && fs.readFileSync(file, 'utf8') === '{ not json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, devices: [{ id: 'zz', secretEnc: 'x' }, { id: '0123456789abcdef', secretEnc: '' }, { id: '0123456789abcdef', secretEnc: 'eA==', name: 'a\u0007b', os: 'beos', blocked: 'yes' }, { id: '0123456789abcdef', secretEnc: 'eA==' }, null] }));
  const odd = mk();
  check('entries that are not entries are left out, the rest is made safe', odd.list().length === 1 && odd.list()[0].name === 'a b' && odd.list()[0].os === '' && odd.list()[0].blocked === false && (await odd.secrets()).length === 0);

  // ---- the access log ----
  const lf = path.join(dir, 'access.log');
  let t = 1000 * 86400e3;
  const log = AccessLog.create({ file: lf, now: () => t, keepDays: 90 });
  check('an entry of an unknown kind is not written', !log.add({ ev: 'hack', name: 'x' }) && !fs.existsSync(lf));
  log.add({ ev: 'connect', via: 'device', dev: a.id, name: 'AI-PC\n', ip: '192.0.2.7', kind: 'host', extra: 'x'.repeat(1000) });
  t += 60e3;
  log.add({ ev: 'end', via: 'device', dev: a.id, name: 'AI-PC', dur: 59.6, in: 2, out: -1, why: '클라이언트 연결 종료' });
  log.add({ ev: 'denied', via: 'device', dev: 'not-an-id', why: 'blocked' });
  const rd = log.read(10);
  check('entries keep known fields only, as plain values, the newest first',
    rd.length === 3 && rd[0].ev === 'denied' && !('dev' in rd[0]) && rd[1].dur === 60 && rd[1].in === 2 && !('out' in rd[1]) && rd[2].name === 'AI-PC' && !('extra' in rd[2]) && rd[2].via === 'device' && rd[2].kind === 'host');
  t += 91 * 86400e3;
  log.add({ ev: 'connect', via: 'key', name: '키로 접속' });
  check('entries older than 90 days go when the host starts', log.prune() === 3 && log.read(10).length === 1 && log.read(10)[0].via === 'key' && log.prune() === 0);
  const sf = path.join(dir, 'small.log');
  const small = AccessLog.create({ file: sf, now: () => t, maxBytes: 2000 });
  for (let i = 0; i < 100; i++) small.add({ ev: 'connect', via: 'key', name: 'n' + i });
  small.prune();
  check('the log is kept under its size, the newest entries kept', fs.statSync(sf).size <= 2000 && small.read(1)[0].name === 'n99');
  fs.appendFileSync(lf, 'not json\n{"t":0}\n');
  check('lines that are not entries are skipped when read', log.read(10).length === 1);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED (of ${n})` : `\nALL PASS (${n})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
