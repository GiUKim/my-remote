const { contextBridge, ipcRenderer } = require('electron');

// Seen by the client page as window.mrShell; its presence tells the page it runs in the app.
contextBridge.exposeInMainWorld('mrShell', {
  screens: () => ipcRenderer.invoke('shell:screens'),
  fullscreenAll: () => ipcRenderer.invoke('shell:fullscreenAll'),
  // Things dragged out of the remote picture (see shell.js).
  dropPoint: () => ipcRenderer.invoke('shell:dropPoint'),
  dropText: (id, text) => ipcRenderer.invoke('shell:dropText', id, text),
  fileBegin: (name) => ipcRenderer.invoke('shell:fileBegin', name),
  fileChunk: (id, bytes) => ipcRenderer.invoke('shell:fileChunk', id, bytes),
  fileEnd: (id) => ipcRenderer.invoke('shell:fileEnd', id),
  dropFiles: (id, ids) => ipcRenderer.invoke('shell:dropFiles', id, ids),
});
