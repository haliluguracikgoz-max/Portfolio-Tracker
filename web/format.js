const num = (min, max) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: min, maximumFractionDigits: max });
const n2 = num(2, 2);
const n0 = num(0, 0);
const n1 = num(1, 1);
const nQty = num(0, 6);
const nPrice = num(2, 4);

const MINUS = '−';
const signOf = (v, shown) => (Number(shown) === 0 ? '' : v > 0 ? '+' : MINUS);

export const money = (v) => (v < -0.005 ? MINUS : '') + '$' + n2.format(Math.abs(v));
export const price = (v) => '$' + nPrice.format(v);
export const signedMoney = (v) => signOf(v, v.toFixed(2)) + '$' + n2.format(Math.abs(v));
export const qty = (v) => nQty.format(v);
export const pct = (v) => (v < -0.00005 ? MINUS : '') + '%' + n2.format(Math.abs(v * 100));
export const pct1 = (v) => '%' + n1.format(v * 100);
export const signedPct = (v) => signOf(v, (v * 100).toFixed(2)) + '%' + n2.format(Math.abs(v * 100));

/** Makro göstergeler: faiz yüzde, petrol dolar, endeksler puan. */
const n3 = num(3, 3);
export const macroValue = (x) => (x.unit === 'yield' ? `%${n3.format(x.value)}` : (x.unit === 'usd' ? '$' : '') + n2.format(x.value));
export const macroChange = (x) => (x.unit === 'yield' ? `${signOf(x.change, (x.change * 100).toFixed(1))}${n1.format(Math.abs(x.change * 100))} bp` : signedPct(x.changePct));

/** Eksen için kısa tutar; adım küçükse ondalık gösterir. */
export function axisMoney(v, step = 1) {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  const unit = a >= 1e6 ? [1e6, 'M'] : a >= 1e4 ? [1e3, 'K'] : [1, ''];
  const digits = Math.max(0, Math.min(2, Math.ceil(-Math.log10(step / unit[0]) - 1e-9)));
  return sign + '$' + num(0, digits).format(a / unit[0]) + unit[1];
}
export function axisPct(v, step = 0.01) {
  const digits = Math.max(0, Math.min(2, Math.ceil(-Math.log10(step * 100) - 1e-9)));
  return (v < -1e-9 ? MINUS : '') + '%' + num(0, digits).format(Math.abs(v * 100));
}

const asDate = (d) => new Date(d + 'T00:00:00Z');
const dateFmt = (o) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', ...o });
const fLong = dateFmt({ day: 'numeric', month: 'short', year: 'numeric' });
const fDay = dateFmt({ day: 'numeric', month: 'short' });
const fMonth = dateFmt({ month: 'short', year: '2-digit' });
const fMonthLong = dateFmt({ month: 'long', year: 'numeric' });
export const longDate = (d) => fLong.format(asDate(d));
export const dayLabel = (d) => fDay.format(asDate(d));
export const monthLabel = (m) => fMonth.format(asDate(m.slice(0, 7) + '-01'));
export const monthLong = (m) => fMonthLong.format(asDate(m.slice(0, 7) + '-01'));
export const clock = (ms) => new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(ms);

/** Form alanına yazılacak sayı: binlik ayırıcı yok, ondalık virgül. */
export const inputNumber = (v) => (v == null ? '' : String(Number(v.toFixed(6))).replace('.', ','));

export const tone = (v) => (Math.abs(v) < 1e-9 ? '' : v > 0 ? 'gain' : 'loss');
export const compactInt = (v) => n0.format(v);

const SECTORS = {
  Technology: 'Teknoloji', 'Financial Services': 'Finans', Healthcare: 'Sağlık', 'Consumer Cyclical': 'Döngüsel tüketim',
  'Consumer Defensive': 'Temel tüketim', 'Communication Services': 'İletişim', Industrials: 'Sanayi', Energy: 'Enerji',
  Utilities: 'Kamu hizmetleri', 'Real Estate': 'Gayrimenkul', 'Basic Materials': 'Temel malzemeler',
};
export const sectorName = (p) => (p.kind === 'ETF' ? 'ETF' : p.kind === 'MUTUALFUND' ? 'Yatırım fonu' : (SECTORS[p.sector] ?? p.sector ?? 'Diğer'));

export const TYPE_LABEL = {
  BUY: 'Alış', SELL: 'Satış', DEPOSIT: 'Nakit girişi', WITHDRAW: 'Nakit çıkışı', DIVIDEND: 'Temettü', INTEREST: 'Faiz', FEE: 'Ücret',
};
