const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dragon', {
  newTab: (url) => ipcRenderer.send('new-tab', url),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  navigate: (id, url) => ipcRenderer.send('navigate', { id, url }),
  goBack: (id) => ipcRenderer.send('go-back', id),
  goForward: (id) => ipcRenderer.send('go-forward', id),
  reload: (id) => ipcRenderer.send('reload', id),

  installExtension: (idOrUrl) => ipcRenderer.invoke('install-extension', idOrUrl),
  listExtensions: () => ipcRenderer.invoke('list-extensions'),
  removeExtension: (id) => ipcRenderer.invoke('remove-extension', id),

  onTabCreated: (cb) => ipcRenderer.on('tab-created', (e, data) => cb(data)),
  onTabClosed: (cb) => ipcRenderer.on('tab-closed', (e, data) => cb(data)),
  onTitleUpdated: (cb) => ipcRenderer.on('tab-title-updated', (e, data) => cb(data)),
  onUrlUpdated: (cb) => ipcRenderer.on('tab-url-updated', (e, data) => cb(data))
});
