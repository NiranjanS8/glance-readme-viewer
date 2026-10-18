// Preload bridge: the ONLY Node/Electron access the renderer gets.
// Renderer never touches fs, dialog, or shell directly.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Opens the native file dialog via main; resolves to { filePath, content } or null.
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // Reads a known path (used for drag-and-drop where renderer only has a path string).
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  // Real filesystem path behind a dropped File. The non-standard File.path
  // was removed in Electron 32, so dropped files carry no path otherwise.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Fired when main opened a file via menu/shortcut.
  onFileOpened: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('file:opened', listener);
    return () => ipcRenderer.removeListener('file:opened', listener);
  },

  // Fired when View > Toggle Theme (or CmdOrCtrl+T) is used.
  onToggleTheme: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('view:toggle-theme', listener);
    return () => ipcRenderer.removeListener('view:toggle-theme', listener);
  },

  // Open a URL in the user's default browser.
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // Keep the native window title in sync with the open file.
  setTitle: (fileName) => ipcRenderer.send('window:setTitle', fileName)
});
