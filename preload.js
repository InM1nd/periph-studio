'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (method, ...args) => ipcRenderer.invoke('kb:call', method, ...args);

contextBridge.exposeInMainWorld('kb', {
  getState: () => ipcRenderer.invoke('kb:state'),
  getModes: () => ipcRenderer.invoke('kb:modes'),
  readInfo: () => call('readInfo'),
  readLight: () => call('readLight'),
  readKeymap: () => call('readKeymap'),
  setLight: (s) => call('setLight', s),
  setReportRate: (r) => call('setReportRate', r),
  setOption: (n, v) => call('setOption', n, v),
  factoryReset: () => call('factoryReset'),
  writeKeymap: (entries) => ipcRenderer.invoke('keymap:write', entries),
  restoreKeymap: () => ipcRenderer.invoke('keymap:restore'),
  backupInfo: () => ipcRenderer.invoke('keymap:backupInfo'),
  openBackups: () => ipcRenderer.invoke('keymap:openBackups'),
  onState: (cb) => ipcRenderer.on('kb:state', (_e, s) => cb(s)),
  devices: {
    list: () => ipcRenderer.invoke('devices:list'),
    report: (id) => ipcRenderer.invoke('devices:report', id),
  },
  sonix: {
    getState: () => ipcRenderer.invoke('sonix:state'),
    setLight: (s) => ipcRenderer.invoke('sonix:setLight', s),
    onState: (cb) => ipcRenderer.on('sonix:state', (_e, s) => cb(s)),
  },
  via: {
    getState: () => ipcRenderer.invoke('via:state'),
    setLight: (p, ch, s) => ipcRenderer.invoke('via:setLight', p, ch, s),
    onState: (cb) => ipcRenderer.on('via:state', (_e, s) => cb(s)),
  },
  mouse: {
    getState: () => ipcRenderer.invoke('mouse:state'),
    refresh: () => ipcRenderer.invoke('mouse:refresh'),
    setDpi: (idx, dpi) => ipcRenderer.invoke('mouse:setDpi', idx, dpi),
    setRate: (idx, ms) => ipcRenderer.invoke('mouse:setRate', idx, ms),
    onState: (cb) => ipcRenderer.on('mouse:state', (_e, s) => cb(s)),
  },
  kt87: {
    getState: () => ipcRenderer.invoke('kt87:state'),
    getMeta: () => ipcRenderer.invoke('kt87:meta'),
    setLight: (s) => ipcRenderer.invoke('kt87:setLight', s),
    onState: (cb) => ipcRenderer.on('kt87:state', (_e, s) => cb(s)),
  },
  onLog: (cb) => ipcRenderer.on('kb:log', (_e, l) => cb(l)),
});
