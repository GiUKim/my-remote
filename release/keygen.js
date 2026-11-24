// Makes the key pair that signs releases (Ed25519), once:
//   node release/keygen.js [--key=<private key file>]
// The private key goes to a file outside the repository (default ~/.pangmote-release/update-signing-key.pem,
// readable by this user only; a key made before the program was renamed in 0.10.0 is used where it is,
// ~/.my-remote-release/: see defaultKey in build.js) and is never printed. The public key is added to app/update-config.json,
// which is part of every installed app: an app installs only what a key listed there has signed.
//
// Whoever has the private key can update every installed app. Keep it on the machine that makes
// releases, keep a copy somewhere safe and offline, and never put it in the repository, a chat or a
// build service's log. If it is lost, apps already installed cannot be updated any more (they must be
// installed anew with a new key); if it leaks, the same, at once. Two keys may be listed: add the new
// one, release a shell with both, and retire the old one once those shells are everywhere.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultKey } = require('./build');

const arg = (process.argv.find((x) => x.startsWith('--key=')) || '').slice(6);
const file = arg ? path.resolve(arg) : defaultKey();
const confFile = path.join(__dirname, '..', 'app', 'update-config.json');

let pem;
if (fs.existsSync(file)) {
  pem = fs.readFileSync(file, 'utf8');
  console.log(`using the key that is there: ${file}`);
} else {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
  console.log(`a new signing key was written to ${file}\nKeep a copy of that file somewhere safe and offline. It is not in the repository and must never be.`);
}
const pub = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
const conf = JSON.parse(fs.readFileSync(confFile, 'utf8'));
conf.keys = Array.isArray(conf.keys) ? conf.keys : [];
if (conf.keys.includes(pub)) console.log('its public key is already in app/update-config.json');
else {
  conf.keys.push(pub);
  fs.writeFileSync(confFile, JSON.stringify(conf, null, 2) + '\n');
  console.log('its public key was added to app/update-config.json (commit that file)');
}
console.log(`public key: ${pub}`);
