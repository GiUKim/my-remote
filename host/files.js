// File names and places for things that come from the other side (files dragged or pasted in).
// Names are made safe part by part and can never leave the folder they are put under.
const fs = require('fs');
const path = require('path');

// A file name that is safe to create on Windows, whatever the other side called the file.
function safeName(name) {
  const n = String(name).replace(/[\\/]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 200);
  return n && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n) ? n : 'file';
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
