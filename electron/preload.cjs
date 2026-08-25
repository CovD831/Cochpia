const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  getModelConfig: () => ipcRenderer.invoke('desktop:get-model-config'),
  saveModelConfig: payload => ipcRenderer.invoke('desktop:save-model-config', payload),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),
  showAbout: () => ipcRenderer.invoke('desktop:show-about'),
  onServerError: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('desktop:server-error', listener);
    return () => ipcRenderer.removeListener('desktop:server-error', listener);
  }
});
