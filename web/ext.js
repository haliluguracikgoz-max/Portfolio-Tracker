import { h } from './dom.js';
import * as f from './format.js';

export const SESSION_NAME = { pre: 'Açılış öncesi', post: 'Kapanış sonrası', night: 'Gece seansı' };

/** Borsa kapalıyken fiyatın altında parantez içinde açılış öncesi ya da kapanış sonrası fiyat. */
export function extPrice(ext, format) {
  if (!ext) return null;
  const when = `${SESSION_NAME[ext.session]}, ${f.clock(ext.at)}${ext.via ? `. ${ext.via} fonunun hareketine göre yaklaşık` : ''}`;
  return h('span', { class: `ext ${f.tone(ext.pct)}`, title: when }, `(${format(ext.price)}`, h('i', null, ` ${f.signedPct(ext.pct)}`), ')');
}
