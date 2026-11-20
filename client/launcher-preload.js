// The bridge of the start screen (launcher.html) to the app (client/main.js): what to show, and the choice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mrStart', {
  // The language (host/i18n.js, through client/main.js): get() -> { lang, strings } for this window's texts,
  // set(code) -> the language then (this PC's choice, the host's too), onChange(f): f(code) when it changed anywhere.
  i18nGet: () => ipcRenderer.sendSync('i18n:sync'),
  i18nSet: (code) => ipcRenderer.invoke('i18n:set', String(code || '')),
  onI18n: (f) => { ipcRenderer.on('i18n:changed', (_e, code) => { try { f(String(code || '')); } catch {} }); },
  info: () => ipcRenderer.invoke('start:info'),               // { version, updates, host: { running, version, behind }, shortcut: { can, has, where } }
  choose: (what, o) => ipcRenderer.invoke('start:choose', what, o), // 'host' | 'client', { shortcut } -> true when done
  checkUpdate: () => ipcRenderer.invoke('start:checkUpdate'), // -> { state, version, error, available: { version, required, kind } | null }
});
