// Watches the one file the window has open and reports fresh contents.
// Main process only: the renderer never touches fs, so changes reach it
// over IPC instead.
const chokidar = require('chokidar');
const fs = require('fs/promises');

// Editors save in several writes (temp file, truncate, rename); waiting a
// beat collapses them into a single render.
const CHANGE_DEBOUNCE_MS = 150;

// A delete only counts once the path has stayed gone; a rename that lands on
// the same path within this window is a save, not a disappearance.
const MISSING_DEBOUNCE_MS = 150;

function createFileWatcher({ onChange, onMissing }) {
  let watcher = null;
  let watchedPath = null;
  let changeTimer = null;
  let missingTimer = null;

  // A file caught mid-save is unreadable or momentarily empty. Skipping it
  // keeps the last good render on screen instead of flashing a blank page.
  async function readContent(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  async function publish() {
    const filePath = watchedPath;
    const content = await readContent(filePath);
    if (content === null || filePath !== watchedPath) return;
    onChange({ filePath, content });
  }

  function scheduleChange() {
    clearTimeout(missingTimer);
    missingTimer = null;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      publish();
    }, CHANGE_DEBOUNCE_MS);
  }

  function scheduleMissing() {
    clearTimeout(changeTimer);
    changeTimer = null;
    clearTimeout(missingTimer);
    missingTimer = setTimeout(() => {
      missingTimer = null;
      if (watchedPath) onMissing({ filePath: watchedPath });
    }, MISSING_DEBOUNCE_MS);
  }

  function stop() {
    clearTimeout(changeTimer);
    clearTimeout(missingTimer);
    changeTimer = null;
    missingTimer = null;
    watchedPath = null;
    if (!watcher) return;
    const closing = watcher;
    watcher = null;
    closing.close();
  }

  function watch(filePath) {
    stop();
    if (!filePath) return;
    watchedPath = filePath;
    // atomic: a save that swaps a temp file into place arrives as one change
    // rather than an unlink plus an add. ignoreInitial: the caller has just
    // read the file, so there is nothing new to report yet.
    watcher = chokidar.watch(filePath, { atomic: true, ignoreInitial: true });
    watcher.on('change', scheduleChange);
    watcher.on('add', scheduleChange);
    // chokidar keeps watching the parent directory of a file path, so a file
    // that comes back at the same path is reported as an add.
    watcher.on('unlink', scheduleMissing);
    // An unhandled 'error' event would throw out of the emitter.
    watcher.on('error', () => {});
  }

  return { watch, stop };
}

module.exports = { createFileWatcher };
