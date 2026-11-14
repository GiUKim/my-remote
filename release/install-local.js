// Puts the release in dist/release into the installed app of this PC (of this user), exactly as the
// app's updater does after fetching the same three files from the feed: the manifest must be signed by
// a key in app/update-config.json, the bundle must be the one it names, and the app takes the version
// at its next start, on trial (it goes back by itself when the version does not come up).
//   node release/install-local.js [--release=dist/release] [--root=<the app's data folder>] [--dry]
// For a PC whose app cannot reach a feed (there is none yet), and for trying a release on the real
// app before it is published. Nothing of the app's own folder is touched, and a running app is not
// disturbed: it reads this at its next start. To undo: delete the version's folder under
// <data folder>/versions (the app then runs the one before).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../app/core');

const ROOT = path.join(__dirname, '..');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? path.resolve(a.slice(name.length + 3)) : ''; };
// The data folder, as app/boot.js finds it.
function dataRoot() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'my-remote', 'app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'my-remote', 'app');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'my-remote', 'app');
}

try {
  const release = arg('release') || path.join(ROOT, 'dist', 'release'), root = arg('root') || dataRoot(), dry = process.argv.includes('--dry');
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'update-config.json'), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8')).base;
  const bytes = fs.readFileSync(path.join(release, 'latest.json')), sig = fs.readFileSync(path.join(release, 'latest.json.sig'), 'utf8');
  const manifest = core.verifyManifest(bytes, sig, conf.keys); // throws when it is not a release this app trusts
  if (manifest.needsBase > base) throw new Error(`release ${manifest.version} needs a newer app (shell ${manifest.needsBase}); install the new package instead`);
  const bundle = fs.readFileSync(path.join(release, manifest.bundle.file));
  const st = core.readState(root);
  console.log(`data folder: ${root}`);
  console.log(`installed there now: ${st.current || 'nothing (the app runs the version it came with)'}${st.trial ? ' (on trial)' : ''}`);
  if (st.bad[manifest.version]) throw new Error(`${manifest.version} is marked as not starting on this PC (${st.bad[manifest.version]}); it would not be run`);
  if (st.current && core.cmp(manifest.version, st.current) <= 0) { console.log(`release ${manifest.version} is not newer: nothing to do`); process.exit(0); }
  if (dry) { console.log(`would install ${manifest.version} (${Object.keys(manifest.files).length} files)`); process.exit(0); }
  core.installVersion(root, manifest, bytes, sig, bundle);
  const check = core.verifyFolder(core.versionDir(root, manifest.version), conf.keys);
  if (!check.ok) throw new Error('what was written does not verify: ' + check.why);
  core.activate(root, manifest.version, st.current ? { source: 'installed', version: st.current } : null);
  console.log(`installed ${manifest.version}: the app runs it from its next start (on trial; a version that came with the app and is newer is still preferred)`);
} catch (e) {
  console.error('not installed: ' + e.message);
  process.exit(1);
}
