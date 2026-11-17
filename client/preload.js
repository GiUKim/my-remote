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

// A window the app opened for one of the PCs in its list (client/main.js): the loader in it is not to
// ask the person for the key. It gets that PC's key from the app, put into the loader's own field (with
// "keep it in this browser" off, where a loader from before 2026-11-16 has that box), and its button is
// pressed - once, for the document this window loads (the loader; the page the loader then writes in its
// place is not touched). So the key is never part of an address and is not kept in this window's
// storage. A PC that gave this app a token of its own (bootDevice below) has no key here: the app hands
// out none for it, and the loader connects with the token.
let inList = false, hasCode = false;
try { inList = ipcRenderer.sendSync('shell:inList') === true; } catch {}
// A window the app opened for a one-time code (from 0.9.0): the code goes into the loader's field the same way.
try { hasCode = !inList && ipcRenderer.sendSync('shell:hasCode') === true; } catch {}
if (inList || hasCode) {
  window.addEventListener('DOMContentLoaded', async () => {
    const field = document.getElementById('key'), go = document.getElementById('go'), keep = document.getElementById('remember');
    if (!field || !go) return; // not the loader
    let key = null;
    try { key = await ipcRenderer.invoke(inList ? 'shell:bootKey' : 'shell:bootCode'); } catch {}
    if (!key || document.getElementById('key') !== field) return; // no key to be had, or the loader has gone on meanwhile
    field.value = key;
    if (keep) keep.checked = false;
    go.click();
  }, { once: true });
}

// Seen by the client page as window.mrShell; its presence tells the page it runs in the app.
contextBridge.exposeInMainWorld('mrShell', {
  // Only in a window opened from the app's list of PCs (from 2026-11-14 on; the page must not rely on
  // them): hostInfo tells the list about this session - { connected, os, name, pc, monitors } - and home
  // brings the list's window forward.
  ...(inList ? {
    hostInfo: (info) => ipcRenderer.invoke('shell:hostInfo', info),
    home: () => ipcRenderer.invoke('shell:home'),
    // This PC as a device of that host (from 2026-11-16 on; the page and the loader must not rely on them):
    // bootDevice -> { id, secret } | null, the token the loader connects with instead of the key (once the
    // key is let go); deviceHello -> what the host is told about this PC when it gives it a token;
    // devicePaired({ id, secret }) keeps the token the host gave; deviceVerified(fp): the token with that
    // hash worked, so the app lets go of the key.
    bootDevice: () => ipcRenderer.invoke('shell:bootDevice'),
    deviceHello: () => ipcRenderer.invoke('shell:deviceHello'),
    devicePaired: (dev) => ipcRenderer.invoke('shell:devicePaired', dev),
    deviceVerified: (id) => ipcRenderer.invoke('shell:deviceVerified', id),
  } : {}),
  // The loader asks before it runs the page the host sent (from 2026-11-16 on): { statement, sig, sha256 } ->
  // whether a release signed it. Only such a page gets the app's powers below (files, the clipboard, ...).
  pageCheck: (o) => ipcRenderer.invoke('shell:pageCheck', o),
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
