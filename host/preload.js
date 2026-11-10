const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  getConfig: () => ipcRenderer.invoke('cfg'),
  getSources: () => ipcRenderer.invoke('sources'),
  getClientApp: () => ipcRenderer.invoke('client-app'),
  input: (text) => ipcRenderer.send('input', text),
  log: (text) => ipcRenderer.send('log', text),
  cursor: () => ipcRenderer.invoke('cursor'),
  hideCursor: (on) => ipcRenderer.invoke('cursor-hide', on),
  readClip: (lastSeq) => ipcRenderer.invoke('clip-read', lastSeq),
  writeClip: (text) => ipcRenderer.send('clip-write', text),
  session: (live) => ipcRenderer.send('session', live),
  onKick: (fn) => ipcRenderer.on('kick', () => fn()),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays-changed', () => fn()),
  copyKey: () => ipcRenderer.invoke('copy-key'),
  regenKey: () => ipcRenderer.invoke('regen-key'),
  exportClient: () => ipcRenderer.invoke('export-client'),
});
