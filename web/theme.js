// Sayfa çizilmeden önce çalışır ki tema değişimi göz kırpmasın.
(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  // Telefonun durum çubuğu, uygulamada seçilen temayla aynı renkte olsun.
  const paintStatusBar = () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : system.matches;
    document.querySelector('meta[name="theme-color"]').content = dark ? '#141b26' : '#ffffff';
  };
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch {
    // Depolama kapalıysa sistem teması geçerlidir.
  }
  paintStatusBar();
  system.addEventListener('change', paintStatusBar);
  new MutationObserver(paintStatusBar).observe(root, { attributeFilter: ['data-theme'] });
})();
