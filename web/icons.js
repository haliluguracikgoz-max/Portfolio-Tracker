import { s } from './dom.js';

// Telefonlarda emoji ya da boş kutu olarak görünebilen semboller yerine çizim kullanılır.
const PATHS = {
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  logout: 'M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h11M17.5 8.5 21 12l-3.5 3.5',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  home: 'M4 18.5l5.5-6.5 4.5 3.5L20 7',
  chevron: 'M6 9l6 6 6-6',
  chevrons: 'M6 6l6 6 6-6M6 13l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
};

export const icon = (name, size = 20) =>
  s('svg', { width: size, height: size, viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true' }, s('path', { d: PATHS[name] }));
