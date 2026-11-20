// The bridge of the list of PCs (home.html) to the app (client/main.js). The page can name, add, open
// and remove PCs; a key goes in when one is added or replaced and never comes back out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mrHome', {
  // The language (host/i18n.js, through client/main.js): get() -> { lang, strings } for this window's texts,
  // set(code) -> the language then (this PC's choice, the host's too), onChange(f): f(code) when it changed anywhere.
  i18nGet: () => ipcRenderer.sendSync('i18n:sync'),
  i18nSet: (code) => ipcRenderer.invoke('i18n:set', String(code || '')),
  onI18n: (f) => { ipcRenderer.on('i18n:changed', (_e, code) => { try { f(String(code || '')); } catch {} }); },
  info: () => ipcRenderer.invoke('home:info'),           // { version, store: 'os' | 'obscured' | 'none', rolledBack, updates }
  list: () => ipcRenderer.invoke('home:list'),           // { hosts: [{ id, name, pc, os, osName, monitors, addedAt, lastAt, open, connected }], note }
  add: (o) => ipcRenderer.invoke('home:add', o),         // { key, name } -> { ok, id, why }
  rename: (id, name) => ipcRenderer.invoke('home:rename', id, name),
  setKey: (id, key) => ipcRenderer.invoke('home:setKey', id, key),
  open: (id) => ipcRenderer.invoke('home:open', id),     // -> { ok, why }
  oneTime: (code) => ipcRenderer.invoke('home:oneTime', code), // a one-time code from someone's host window -> { ok, why }: a window of its own, not in the list
  close: (id) => ipcRenderer.invoke('home:close', id),
  remove: (id) => ipcRenderer.invoke('home:remove', id),
  checkUpdate: () => ipcRenderer.invoke('home:checkUpdate'), // -> { state, version, error, available: { version, required, kind } | null }
  exit: () => ipcRenderer.invoke('home:exit'), // "나가기": the start screen comes, this list closes
  onChange: (f) => { ipcRenderer.on('home:changed', () => { try { f(); } catch {} }); },
});
