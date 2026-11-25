import { addDays, addMonths } from './dates.js';

export const RANGES = [
  { key: '1W', label: '1H', title: 'Son 1 hafta' },
  { key: '1M', label: '1A', title: 'Son 1 ay' },
  { key: '3M', label: '3A', title: 'Son 3 ay' },
  { key: '6M', label: '6A', title: 'Son 6 ay' },
  { key: 'YTD', label: 'YBB', title: 'Yıl başından beri' },
  { key: '1Y', label: '1Y', title: 'Son 1 yıl' },
  { key: 'ALL', label: 'Tümü', title: 'Başlangıçtan beri' },
];

/** Dönemin taban günü: getiri bu günün kapanışından itibaren ölçülür. null = başlangıç. */
export function rangeBaseDate(key, lastDate) {
  switch (key) {
    case '1W': return addDays(lastDate, -7);
    case '1M': return addMonths(lastDate, -1);
    case '3M': return addMonths(lastDate, -3);
    case '6M': return addMonths(lastDate, -6);
    case 'YTD': return `${Number(lastDate.slice(0, 4)) - 1}-12-31`;
    case '1Y': return addMonths(lastDate, -12);
    default: return null;
  }
}

/** Takvim ayı bazında zaman ağırlıklı getiriler. */
export function monthlyReturns(history) {
  const out = [];
  let prev = 1;
  for (let i = 0; i < history.length; i++) {
    const month = history[i].date.slice(0, 7);
    if (history[i + 1]?.date.slice(0, 7) === month) continue;
    out.push({ month, value: history[i].index / prev - 1 });
    prev = history[i].index;
  }
  return out;
}
