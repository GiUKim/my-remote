const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The window was minimized or hidden, or is back (shell.js). The app keeps its windows running
// (backgroundThrottling off), so the page's document.visibilityState never says 'hidden'; this mark on
// the document says it instead, and the page (which reads every window's document) stops asking the
// host for what this window shows. From 2026-11-13 on; the page must not rely on it.
ipcRenderer.on('shell:shown', (_e, shown) => {
  const el = document.documentElement;
  if (!el) return;
  if (shown) delete el.dataset.mrHidden; else el.dataset.mrHidden = '1';
  document.dispatchEvent(new Event('mrshown'));
});

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
  // What is being carried out of the remote picture, shown beside the real pointer while it is outside
  // the picture: { on, kind: 'files' | 'text', label }. From 2026-11-13 on; the page must not rely on it.
  dragGhost: (o) => ipcRenderer.invoke('shell:dragGhost', o),
  // The clipboard shared with the host (see shell.js): what changed here since `seq`, and text from the host.
  clipPoll: (seq) => ipcRenderer.invoke('shell:clipPoll', seq),
  clipWrite: (text) => ipcRenderer.invoke('shell:clipWrite', text),
  // Where a file or folder dropped on the page is on this PC (for reading a dropped folder here).
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
