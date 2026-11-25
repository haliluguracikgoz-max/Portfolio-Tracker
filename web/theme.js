// Sayfa çizilmeden önce çalışır ki tema değişimi göz kırpmasın.
try {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // Depolama kapalıysa sistem teması geçerlidir.
}
