const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('personalWorkbenchDesktop', Object.freeze({
  isDesktop: true,
  selectFile: () => ipcRenderer.invoke('desktop:pick-input', { kind: 'file', multiple: false }),
  selectFiles: () => ipcRenderer.invoke('desktop:pick-input', { kind: 'file', multiple: true }),
  selectDirectory: () => ipcRenderer.invoke('desktop:pick-input', { kind: 'directory', multiple: false }),
  openPath: path => ipcRenderer.invoke('desktop:open-path', path),
  showItemInFolder: path => ipcRenderer.invoke('desktop:show-item-in-folder', path),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url),
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  getCloseBehavior: () => ipcRenderer.invoke('desktop:get-close-behavior'),
  setCloseBehavior: value => ipcRenderer.invoke('desktop:set-close-behavior', value),
  installModel: model => ipcRenderer.invoke('desktop:install-model', model),
  cancelModelInstall: () => ipcRenderer.invoke('desktop:cancel-model-install'),
  exportDiagnostics: () => ipcRenderer.invoke('desktop:export-diagnostics'),
  onModelProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:model-progress', listener)
    return () => ipcRenderer.removeListener('desktop:model-progress', listener)
  },
  onNavigate: callback => {
    const listener = (_event, page) => callback(page)
    ipcRenderer.on('desktop:navigate', listener)
    return () => ipcRenderer.removeListener('desktop:navigate', listener)
  },
}))
