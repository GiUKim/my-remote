// Runs as a tiny separate process while the host has hidden this PC's cursor.
// If the host process disappears without restoring it (crash, kill), this puts
// the user's real cursors back. Usage: cursor-guard.js <host pid>
// Its work done, it ends at once (TerminateProcess on itself): ending the usual way, through Node's and
// koffi's clean-up, ended in koffi.node with 0xC0000409 four times on the user's PC on 2026-11-16 (the
// cursors had been put back before that). Not reproduced elsewhere; there is nothing left to clean up.
const koffi = require('koffi');
const pid = Number(process.argv[2]);
const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll');
const SystemParametersInfoW = user32.func('SystemParametersInfoW', 'bool', ['uint32', 'uint32', 'uintptr_t', 'uint32']);
const GetCurrentProcess = kernel32.func('GetCurrentProcess', 'uintptr_t', []);
const TerminateProcess = kernel32.func('TerminateProcess', 'bool', ['uintptr_t', 'uint32']);

function alive() {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
if (!pid) process.exit(1);
setInterval(() => {
  if (alive()) return;
  SystemParametersInfoW(0x0057, 0, 0, 0); // SPI_SETCURSORS: reload the user's cursor scheme
  TerminateProcess(GetCurrentProcess(), 0);
  process.exit(0); // only if that failed
}, 1000);
