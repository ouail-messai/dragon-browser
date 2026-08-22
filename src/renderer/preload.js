const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dragon', {
  newTab: (url) => ipcRenderer.send('new-tab', url),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  navigate: (id, url) => ipcRenderer.send('navigate', { id, url }),
  goBack: (id) => ipcRenderer.send('go-back', id),
  goForward: (id) => ipcRenderer.send('go-forward', id),
  reload: (id) => ipcRenderer.send('reload', id),

  onTabCreated: (cb) => ipcRenderer.on('tab-created', (e, data) => cb(data)),
  onTabClosed: (cb) => ipcRenderer.on('tab-closed', (e, data) => cb(data)),
  onTitleUpdated: (cb) => ipcRenderer.on('tab-title-updated', (e, data) => cb(data)),
  onUrlUpdated: (cb) => ipcRenderer.on('tab-url-updated', (e, data) => cb(data))
});
