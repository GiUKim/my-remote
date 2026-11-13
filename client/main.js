// My Remote client app: a thin window around the same client page a browser uses.
// It loads the loader file, which fetches the current page from the host, so this
// app does not need updating when the client changes. See shell.js for what it adds.
const { app, BrowserWindow, dialog, shell: openWith } = require('electron');
const path = require('path');
const shell = require('./shell');

// --loader=<file>: show that loader file instead of the one in the repository, with a profile of its own
// in a folder next to it, so the app's own profile (and a key kept there) is left alone. The host's
// self-test (--client-app-check) runs the app this way on a loader that talks only to the test's relay.
const alt = (process.argv.find((a) => a.startsWith('--loader=')) || '').slice('--loader='.length);
if (alt) app.setPath('userData', path.join(path.dirname(path.resolve(alt)), 'client-app-profile'));

// The installed app (started by app/boot.js, see host/main.js): the shell finds and installs updates of
// the app itself - this file, shell.js and preload.js, which the host cannot send as it does the page.
// Here the person is asked about an ordinary one; a required one is installed without asking and only
// the restart is announced. Run from a source folder there is no shell.
const APP = global.__mrApp || null;
function watchUpdates(win) {
  const u = APP.update;
  let asked = '';
  const notes = (a) => ((a.notes && a.notes.ko) || []).map((s) => '· ' + s).join('\n');
  u.onChange(async (s) => {
    const a = s.available;
    if (!a || s.state !== 'available' || asked === a.version || a.required || win.isDestroyed()) return;
    asked = a.version;
    if (a.kind === 'package') {
      const r = await dialog.showMessageBox(win, { type: 'info', noLink: true, buttons: ['내려받기 페이지 열기', '나중에'], defaultId: 0, cancelId: 1,
        message: `새 버전 ${a.version}이 있습니다`, detail: '이 버전은 새 설치 파일이 필요합니다. 내려받아 다시 설치해 주세요.\n\n' + notes(a) });
      if (r.response === 0 && APP.downloads) openWith.openExternal(APP.downloads).catch(() => {});
      return;
    }
    const r = await dialog.showMessageBox(win, { type: 'info', noLink: true, buttons: ['지금 업데이트', '나중에'], defaultId: 0, cancelId: 1,
      message: `새 버전 ${a.version}이 있습니다`, detail: `${notes(a)}\n\n업데이트하면 앱이 다시 시작됩니다. 원격 접속 중이면 다시 연결해야 합니다. (현재 v${APP.version})`.trim() });
    if (r.response === 0) u.install().catch((e) => dialog.showErrorBox('My Remote', '업데이트하지 못했습니다: ' + e.message));
  });
  u.setCanRestart(async (s) => {
    if (win.isDestroyed()) return true;
    const told = dialog.showMessageBox(win, { type: 'warning', noLink: true, buttons: ['다시 시작'],
      message: `중요 업데이트 ${s.available ? s.available.version : ''}을 설치했습니다`, detail: '이 버전의 심각한 문제를 고친 업데이트입니다. 확인을 누르면 앱이 다시 시작됩니다(10분 뒤에는 자동으로 다시 시작합니다).' });
    await Promise.race([told, new Promise((r) => setTimeout(r, 10 * 60e3))]);
    return true;
  });
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'My Remote' + (APP ? ` ${APP.version}` : ''), autoHideMenuBar: true, backgroundColor: '#14171c',
    webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false },
  });
  shell.attach(win);
  win.loadFile(alt ? path.resolve(alt) : path.join(__dirname, '..', 'my-remote-client.html'));
  if (APP) {
    // This version counts as up once its window has shown its page for a while (see app/boot.js).
    win.webContents.once('did-finish-load', () => setTimeout(() => { if (!win.isDestroyed()) APP.ok(); }, 4000));
    if (APP.update && !alt) watchUpdates(win);
  }
});
app.on('window-all-closed', () => app.quit());
