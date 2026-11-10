const { contextBridge, ipcRenderer } = require('electron');

// Seen by the client page as window.mrShell; its presence tells the page it runs in the app.
contextBridge.exposeInMainWorld('mrShell', {
  screens: () => ipcRenderer.invoke('shell:screens'),
  fullscreenAll: () => ipcRenderer.invoke('shell:fullscreenAll'),
});
