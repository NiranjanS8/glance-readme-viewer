/* global markdownit, markdownItAnchor, hljs, DOMPurify */
(function () {
  'use strict';

  const THEME_KEY = 'glance-theme';
  const ALLOWED_EXTS = ['.md', '.markdown', '.mdown', '.txt'];
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
  const TOC_LEVELS = 'h1, h2, h3, h4'; // the outline stops at H4

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

  async function openEntry(entry) {
    const opened = await window.api.readFile(entry.filePath);
    if (opened) showFile(opened);
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
      li.addEventListener('click', () => openEntry(entry));
      fileList.appendChild(li);
    });
  }

  // Ctrl/Cmd+1-9 counts down the sidebar list, so 1 is the newest entry.
  function selectFileAt(position) {
    const entry = sessionFiles[position - 1];
    if (entry) openEntry(entry);
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
    buildToc();
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
    buildToc({ keepActive: true });
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

  function syncTocVisibility() {
    tocPanel.hidden = !tocVisible();
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
    if (!filePath || !hasAllowedExt(filePath)) return;
    const opened = await window.api.readFile(filePath);
    if (opened) showFile(opened);
  });
})();
