// Sayfa çizilmeden önce çalışır ki tema değişimi göz kırpmasın.
(() => {
  const root = document.documentElement;
  // Telefonun durum çubuğu, uygulamada seçilen temayla aynı renkte olsun.
  const paintStatusBar = () => {
    document.querySelector('meta[name="theme-color"]').content = root.dataset.theme === 'light' ? '#ffffff' : '#141b26';
  };
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {
    // Depolama kapalıysa varsayılan tema geçerlidir.
  }
  // Seçim yapılmadıysa sistem ayarından bağımsız olarak koyu tema açılır.
  root.dataset.theme = saved === 'light' ? 'light' : 'dark';
  paintStatusBar();
  new MutationObserver(paintStatusBar).observe(root, { attributeFilter: ['data-theme'] });
})();
