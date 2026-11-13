// The client side of a two-machine bench run (see bench.js, bench-peer.js). bench-peer.js on the
// host PC copies this file to the other machine and starts it there over ssh, in that machine's
// Electron under a virtual display; it then drives the client page through this process's
// stdin/stdout: one JSON request per line in, one "@@RPC {...}" line per answer out.
//
// Nothing here is specific to the bench's measurements: it opens the client page it is given and
// runs the JavaScript it is sent in that page. It ends when the ssh session ends, and in any case
// after ten minutes, so nothing is left running on the other machine.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');

let opts = {};
try { opts = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], 'base64').toString('utf8')); } catch {}
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-peer-')));
// The answer must carry this machine's real addresses: there is no STUN in an isolated run.
app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns', ...(opts.disableFeatures || [])].join(','));
if (opts.trials) app.commandLine.appendSwitch('force-fieldtrials', opts.trials);
for (const [k, v] of Object.entries(opts.switches || {})) app.commandLine.appendSwitch(k, String(v));

const out = (o) => process.stdout.write('@@RPC ' + JSON.stringify(o) + '\n');
const cleanup = () => { try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch {} };
setTimeout(() => { cleanup(); app.exit(3); }, 10 * 60 * 1000);

app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myremote-page-'));
  let win = null;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    try {
      let value = null;
      if (m.op === 'open') {
        const file = path.join(dir, 'client.html');
        fs.writeFileSync(file, m.html);
        win = new BrowserWindow({ x: 0, y: 0, width: m.width || 320, height: m.height || 200, webPreferences: { backgroundThrottling: false } });
        // The link emulator on the host needs to know which of the host's addresses the page picked.
        // The message is on the event since Electron 35 (the other machine may run an older one).
        win.webContents.on('console-message', (e, _l, legacy) => {
          const text = String(e && e.message !== undefined ? e.message : legacy);
          if (text.startsWith('BENCH-TARGET ')) { try { out({ event: 'target', value: JSON.parse(text.slice(13)) }); } catch {} }
        });
        await win.loadFile(file, { hash: m.hash });
      } else if (m.op === 'js') value = await win.webContents.executeJavaScript(m.code);
      else if (m.op === 'time') value = performance.timeOrigin + performance.now();
      else if (m.op === 'cpu') value = Math.round(app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0) * 10) / 10;
      else if (m.op === 'info') value = { threads: os.cpus().length, platform: process.platform, gpu: app.getGPUFeatureStatus().video_decode + '/' + app.getGPUFeatureStatus().gpu_compositing };
      out({ id: m.id, ok: true, value });
    } catch (e) { out({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
  });
  rl.on('close', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} cleanup(); app.exit(0); });
  out({ ready: true });
});
