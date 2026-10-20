// Folder mode support: the recursive Markdown scan, the one path guard every
// local read/image/link goes through, and a watcher that keeps the sidebar tree
// honest. Main process only — the renderer never touches fs.
const chokidar = require('chokidar');
const fs = require('fs/promises');
const path = require('path');

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

// Caps keep a runaway folder from turning the scan into a stall. The scan is
// breadth-first, so what survives a cap is the shallow, useful part of the tree.
const MAX_DEPTH = 8;
const MAX_FILES = 5000;
const MAX_DIRECTORIES = 2000;

// One save can produce several events; a short wait collapses them into one
// rescan.
const TREE_DEBOUNCE_MS = 300;

function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

// Windows paths are case-insensitive, and fs.realpath can hand back a drive
// letter or directory casing that differs from the one the folder was opened
// with.
function isInside(root, candidate) {
  if (process.platform === 'win32') {
    const normalizedRoot = root.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(normalizedRoot + path.sep)
    );
  }
  return candidate === root || candidate.startsWith(root + path.sep);
}

// The single guard for local paths. Resolve against the root, refuse anything
// that lands outside it, then follow symlinks and check again — a link can
// point out of the folder even when its own path looks safe. Missing paths are
// reported separately so callers can tell "not there" from "not allowed".
async function guardPath(root, candidate) {
  if (!root) return { ok: false, reason: 'outside' };
  const resolved = path.resolve(root, String(candidate || ''));
  if (!isInside(root, resolved)) return { ok: false, reason: 'outside' };
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!isInside(root, real)) return { ok: false, reason: 'outside' };
  return { ok: true, path: real };
}

async function scanMarkdown(root) {
  const files = [];
  const queue = [{ directory: root, depth: 0 }];
  let directories = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (directories >= MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    const { directory, depth } = queue.shift();
    directories += 1;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it, keep the rest of the tree
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const absolute = path.join(directory, name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name) || depth >= MAX_DEPTH) continue;
        queue.push({ directory: absolute, depth: depth + 1 });
        continue;
      }
      // Symlinks are skipped: following them can escape the root or loop.
      if (!entry.isFile() || !MARKDOWN_EXTS.has(path.extname(name).toLowerCase())) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      files.push(toPosix(path.relative(root, absolute)));
    }
  }

  files.sort();
  return { files, truncated, limit: MAX_FILES };
}

function ignoredInRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..')) return false;
  return relative
    .split(path.sep)
    .some((part) => part.startsWith('.') || IGNORED_DIRS.has(part));
}

function createTreeWatcher({ onChange }) {
  let watcher = null;
  let watchedRoot = null;
  let timer = null;

  function stop() {
    clearTimeout(timer);
    timer = null;
    watchedRoot = null;
    if (!watcher) return;
    const closing = watcher;
    watcher = null;
    closing.close();
  }

  function watch(root) {
    stop();
    if (!root) return;
    watchedRoot = root;
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: MAX_DEPTH,
      ignored: (candidate) => ignoredInRoot(root, candidate)
    });

    // Contents changing does not change the tree; adds, removals and renames
    // do. A renamed file arrives as unlink plus add, which debounces to one
    // rescan either way.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (watchedRoot) onChange({ root: watchedRoot });
      }, TREE_DEBOUNCE_MS);
    };
    watcher.on('add', schedule);
    watcher.on('unlink', schedule);
    watcher.on('addDir', schedule);
    watcher.on('unlinkDir', schedule);
    // An unhandled 'error' event would throw out of the emitter.
    watcher.on('error', () => {});
  }

  return { watch, stop };
}

module.exports = {
  guardPath,
  isInside,
  scanMarkdown,
  createTreeWatcher,
  toPosix
};
