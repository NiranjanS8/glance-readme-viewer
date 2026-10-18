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

  // Fired when the open file changed on disk, carrying its fresh contents.
  onFileChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('file:changed', listener);
    return () => ipcRenderer.removeListener('file:changed', listener);
  },

  // Fired when the open file is deleted or renamed away.
  onFileMissing: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('file:missing', listener);
    return () => ipcRenderer.removeListener('file:missing', listener);
  },

  // Fired when View > Toggle Theme (or CmdOrCtrl+T) is used.
  onToggleTheme: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('view:toggle-theme', listener);
    return () => ipcRenderer.removeListener('view:toggle-theme', listener);
  },

  // Fired when View > Toggle Sidebar (or CmdOrCtrl+B) is used.
  onToggleSidebar: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('view:toggle-sidebar', listener);
    return () => ipcRenderer.removeListener('view:toggle-sidebar', listener);
  },

  // Fired when View > Switch to File (or CmdOrCtrl+1-9) is used; position is
  // 1-based into the sidebar list.
  onSelectFile: (callback) => {
    const listener = (_event, position) => callback(position);
    ipcRenderer.on('view:select-file', listener);
    return () => ipcRenderer.removeListener('view:select-file', listener);
  },

  // Table of contents preference, owned by main so the View menu checkbox and
  // the panel agree between launches.
  getTocEnabled: () => ipcRenderer.invoke('toc:get-enabled'),

  // Fired when View > Table of Contents (or CmdOrCtrl+Shift+O) is used.
  onTocEnabledChanged: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('toc:enabled-changed', listener);
    return () => ipcRenderer.removeListener('toc:enabled-changed', listener);
  },

  // Open a URL in the user's default browser.
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // Keep the native window title in sync with the open file.
  setTitle: (fileName) => ipcRenderer.send('window:setTitle', fileName)
});
