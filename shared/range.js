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

/**
 * Geçmişi seçilen döneme indirger. Getiriler ve düşüş, dönemin taban noktasına göre
 * yeniden hesaplanır; portföy dönemden gençse taban, ilk işlemden önceki gündür.
 */
export function sliceRange(history, base, key) {
  if (!history.length) return null;
  const last = history.at(-1);
  const from = rangeBaseDate(key, last.date);
  let i = -1;
  if (from) while (i + 1 < history.length && history[i + 1].date <= from) i++;

  const origin =
    i >= 0
      ? history[i]
      : { date: base && base.date < history[0].date ? base.date : addDays(history[0].date, -1), value: 0, contributed: 0, index: 1, bench: base?.bench ?? history[0].bench };
  const points = history.slice(i + 1);
  const all = i >= 0 ? [origin, ...points] : points;

  const pct = (v, v0) => (v != null && v0 ? v / v0 - 1 : null);
  let peak = origin.index;
  let maxDrawdown = 0;
  const drawdown = [];
  for (const p of points) {
    peak = Math.max(peak, p.index);
    const dd = p.index / peak - 1;
    maxDrawdown = Math.min(maxDrawdown, dd);
    drawdown.push(dd);
  }

  const netFlow = last.contributed - origin.contributed;
  return {
    /** Değer grafiği: taban günü gerçekten varsa dahil. */
    dates: all.map((p) => p.date),
    value: all.map((p) => p.value),
    contributed: all.map((p) => p.contributed),
    /** Getiri grafiği: her zaman %0'dan başlar. */
    returnDates: [origin.date, ...points.map((p) => p.date)],
    portfolio: [0, ...points.map((p) => p.index / origin.index - 1)],
    bench: [0, ...points.map((p) => pct(p.bench, origin.bench))],
    drawdown: [0, ...drawdown],
    startValue: origin.value,
    netFlow,
    gain: last.value - origin.value - netFlow,
    twr: last.index / origin.index - 1,
    benchReturn: pct(last.bench, origin.bench),
    maxDrawdown,
  };
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
