const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qt', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  spawn: (id, cols, rows, opts) => ipcRenderer.send('pty:spawn', id, cols, rows, opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  isDir: (p) => ipcRenderer.invoke('fs:isDir', p),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),
  onInfo: (cb) => ipcRenderer.on('pty:info', (_e, info) => cb(info)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action, arg) => cb(action, arg)),

  // 獨立視窗
  popout: (id, payload) => ipcRenderer.send('session:popout', id, payload),
  popData: (id) => ipcRenderer.invoke('session:popdata', id),
  dock: (id, serialized) => ipcRenderer.send('session:dock', id, serialized),
  requestDock: (id) => ipcRenderer.send('session:requestDock', id),
  focusPopout: (id) => ipcRenderer.send('session:focusPopout', id),
  setPopTitle: (id, title) => ipcRenderer.send('session:title', id, title),
  onDocked: (cb) => ipcRenderer.on('session:docked', (_e, id, serialized, exited) => cb(id, serialized, exited)),
  onRequestDock: (cb) => ipcRenderer.on('session:requestDock', () => cb()),

  copy: (text) => ipcRenderer.send('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),
  openUrl: (url) => ipcRenderer.send('open:url', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform
});
