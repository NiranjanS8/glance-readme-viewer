const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { createFileWatcher } = require('./watcher');

const ALLOWED_EXTS = new Set(['.md', '.markdown', '.mdown', '.txt']);

let mainWindow = null;
let activeFilePath = null;
let settings = { liveReload: true };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    title: 'Glance',
    backgroundColor: '#F7F6F2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    fileWatcher.stop();
    mainWindow = null;
  });

  // Never navigate inside the app window; open http(s) externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

// Live reload: only the file the window is showing is watched, and only in
// the main process — the renderer receives fresh contents (or a missing-file
// notice) over IPC.
const fileWatcher = createFileWatcher({
  onChange: ({ filePath, content }) => {
    if (!mainWindow || filePath !== activeFilePath) return;
    mainWindow.webContents.send('file:changed', { filePath, content });
  },
  onMissing: ({ filePath }) => {
    if (!mainWindow || filePath !== activeFilePath) return;
    mainWindow.webContents.send('file:missing', { filePath });
  }
});

// --- Live reload preference, kept in userData/settings.json ---

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
  } catch {
    // first launch, or a settings file we cannot use
  }
  settings = { liveReload: stored.liveReload !== false };
}

async function saveSettings() {
  try {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // preferences are best-effort; the app works without them
  }
}

// Off means no watcher runs at all, for this file and the next one opened.
function watchActiveFile() {
  if (settings.liveReload) {
    fileWatcher.watch(activeFilePath);
  } else {
    fileWatcher.stop();
  }
}

// Every open path (menu, shortcut, dialog, drag-and-drop, sidebar) ends up
// here, so the watcher always follows what the window is showing.
function setActiveFile(filePath) {
  activeFilePath = filePath;
  if (mainWindow) mainWindow.setTitle(`${path.basename(filePath)} — Glance`);
  watchActiveFile();
}

function setLiveReload(enabled) {
  settings.liveReload = enabled;
  saveSettings();
  const item = Menu.getApplicationMenu()?.getMenuItemById('liveReload');
  if (item) item.checked = enabled;
  watchActiveFile();
}

async function openFileDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    setActiveFile(filePath);
    return { filePath, content };
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open file',
      message: `Could not read ${filePath}: ${err.message}`
    });
    return null;
  }
}

// The zoom roles only run from the native menu, and the zoomIn role's own
// accelerator is Ctrl+Plus, so the steps live here: this keeps Ctrl+= working
// and makes the step size explicit.
function zoomBy(steps) {
  if (!mainWindow) return;
  const level = mainWindow.webContents.getZoomLevel();
  mainWindow.webContents.setZoomLevel(level + steps);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const opened = await openFileDialog();
            if (opened && mainWindow) {
              mainWindow.webContents.send('file:opened', opened);
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'liveReload',
          label: 'Live Reload',
          type: 'checkbox',
          checked: settings.liveReload,
          accelerator: 'CmdOrCtrl+Shift+L',
          click: (item) => setLiveReload(item.checked)
        },
        {
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('view:toggle-theme');
          }
        },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('view:toggle-sidebar');
          }
        },
        {
          label: 'Switch to File',
          submenu: Array.from({ length: 9 }, (_, i) => ({
            label: String(i + 1),
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: () => {
              if (mainWindow) mainWindow.webContents.send('view:select-file', i + 1);
            }
          }))
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => zoomBy(0.5)
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomBy(-0.5)
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            if (mainWindow) mainWindow.webContents.setZoomLevel(0);
          }
        },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Glance',
          click: async () => {
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Glance',
              message: 'Glance — README viewer.\nOpen a .md file via File > Open or drag-and-drop.'
            });
          }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  await loadSettings();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  fileWatcher.stop();
});

// --- IPC: renderer asks main to open a dialog + read the file ---
ipcMain.handle('dialog:openFile', () => openFileDialog());

// --- IPC: renderer has a path (e.g. from drag-and-drop) and needs contents ---
ipcMain.handle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    setActiveFile(filePath);
    return { filePath, content };
  } catch {
    return null;
  }
});

// --- IPC: renderer asks main to open a URL in the default browser ---
ipcMain.on('shell:openExternal', (_event, url) => {
  if (typeof url !== 'string') return;
  if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')) {
    shell.openExternal(url);
  }
});

// --- IPC: renderer reports current filename so the OS title stays correct ---
ipcMain.on('window:setTitle', (_event, fileName) => {
  if (!mainWindow) return;
  if (typeof fileName === 'string' && fileName.length > 0) {
    mainWindow.setTitle(`${fileName} — Glance`);
  } else {
    mainWindow.setTitle('Glance');
  }
});
