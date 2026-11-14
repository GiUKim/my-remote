// The client app's list of PCs (client/hosts.js), without Electron: node release/test-hosts.js
// The store is given a stand-in for the operating system's encryption (reversible, marked), so the
// test can see that a key is in the file only as that made it, and what happens when it cannot be read.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Hosts = require('../client/hosts');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-hosts-test-'));
const file = path.join(dir, 'hosts.json');
const key = () => crypto.randomBytes(32).toString('base64url');
const crypt = (opts = {}) => ({
  ready: async () => opts.ready !== false,
  encrypt: async (t) => Buffer.from('sealed:' + [...t].reverse().join('')).toString('base64'),
  decrypt: async (b) => { if (opts.locked) throw new Error('locked'); const t = Buffer.from(b, 'base64').toString(); if (!t.startsWith('sealed:')) throw new Error('not ours'); return [...t.slice(7)].reverse().join(''); },
});

(async () => {
  let clock = 1000;
  const mk = (c) => Hosts.create({ file, crypt: c || crypt(), now: () => clock });
  let h = mk();
  check('an empty list where there is no file', h.list().length === 0 && h.note() === '');

  const k1 = key(), k2 = key();
  const a = await h.add({ key: '  ' + k1 + '\n', name: '  회사 PC  ' });
  check('a PC is added with its name, spaces around the key and the name taken off', a.ok && h.get(a.id).name === '회사 PC');
  const text = fs.readFileSync(file, 'utf8');
  check('the key is not in the file as text', !text.includes(k1) && !text.includes(Buffer.from(k1).toString('base64')) && /"keyEnc"/.test(text));
  check('the key comes back out for the window that connects', (await h.key(a.id)) === k1);
  check('what a page gets of an entry has no key in it', !JSON.stringify(h.list()).includes(k1) && !('keyEnc' in h.list()[0]) && !('fp' in h.list()[0]));

  const dup = await h.add({ key: k1, name: 'again' });
  check('the same key again names the entry that has it', !dup.ok && dup.why === 'exists' && dup.id === a.id && h.list().length === 1);
  for (const bad of ['', 'short', k1 + 'x', k1.slice(0, 42) + '!', null, 42]) {
    const r = await h.add({ key: bad, name: 'x' });
    if (r.ok || r.why !== 'badkey') { check('what is not a key is refused', false, JSON.stringify(bad)); break; }
    if (bad === 42) check('what is not a key is refused', h.list().length === 1);
  }

  clock = 2000;
  const b = await h.add({ key: k2, name: '' });
  clock = 5000;
  h.seen(b.id, { os: 'linux', name: 'Ubuntu 24.04.4 LTS', pc: 'build-server', monitors: 2 });
  const e = h.get(b.id);
  check('a connection notes when it was and what the PC said it is', e.lastAt === 5000 && e.os === 'linux' && e.osName === 'Ubuntu 24.04.4 LTS' && e.pc === 'build-server' && e.monitors === 2 && e.addedAt === 2000);
  h.seen(b.id, { os: 'solaris', name: 'x'.repeat(200) + '\u0007', pc: 'line\nbreak', monitors: 1e9 });
  const e2 = h.get(b.id);
  check('what a host says is cut to size and to plain text; an unknown system keeps the one known', e2.os === 'linux' && e2.osName.length === 60 && !/[\u0000-\u001f]/.test(e2.osName + e2.pc) && e2.pc === 'line break' && e2.monitors <= 64);
  h.seen(b.id, { pc: '' });
  check('a host that names no computer does not erase the name known', h.get(b.id).pc === 'line break');

  check('a name is changed, and cut to 40', h.rename(a.id, 'N'.repeat(60)) && h.get(a.id).name.length === 40 && !h.rename('nosuchidhere', 'x'));

  // Read again from the file, as the next start of the app does.
  h = mk();
  check('the list is the same after reading the file again', h.list().length === 2 && (await h.key(a.id)) === k1 && (await h.key(b.id)) === k2 && h.get(b.id).lastAt === 5000);

  const k3 = key();
  const sk = await h.setKey(a.id, k3);
  check('a new key replaces the old one of an entry; its name stays', sk.ok && (await h.key(a.id)) === k3 && h.get(a.id).name.length === 40);
  check('... but not with the key of another entry, nor with what is no key', !(await h.setKey(a.id, k2)).ok && (await h.setKey(a.id, 'nope')).why === 'badkey' && (await h.key(a.id)) === k3);
  check('the old key can be added again as a PC of its own', (await h.add({ key: k1, name: 'old' })).ok && h.list().length === 3);

  const locked = mk(crypt({ locked: true }));
  check('a key that cannot be read (the store is locked) gives none; the entry stays', (await locked.key(a.id)) === null && locked.list().length === 3);
  const none = mk(crypt({ ready: false }));
  const r = await none.add({ key: key(), name: 'x' });
  check('without a store for keys nothing is added, and nothing is written as text', !r.ok && r.why === 'nostore' && none.list().length === 3);

  check('an entry is removed, with its key', h.remove(b.id) && !h.get(b.id) && (await h.key(b.id)) === null && !fs.readFileSync(file, 'utf8').includes(b.id) && !h.remove(b.id));

  fs.writeFileSync(file, '{ this is not json');
  const broken = mk();
  check('a file that is not ours is kept under another name and not written over until something is added',
    broken.list().length === 0 && broken.note() === 'broken' && fs.readdirSync(dir).some((f) => f.startsWith('hosts.json.bad-')) && fs.readFileSync(file, 'utf8') === '{ this is not json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, hosts: [{ id: 'zz', keyEnc: 'x' }, { id: 'abcdef012345', keyEnc: '' }, { id: 'abcdef012345', keyEnc: 'eA==', name: 'ok\u0001', os: 'beos' }, { id: 'abcdef012345', keyEnc: 'eA==' }, null] }));
  const odd = mk();
  check('entries that are not entries are left out, the rest is made safe', odd.list().length === 1 && odd.list()[0].name === 'ok' && odd.list()[0].os === '' && (await odd.key('abcdef012345')) === null);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} FAILED (of ${n})` : `\nALL PASS (${n})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
