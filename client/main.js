// My Remote client app: a thin window around the same client page a browser uses.
// It loads the loader file, which fetches the current page from the host, so this
// app does not need updating when the client changes. See shell.js for what it adds.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const shell = require('./shell');

// --loader=<file>: show that loader file instead of the one in the repository, with a profile of its own
// in a folder next to it, so the app's own profile (and a key kept there) is left alone. The host's
// self-test (--client-app-check) runs the app this way on a loader that talks only to the test's relay.
const alt = (process.argv.find((a) => a.startsWith('--loader=')) || '').slice('--loader='.length);
if (alt) app.setPath('userData', path.join(path.dirname(path.resolve(alt)), 'client-app-profile'));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'My Remote', autoHideMenuBar: true, backgroundColor: '#14171c',
    webPreferences: { preload: shell.PRELOAD, backgroundThrottling: false },
  });
  shell.attach(win);
  win.loadFile(alt ? path.resolve(alt) : path.join(__dirname, '..', 'my-remote-client.html'));
});
app.on('window-all-closed', () => app.quit());
