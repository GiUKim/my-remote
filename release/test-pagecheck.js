// The client app's check of a host's page (client/pagecheck.js) and what release/build.js signs, without
// Electron: node release/test-pagecheck.js
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { verifyPage } = require('../client/pagecheck');
const core = require('../app/core');
const builder = require('../host/build-client');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const pair = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }; };
const sign = (text, k) => crypto.sign(null, Buffer.from(text, 'utf8'), k.priv).toString('base64');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const rel = pair(), other = pair();
const html = '<!doctype html><title>page</title>' + 'x'.repeat(5000);
const st = JSON.stringify({ format: 1, app: 'my-remote', kind: 'page', version: '0.8.0', server: 'https://ntfy.sh', sha256: sha(html) }) + '\n';
const good = { statement: st, sig: sign(st, rel), sha256: sha(html) };

check('a page a release key signed is taken', verifyPage(good, [rel.pub]).ok && verifyPage(good, [other.pub, rel.pub]).version === '0.8.0');
check('... not with another key', verifyPage(good, [other.pub]).why === 'sig' && verifyPage(good, []).why === 'sig');
check('... not when the page is another than the one signed', verifyPage({ ...good, sha256: sha(html + ' ') }, [rel.pub]).why === 'other');
check('a statement changed after signing is refused', verifyPage({ ...good, statement: st.replace('0.8.0', '9.9.9') }, [rel.pub]).why === 'sig');
const manifestLike = JSON.stringify({ format: 1, app: 'my-remote', version: '0.8.0', files: {}, sha256: sha(html) });
check('something else the release key signed (a manifest) is no page statement', verifyPage({ statement: manifestLike, sig: sign(manifestLike, rel), sha256: sha(html) }, [rel.pub]).why === 'sig');
const otherApp = st.replace('"my-remote"', '"other-app"');
check('a statement of another program is refused', verifyPage({ statement: otherApp, sig: sign(otherApp, rel), sha256: sha(html) }, [rel.pub]).why === 'sig');
check('nothing, or what is no statement, is "none"', [{}, { statement: st }, { statement: st, sig: 'x'.repeat(300), sha256: sha(html) }, { ...good, sha256: 'abc' }, null].every((o) => verifyPage(o || {}, [rel.pub]).why === 'none'));

// What release/build.js signs is the page a host of that release builds for the default relay.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-page-test-'));
try {
  const keyFile = path.join(dir, 'key.pem');
  const k = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, k.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const pub = k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p));
  const files = new Map(['host/client.template.html', 'host/signal.js', 'host/package.json'].map((p) => [p, read(p)]));
  const { build } = require('./build');
  const r = build({ out: path.join(dir, 'out'), key: keyFile, files, version: '9.9.9', notes: { ko: [], en: [] }, minimum: '0.0.0', needsBase: 1, date: '' });
  const statement = fs.readFileSync(path.join(dir, 'out', 'bundle', 'host', 'page.json'), 'utf8');
  const signature = fs.readFileSync(path.join(dir, 'out', 'bundle', 'host', 'page.sig'), 'utf8').trim();
  const page = builder.build(builder.DEFAULT_SERVER);
  check('release/build.js signs the page a host builds for the default relay, and the manifest lists the statement',
    verifyPage({ statement, sig: signature, sha256: sha(page) }, [pub]).ok && !!r.manifest.files['host/page.json'] && !!r.manifest.files['host/page.sig']);
  check('... a host on another relay builds another page, which that statement does not cover', verifyPage({ statement, sig: signature, sha256: sha(builder.build('https://relay.example')) }, [pub]).why === 'other');
} catch (e) { check('release/build.js signs the page', false, e.message); } finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(failed ? `\n${failed} FAILED (of ${n})` : `\nALL PASS (${n})`);
process.exit(failed ? 1 : 0);
