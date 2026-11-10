// Runs as a tiny separate process while the host has hidden this PC's cursor.
// If the host process disappears without restoring it (crash, kill), this puts
// the user's real cursors back. Usage: cursor-guard.js <host pid>
const koffi = require('koffi');
const pid = Number(process.argv[2]);
const user32 = koffi.load('user32.dll');
const SystemParametersInfoW = user32.func('SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'uintptr_t', 'uint32']);

function alive() {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
if (!pid) process.exit(1);
setInterval(() => {
  if (alive()) return;
  SystemParametersInfoW(0x0057, 0, 0, 0); // SPI_SETCURSORS: reload the user's cursor scheme
  process.exit(0);
}, 1000);
