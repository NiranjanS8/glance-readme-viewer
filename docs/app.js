(function () {
  'use strict';

  const THEME_KEY = 'glance-site-theme';
  const REPO = 'NiranjanS8/glance-readme-viewer';
  const RELEASE = window.GLANCE_RELEASE || {};
  const FALLBACK_DOWNLOAD = {
    version: RELEASE.version || 'v0.1.3',
    url:
      RELEASE.installerUrl ||
      'https://github.com/NiranjanS8/glance-readme-viewer/releases/download/v0.1.3/Glance.Setup.0.1.3.exe',
    size: RELEASE.size || 83820088,
    checksum:
      RELEASE.checksum ||
      '52C0BE36B17CDDB21C76C1B60CCA5CC5731154E5D167626DD6D1A49812551945',
  };

  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const themeLabel = themeToggle ? themeToggle.querySelector('.theme-label') : null;
  const currentFile = document.getElementById('currentFile');
  const checksum = document.getElementById('checksum');
  const copyButton = document.getElementById('copyChecksum');
  const hasDownloadTargets = Boolean(document.querySelector('[data-download], #checksum'));

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '83.8 MB';
    return `${(bytes / 1000000).toFixed(1)} MB`;
  }

  function syncTheme() {
    if (!themeToggle || !themeLabel) return;
    const isDark = root.getAttribute('data-theme') === 'dark';
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light theme' : 'Switch to dark theme'
    );
    themeLabel.textContent = isDark ? 'Light' : 'Dark';
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // theme still applies for this visit
      }
      syncTheme();
    });

    syncTheme();
  }

  const sections = Array.from(document.querySelectorAll('[data-file]'));
  const fileLinks = new Map(
    Array.from(document.querySelectorAll('.file-link[data-section]')).map((link) => [
      link.dataset.section,
      link,
    ])
  );
  let activeSection = null;
  let scrollFrame = 0;

  function updateActiveSection() {
    if (!sections.length || !currentFile) return;

    let candidate = sections[0];
    const marker = window.innerHeight * 0.34;

    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.top <= marker) candidate = section;
    }

    const nearBottom =
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
    if (nearBottom) candidate = sections[sections.length - 1];

    if (candidate === activeSection) return;
    activeSection = candidate;

    currentFile.textContent = candidate.dataset.file;
    for (const [sectionId, link] of fileLinks) {
      const isActive = sectionId === candidate.id;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  function requestSectionUpdate() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(function () {
      scrollFrame = 0;
      updateActiveSection();
    });
  }

  if (sections.length && currentFile) {
    window.addEventListener('scroll', requestSectionUpdate, { passive: true });
    window.addEventListener('resize', requestSectionUpdate);
    updateActiveSection();
  }

  function setDownload(info) {
    document.querySelectorAll('[data-version]').forEach(function (element) {
      element.textContent = info.version;
    });
    document.querySelectorAll('[data-size]').forEach(function (element) {
      element.textContent = formatSize(info.size);
    });
    document.querySelectorAll('[data-download]').forEach(function (link) {
      link.href = info.url;
    });

    if (!checksum) return;

    if (info.checksum) {
      checksum.textContent = info.checksum;
      checksum.dataset.checksum = info.checksum;
      if (copyButton) copyButton.hidden = false;
    } else {
      checksum.textContent = 'See the release notes';
      checksum.dataset.checksum = '';
      if (copyButton) copyButton.hidden = true;
    }
  }

  async function loadLatestRelease() {
    try {
      const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);

      const release = await response.json();
      const asset = release.assets.find(function (candidate) {
        return /\.exe$/i.test(candidate.name);
      });
      if (!asset) throw new Error('No Windows installer asset found');

      const checksumMatch = /SHA-?256:\s*`?([a-f0-9]{64})`?/i.exec(release.body || '');
      const checksumValue =
        checksumMatch?.[1] ||
        (release.tag_name === FALLBACK_DOWNLOAD.version ? FALLBACK_DOWNLOAD.checksum : null);

      setDownload({
        version: release.tag_name,
        url: asset.browser_download_url,
        size: asset.size,
        checksum: checksumValue,
      });
    } catch {
      setDownload(FALLBACK_DOWNLOAD);
    }
  }

  setDownload(FALLBACK_DOWNLOAD);

  if (hasDownloadTargets) {
    void loadLatestRelease();
  }

  async function copyChecksum() {
    if (!checksum) return;
    const value = checksum.dataset.checksum;
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.className = 'clipboard-fallback';
      fallback.value = value;
      fallback.setAttribute('readonly', '');
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }

    if (!copyButton) return;
    copyButton.textContent = 'Copied';
    copyButton.classList.add('is-copied');
    window.setTimeout(function () {
      copyButton.textContent = 'Copy';
      copyButton.classList.remove('is-copied');
    }, 1600);
  }

  if (copyButton) {
    copyButton.addEventListener('click', copyChecksum);
  }
})();
