/**
 * "1.234,56", "1,234.56", "12,5" ve "12.5" biçimlerini kabul eder.
 * Tek başına virgül ya da nokta ondalık ayıracı sayılır. Boşsa null, sayı değilse NaN.
 */
export function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[\s$]/g, '');
  if (s === '') return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replaceAll('.', '').replace(',', '.') : s.replaceAll(',', '');
  else if (comma >= 0) s = s.indexOf(',') === comma ? s.replace(',', '.') : s.replaceAll(',', '');
  else if (dot >= 0 && s.indexOf('.') !== dot) s = s.replaceAll('.', '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}
