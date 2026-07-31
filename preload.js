const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onWindowStateChange: (cb) => ipcRenderer.on('window-state-changed', (e, state) => cb(state)),

  // File operations
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (filePath, base64Data) => ipcRenderer.invoke('save-file', filePath, base64Data),
  saveFileDialog: (base64Data, defaultName) => ipcRenderer.invoke('save-file-dialog', base64Data, defaultName),

  // Annotations
  saveAnnotations: (pdfPath, data) => ipcRenderer.invoke('save-annotations', pdfPath, data),
  loadAnnotations: (pdfPath) => ipcRenderer.invoke('load-annotations', pdfPath),

  // Settings
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Clipboard
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
  writeClipboardImage: (dataUrl) => ipcRenderer.invoke('write-clipboard-image', dataUrl),
});
