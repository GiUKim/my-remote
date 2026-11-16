// Whether a client page is one a release signed (the user's go-ahead, 2026-11-16: the code a host sends is
// run with the app's powers only when it is the release's). release/build.js builds the page a host of that
// release serves (for the default relay) and signs a statement of its SHA-256 with the release key
// (host/page.json, host/page.sig in the bundle); the host sends the statement with the page, and the loader
// asks the app (shell:pageCheck) before it runs the page. Signed: the page gets what the app adds to a
// browser (saving files where they were dropped, the clipboard, the click and Ctrl+V after a drop, device
// tokens). Not signed (a host from before 0.8.0, a source folder, another relay, someone posing as the host):
// it runs as it would in a browser.
//
// The keys are the shell's own (update-config.json, which an update of the code cannot change); a test
// may add one of its own (client/main.js --trust-page-key=, with --loader= only).
//
// Electron-free (release/test-pagecheck.js).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP = 'my-remote';
const HEX64 = /^[0-9a-f]{64}$/;

// -> { ok: true, version } | { ok: false, why: 'none' | 'sig' | 'other' }
function verifyPage({ statement, sig, sha256 } = {}, keys = []) {
  if (typeof statement !== 'string' || !statement || statement.length > 2000 || typeof sig !== 'string' || !sig || sig.length > 200 || !HEX64.test(String(sha256))) return { ok: false, why: 'none' };
  const bytes = Buffer.from(statement, 'utf8'), s = Buffer.from(sig.trim(), 'base64');
  const signed = keys.some((k) => {
    try { return crypto.verify(null, bytes, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), s); } catch { return false; }
  });
  if (!signed) return { ok: false, why: 'sig' };
  let st = null;
  try { st = JSON.parse(statement); } catch {}
  if (!st || st.kind !== 'page' || st.app !== APP || !HEX64.test(String(st.sha256))) return { ok: false, why: 'sig' };
  if (st.sha256 !== sha256) return { ok: false, why: 'other' }; // signed, but for another page
  return { ok: true, version: String(st.version || '') };
}

// What a window's page gets (client/shell.js), from the check above (the user's decision, 2026-11-16: no
// disruption for those who update the client app before their host):
//   signed by a release            everything; its PC of the list is remembered as one whose host signs (`pin`)
//   no signature at all, from a PC of the list whose host never sent a signed page (a host from before 0.8.0)
//                                  what it had before 0.8.0: everything but device tokens (`legacy`)
//   anything else                  as in a browser (a bad or another page's signature; a PC whose host signed
//                                  before, so that someone posing as it with the key gains nothing by leaving
//                                  the signature out; a window not of the list)
function decide(r, { listed = false, pinned = false } = {}) {
  if (r && r.ok) return { trusted: true, legacy: false, pin: !!listed };
  if (r && r.why === 'none' && listed && !pinned) return { trusted: true, legacy: true, pin: false };
  return { trusted: false, legacy: false, pin: false };
}

// The release keys of the shell this app runs in: the installed app's (next to app/boot.js, which started it:
// see host/appsync.js shellParts), or a source folder's (app/update-config.json).
function releaseKeys() {
  const shellDir = require.main && require.main.filename ? path.dirname(require.main.filename) : '';
  for (const dir of [shellDir, path.join(__dirname, '..', 'app')].filter(Boolean)) {
    try {
      const conf = JSON.parse(fs.readFileSync(path.join(dir, 'update-config.json'), 'utf8'));
      if (Array.isArray(conf.keys) && conf.keys.length) return conf.keys.filter((k) => typeof k === 'string');
    } catch {}
  }
  return [];
}

module.exports = { verifyPage, decide, releaseKeys, APP };
