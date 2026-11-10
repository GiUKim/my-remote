// My Remote client app: a thin window around the same client page a browser uses.
// It loads the loader file, which fetches the current page from the host, so this
// app does not need updating when the client changes. See shell.js for what it adds.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const shell = require('./shell');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'My Remote', autoHideMenuBar: true, backgroundColor: '#14171c',
    webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false },
  });
  shell.attach(win);
  win.loadFile(path.join(__dirname, '..', 'my-remote-client.html'));
});
app.on('window-all-closed', () => app.quit());
