(function () {
  try {
    var saved = localStorage.getItem('flowmap-theme');
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : (prefersLight ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* localStorage may be unavailable — default dark */ }
})();
