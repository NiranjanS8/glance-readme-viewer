/* global markdownit, markdownItAnchor, hljs, DOMPurify */
(function () {
  'use strict';

  const THEME_KEY = 'glance-theme';
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
  const TOC_LEVELS = 'h1, h2, h3, h4'; // the outline stops at H4
  // Relative images are served by main through this scheme, never file://.
  const IMAGE_PREFIX = 'glance-file://local/';
  const FIND_DEBOUNCE_MS = 100;
  const SEARCH_DEBOUNCE_MS = 250;
  const SEARCH_MIN_LENGTH = 2;
  const HIGHLIGHT_ALL = 'glance-find';
  const HIGHLIGHT_CURRENT = 'glance-find-current';

  const html = document.documentElement;
  const filenameEl = document.getElementById('filename');
  const markdownBody = document.getElementById('markdownBody');
  const emptyState = document.getElementById('emptyState');
  const fileList = document.getElementById('fileList');
  const fileListEmpty = document.getElementById('fileListEmpty');
  const sidebarSection = document.getElementById('sidebarSection');
  const themeToggle = document.getElementById('themeToggle');
  const openFileBtn = document.getElementById('openFileBtn');
  const emptyOpenBtn = document.getElementById('emptyOpenBtn');
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
  const showSidebarBtn = document.getElementById('showSidebarBtn');
  const sidebarSearchBtn = document.getElementById('sidebarSearchBtn');
  const readingPane = document.getElementById('readingPane');
  const dropHint = document.getElementById('dropHint');
  const staleNotice = document.getElementById('staleNotice');
  const linkNotice = document.getElementById('linkNotice');
  const findBar = document.getElementById('findBar');
  const findInput = document.getElementById('findInput');
  const findCount = document.getElementById('findCount');
  const findCaseBtn = document.getElementById('findCase');
  const tocToggle = document.getElementById('tocToggle');
  const searchView = document.getElementById('searchView');
  const searchInput = document.getElementById('sidebarSearchInput');
  const searchClose = document.getElementById('sidebarSearchClose');
  const searchStatus = document.getElementById('sidebarSearchStatus');
  const searchResults = document.getElementById('sidebarSearchResults');

  const sessionFiles = []; // [{ filePath, name }]
  const treeExpanded = new Set(); // folder paths the reader left open
  const history = []; // [{ filePath, scrollTop }]
  let historyIndex = -1;
  let activePath = null;
  let current = null; // { mode, filePath, relativePath }
  let folder = null; // { name, root, files, truncated, limit } while a folder is open

  const highlightsSupported =
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

  let findOpen = false;
  let findCaseSensitive = false;
  let findQuery = '';
  let findTimer = null;
  let findMatches = [];
  let findCurrent = -1;
  let findJumpTarget = null;

  let sidebarSearchQuery = '';
  let sidebarSearchSeq = 0;
  let sidebarSearchActive = 0;
  let sidebarSearchTimer = null;

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

  // GitHub-style heading anchors, so the "#installation" links a README was
  // written with resolve here too. DOMPurify drops an id that shadows a
  // document property (id="title", id="links", id="scripts", ...), so every
  // heading also carries its slug in a data attribute, restored after
  // sanitizing.
  function headingSlug(text) {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
  }

  md.use(markdownItAnchor, {
    slugify: headingSlug,
    callback: (token, { slug }) => token.attrSet('data-anchor', slug)
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
    const theme = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  }

  // theme-init.js resolved stored-or-OS before first paint; persist that
  // resolved value so the next launch short-circuits on localStorage.
  applyTheme(html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  // ---------- Rendering ----------

  // "#installation" links resolve inside the rendered document. The ids are
  // the plugin's slugs, including the ones the sanitizer had to drop.
  function anchorTarget(id) {
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      // a malformed escape is not worth failing a click over
    }
    return markdownBody.querySelector(`[id="${CSS.escape(decoded)}"]`);
  }

  function encodeSegments(relativePath) {
    return relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  // Absolute URLs are left alone; a leading slash means "from the folder
  // root", everything else is relative to the open document. ".." segments are
  // normalized by the URL parser and checked again by main's guard.
  function imageUrl(source) {
    if (!source || source.startsWith('//')) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
    const trimmed = source.replace(/\\/g, '/');
    if (trimmed.startsWith('/')) return IMAGE_PREFIX + encodeSegments(trimmed.slice(1));
    const relativePath = current ? current.relativePath : '';
    const directory = relativePath.includes('/')
      ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
      : '';
    return IMAGE_PREFIX + encodeSegments(directory + trimmed);
  }

  function renderMarkdown(source) {
    const raw = md.render(normalizeMarkdown(source));
    const clean = DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
      ADD_ATTR: ['target', 'rel']
    });
    markdownBody.innerHTML = clean;

    // Heading anchors: the sanitizer keeps the id unless it shadows a document
    // property, in which case the slug kept aside at parse time fills it back in.
    markdownBody.querySelectorAll(HEADING_SELECTOR).forEach((heading) => {
      const slug = heading.dataset.anchor;
      if (!slug) return;
      if (!heading.id) heading.id = slug;
      delete heading.dataset.anchor;
    });

    // Code blocks: ensure hljs class for our token styling.
    markdownBody.querySelectorAll('pre code').forEach((block) => {
      block.classList.add('hljs');
    });

    // Links: http(s)/mailto go to the OS browser, #anchors stay in the pane,
    // and anything relative is resolved by main against the allowed root.
    markdownBody.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
        const target = href.startsWith('//') ? `https:${href}` : href;
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          window.api.openExternal(target);
        });
      } else if (href.startsWith('#')) {
        // In-document anchors jump inside the reading pane; they must never
        // navigate the window.
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          const target = anchorTarget(href.slice(1));
          if (target) scrollToAnchor(target);
        });
      } else if (/^(javascript:|data:|vbscript:)/i.test(href)) {
        anchor.removeAttribute('href');
      } else {
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          followLocalLink(href);
        });
      }
    });

    // Task-list checkboxes are display-only.
    markdownBody.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.disabled = true;
      box.setAttribute('tabindex', '-1');
    });

    // Relative images load from disk through main's guard; broken ones are
    // hidden quietly instead of leaving a browser placeholder.
    markdownBody.querySelectorAll('img').forEach((img) => {
      const source = img.getAttribute('src');
      if (source) {
        if (/^file:/i.test(source)) {
          img.removeAttribute('src');
        } else {
          const resolved = imageUrl(source);
          if (resolved) img.setAttribute('src', resolved);
        }
      }
      img.setAttribute('loading', 'lazy');
      img.addEventListener('error', () => img.classList.add('img-broken'));
    });
  }

  // ---------- Notices ----------

  // A deleted file keeps its last render on screen, with the notice above it.
  function setStaleNotice(visible) {
    staleNotice.hidden = !visible;
  }

  // The quiet line above the document: why a click did nothing.
  function setLinkNotice(message) {
    if (!message) {
      linkNotice.hidden = true;
      linkNotice.textContent = '';
      return;
    }
    linkNotice.textContent = message;
    linkNotice.hidden = false;
  }

  function linkNoticeText({ status, displayPath }) {
    const shown = displayPath || 'link';
    if (status === 'outside') return `Link outside the opened folder: ${shown}`;
    if (status === 'unsupported') return `Not a file: ${shown}`;
    if (status === 'failed') return `Could not open: ${shown}`;
    return `Linked file not found: ${shown}`;
  }

  // ---------- Find in document ----------
  // Ranges painted through the CSS Custom Highlight API: the DOM is never
  // mutated, so the sanitizer, the TOC and live reload keep working untouched.

  function escapePattern(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function collectFindMatches() {
    if (!findQuery) return [];
    let pattern;
    try {
      pattern = new RegExp(escapePattern(findQuery), findCaseSensitive ? 'gu' : 'giu');
    } catch {
      return [];
    }

    const matches = [];
    const visibility = new Map();
    const isVisible = (element) => {
      if (!visibility.has(element)) {
        let visible = true;
        try {
          visible = element.checkVisibility();
        } catch {
          visible = true;
        }
        visibility.set(element, visible);
      }
      return visibility.get(element);
    };

    const walker = document.createTreeWalker(markdownBody, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest('.find-bar')) return NodeFilter.FILTER_REJECT;
        return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(node.nodeValue)) !== null) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        matches.push(range);
      }
    }
    return matches;
  }

  function clearFindHighlights() {
    if (!highlightsSupported) return;
    CSS.highlights.delete(HIGHLIGHT_ALL);
    CSS.highlights.delete(HIGHLIGHT_CURRENT);
  }

  function paintFindHighlights() {
    if (!highlightsSupported) return;
    clearFindHighlights();
    if (findMatches.length === 0) return;
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...findMatches));
    if (findCurrent >= 0 && findCurrent < findMatches.length) {
      CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(findMatches[findCurrent]));
    }
  }

  function updateFindCounter() {
    if (!findOpen || findQuery.length === 0) {
      findCount.textContent = '';
      return;
    }
    findCount.textContent = findMatches.length
      ? `${findCurrent + 1} of ${findMatches.length}`
      : 'no matches';
  }

  // Off-screen only: a match already in view keeps the reader's place.
  function scrollToFindMatch() {
    if (findCurrent < 0) return;
    const range = findMatches[findCurrent];
    if (!range) return;
    const pane = readingPane.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    if (rect.top >= pane.top + 48 && rect.bottom <= pane.bottom - 8) return;
    const top =
      readingPane.scrollTop + rect.top - pane.top - (readingPane.clientHeight - rect.height) / 2;
    readingPane.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  }

  function refreshFind({ reset = false, scroll = false, jumpTo = null } = {}) {
    if (!findOpen) return;
    findMatches = collectFindMatches();
    if (jumpTo !== null && jumpTo >= 0 && jumpTo < findMatches.length) {
      findCurrent = jumpTo;
    } else if (reset || findCurrent < 0) {
      findCurrent = findMatches.length ? 0 : -1;
    } else if (findCurrent >= findMatches.length) {
      findCurrent = findMatches.length - 1;
    }
    if (findMatches.length === 0) findCurrent = -1;
    paintFindHighlights();
    updateFindCounter();
    if (scroll) scrollToFindMatch();
  }

  function openFindBar(query = null) {
    if (query !== null) {
      findInput.value = query;
      findQuery = query;
    }
    if (!findOpen) {
      findOpen = true;
      findBar.hidden = false;
      findQuery = findInput.value;
      refreshFind({ reset: true, scroll: true });
    }
    findInput.focus();
    findInput.select();
  }

  function closeFindBar() {
    clearTimeout(findTimer);
    findTimer = null;
    findOpen = false;
    findBar.hidden = true;
    findMatches = [];
    findCurrent = -1;
    findJumpTarget = null;
    clearFindHighlights();
    findCount.textContent = '';
    readingPane.focus({ preventScroll: true });
  }

  function stepFind(direction) {
    if (findMatches.length === 0) return;
    findCurrent = (findCurrent + direction + findMatches.length) % findMatches.length;
    paintFindHighlights();
    updateFindCounter();
    scrollToFindMatch();
  }

  function runFindFromInput() {
    findQuery = findInput.value;
    refreshFind({ reset: true, scroll: true });
  }

  // ---------- History ----------
  // The renderer owns the stack because only it knows the reading position.
  // Entries are re-read from disk on the way back, so edits show up and a file
  // that disappeared is reported instead of restored stale.

  function syncHistoryMenu() {
    window.api.setHistoryState({
      canBack: historyIndex > 0,
      canForward: historyIndex >= 0 && historyIndex < history.length - 1
    });
  }

  function saveHistoryScroll() {
    const entry = history[historyIndex];
    if (entry && entry.filePath === activePath) entry.scrollTop = readingPane.scrollTop;
  }

  function pushHistoryEntry(document) {
    saveHistoryScroll();
    history.splice(historyIndex + 1);
    history.push({ filePath: document.filePath, scrollTop: 0 });
    historyIndex = history.length - 1;
    syncHistoryMenu();
  }

  async function goTo(index) {
    if (index < 0 || index >= history.length || index === historyIndex) return;
    const entry = history[index];
    const opened = await window.api.readFile(entry.filePath);
    if (!opened) {
      setLinkNotice(`File no longer exists on disk: ${basename(entry.filePath)}`);
      return;
    }
    saveHistoryScroll();
    historyIndex = index;
    syncHistoryMenu();
    showDocument(opened, { scrollTop: entry.scrollTop });
  }

  function goBack() {
    goTo(historyIndex - 1);
  }

  function goForward() {
    goTo(historyIndex + 1);
  }

  // ---------- Documents ----------

  async function navigateTo(document, { anchor = null, scrollTop = 0, push = true } = {}) {
    if (!document || !document.filePath) return;
    if (push) pushHistoryEntry(document);
    else saveHistoryScroll();
    showDocument(document, { anchor, scrollTop });
  }

  async function openEntry(entry) {
    const opened = await window.api.readFile(entry.filePath);
    if (opened) await navigateTo(opened);
  }

  async function openTreeFile(relativePath) {
    const result = await window.api.openFolderFile(relativePath);
    if (!result) return;
    if (result.status === 'ok') {
      await navigateTo(result.document);
      return;
    }
    setLinkNotice(linkNoticeText(result));
  }

  async function followLocalLink(href) {
    const result = await window.api.followLink(href);
    if (!result) return;
    if (result.status === 'ok') {
      await navigateTo(result.document, { anchor: result.anchor });
      return;
    }
    if (result.status === 'external') {
      setLinkNotice(null);
      return;
    }
    setLinkNotice(linkNoticeText(result));
  }

  function rememberSessionEntry(filePath, name) {
    const index = sessionFiles.findIndex((entry) => entry.filePath === filePath);
    if (index === -1) {
      sessionFiles.unshift({ filePath, name });
      return;
    }
    // move to top, keep click order predictable
    const [entry] = sessionFiles.splice(index, 1);
    sessionFiles.unshift(entry);
  }

  function showDocument({ mode, filePath, relativePath, content }, { anchor = null, scrollTop = 0 } = {}) {
    if (!filePath) return;
    const name = basename(filePath);
    activePath = filePath;
    current = { mode, filePath, relativePath };
    // A file opened outside the folder leaves folder mode behind.
    if (mode === 'single') {
      if (folder) resetSidebarSearch();
      folder = null;
    }
    rememberSessionEntry(filePath, name);
    filenameEl.textContent = name;
    window.api.setTitle(name);
    document.title = `${name} — Glance`;

    renderMarkdown(content);
    buildToc();
    emptyState.hidden = true;
    markdownBody.hidden = false;
    setStaleNotice(false);
    setLinkNotice(null);
    if (mode === 'folder' && relativePath) expandAncestors(relativePath);
    renderSidebar({ reveal: true });

    readingPane.scrollTop = 0;
    const target = anchor ? anchorTarget(anchor) : null;
    if (target) {
      scrollToAnchor(target);
    } else {
      readingPane.scrollTop = scrollTop;
      // A restored position should light the entry the reader is actually at,
      // not whichever heading the fresh build defaulted to.
      syncTocActive();
    }

    // The find bar follows the reader across files and live reloads.
    if (findOpen) {
      refreshFind({ reset: true, scroll: !target, jumpTo: findJumpTarget });
    }
    findJumpTarget = null;

    // A newly opened file joins the opened-files scope, so refresh a search
    // that is already sitting in the sidebar.
    if (!folder && !searchView.hidden && sidebarSearchQuery.length >= SEARCH_MIN_LENGTH) {
      startSidebarSearch();
    }
  }

  // A folder with no README opens no document: the tree is live and the
  // reading pane keeps its empty state.
  function showFolderWithoutDocument() {
    activePath = null;
    current = null;
    if (findOpen) closeFindBar();
    markdownBody.innerHTML = '';
    markdownBody.hidden = true;
    emptyState.hidden = false;
    setStaleNotice(false);
    setLinkNotice(null);
    readingPane.scrollTop = 0;
    buildToc();
    // With no document open, the folder is what the window is showing.
    const heading = folder ? folder.name : '';
    filenameEl.textContent = heading || 'README Viewer';
    window.api.setTitle(heading);
    document.title = heading ? `${heading} — Glance` : 'Glance';
  }

  function applyFolderOpened(payload) {
    if (!payload) return;
    resetSidebarSearch();
    folder = {
      name: payload.name,
      root: payload.root,
      files: payload.files || [],
      truncated: Boolean(payload.truncated),
      limit: payload.limit || 0
    };
    treeExpanded.clear();
    history.splice(0);
    historyIndex = -1;
    syncHistoryMenu();
    if (payload.document) {
      expandAncestors(payload.document.relativePath);
      pushHistoryEntry(payload.document);
      showDocument(payload.document);
      return;
    }
    showFolderWithoutDocument();
    renderSidebar();
  }

  // A rescan replaces the tree but keeps what the reader expanded and where
  // the sidebar was scrolled to.
  function applyFolderChanged(payload) {
    if (!folder || !payload) return;
    folder = {
      ...folder,
      name: payload.name,
      files: payload.files || [],
      truncated: Boolean(payload.truncated),
      limit: payload.limit || 0
    };
    renderSidebar();
  }

  // Live reload: main pushes fresh contents when the open file changes on
  // disk. Re-rendering is safe because renderMarkdown sanitizes every time.
  function applyLiveUpdate({ filePath, content }) {
    if (filePath !== activePath) return;
    const previousTop = readingPane.scrollTop;
    renderMarkdown(content);
    buildToc({ keepActive: true });
    setStaleNotice(false);
    // Keep the reading position; clamp it when the document got shorter.
    const maxTop = Math.max(0, readingPane.scrollHeight - readingPane.clientHeight);
    readingPane.scrollTop = Math.min(previousTop, maxTop);
    // Ranges point at the old nodes now; re-run the query without moving the
    // reader, keeping the current match number where the new text allows it.
    if (findOpen) refreshFind({ scroll: false });
  }

  async function handleOpenRequest() {
    const opened = await window.api.openFileDialog();
    applyOpenPayload(opened);
  }

  // Dialog and menu opens carry the full selection; drag-drop is a bare
  // document.
  function applyOpenPayload(payload) {
    if (!payload) return;
    if (payload.document) applyFreshDocument(payload.document, payload.files || []);
    else applyFreshDocument(payload);
  }

  // Menu and dialog opens start a new stack; moving inside a folder or through
  // a link pushes onto the current one.
  function applyFreshDocument(document, files = []) {
    // rememberSessionEntry moves entries to the top, so walk backwards to keep
    // the dialog's order below the active file.
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const entry = files[index];
      if (entry.filePath === document.filePath) continue;
      rememberSessionEntry(entry.filePath, entry.name);
    }
    history.splice(0);
    historyIndex = -1;
    pushHistoryEntry(document);
    showDocument(document);
  }

  // ---------- Sidebar ----------

  function updateSidebarLabel() {
    sidebarSection.textContent = folder ? folder.name : 'open files';
    sidebarSection.title = folder ? folder.root : '';
  }

  function showSidebarEmpty(message) {
    fileListEmpty.textContent = message;
    fileListEmpty.hidden = false;
  }

  function relativeFolders(relativePath) {
    const parts = relativePath.split('/');
    const folders = [];
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      folders.push(prefix);
    }
    return folders;
  }

  // Following a link into a collapsed folder reveals the file it landed on.
  function expandAncestors(relativePath) {
    relativeFolders(relativePath).forEach((relativeFolder) => treeExpanded.add(relativeFolder));
  }

  function buildTree(files) {
    const root = { children: new Map() };
    for (const relativePath of files) {
      const parts = relativePath.split('/');
      let node = root;
      let prefix = '';
      parts.forEach((part, index) => {
        prefix = prefix ? `${prefix}/${part}` : part;
        const isFile = index === parts.length - 1;
        let child = node.children.get(part);
        if (!child) {
          child = isFile
            ? { type: 'file', name: part, path: prefix }
            : { type: 'dir', name: part, path: prefix, children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      });
    }
    return root;
  }

  function compareTreeNames(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  }

  function treeRow(node, depth) {
    const isDir = node.type === 'dir';
    const isActive = !isDir && current !== null && node.path === current.relativePath;
    const row = document.createElement('li');
    row.className = 'file-item' + (isActive ? ' active' : '');
    row.dataset.path = node.path;
    row.dataset.type = node.type;
    row.dataset.depth = String(depth);
    row.style.paddingLeft = `${8 + (depth - 1) * 12}px`;
    row.tabIndex = -1;
    row.title = node.path;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth));

    const marker = document.createElement('span');
    if (isDir) {
      const expanded = treeExpanded.has(node.path);
      marker.className = 'tree-chevron';
      marker.textContent = expanded ? '\u25BE' : '\u25B8';
      marker.setAttribute('aria-hidden', 'true');
      row.setAttribute('aria-expanded', String(expanded));
    } else {
      marker.className = 'file-dot';
      marker.textContent = isActive ? '\u25CF' : '\u25CB';
      if (isActive) row.setAttribute('aria-selected', 'true');
    }

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = node.name;

    row.append(marker, name);
    row.addEventListener('click', () => {
      if (isDir) toggleFolder(node.path);
      else openTreeFile(node.path);
    });
    return row;
  }

  function appendTreeRows(node, depth, rows) {
    const children = Array.from(node.children.values());
    const dirs = children.filter((child) => child.type === 'dir').sort(compareTreeNames);
    const files = children.filter((child) => child.type === 'file').sort(compareTreeNames);
    for (const child of dirs) {
      rows.push(treeRow(child, depth));
      if (treeExpanded.has(child.path)) appendTreeRows(child, depth + 1, rows);
    }
    for (const child of files) rows.push(treeRow(child, depth));
    return rows;
  }

  function treeRows() {
    return Array.from(fileList.querySelectorAll('li[data-path]'));
  }

  function toggleFolder(relativePath) {
    if (treeExpanded.has(relativePath)) treeExpanded.delete(relativePath);
    else treeExpanded.add(relativePath);
    renderSidebar({ focusPath: relativePath });
  }

  function focusTreeRow(row) {
    if (!row) return;
    treeRows().forEach((candidate) => {
      candidate.tabIndex = -1;
    });
    row.tabIndex = 0;
    row.focus();
  }

  function revealActiveRow() {
    if (!current) return;
    const row = treeRows().find((candidate) => candidate.dataset.path === current.relativePath);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function renderSidebar({ reveal = false, focusPath = null } = {}) {
    const previousScroll = fileList.scrollTop;
    const active = document.activeElement;
    const focusedRow =
      active instanceof HTMLElement && fileList.contains(active)
        ? active.closest('li[data-path]')
        : null;
    const previousFocus = focusedRow ? focusedRow.dataset.path : null;

    fileList.querySelectorAll('li[data-path], li.tree-note').forEach((row) => row.remove());
    updateSidebarLabel();
    fileList.setAttribute('role', folder ? 'tree' : 'list');

    if (folder) {
      const rows = appendTreeRows(buildTree(folder.files), 1, []);
      if (rows.length === 0) {
        showSidebarEmpty('no markdown files');
      } else {
        fileListEmpty.hidden = true;
        rows.forEach((row) => fileList.appendChild(row));
        if (folder.truncated) {
          const note = document.createElement('li');
          note.className = 'file-list-empty tree-note';
          note.textContent = folder.limit
            ? `first ${folder.limit} files shown`
            : 'file list truncated';
          fileList.appendChild(note);
        }
        const activeRow = rows.find((row) => row.classList.contains('active'));
        (activeRow || rows[0]).tabIndex = 0;
      }
    } else if (sessionFiles.length === 0) {
      showSidebarEmpty('nothing open yet');
    } else {
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
        li.addEventListener('click', () => openEntry(entry));
        fileList.appendChild(li);
      });
    }

    fileList.scrollTop = previousScroll;
    const focusTarget = focusPath || previousFocus;
    if (focusTarget && folder) {
      const row = treeRows().find((candidate) => candidate.dataset.path === focusTarget);
      if (row) focusTreeRow(row);
    }
    if (reveal) revealActiveRow();
  }

  // Ctrl/Cmd+1-9 counts down the sidebar list, so 1 is the newest entry.
  function selectFileAt(position) {
    const entry = sessionFiles[position - 1];
    if (entry) openEntry(entry);
  }

  // Up/down walk the visible rows, left/right collapse and expand, Enter opens.
  fileList.addEventListener('keydown', (event) => {
    if (!folder) return;
    const rows = treeRows();
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement);
    if (index === -1) return;
    const row = rows[index];

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusTreeRow(rows[Math.min(rows.length - 1, index + 1)]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusTreeRow(rows[Math.max(0, index - 1)]);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.dataset.type !== 'dir') return;
      if (!treeExpanded.has(row.dataset.path)) {
        toggleFolder(row.dataset.path);
        return;
      }
      const child = rows[index + 1];
      if (child && Number(child.dataset.depth) === Number(row.dataset.depth) + 1) {
        focusTreeRow(child);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.dataset.type === 'dir' && treeExpanded.has(row.dataset.path)) {
        toggleFolder(row.dataset.path);
        return;
      }
      const depth = Number(row.dataset.depth);
      for (let i = index - 1; i >= 0; i--) {
        if (Number(rows[i].dataset.depth) === depth - 1) {
          focusTreeRow(rows[i]);
          return;
        }
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (row.dataset.type === 'dir') toggleFolder(row.dataset.path);
      else openTreeFile(row.dataset.path);
    }
  });

  // ---------- Sidebar search ----------

  function setSearchStatus(message) {
    searchStatus.textContent = message;
    searchStatus.hidden = !message;
  }

  function searchIdleMessage() {
    return !folder && sessionFiles.length === 0 ? 'open a file to search' : 'type to search';
  }

  function syncSearchTrigger() {
    const open = !searchView.hidden;
    const filesLabel = folder ? 'folder files' : 'opened files';
    sidebarSearchBtn.setAttribute('aria-pressed', String(open));
    sidebarSearchBtn.title = open ? `Show ${filesLabel}` : 'Search (Ctrl+Shift+F)';
    sidebarSearchBtn.setAttribute('aria-label', open ? `Show ${filesLabel}` : 'Search files');
    searchClose.title = `Show ${filesLabel}`;
  }

  function showSearchView() {
    if (sidebar.hidden) {
      sidebar.hidden = false;
      showSidebarBtn.hidden = true;
    }
    fileList.hidden = true;
    searchView.hidden = false;
    syncSearchTrigger();
  }

  function hideSearchView() {
    searchView.hidden = true;
    fileList.hidden = false;
    syncSearchTrigger();
  }

  function closeSidebarSearch() {
    cancelSidebarSearch();
    hideSearchView();
    readingPane.focus({ preventScroll: true });
  }

  function toggleSidebarSearch() {
    if (!searchView.hidden) closeSidebarSearch();
    else showSidebarSearch();
  }

  function cancelSidebarSearch() {
    if (sidebarSearchActive) window.api.cancelSearch(sidebarSearchActive);
    sidebarSearchActive = 0;
  }

  function resetSidebarSearch() {
    clearTimeout(sidebarSearchTimer);
    sidebarSearchTimer = null;
    cancelSidebarSearch();
    sidebarSearchQuery = '';
    searchInput.value = '';
    searchResults.textContent = '';
    setSearchStatus(searchIdleMessage());
    hideSearchView();
  }

  function startSidebarSearch() {
    clearTimeout(sidebarSearchTimer);
    sidebarSearchTimer = null;
    cancelSidebarSearch();
    sidebarSearchQuery = searchInput.value;
    searchResults.textContent = '';
    if (sidebarSearchQuery.length < SEARCH_MIN_LENGTH) {
      setSearchStatus(searchIdleMessage());
      return;
    }
    const searchId = ++sidebarSearchSeq;
    sidebarSearchActive = searchId;
    setSearchStatus('searching');
    if (folder) {
      window.api.searchFolder(searchId, sidebarSearchQuery);
      return;
    }
    if (sessionFiles.length === 0) {
      sidebarSearchActive = 0;
      setSearchStatus('open a file to search');
      return;
    }
    // Without a folder, the session's opened files are the search scope.
    window.api.searchOpened(
      searchId,
      sidebarSearchQuery,
      sessionFiles.map((entry) => entry.filePath)
    );
  }

  function showSidebarSearch() {
    const alreadyOpen = !searchView.hidden;
    showSearchView();
    searchInput.placeholder = folder ? 'search folder' : 'search opened files';
    searchInput.focus();
    searchInput.select();
    if (alreadyOpen) return;
    if (sidebarSearchQuery.length < SEARCH_MIN_LENGTH) {
      setSearchStatus(searchIdleMessage());
      return;
    }
    // Reopening after it was closed re-runs the query and picks up edits.
    startSidebarSearch();
  }

  function searchHitRows() {
    return Array.from(searchResults.querySelectorAll('.search-hit'));
  }

  function appendSearchGroups(groups) {
    for (const group of groups) {
      const target = group.filePath || group.relativePath;
      const scope = group.filePath ? 'opened' : 'folder';
      const item = document.createElement('li');
      item.className = 'search-group';

      const file = document.createElement('div');
      file.className = 'search-file';
      file.textContent = group.relativePath;
      file.title = target;
      item.appendChild(file);

      const hits = document.createElement('ul');
      hits.className = 'search-hits';
      (group.hits || []).forEach((hit) =>
        hits.appendChild(searchHitRow(target, group.relativePath, hit, scope))
      );
      if (group.more > 0) {
        const more = document.createElement('li');
        more.className = 'search-more';
        more.textContent = `${group.more} more in this file`;
        hits.appendChild(more);
      }

      item.appendChild(hits);
      searchResults.appendChild(item);
    }
  }

  function searchHitRow(target, label, hit, scope) {
    const row = document.createElement('li');
    row.className = 'search-hit';
    row.tabIndex = -1;
    row.dataset.path = target;
    row.dataset.label = label;
    row.dataset.scope = scope;
    row.dataset.occurrence = String(hit.occurrence);
    row.title = `${target}:${hit.line}`;

    const line = document.createElement('span');
    line.className = 'search-line';
    line.textContent = String(hit.line);

    const snippet = document.createElement('span');
    snippet.className = 'search-snippet';
    const end = hit.matchStart + hit.matchLength;
    snippet.appendChild(document.createTextNode(hit.snippet.slice(0, hit.matchStart)));
    const mark = document.createElement('mark');
    mark.textContent = hit.snippet.slice(hit.matchStart, end);
    snippet.appendChild(mark);
    snippet.appendChild(document.createTextNode(hit.snippet.slice(end)));

    row.append(line, snippet);
    row.addEventListener('click', () => openSearchHit(row));
    return row;
  }

  async function openSearchHit(row) {
    const target = row.dataset.path;
    const occurrence = Number(row.dataset.occurrence);
    let openedDocument;

    if (row.dataset.scope === 'opened') {
      openedDocument = await window.api.readFile(target);
      if (!openedDocument) {
        setLinkNotice(`Could not open: ${row.dataset.label || target}`);
        return;
      }
    } else {
      const opened = await window.api.openFolderFile(target);
      if (!opened) return;
      if (opened.status !== 'ok') {
        setLinkNotice(linkNoticeText(opened));
        return;
      }
      openedDocument = opened.document;
    }

    clearTimeout(sidebarSearchTimer);
    sidebarSearchTimer = null;
    cancelSidebarSearch();
    hideSearchView();

    findOpen = true;
    findBar.hidden = false;
    findInput.value = sidebarSearchQuery;
    findQuery = sidebarSearchQuery;
    findJumpTarget = Number.isInteger(occurrence) ? occurrence : null;
    await navigateTo(openedDocument);
    findInput.focus();
  }

  searchInput.addEventListener('input', () => {
    sidebarSearchQuery = searchInput.value;
    clearTimeout(sidebarSearchTimer);
    sidebarSearchTimer = null;
    cancelSidebarSearch();
    searchResults.textContent = '';
    if (sidebarSearchQuery.length < SEARCH_MIN_LENGTH) {
      setSearchStatus(searchIdleMessage());
      return;
    }
    setSearchStatus('searching');
    sidebarSearchTimer = setTimeout(startSidebarSearch, SEARCH_DEBOUNCE_MS);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSidebarSearch();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = searchHitRows();
      if (rows.length === 0) return;
      event.preventDefault();
      rows[event.key === 'ArrowDown' ? 0 : rows.length - 1].focus();
      return;
    }
    if (event.key === 'Enter') {
      const first = searchHitRows()[0];
      if (!first) return;
      event.preventDefault();
      openSearchHit(first);
    }
  });

  searchResults.addEventListener('keydown', (event) => {
    const row = event.target instanceof HTMLElement ? event.target.closest('.search-hit') : null;
    if (!row) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSidebarSearch();
      return;
    }
    const rows = searchHitRows();
    const index = rows.indexOf(row);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows[Math.min(rows.length - 1, index + 1)].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(0, index - 1)].focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSearchHit(row);
    }
  });

  window.api.onSearchBatch((payload) => {
    if (!payload || payload.searchId !== sidebarSearchActive) return;
    appendSearchGroups(payload.groups || []);
    if (searchResults.querySelector('.search-hit')) setSearchStatus('');
  });

  window.api.onSearchDone((payload) => {
    if (!payload || payload.searchId !== sidebarSearchActive) return;
    sidebarSearchActive = 0;
    if (payload.truncated) {
      const note = document.createElement('li');
      note.className = 'search-status search-truncated';
      note.textContent = 'results truncated';
      searchResults.appendChild(note);
    }
    if (!searchResults.querySelector('.search-hit')) setSearchStatus('no results');
    else setSearchStatus('');
  });

  // ---------- Table of contents ----------

  const TOC_MIN_HEADINGS = 3;
  // A heading counts as "at the top" once it reaches the top tenth of the pane,
  // and a jump lands a heading just inside that band, so clicking an entry
  // highlights the entry it scrolled to.
  const TOC_SPY_BAND = 0.1;
  const TOC_LANDING = 48;

  const tocPanel = document.getElementById('toc');
  const tocList = document.getElementById('tocList');

  let tocEnabled = true; // View > Table of Contents
  let tocHeadings = []; // heading elements, in document order
  let tocEntries = new Map(); // heading -> its link
  let tocActive = null;
  let tocObserver = null;
  let tocEndObserver = null; // watches the last block: are we at the bottom?
  let tocEndBlock = null;

  function tocVisible() {
    return tocEnabled && tocHeadings.length >= TOC_MIN_HEADINGS;
  }

  function setTocActive(heading) {
    if (!heading || heading === tocActive) return;
    const previous = tocEntries.get(tocActive);
    if (previous) previous.removeAttribute('aria-current');
    tocActive = heading;
    const entry = tocEntries.get(heading);
    entry.setAttribute('aria-current', 'location');
    entry.scrollIntoView({ block: 'nearest' });
  }

  function scrollToAnchor(anchor) {
    const paneTop = readingPane.getBoundingClientRect().top;
    const landing = Math.min(TOC_LANDING, readingPane.clientHeight * TOC_SPY_BAND);
    const top = readingPane.scrollTop + anchor.getBoundingClientRect().top - paneTop - landing;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    readingPane.scrollTo({ top, behavior: reduceMotion ? 'instant' : 'smooth' });
  }

  // The highlight is the last heading whose top edge has reached the spy band.
  // Intersection events are the only trigger, and every one of them re-reads
  // positions, so the highlight stays right however the pane got scrolled.
  // Two cases the band alone gets wrong: a document that fits the pane (the
  // reader is at the top, whatever sits in the band), and the end of a document
  // whose last section is too short to lift its heading into the band.
  function syncTocActive() {
    const pane = readingPane.getBoundingClientRect();
    const fits = readingPane.scrollHeight <= readingPane.clientHeight + 1;
    const atEnd =
      !fits &&
      tocEndBlock !== null &&
      tocEndBlock.getBoundingClientRect().bottom <= pane.bottom + 1;
    const band = pane.top + readingPane.clientHeight * TOC_SPY_BAND;
    let active = tocHeadings[0];
    if (!fits) {
      for (const heading of tocHeadings) {
        if (heading.getBoundingClientRect().top > band) break;
        active = heading;
      }
    }
    if (atEnd) active = tocHeadings[tocHeadings.length - 1];
    if (active) setTocActive(active);
  }

  // Both observers swallow the callback reporting the state they were created
  // in, so a fresh build or a live reload keeps the highlight it was handed.
  function afterFirstCross(handler) {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return;
      }
      handler();
    };
  }

  function stopTocSpy() {
    if (tocObserver) {
      tocObserver.disconnect();
      tocObserver = null;
    }
    if (tocEndObserver) {
      tocEndObserver.disconnect();
      tocEndObserver = null;
    }
  }

  function startTocSpy() {
    stopTocSpy();
    if (!tocVisible()) return;
    tocObserver = new IntersectionObserver(afterFirstCross(syncTocActive), {
      root: readingPane,
      rootMargin: `0px 0px -${Math.round((1 - TOC_SPY_BAND) * 100)}% 0px`
    });
    tocHeadings.forEach((heading) => tocObserver.observe(heading));
    // The band cannot see the end when the last section is short, so the last
    // block is its own trigger: it is fully visible only at the bottom.
    if (tocEndBlock) {
      tocEndObserver = new IntersectionObserver(afterFirstCross(syncTocActive), {
        root: readingPane,
        threshold: 1
      });
      tocEndObserver.observe(tocEndBlock);
    }
  }

  function syncTocToggle() {
    const available = tocHeadings.length >= TOC_MIN_HEADINGS;
    tocToggle.hidden = !available;
    tocToggle.setAttribute('aria-pressed', String(tocEnabled));
    tocToggle.setAttribute('aria-label', tocEnabled ? 'Hide contents' : 'Show contents');
    tocToggle.title = `${tocEnabled ? 'Hide' : 'Show'} contents (Ctrl+Shift+O)`;
  }

  function syncTocVisibility() {
    tocPanel.hidden = !tocVisible();
    syncTocToggle();
    startTocSpy();
  }

  // Rebuilt on every render, live reloads included; keepActive re-highlights
  // the same heading when the edit kept it.
  function buildToc({ keepActive = false } = {}) {
    const activeSlug = keepActive && tocActive ? tocActive.id : null;
    tocActive = null;
    tocEntries = new Map();
    tocList.textContent = '';
    tocHeadings = Array.from(markdownBody.querySelectorAll(TOC_LEVELS)).filter(
      (heading) => heading.id
    );
    tocEndBlock = markdownBody.lastElementChild;
    syncTocVisibility();
    for (const heading of tocHeadings) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = `toc-link toc-level-${heading.tagName[1]}`;
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      link.title = heading.textContent;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        setTocActive(heading);
        scrollToAnchor(heading);
      });
      item.appendChild(link);
      tocList.appendChild(item);
      tocEntries.set(heading, link);
    }
    const restored = activeSlug
      ? tocHeadings.find((heading) => heading.id === activeSlug)
      : null;
    // A live reload keeps the heading the reader was on; if the edit renamed it
    // away, follow the pane instead of dropping back to the first entry.
    if (restored) setTocActive(restored);
    else if (keepActive) syncTocActive();
    else setTocActive(tocHeadings[0]);
  }

  // ---------- Events ----------

  themeToggle.addEventListener('click', toggleTheme);
  openFileBtn.addEventListener('click', handleOpenRequest);
  emptyOpenBtn.addEventListener('click', handleOpenRequest);
  sidebarSearchBtn.addEventListener('click', toggleSidebarSearch);
  searchClose.addEventListener('click', closeSidebarSearch);
  tocToggle.addEventListener('click', () => window.api.setTocEnabled(!tocEnabled));

  findInput.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(runFindFromInput, FIND_DEBOUNCE_MS);
  });

  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBar();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(findTimer);
    findTimer = null;
    // A query typed but not yet debounced becomes the first match.
    if (findInput.value !== findQuery) {
      runFindFromInput();
      return;
    }
    stepFind(event.shiftKey ? -1 : 1);
  });

  findCaseBtn.addEventListener('click', () => {
    findCaseSensitive = !findCaseSensitive;
    findCaseBtn.setAttribute('aria-pressed', String(findCaseSensitive));
    clearTimeout(findTimer);
    findTimer = null;
    findQuery = findInput.value;
    refreshFind({ reset: true, scroll: true });
  });

  // Ctrl/Cmd+F finds in the document. Adding Shift opens sidebar search:
  // the folder when one is open, otherwise the files opened this session.
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== 'f') return;
    event.preventDefault();
    if (event.shiftKey) showSidebarSearch();
    else openFindBar();
  });

  window.api.onFileOpened((data) => applyOpenPayload(data));
  window.api.onFolderOpened((data) => applyFolderOpened(data));
  window.api.onFolderChanged((data) => applyFolderChanged(data));
  window.api.onFileChanged((data) => {
    if (data) applyLiveUpdate(data);
  });
  window.api.onFileMissing((data) => {
    if (data && data.filePath === activePath) setStaleNotice(true);
  });
  window.api.onHistoryBack(() => goBack());
  window.api.onHistoryForward(() => goForward());
  syncHistoryMenu();
  window.api.onToggleTheme(() => toggleTheme());
  window.api.onToggleSidebar(() => toggleSidebar());
  window.api.onSelectFile((position) => selectFileAt(position));
  window.api.onTocEnabledChanged((enabled) => {
    tocEnabled = enabled !== false;
    syncTocVisibility();
    // Switching it back on should reflect where the reader is now.
    if (tocVisible()) syncTocActive();
  });

  // The rail's on/off state lives in main so the View menu checkbox and the
  // rail agree from launch.
  window.api.getTocEnabled().then((enabled) => {
    tocEnabled = enabled !== false;
    syncTocVisibility();
    if (tocVisible()) syncTocActive();
  });

  function toggleSidebar() {
    const visible = sidebar.hidden;
    sidebar.hidden = !visible;
    showSidebarBtn.hidden = visible;
  }

  toggleSidebarBtn.addEventListener('click', () => toggleSidebar());
  showSidebarBtn.addEventListener('click', () => toggleSidebar());

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
    if (!filePath) return;
    // A dropped folder takes over the tree; a dropped file opens one document.
    await window.api.openDroppedPath(filePath);
  });
})();
