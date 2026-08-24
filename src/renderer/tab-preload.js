const { contextBridge, ipcRenderer } = require('electron');

// هذا الـ preload يتحط فقط على صفحاتنا الداخلية (New Tab, صفحة الخطأ, صفحة الإضافات)
// وليس على المواقع الحقيقية — فما يأثرش على أمان أو خصوصية التصفح العادي
contextBridge.exposeInMainWorld('dragon', {
  openDevTools: () => ipcRenderer.send('open-devtools-self'),
  listExtensions: () => ipcRenderer.invoke('list-extensions'),
  installExtension: (idOrUrl) => ipcRenderer.invoke('install-extension', idOrUrl),
  removeExtension: (id) => ipcRenderer.invoke('remove-extension', id),
  toggleExtension: (id, enabled) => ipcRenderer.invoke('toggle-extension', id, enabled)
});
