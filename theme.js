(function(global) {
  'use strict';

  function initTheme() {
    const savedTheme = localStorage.getItem('shungxin_theme');
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
      const prefersDark = global.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('shungxin_theme', newTheme);
    if (typeof global.showToast === 'function') {
      global.showToast(newTheme === 'light' ? '已切换到浅色主题' : '已切换到深色主题');
    }
    try { global.EventBus && global.EventBus.emit('theme:change', { from: currentTheme, to: newTheme }); } catch (e) {}
  }

  initTheme();
  document.addEventListener('DOMContentLoaded', function() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
  });

  global.initTheme = initTheme;
  global.toggleTheme = toggleTheme;
  global.Theme = {
    init: initTheme,
    toggle: toggleTheme,
  };
})(window);
