// Preload — exposes a small, safe IPC surface to the setup window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brainSync', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),
});
