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

  // Google Drive Sync
  driveGetStatus: () => ipcRenderer.invoke('drive-get-status'),
  driveConnect: () => ipcRenderer.invoke('drive-connect'),
  driveDisconnect: () => ipcRenderer.invoke('drive-disconnect'),
  driveUploadPDF: (localFilePath) => ipcRenderer.invoke('drive-upload-pdf', localFilePath),
  driveUploadAnnotations: (pdfPath, data) => ipcRenderer.invoke('drive-upload-annotations', pdfPath, data),
  driveListFiles: () => ipcRenderer.invoke('drive-list-files'),
  driveDownloadFile: (fileId, localDestPath) => ipcRenderer.invoke('drive-download-file', fileId, localDestPath),
  driveForceDownload: (fileId, localDestPath) => ipcRenderer.invoke('drive-force-download', fileId, localDestPath),
  driveDownloadAnnotations: (pdfPath) => ipcRenderer.invoke('drive-download-annotations', pdfPath),
  driveGetDownloadsPath: () => ipcRenderer.invoke('drive-get-downloads-path'),

  // File operations
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
});
