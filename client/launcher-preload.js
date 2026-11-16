// The bridge of the start screen (launcher.html) to the app (client/main.js): what to show, and the choice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mrStart', {
  info: () => ipcRenderer.invoke('start:info'),               // { version, updates, host: { running, version, behind }, shortcut: { can, has, where } }
  choose: (what, o) => ipcRenderer.invoke('start:choose', what, o), // 'host' | 'client', { shortcut } -> true when done
  checkUpdate: () => ipcRenderer.invoke('start:checkUpdate'), // -> { state, version, error, available: { version, required, kind } | null }
});
