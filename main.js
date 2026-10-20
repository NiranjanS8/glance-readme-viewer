const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs/promises');
const { createFileWatcher } = require('./watcher');
const { createTreeWatcher, guardPath, isInside, scanMarkdown, toPosix } = require('./folder');

const ALLOWED_EXTS = new Set(['.md', '.markdown', '.mdown', '.txt']);
const IMAGE_SCHEME = 'glance-file';
const HELP_PATH = path.join(__dirname, 'HELP.md');

// Folder search caps. The per-file limit keeps one noisy file from filling the
// sidebar; the total limit keeps a huge folder from producing an endless list.
const SEARCH_MAX_RESULTS = 200;
const SEARCH_PER_FILE = 5;
const SEARCH_CONTEXT = 60;
const SEARCH_BATCH_GROUPS = 8;
const SEARCH_YIELD_EVERY = 12;

// Relative images are served from disk through our own scheme, never file://.
// It has to be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: IMAGE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

let mainWindow = null;
let activeFilePath = null;
let activeRelative = null; // active file relative to the allowed root, posix
let allowedRoot = null; // real path: the open folder, or the open file's directory
let folderRoot = null; // real path of the open folder, null in single-file mode
let folderName = null;
let folderFiles = [];
let folderTruncated = false;
let folderLimit = 0;
let settings = { liveReload: true, tableOfContents: true, reopenLastFolder: true, lastFolder: null };

// Bumped for every new search so a read that finishes late cannot publish into
// a newer result set.
let searchToken = 0;
let activeSearchId = 0;

// Every document the window has opened. The renderer may search only these
// absolute paths, so opened-file search cannot become an arbitrary file reader.
const openedPaths = new Set();

// Paths handed to the app by Explorer, a shortcut, or a second instance. They
// wait here until the renderer has loaded, then open one after another.
const pendingOpenPaths = [];
let rendererReady = false;
let drainingOpenPaths = false;

function commandLinePaths(argv) {
  const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
  return args.filter((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('-'));
}

function queueOpenPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return;
  const resolved = path.resolve(candidate);
  if (!pendingOpenPaths.includes(resolved)) pendingOpenPaths.push(resolved);
  if (rendererReady && mainWindow) void drainPendingOpenPaths();
}

async function drainPendingOpenPaths() {
  if (!rendererReady || drainingOpenPaths || !mainWindow) return;
  drainingOpenPaths = true;
  try {
    while (pendingOpenPaths.length > 0) {
      const candidate = pendingOpenPaths.shift();
      await openExternalPath(candidate);
    }
  } finally {
    drainingOpenPaths = false;
  }
}

function createWindow() {
  rendererReady = false;
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
    rendererReady = false;
    fileWatcher.stop();
    treeWatcher.stop();
    cancelActiveSearch();
    mainWindow = null;
  });

  // A reload starts a fresh renderer; hold external opens until it has loaded.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  // The renderer is ready once the page has loaded. A file handed in on the
  // command line takes precedence over the saved folder; otherwise reopening
  // the last folder here also covers a manual reload.
  mainWindow.webContents.on('did-finish-load', async () => {
    rendererReady = true;
    if (pendingOpenPaths.length > 0) {
      await drainPendingOpenPaths();
      return;
    }
    if (!settings.reopenLastFolder || !settings.lastFolder) return;
    const opened = await openFolder(settings.lastFolder);
    if (opened && mainWindow) mainWindow.webContents.send('folder:opened', opened);
  });

  // Never navigate inside the app window; open http(s) externally and drop
  // everything else. Rendered links are intercepted in the renderer too — this
  // is the backstop for middle-clicks and scripted navigation.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
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

// A second watcher for the folder tree. It only ever reports "something in the
// tree changed"; the scan below decides what the tree now looks like.
const treeWatcher = createTreeWatcher({
  onChange: async ({ root }) => {
    if (root !== folderRoot) return;
    const scanned = await scanMarkdown(root);
    if (root !== folderRoot) return; // the folder changed while we scanned
    folderFiles = scanned.files;
    folderTruncated = scanned.truncated;
    folderLimit = scanned.limit;
    if (!mainWindow) return;
    mainWindow.webContents.send('folder:changed', {
      name: folderName,
      root,
      files: folderFiles,
      truncated: folderTruncated,
      limit: folderLimit
    });
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
  settings = {
    liveReload: stored.liveReload !== false,
    tableOfContents: stored.tableOfContents !== false,
    reopenLastFolder: stored.reopenLastFolder !== false,
    lastFolder: typeof stored.lastFolder === 'string' ? stored.lastFolder : null
  };
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

function watchTree() {
  if (settings.liveReload && folderRoot) {
    treeWatcher.watch(folderRoot);
  } else {
    treeWatcher.stop();
  }
}

// Every open path (menu, shortcut, dialog, drag-and-drop, sidebar, link) ends
// up here, so the watcher always follows what the window is showing.
function setActiveFile(filePath) {
  activeFilePath = filePath;
  activeRelative = allowedRoot ? toPosix(path.relative(allowedRoot, filePath)) : null;
  if (mainWindow) mainWindow.setTitle(`${path.basename(filePath)} — Glance`);
  watchActiveFile();
}

function setLiveReload(enabled) {
  settings.liveReload = enabled;
  saveSettings();
  const item = Menu.getApplicationMenu()?.getMenuItemById('liveReload');
  if (item) item.checked = enabled;
  watchActiveFile();
  watchTree();
}

function setTableOfContents(enabled) {
  settings.tableOfContents = enabled;
  saveSettings();
  const item = Menu.getApplicationMenu()?.getMenuItemById('tableOfContents');
  if (item) item.checked = enabled;
  if (mainWindow) mainWindow.webContents.send('toc:enabled-changed', enabled);
}

// --- Documents and folders ---

// Reads a file that has already passed the path guard and makes it the file
// the window is showing. `root` is what local images and links may reach.
async function readDocument(filePath, { root, folder, name, relative }) {
  const content = await fs.readFile(filePath, 'utf8');
  openedPaths.add(filePath);
  const leavingFolder = !folder && folderRoot !== null;
  allowedRoot = root;
  folderRoot = folder ? root : null;
  folderName = folder ? name : null;
  if (leavingFolder) {
    folderFiles = [];
    folderTruncated = false;
    folderLimit = 0;
    cancelActiveSearch();
    treeWatcher.stop();
  }
  setActiveFile(filePath);
  return {
    mode: folderRoot ? 'folder' : 'single',
    filePath,
    relativePath: relative,
    folderName,
    content
  };
}

async function resolveFile(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { status: 'missing', displayPath: '' };
  }
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return { status: 'missing', displayPath: path.basename(candidate) };
  }
  const info = await fs.stat(real).catch(() => null);
  if (!info || !info.isFile()) {
    return { status: 'missing', displayPath: path.basename(real) };
  }
  if (!ALLOWED_EXTS.has(path.extname(real).toLowerCase())) {
    return { status: 'unsupported', displayPath: path.basename(real) };
  }
  return { status: 'ok', filePath: real };
}

// Any path the user picked: inside the open folder it stays folder mode,
// otherwise that file's own directory becomes the allowed root.
async function openPath(candidate) {
  const resolved = await resolveFile(candidate);
  if (resolved.status !== 'ok') return resolved;
  const { filePath } = resolved;

  try {
    if (folderRoot && isInside(folderRoot, filePath)) {
      const relative = toPosix(path.relative(folderRoot, filePath));
      return {
        status: 'ok',
        document: await readDocument(filePath, {
          root: folderRoot,
          folder: true,
          name: folderName,
          relative
        })
      };
    }
    return {
      status: 'ok',
      document: await readDocument(filePath, {
        root: path.dirname(filePath),
        folder: false,
        name: null,
        relative: path.basename(filePath)
      })
    };
  } catch {
    return { status: 'missing', displayPath: path.basename(filePath) };
  }
}

async function reportOpenFailure(candidate, status) {
  if (!mainWindow) return;
  const name = path.basename(candidate);
  const message =
    status === 'unsupported'
      ? `${name} is not a supported Markdown or text file.`
      : `Could not open ${name}.`;
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Could not open',
    message
  });
}

// Explorer, shortcut drops, and second instances all arrive as a path. Folders
// open in folder mode; files become the active document in the open window.
async function openExternalPath(candidate) {
  const info = await fs.stat(candidate).catch(() => null);
  if (!info) {
    await reportOpenFailure(candidate, 'missing');
    return;
  }
  if (info.isDirectory()) {
    const opened = await openFolder(candidate);
    if (!opened) {
      await reportOpenFailure(candidate, 'failed');
      return;
    }
    if (mainWindow) mainWindow.webContents.send('folder:opened', opened);
    return;
  }
  const opened = await openPath(candidate);
  if (opened.status === 'ok') {
    if (mainWindow) mainWindow.webContents.send('file:opened', opened.document);
    return;
  }
  await reportOpenFailure(candidate, opened.status);
}

function readmeAtRoot(files) {
  return files.find((relative) => !relative.includes('/') && /^readme\.md$/i.test(relative));
}

// Opens a folder: scan it, make its real path the allowed root, watch it and
// open the root README when there is one. Returns the payload the renderer
// needs to draw the tree.
async function openFolder(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch {
    return null;
  }
  const info = await fs.stat(real).catch(() => null);
  if (!info || !info.isDirectory()) return null;

  const scanned = await scanMarkdown(real);
  cancelActiveSearch();
  allowedRoot = real;
  folderRoot = real;
  folderName = path.basename(real) || real;
  folderFiles = scanned.files;
  folderTruncated = scanned.truncated;
  folderLimit = scanned.limit;
  activeFilePath = null;
  activeRelative = null;
  fileWatcher.stop();
  watchTree();

  if (settings.lastFolder !== real) {
    settings.lastFolder = real;
    saveSettings();
  }

  let document = null;
  const readme = readmeAtRoot(folderFiles);
  if (readme) {
    const opened = await openFolderFile(readme);
    if (opened.status === 'ok') document = opened.document;
  }
  if (!document && mainWindow) mainWindow.setTitle(`${folderName} — Glance`);

  return {
    name: folderName,
    root: real,
    files: folderFiles,
    truncated: folderTruncated,
    limit: folderLimit,
    document
  };
}

async function openFolderFile(relative) {
  const displayPath = String(relative || '');
  if (!folderRoot) return { status: 'missing', displayPath };
  const guarded = await guardPath(folderRoot, displayPath);
  if (!guarded.ok) return { status: guarded.reason, displayPath };
  const info = await fs.stat(guarded.path).catch(() => null);
  if (!info || !info.isFile()) return { status: 'missing', displayPath };
  if (!ALLOWED_EXTS.has(path.extname(guarded.path).toLowerCase())) {
    return { status: 'unsupported', displayPath };
  }
  try {
    const document = await readDocument(guarded.path, {
      root: folderRoot,
      folder: true,
      name: folderName,
      relative: toPosix(path.relative(folderRoot, guarded.path))
    });
    return { status: 'ok', document };
  } catch {
    return { status: 'missing', displayPath };
  }
}

function cancelActiveSearch() {
  activeSearchId = 0;
  searchToken += 1;
}

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Occurrences are counted across the whole file so "N more in this file" is
// exact, but only `limit` snippets are kept. The walking line cursor keeps
// line numbers cheap for hits that appear in order.
function collectHits(text, pattern, limit) {
  const hits = [];
  let occurrence = 0;
  let line = 1;
  let cursor = 0;
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (hits.length < limit) {
      while (cursor < match.index) {
        if (text.charCodeAt(cursor) === 10) line += 1;
        cursor += 1;
      }
      const start = Math.max(0, match.index - SEARCH_CONTEXT);
      const end = Math.min(text.length, match.index + match[0].length + SEARCH_CONTEXT);
      hits.push({
        line,
        snippet: text.slice(start, end).replace(/\n/g, ' '),
        matchStart: match.index - start,
        matchLength: match[0].length,
        occurrence
      });
    }
    occurrence += 1;
  }
  return { hits, more: Math.max(0, occurrence - hits.length) };
}

// Shared search loop: each entry carries a display label and a loader. Reads
// happen one at a time and groups are pushed in batches, while a superseded
// search stops at the next file boundary.
async function runFileSearch({ query, searchId, token, sender, entries }) {
  const pattern = new RegExp(escapePattern(query), 'gi');
  let emitted = 0;
  let batch = [];
  let truncated = false;

  const send = (channel, payload) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };
  const flush = () => {
    if (batch.length === 0) return;
    send('search:batch', { searchId, groups: batch });
    batch = [];
  };

  try {
    for (let i = 0; i < entries.length; i++) {
      if (token !== searchToken) return;
      if (emitted >= SEARCH_MAX_RESULTS) {
        truncated = true;
        break;
      }
      const entry = entries[i];
      let content;
      try {
        content = await entry.load();
      } catch {
        continue; // unreadable file: skip it, keep searching
      }
      if (typeof content !== 'string') continue;
      const text = content.replace(/\r\n?/g, '\n');
      const limit = Math.min(SEARCH_PER_FILE, SEARCH_MAX_RESULTS - emitted);
      const { hits, more } = collectHits(text, pattern, limit);
      if (hits.length === 0) continue;
      emitted += hits.length;
      const group = { relativePath: entry.label, hits, more };
      if (entry.filePath) group.filePath = entry.filePath;
      batch.push(group);
      if (batch.length >= SEARCH_BATCH_GROUPS) flush();
      if (emitted >= SEARCH_MAX_RESULTS) {
        truncated = more > 0 || i < entries.length - 1;
        break;
      }
      if (i % SEARCH_YIELD_EVERY === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (token !== searchToken) return;
    flush();
    send('search:done', { searchId, truncated });
  } catch {
    if (token !== searchToken) return;
    flush();
    send('search:done', { searchId, truncated: false });
  }
}

// Folder search reads only files the tree scan already vetted, and every read
// still goes through the path guard.
async function runFolderSearch({ query, searchId, token, sender }) {
  const root = folderRoot;
  const entries = folderFiles.slice().map((relative) => ({
    label: relative,
    load: async () => {
      const guarded = await guardPath(root, relative);
      if (!guarded.ok) return null;
      try {
        return await fs.readFile(guarded.path, 'utf8');
      } catch {
        return null;
      }
    }
  }));
  return runFileSearch({ query, searchId, token, sender, entries });
}

// Opened-file search is limited to paths main has actually opened, and each is
// canonicalised again before reading so a moved link cannot widen the set.
async function runOpenedSearch({ query, searchId, token, sender, paths }) {
  const entries = [];
  const seen = new Set();
  for (const candidate of paths) {
    if (typeof candidate !== 'string') continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || seen.has(real) || !openedPaths.has(real)) continue;
    if (!ALLOWED_EXTS.has(path.extname(real).toLowerCase())) continue;
    seen.add(real);
    const parent = path.basename(path.dirname(real));
    entries.push({
      label: parent ? `${parent}/${path.basename(real)}` : path.basename(real),
      filePath: real,
      load: async () => {
        const info = await fs.stat(real).catch(() => null);
        if (!info || !info.isFile()) return null;
        try {
          return await fs.readFile(real, 'utf8');
        } catch {
          return null;
        }
      }
    });
  }
  return runFileSearch({ query, searchId, token, sender, entries });
}

function splitHref(href) {
  const raw = String(href || '');
  const hashIndex = raw.indexOf('#');
  const pathPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? null : raw.slice(hashIndex + 1);
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // a malformed escape is kept as written; the guard decides if it exists
  }
  return { pathPart: decoded.replace(/\\/g, '/'), anchor };
}

// A relative link in rendered Markdown: another document opens in the app,
// anything else opens with the OS, and the guard decides what is reachable.
async function followLink(href) {
  if (!allowedRoot || !activeRelative) {
    return { status: 'missing', displayPath: String(href || '') };
  }
  const { pathPart, anchor } = splitHref(href);
  if (!pathPart) return { status: 'missing', displayPath: String(href || '') };

  const directory = activeRelative.includes('/')
    ? activeRelative.slice(0, activeRelative.lastIndexOf('/') + 1)
    : '';
  // A leading slash means "from the folder root", the way a repo link reads.
  const candidate = pathPart.startsWith('/') ? pathPart.slice(1) : directory + pathPart;
  const guarded = await guardPath(allowedRoot, candidate);
  if (!guarded.ok) return { status: guarded.reason, displayPath: candidate };

  const info = await fs.stat(guarded.path).catch(() => null);
  if (!info) return { status: 'missing', displayPath: candidate };
  if (!info.isFile()) return { status: 'unsupported', displayPath: candidate };

  if (ALLOWED_EXTS.has(path.extname(guarded.path).toLowerCase())) {
    try {
      const document = await readDocument(guarded.path, {
        root: allowedRoot,
        folder: folderRoot !== null,
        name: folderName,
        relative: toPosix(path.relative(allowedRoot, guarded.path))
      });
      return { status: 'ok', document, anchor };
    } catch {
      return { status: 'missing', displayPath: candidate };
    }
  }

  const failure = await shell.openPath(guarded.path);
  if (failure) return { status: 'failed', displayPath: candidate };
  return { status: 'external' };
}

// Serves images for the open document. Everything goes through the same guard
// as links and reads, so the scheme cannot reach outside the allowed root.
function registerFileProtocol() {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    if (request.method !== 'GET' || !allowedRoot) {
      return new Response(null, { status: 404 });
    }
    let relative;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local') return new Response(null, { status: 404 });
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return new Response(null, { status: 400 });
    }
    const guarded = await guardPath(allowedRoot, relative);
    if (!guarded.ok) return new Response(null, { status: 404 });
    const info = await fs.stat(guarded.path).catch(() => null);
    if (!info || !info.isFile()) return new Response(null, { status: 404 });
    try {
      return await net.fetch(pathToFileURL(guarded.path).toString());
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

async function openFolderDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const opened = await openFolder(result.filePaths[0]);
  if (!opened) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open folder',
      message: `Could not open ${result.filePaths[0]}`
    });
    return null;
  }
  return opened;
}

async function openFileDialog() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const files = [];
  const seen = new Set();
  for (const candidate of result.filePaths) {
    const resolved = await resolveFile(candidate);
    if (resolved.status !== 'ok' || seen.has(resolved.filePath)) continue;
    seen.add(resolved.filePath);
    files.push({ filePath: resolved.filePath, name: path.basename(resolved.filePath) });
  }
  if (files.length === 0) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open files',
      message: 'Could not read the selected files.'
    });
    return null;
  }

  // The first readable file is displayed; every selected file joins the
  // session list so it can be opened from the sidebar without another dialog.
  let document = null;
  for (let index = 0; index < files.length; index += 1) {
    const opened = await openPath(files[index].filePath);
    if (opened.status !== 'ok') {
      files.splice(index, 1);
      index -= 1;
      continue;
    }
    document = opened.document;
    break;
  }
  if (!document) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not open files',
      message: 'Could not read the selected files.'
    });
    return null;
  }

  for (const file of files) openedPaths.add(file.filePath);
  return { document, files };
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
        {
          // CmdOrCtrl+Shift+F now belongs to folder search, so folder opening
          // moves to the explorer-style combo.
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: async () => {
            const opened = await openFolderDialog();
            if (opened && mainWindow) {
              mainWindow.webContents.send('folder:opened', opened);
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
          id: 'back',
          label: 'Back',
          accelerator: process.platform === 'darwin' ? 'Command+[' : 'Alt+Left',
          enabled: false,
          click: () => {
            if (mainWindow) mainWindow.webContents.send('history:back');
          }
        },
        {
          id: 'forward',
          label: 'Forward',
          accelerator: process.platform === 'darwin' ? 'Command+]' : 'Alt+Right',
          enabled: false,
          click: () => {
            if (mainWindow) mainWindow.webContents.send('history:forward');
          }
        },
        { type: 'separator' },
        {
          id: 'liveReload',
          label: 'Live Reload',
          type: 'checkbox',
          checked: settings.liveReload,
          accelerator: 'CmdOrCtrl+Shift+L',
          click: (item) => setLiveReload(item.checked)
        },
        {
          id: 'tableOfContents',
          label: 'Table of Contents',
          type: 'checkbox',
          checked: settings.tableOfContents,
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (item) => setTableOfContents(item.checked)
        },
        {
          id: 'reopenLastFolder',
          label: 'Reopen Last Folder',
          type: 'checkbox',
          checked: settings.reopenLastFolder,
          click: (item) => {
            settings.reopenLastFolder = item.checked;
            saveSettings();
          }
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
        { role: 'reload' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          id: 'help',
          label: 'Help',
          accelerator: 'F1',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('help:open');
          }
        },
        { type: 'separator' },
        {
          label: 'About Glance',
          click: async () => {
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Glance',
              message: 'Glance — README viewer.\nOpen a .md file or a project folder from the File menu, or drop either here.'
            });
          }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

for (const candidate of commandLinePaths(process.argv)) {
  queueOpenPath(candidate);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // A second launch (including dropping a file on Glance's icon) forwards its
  // path to the window that is already open instead of starting a second copy.
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    for (const candidate of commandLinePaths(argv)) {
      queueOpenPath(candidate);
    }
    if (!mainWindow && app.isReady()) createWindow();
  });

  // macOS sends Finder opens (Open With, Dock drops) through this event rather
  // than argv. It can fire before the app is ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenPath(filePath);
  });

  app.whenReady().then(async () => {
    await loadSettings();
    registerFileProtocol();
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
    treeWatcher.stop();
  });
}

// --- IPC: renderer asks main to open a dialog + read the file ---
ipcMain.handle('dialog:openFile', () => openFileDialog());

// --- IPC: help is read only when the Help menu item is used ---
ipcMain.handle('help:read', async () => {
  try {
    return await fs.readFile(HELP_PATH, 'utf8');
  } catch {
    return null;
  }
});

// --- IPC: the table of contents preference, read once on renderer startup ---
ipcMain.handle('toc:get-enabled', () => settings.tableOfContents);

// The rail's own icon toggles the same persisted preference as the View menu.
ipcMain.on('toc:set-enabled', (_event, enabled) => setTableOfContents(enabled !== false));

// --- IPC: open a known path in the session (sidebar, shortcuts, history) ---
ipcMain.handle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (!ALLOWED_EXTS.has(path.extname(filePath).toLowerCase())) return null;
  const opened = await openPath(filePath);
  return opened.status === 'ok' ? opened.document : null;
});

// --- IPC: a path arrived from the outside (drag-and-drop), so it may be a
// folder and it starts a fresh session either way ---
ipcMain.handle('path:open', async (_event, candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { status: 'missing', displayPath: '' };
  }
  const info = await fs.stat(candidate).catch(() => null);
  if (!info) return { status: 'missing', displayPath: path.basename(candidate) };
  if (info.isDirectory()) {
    const opened = await openFolder(candidate);
    if (!opened) return { status: 'failed', displayPath: path.basename(candidate) };
    if (mainWindow) mainWindow.webContents.send('folder:opened', opened);
    return { status: 'ok' };
  }
  const opened = await openPath(candidate);
  if (opened.status !== 'ok') return opened;
  if (mainWindow) mainWindow.webContents.send('file:opened', opened.document);
  return { status: 'ok' };
});

// --- IPC: a file picked from the folder tree ---
ipcMain.handle('folder:file', (_event, relative) => openFolderFile(relative));

// --- IPC: a relative link inside a rendered document ---
ipcMain.handle('link:follow', (_event, href) => followLink(href));

// --- IPC: sidebar search, in the open folder or across opened files ---
ipcMain.on('search:start', (event, payload) => {
  const searchId = payload && payload.searchId;
  const query = payload && payload.query;
  const scope = payload && payload.scope;
  if (!Number.isInteger(searchId)) return;
  const finishEmpty = () => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('search:done', { searchId, truncated: false });
    }
  };
  if (typeof query !== 'string' || query.length < 2) {
    finishEmpty();
    return;
  }
  activeSearchId = searchId;
  const token = ++searchToken;
  if (scope === 'opened') {
    const paths = Array.isArray(payload.paths) ? payload.paths : [];
    runOpenedSearch({ query, searchId, token, sender: event.sender, paths }).catch(finishEmpty);
    return;
  }
  if (!folderRoot) {
    finishEmpty();
    return;
  }
  runFolderSearch({ query, searchId, token, sender: event.sender }).catch(finishEmpty);
});

ipcMain.on('search:cancel', (_event, searchId) => {
  if (searchId !== activeSearchId) return;
  cancelActiveSearch();
});

// --- IPC: the renderer owns history; main only greys out the menu items ---
ipcMain.on('history:state', (_event, state) => {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const back = menu.getMenuItemById('back');
  const forward = menu.getMenuItemById('forward');
  if (back) back.enabled = Boolean(state && state.canBack);
  if (forward) forward.enabled = Boolean(state && state.canForward);
});

// --- IPC: renderer asks main to open a URL in the default browser ---
ipcMain.on('shell:openExternal', (_event, url) => {
  if (typeof url !== 'string') return;
  if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')) {
    shell.openExternal(url);
  }
});

// Code-block copy uses the OS clipboard in main; the renderer never gets a
// Node clipboard module.
ipcMain.handle('clipboard:write-text', (_event, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
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
