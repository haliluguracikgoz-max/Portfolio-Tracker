const nyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Verilen anın New York'taki takvim günü (YYYY-MM-DD). */
export const nyDate = (ms = Date.now()) => nyFormat.format(ms);

export function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Ay sonu taşmalarını ayın son gününe sabitler: 31 Mart − 1 ay = 28/29 Şubat. */
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + months, 0));
  last.setUTCDate(Math.min(d, last.getUTCDate()));
  return last.toISOString().slice(0, 10);
}

export const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
