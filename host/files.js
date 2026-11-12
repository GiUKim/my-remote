// File names and places for things that come from the other side: files dragged or pasted in
// (host/main.js) and files dragged out to the client app (client/shell.js). Names are made safe
// part by part and can never leave the folder they are put under.
const fs = require('fs');
const path = require('path');

// Names Windows keeps for devices, also with an extension or spaces after them ('CON.txt', 'nul .',
// 'COM¹.txt'). Node can create such a file, but other programs open the device instead and
// Explorer cannot delete it.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)/i;
const MAX_NAME = 200;
// Windows drops dots and spaces at the end of a name, so a file named that way could not be opened
// or deleted by Explorer and other programs. A half emoji left by shortening goes too.
const trimEnd = (s) => s.replace(/[\ud800-\udbff]$/, '').replace(/[. ]+$/, '');
// A file name that is safe to create on Windows, whatever the other side called the file. A long
// name is shortened before its extension, so the file still opens with the same program.
function safeName(name) {
  let n = trimEnd(String(name).replace(/[\\/]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_'));
  const ext = path.extname(n).length <= 20 ? path.extname(n) : '';
  if (n.length > MAX_NAME) n = trimEnd(n.slice(0, MAX_NAME - ext.length)) + ext;
  if (DEVICE.test(n)) n = 'file' + ext;
  return n || 'file';
}
// "name.ext", or "name (2).ext", "name (3).ext", ... when that is taken.
function freePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) { const f = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`); if (!fs.existsSync(f)) return f; }
  throw new Error('no free file name');
}
// A path inside `base` for a name from the other side ('folder/sub/file.txt').
function stagedPath(base, name) {
  const parts = String(name).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeName).slice(0, 64);
  return path.join(base, ...(parts.length ? parts : ['file']));
}
// Folders under `root` older than `ms` are removed (leftovers of earlier transfers).
function sweep(root, ms) {
  try {
    for (const n of fs.readdirSync(root)) {
      const f = path.join(root, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs > ms) fs.rmSync(f, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

module.exports = { safeName, freePath, stagedPath, sweep };
