// The bridge of the list of PCs (home.html) to the app (client/main.js). The page can name, add, open
// and remove PCs; a key goes in when one is added or replaced and never comes back out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mrHome', {
  info: () => ipcRenderer.invoke('home:info'),           // { version, store: 'os' | 'obscured' | 'none', rolledBack, updates }
  list: () => ipcRenderer.invoke('home:list'),           // { hosts: [{ id, name, pc, os, osName, monitors, addedAt, lastAt, open, connected }], note }
  add: (o) => ipcRenderer.invoke('home:add', o),         // { key, name } -> { ok, id, why }
  rename: (id, name) => ipcRenderer.invoke('home:rename', id, name),
  setKey: (id, key) => ipcRenderer.invoke('home:setKey', id, key),
  open: (id) => ipcRenderer.invoke('home:open', id),     // -> { ok, why }
  close: (id) => ipcRenderer.invoke('home:close', id),
  remove: (id) => ipcRenderer.invoke('home:remove', id),
  checkUpdate: () => ipcRenderer.invoke('home:checkUpdate'), // -> { state, version, error, available: { version, required, kind } | null }
  exit: () => ipcRenderer.invoke('home:exit'), // "나가기": the start screen comes, this list closes
  onChange: (f) => { ipcRenderer.on('home:changed', () => { try { f(); } catch {} }); },
});
