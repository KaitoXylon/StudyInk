const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env file
require('dotenv').config({ path: path.join(__dirname, '.env') });

const DriveSyncManager = require('./drive-sync');

// Drive sync singleton (initialized after app is ready)
let driveSync = null;

// Keep a global reference of the window object
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow loading local PDF files
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Custom menu - remove default menu bar
  Menu.setApplicationMenu(null);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-changed', 'maximized');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-changed', 'restored');
  });
}

app.whenReady().then(() => {
  createWindow();
  // Initialize drive sync after app is ready
  driveSync = new DriveSyncManager(app.getPath('userData'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ──────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());

// Open PDF file dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (result.canceled) return null;
  return result.filePaths;
});

// Read file as binary buffer
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { success: true, data: buffer.toString('base64'), path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save file (overwrite)
ipcMain.handle('save-file', async (event, filePath, base64Data) => {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save As dialog
ipcMain.handle('save-file-dialog', async (event, base64Data, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'exported.pdf',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (result.canceled) return { success: false, canceled: true };
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get app data path for storing annotation JSON files
ipcMain.handle('get-userdata-path', () => app.getPath('userData'));

// Save annotation data
ipcMain.handle('save-annotations', async (event, pdfPath, annotationData) => {
  try {
    const userDataPath = app.getPath('userData');
    const annotationsDir = path.join(userDataPath, 'annotations');
    if (!fs.existsSync(annotationsDir)) fs.mkdirSync(annotationsDir, { recursive: true });
    // Use a hash of the file path as filename
    const safeKey = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
    const annotFile = path.join(annotationsDir, `${safeKey}.json`);
    fs.writeFileSync(annotFile, JSON.stringify(annotationData, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Load annotation data
ipcMain.handle('load-annotations', async (event, pdfPath) => {
  try {
    const userDataPath = app.getPath('userData');
    const annotationsDir = path.join(userDataPath, 'annotations');
    const safeKey = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
    const annotFile = path.join(annotationsDir, `${safeKey}.json`);
    if (!fs.existsSync(annotFile)) return { success: true, data: null };
    const data = JSON.parse(fs.readFileSync(annotFile, 'utf8'));
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Load settings
ipcMain.handle('load-settings', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const settingsFile = path.join(userDataPath, 'settings.json');
    if (!fs.existsSync(settingsFile)) return { success: true, data: null };
    return { success: true, data: JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save settings
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const userDataPath = app.getPath('userData');
    const settingsFile = path.join(userDataPath, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Read image from system clipboard
ipcMain.handle('read-clipboard-image', () => {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch (err) {
    console.error('Failed to read clipboard image:', err);
    return null;
  }
});

// Write image to system clipboard
ipcMain.handle('write-clipboard-image', (event, dataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    return { success: true };
  } catch (err) {
    console.error('Failed to write clipboard image:', err);
    return { success: false, error: err.message };
  }
});

// ─── Google Drive IPC Handlers ──────────────────────────────────────────────

ipcMain.handle('drive-get-status', async () => {
  try {
    if (!driveSync) return { connected: false, email: null };
    return await driveSync.getStatus();
  } catch (err) {
    return { connected: false, email: null, error: err.message };
  }
});

ipcMain.handle('drive-connect', async () => {
  try {
    if (!driveSync) return { success: false, error: 'Drive sync not initialized' };
    const result = await driveSync.connect();
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-disconnect', async () => {
  try {
    if (!driveSync) return { success: false };
    return await driveSync.disconnect();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-upload-pdf', async (event, localFilePath) => {
  try {
    if (!driveSync || !driveSync.isConnected()) return { success: false, error: 'Not connected' };
    const result = await driveSync.uploadPDF(localFilePath);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-upload-annotations', async (event, pdfPath, annotationData) => {
  try {
    if (!driveSync || !driveSync.isConnected()) return { success: false, error: 'Not connected' };
    const result = await driveSync.uploadAnnotations(pdfPath, annotationData);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-list-files', async () => {
  try {
    if (!driveSync || !driveSync.isConnected()) return { success: false, error: 'Not connected', files: [] };
    const files = await driveSync.listFiles();
    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message, files: [] };
  }
});

ipcMain.handle('drive-download-file', async (event, fileId, localDestPath) => {
  try {
    if (!driveSync || !driveSync.isConnected()) return { success: false, error: 'Not connected' };
    // Ensure destination directory exists
    const dir = path.dirname(localDestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const result = await driveSync.downloadFile(fileId, localDestPath);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-force-download', async (event, fileId, localDestPath) => {
  try {
    if (!driveSync || !driveSync.isConnected()) return { success: false, error: 'Not connected' };
    const dir = path.dirname(localDestPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const result = await driveSync.forceDownload(fileId, localDestPath);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('drive-download-annotations', async (event, pdfPath) => {
  try {
    if (!driveSync || !driveSync.isConnected()) return null;
    return await driveSync.downloadAnnotations(pdfPath);
  } catch (err) {
    return null;
  }
});

ipcMain.handle('drive-get-downloads-path', () => {
  return app.getPath('downloads');
});

// Rename a PDF file on disk
ipcMain.handle('rename-file', async (event, oldPath, newName) => {
  try {
    if (!newName || !newName.trim()) return { success: false, error: 'Name cannot be empty' };
    // Ensure .pdf extension
    let safeName = newName.trim();
    if (!safeName.toLowerCase().endsWith('.pdf')) safeName += '.pdf';
    // Sanitize: remove illegal chars
    safeName = safeName.replace(/[<>:"/\\|?*]/g, '_');
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, safeName);
    if (newPath === oldPath) return { success: true, newPath, newName: safeName }; // no change
    if (fs.existsSync(newPath)) return { success: false, error: 'A file with that name already exists' };
    fs.renameSync(oldPath, newPath);
    return { success: true, newPath, newName: safeName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

