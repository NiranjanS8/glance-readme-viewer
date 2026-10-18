/* global markdownit, hljs, DOMPurify */
(function () {
  'use strict';

  const THEME_KEY = 'glance-theme';
  const ALLOWED_EXTS = ['.md', '.markdown', '.mdown', '.txt'];

  const html = document.documentElement;
  const filenameEl = document.getElementById('filename');
  const markdownBody = document.getElementById('markdownBody');
  const emptyState = document.getElementById('emptyState');
  const fileList = document.getElementById('fileList');
  const fileListEmpty = document.getElementById('fileListEmpty');
  const themeToggle = document.getElementById('themeToggle');
  const openFileBtn = document.getElementById('openFileBtn');
  const emptyOpenBtn = document.getElementById('emptyOpenBtn');
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
  const showSidebarBtn = document.getElementById('showSidebarBtn');
  const readingPane = document.getElementById('readingPane');
  const dropHint = document.getElementById('dropHint');
  const staleNotice = document.getElementById('staleNotice');

  const sessionFiles = []; // [{ filePath, name }]
  let activePath = null;

  // ---------- Markdown setup ----------

  // Raw HTML passes through markdown-it so common README markup
  // (<details>, <div align="center">, <br>) renders GitHub-style.
  // DOMPurify then strips anything dangerous (<script>, event
  // handlers, javascript: URLs) entirely — never shown, never run.
  const md = markdownit({
    html: true,
    linkify: true,
    typographer: true,
    highlight: function (code, lang) {
      try {
        if (typeof hljs === 'undefined') return '';
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch {
        return '';
      }
    }
  });

  // GitHub-style task lists without an extra dependency:
  // "- [ ] todo" / "- [x] done" -> disabled checkboxes.
  md.core.ruler.after('inline', 'glance-task-lists', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'list_item_open') continue;
      const next = tokens[i + 1];
      const inline = tokens[i + 2];
      if (!next || next.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue;
      const first = inline.children && inline.children[0];
      if (!first || first.type !== 'text') continue;
      const match = /^\[([ xX])\]\s+/.exec(first.content);
      if (!match) continue;
      const checked = match[1].toLowerCase() === 'x';
      token.attrSet('class', 'task-list-item' + (checked ? ' checked' : ''));
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} tabindex="-1">`;
      inline.children.unshift(checkbox);
    }
    return false;
  });

  function basename(p) {
    if (typeof p !== 'string') return '';
    return p.split(/[\\/]/).pop() || p;
  }

  function hasAllowedExt(p) {
    if (typeof p !== 'string') return false;
    const lower = p.toLowerCase();
    return ALLOWED_EXTS.some((ext) => lower.endsWith(ext));
  }

  // LLMs and rich-text editors often emit "smart" dashes (—, –)
  // where GFM requires ASCII hyphens. The usual casualty is the
  // table delimiter row (|—|—|), which then renders as raw text
  // instead of a table. Normalize dash variants on delimiter-shaped
  // lines only — prose em dashes and fenced code are left alone.
  const UNICODE_DASH = /[—–―‐‑‒−]/;
  const UNICODE_DASH_ALL = /[—–―‐‑‒−]/g;
  const DELIMITER_SHAPED = /^[\s|:—–―‐‑‒−-]+$/;

  function normalizeMarkdown(source) {
    const lines = String(source || '').split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const trimmed = line.trim();
      if (line.includes('|') && UNICODE_DASH.test(line) && DELIMITER_SHAPED.test(trimmed)) {
        lines[i] = line.replace(UNICODE_DASH_ALL, '-');
      }
    }
    return lines.join('\n');
  }

  // ---------- Theme ----------

  function applyTheme(theme) {
    html.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore persistence failures
    }
  }

  function toggleTheme() {
    const current = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // theme-init.js resolved stored-or-OS before first paint; persist that
  // resolved value so the next launch short-circuits on localStorage.
  applyTheme(html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  // ---------- Rendering ----------

  function renderMarkdown(source) {
    const raw = md.render(normalizeMarkdown(source));
    const clean = DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
      ADD_ATTR: ['target', 'rel']
    });
    markdownBody.innerHTML = clean;

    // Code blocks: ensure hljs class for our token styling.
    markdownBody.querySelectorAll('pre code').forEach((block) => {
      block.classList.add('hljs');
    });

    // Links: route everything http(s)/mailto through the OS browser.
    markdownBody.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href)) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          window.api.openExternal(href);
        });
      } else if (/^(javascript:|data:|vbscript:)/i.test(href)) {
        anchor.removeAttribute('href');
      }
    });

    // Task-list checkboxes are display-only.
    markdownBody.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.disabled = true;
      box.setAttribute('tabindex', '-1');
    });

    // Local images: allow relative paths Electron can resolve is out of v1
    // scope, so just mark broken ones quietly instead of navigating.
    markdownBody.querySelectorAll('img').forEach((img) => {
      img.setAttribute('loading', 'lazy');
      img.addEventListener('error', () => img.classList.add('img-broken'));
    });
  }

  function renderSidebar() {
    fileList.querySelectorAll('li[data-path]').forEach((li) => li.remove());
    if (sessionFiles.length === 0) {
      fileListEmpty.hidden = false;
      return;
    }
    fileListEmpty.hidden = true;
    sessionFiles.forEach((entry) => {
      const li = document.createElement('li');
      li.dataset.path = entry.filePath;
      li.className = 'file-item' + (entry.filePath === activePath ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'file-dot';
      dot.textContent = entry.filePath === activePath ? '\u25CF' : '\u25CB';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = entry.name;
      name.title = entry.filePath;
      li.append(dot, name);
      li.addEventListener('click', async () => {
        const opened = await window.api.readFile(entry.filePath);
        if (opened) showFile(opened);
      });
      fileList.appendChild(li);
    });
  }

  function showFile({ filePath, content }) {
    if (!filePath) return;
    const name = basename(filePath);
    activePath = filePath;
    if (!sessionFiles.some((f) => f.filePath === filePath)) {
      sessionFiles.unshift({ filePath, name });
    } else {
      // move to top, keep click order predictable
      const idx = sessionFiles.findIndex((f) => f.filePath === filePath);
      const [entry] = sessionFiles.splice(idx, 1);
      sessionFiles.unshift(entry);
    }
    filenameEl.textContent = name;
    window.api.setTitle(name);
    document.title = `${name} — Glance`;
    renderSidebar();
    renderMarkdown(content);
    emptyState.hidden = true;
    markdownBody.hidden = false;
    setStaleNotice(false);
    readingPane.scrollTop = 0;
  }

  // Live reload: main pushes fresh contents when the open file changes on
  // disk. Re-rendering is safe because renderMarkdown sanitizes every time.
  function applyLiveUpdate({ filePath, content }) {
    if (filePath !== activePath) return;
    const previousTop = readingPane.scrollTop;
    renderMarkdown(content);
    setStaleNotice(false);
    // Keep the reading position; clamp it when the document got shorter.
    const maxTop = Math.max(0, readingPane.scrollHeight - readingPane.clientHeight);
    readingPane.scrollTop = Math.min(previousTop, maxTop);
  }

  // A deleted file keeps its last render on screen, with the notice above it.
  function setStaleNotice(visible) {
    staleNotice.hidden = !visible;
  }

  async function handleOpenRequest() {
    const opened = await window.api.openFileDialog();
    if (opened) showFile(opened);
  }

  // ---------- Events ----------

  themeToggle.addEventListener('click', toggleTheme);
  openFileBtn.addEventListener('click', handleOpenRequest);
  emptyOpenBtn.addEventListener('click', handleOpenRequest);

  window.api.onFileOpened((data) => {
    if (data) showFile(data);
  });
  window.api.onFileChanged((data) => {
    if (data) applyLiveUpdate(data);
  });
  window.api.onFileMissing((data) => {
    if (data && data.filePath === activePath) setStaleNotice(true);
  });
  window.api.onToggleTheme(() => toggleTheme());

  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.hidden = true;
    showSidebarBtn.hidden = false;
  });
  showSidebarBtn.addEventListener('click', () => {
    sidebar.hidden = false;
    showSidebarBtn.hidden = true;
  });

  // Drag-and-drop: accept a single .md-ish file anywhere on the window.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    dropHint.hidden = false;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropHint.hidden = true;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    document.body.classList.remove('dragging');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const filePath = window.api.getPathForFile(files[0]);
    if (!filePath || !hasAllowedExt(filePath)) return;
    const opened = await window.api.readFile(filePath);
    if (opened) showFile(opened);
  });
})();
