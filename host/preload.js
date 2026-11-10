const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  getConfig: () => ipcRenderer.invoke('cfg'),
  getSources: () => ipcRenderer.invoke('sources'),
  input: (text) => ipcRenderer.send('input', text),
  log: (text) => ipcRenderer.send('log', text),
  cursor: () => ipcRenderer.invoke('cursor'),
  readClip: () => ipcRenderer.invoke('clip-read'),
  writeClip: (text) => ipcRenderer.send('clip-write', text),
  session: (live) => ipcRenderer.send('session', live),
  onKick: (fn) => ipcRenderer.on('kick', () => fn()),
  onDisplaysChanged: (fn) => ipcRenderer.on('displays-changed', () => fn()),
  copyKey: () => ipcRenderer.invoke('copy-key'),
  regenKey: () => ipcRenderer.invoke('regen-key'),
  exportClient: () => ipcRenderer.invoke('export-client'),
});
