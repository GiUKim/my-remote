const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Seen by the client page as window.mrShell; its presence tells the page it runs in the app.
contextBridge.exposeInMainWorld('mrShell', {
  screens: () => ipcRenderer.invoke('shell:screens'),
  fullscreenAll: () => ipcRenderer.invoke('shell:fullscreenAll'),
  // Things dragged out of the remote picture (see shell.js).
  dropPoint: () => ipcRenderer.invoke('shell:dropPoint'),
  dropText: (id, text) => ipcRenderer.invoke('shell:dropText', id, text),
  fileBegin: (name, group) => ipcRenderer.invoke('shell:fileBegin', name, group),
  makeDir: (name, group) => ipcRenderer.invoke('shell:makeDir', name, group),
  fileChunk: (id, bytes) => ipcRenderer.invoke('shell:fileChunk', id, bytes),
  fileEnd: (id) => ipcRenderer.invoke('shell:fileEnd', id),
  // A transfer cut off part-way: the file (from fileBegin) and the rest of its transfer are thrown away.
  fileAbort: (id) => ipcRenderer.invoke('shell:fileAbort', id),
  dropFiles: (id, ids, group) => ipcRenderer.invoke('shell:dropFiles', id, ids, group),
  // Whether the real pointer is over one of this client's windows right now: true, false (another
  // program), or null (cannot be told here; only on Windows).
  pointerOwn: () => ipcRenderer.invoke('shell:pointerOwn'),
  // Where a file or folder dropped on the page is on this PC (for reading a dropped folder here).
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
