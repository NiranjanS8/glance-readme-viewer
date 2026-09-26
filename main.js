const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const ALLOWED_EXTS = new Set(['.md', '.markdown', '.mdown', '.txt']);

let mainWindow = null;

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
              mainWindow.setTitle(`${path.basename(opened.filePath)} — Glance`);
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
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('view:toggle-theme');
          }
        },
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

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: renderer asks main to open a dialog + read the file ---
ipcMain.handle('dialog:openFile', async () => {
  const opened = await openFileDialog();
  if (opened && mainWindow) {
    mainWindow.setTitle(`${path.basename(opened.filePath)} — Glance`);
  }
  return opened;
});

// --- IPC: renderer has a path (e.g. from drag-and-drop) and needs contents ---
ipcMain.handle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (mainWindow) {
      mainWindow.setTitle(`${path.basename(filePath)} — Glance`);
    }
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
