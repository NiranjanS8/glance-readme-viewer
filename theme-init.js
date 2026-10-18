// Runs in <head> before first paint, so the stored (or OS) theme is on
// <html> before the stylesheet resolves — otherwise dark-mode users see a
// flash of the light theme on launch.
(function () {
  'use strict';

  const THEME_KEY = 'glance-theme';
  let theme = null;

  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch {
    // storage unavailable; fall through to OS preference
  }

  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.documentElement.setAttribute('data-theme', theme);
})();
