(function () {
  'use strict';

  const THEME_KEY = 'glance-site-theme';
  let theme = null;

  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    // storage unavailable; fall through to the OS preference
  }

  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.documentElement.setAttribute('data-theme', theme);
})();
