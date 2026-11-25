const COLUMNS = ['date', 'type', 'symbol', 'quantity', 'price', 'amount', 'fee', 'settle', 'note'];

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// Baştaki BOM, Excel'in Türkçe karakterleri doğru okuması içindir.
export const toCsv = (txs) => '﻿' + [COLUMNS.join(','), ...txs.map((t) => COLUMNS.map((c) => cell(t[c])).join(','))].join('\r\n') + '\r\n';

function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Excel'in Türkçe ayarla kaydettiği noktalı virgüllü dosyaları da okur. */
export function fromCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const header = clean.split('\n', 1)[0];
  const delimiter = header.split(';').length > header.split(',').length ? ';' : ',';
  const [head, ...rows] = parseRows(clean, delimiter);
  const names = (head ?? []).map((h) => h.trim().toLowerCase());
  const missing = ['date', 'type'].filter((c) => !names.includes(c));
  if (missing.length) throw new Error(`CSV başlığında eksik sütun: ${missing.join(', ')}. Beklenen: ${COLUMNS.join(', ')}`);
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}
