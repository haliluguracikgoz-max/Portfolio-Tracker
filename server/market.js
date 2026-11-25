import { addDays, nyDate } from '../shared/dates.js';
import { transaction } from './db.js';

export const BENCH = '^GSPC';
const BASE = 'https://query1.finance.yahoo.com';
const HISTORY_TTL = 12 * 3600_000;
/** Sayfa 60 saniyede bir sorar; her soruşta taze fiyat için önbellek bundan kısadır. */
const QUOTE_TTL = 30_000;
const GAP_RETRY = 30 * 60_000;
const GAP_DAYS = 25;
const KINDS = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
// Yahoo'nun ABD borsa kodları: NASDAQ, NYSE, AMEX, Arca, Cboe ve tezgâh üstü pazarlar.
export const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'ASE', 'PCX', 'BTS', 'CBO', 'PNK', 'OQB', 'OQX', 'OEM', 'YHD']);

export class MarketError extends Error {}

/** BRK.B → BRK-B. Geçersizse null. */
export function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replaceAll('.', '-');
  return /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s) ? s : null;
}

export async function yahoo(path) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MarketError('Fiyat servisine ulaşılamadı. İnternet bağlantınızı kontrol edin.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new MarketError(`Fiyat servisi yanıt vermedi (HTTP ${res.status}).`);
  return res.json();
}

/** Yahoo grafik yanıtını sade kayıtlara çevirir. */
export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r?.meta) return null;
  const closes = new Map();
  const raw = r.indicators?.quote?.[0]?.close ?? [];
  (r.timestamp ?? []).forEach((t, i) => {
    if (raw[i] > 0) closes.set(nyDate(t * 1000), raw[i]);
  });
  const splits = Object.values(r.events?.splits ?? {})
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ date: nyDate(s.date * 1000), ratio: s.numerator / s.denominator }));
  const dividends = Object.values(r.events?.dividends ?? {})
    .filter((d) => d.amount > 0)
    .map((d) => ({ date: nyDate(d.date * 1000), perShare: d.amount }));
  return { meta: r.meta, closes: [...closes].map(([date, close]) => ({ date, close })), splits, dividends };
}

/**
 * Önceki kapanış. Yahoo'nun günlük mumlarında son günler bazen boş gelir ya da bölünmeye göre
 * düzeltilmemiş olur; o zaman son mum yanıltır. Yahoo'nun bildirdiği günlük değişim esas alınır.
 */
export function previousClose(meta, barClose) {
  const price = meta.regularMarketPrice;
  const pct = meta.regularMarketChangePercent;
  if (!(price > 0) || !Number.isFinite(pct) || pct <= -100) return barClose ?? price ?? null;
  const reported = price / (1 + pct / 100);
  // Bildirilen yüzde yuvarlanmıştır; mumla örtüşüyorsa mumun tam değeri kullanılır.
  return barClose > 0 && Math.abs(barClose / reported - 1) < 5e-4 ? barClose : reported;
}

export class Market {
  #db;
  #get;
  #inflight = new Map();
  #closes = new Map();
  #warned = new Set();
  #filledAt = new Map();

  constructor(db, get = yahoo) {
    this.#db = db;
    this.#get = get;
  }

  #row(symbol) {
    return this.#db.prepare('SELECT * FROM symbols WHERE symbol = ?').get(symbol) ?? null;
  }

  closes(symbol) {
    if (!this.#closes.has(symbol)) {
      this.#closes.set(symbol, this.#db.prepare('SELECT date, close FROM prices WHERE symbol = ? ORDER BY date').all(symbol));
    }
    return this.#closes.get(symbol);
  }
  bench() {
    return this.closes(BENCH);
  }
  quote(symbol) {
    const r = this.#row(symbol);
    return r?.price ? { price: r.price, prevClose: r.prev_close, date: r.quote_date, time: r.quote_time } : null;
  }
  splits(symbol) {
    return this.#db.prepare('SELECT date, ratio FROM splits WHERE symbol = ? ORDER BY date').all(symbol);
  }
  dividends(symbol) {
    return this.#db.prepare('SELECT date, per_share AS perShare FROM dividends WHERE symbol = ? ORDER BY date').all(symbol);
  }
  info(symbol) {
    const r = this.#row(symbol);
    return { symbol, name: r?.name ?? symbol, kind: r?.kind ?? 'EQUITY', exchange: r?.exchange ?? '', sector: r?.sector ?? null };
  }
  isOpen(now = Date.now()) {
    const r = this.#row(BENCH);
    const t = now / 1000;
    return !!r?.session_start && t >= r.session_start && t < r.session_end && r.quote_time >= r.session_start;
  }

  /** Hesaplama boyunca tekrar tekrar SQL'e gitmemek için sabit bir görünüm. */
  snapshot() {
    const memo = (fn) => {
      const cache = new Map();
      return (key) => {
        if (!cache.has(key)) cache.set(key, fn(key));
        return cache.get(key);
      };
    };
    return {
      closes: (s) => this.closes(s),
      bench: () => this.bench(),
      quote: memo((s) => this.quote(s)),
      splits: memo((s) => this.splits(s)),
      dividends: memo((s) => this.dividends(s)),
      info: memo((s) => this.info(s)),
    };
  }

  /** Sembolün `from` tarihinden bugüne verisi hazır olsun. Aynı anda gelen istekler birleşir. */
  async ensure(symbol, from, { force = false } = {}) {
    const key = `${symbol}|${from}|${force}`;
    if (!this.#inflight.has(key)) {
      this.#inflight.set(key, this.#ensure(symbol, from, force).finally(() => this.#inflight.delete(key)));
    }
    return this.#inflight.get(key);
  }

  async #ensure(symbol, from, force) {
    const now = Date.now();
    const row = this.#row(symbol);
    const start = row?.covered_from && row.covered_from < from ? row.covered_from : from;
    if (!row || !row.covered_from || from < row.covered_from || now - row.history_at > HISTORY_TTL) {
      return this.#fetchHistory(symbol, start);
    }
    if (!force && now - row.quote_at < QUOTE_TTL) return;

    const chart = parseChart(await this.#get(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&events=split%2Cdiv`));
    if (!chart) return;
    // Yeni bölünme, saklanan tüm eski kapanışları geçersiz kılar.
    const known = new Set(this.splits(symbol).map((s) => s.date));
    if (chart.splits.some((s) => !known.has(s.date))) return this.#fetchHistory(symbol, start);
    this.#store(symbol, chart, {});
    await this.#fillFromHourly(symbol, now);
  }

  async #fetchHistory(symbol, from) {
    const period1 = Math.floor(Date.parse(addDays(from, -10) + 'T00:00:00Z') / 1000);
    const period2 = Math.floor(Date.now() / 1000) + 86_400;
    const chart = parseChart(
      await this.#get(`/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=split%2Cdiv`),
    );
    if (!chart) throw new MarketError(`“${symbol}” sembolü bulunamadı.`);
    if (symbol !== BENCH && (chart.meta.currency !== 'USD' || !KINDS.has(chart.meta.instrumentType))) {
      throw new MarketError(`“${symbol}” desteklenmiyor. Yalnızca ABD borsalarındaki hisse ve fonlar eklenebilir.`);
    }
    let sector = this.#row(symbol)?.sector ?? null;
    if (!sector && chart.meta.instrumentType === 'EQUITY') {
      sector = (await this.search(symbol).catch(() => [])).find((q) => q.symbol === symbol)?.sector ?? null;
    }
    this.#store(symbol, chart, { coveredFrom: from, sector });
    await this.#fillFromHourly(symbol, Date.now());
  }

  /** Günlük mumu hiç gelmeyen son günler, saatlik mumların gün sonu değeriyle doldurulur. Günlük mum gelince onun yerini alır. */
  async #fillFromHourly(symbol, now) {
    if (symbol === BENCH || now - (this.#filledAt.get(symbol) ?? -Infinity) < GAP_RETRY) return;
    const stored = this.closes(symbol);
    const today = this.quote(symbol)?.date;
    const have = new Set(stored.map((c) => c.date));
    const recent = addDays(nyDate(now), -GAP_DAYS);
    const missing = new Set(this.bench().map((b) => b.date).filter((d) => d > recent && d > stored[0]?.date && d < today && !have.has(d)));
    if (!missing.size) return;
    this.#filledAt.set(symbol, now);
    const hourly = await this.#get(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=60m`).catch(() => null);
    // Gün içinde son mum kazanır.
    const found = (parseChart(hourly)?.closes ?? []).filter((c) => missing.has(c.date));
    const insert = this.#db.prepare('INSERT INTO prices VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    for (const c of found) insert.run(symbol, c.date, c.close);
    if (found.length) this.#closes.delete(symbol);
    console.log(`${symbol}: ${missing.size} eksik günün ${found.length} tanesi saatlik veriyle dolduruldu.`);
  }

  /** Yanıtta bir önceki işlem günü yoksa ve kayıtlı da değilse, o günün kapanışı önceki kapanıştır. */
  #fillGap(symbol, closes, quoteDate, prev, barClose) {
    const have = new Set(closes.map((c) => c.date));
    const missing = this.bench().map((b) => b.date).filter((d) => closes.length && d > closes[0].date && d < quoteDate && !have.has(d));
    const key = `${symbol}|${quoteDate}|${missing.join()}`;
    if ((missing.length || (barClose && prev && Math.abs(barClose / prev - 1) > 5e-3)) && !this.#warned.has(key)) {
      this.#warned.add(key);
      console.warn(`${symbol}: kaynak verisi tutarsız. Eksik günler: ${missing.slice(-5).join(', ') || 'yok'}; son mum ${barClose}, önceki kapanış ${prev}`);
    }
    const last = this.bench().map((b) => b.date).filter((d) => d < quoteDate).at(-1);
    if (!last || !prev || have.has(last) || this.closes(symbol).some((c) => c.date === last)) return [];
    return [{ date: last, close: prev }];
  }

  #store(symbol, chart, { coveredFrom, sector }) {
    const { meta, closes } = chart;
    const now = Date.now();
    const quoteDate = meta.regularMarketTime ? nyDate(meta.regularMarketTime * 1000) : (closes.at(-1)?.date ?? nyDate());
    const barClose = closes.filter((c) => c.date < quoteDate).at(-1)?.close;
    const prev = previousClose(meta, barClose);
    const filled = symbol === BENCH ? [] : this.#fillGap(symbol, closes, quoteDate, prev, barClose);
    const session = meta.currentTradingPeriod?.regular;
    const quote = [meta.regularMarketPrice ?? null, prev ?? null, quoteDate, meta.regularMarketTime ?? null, session?.start ?? null, session?.end ?? null];

    transaction(this.#db, () => {
      if (coveredFrom) {
        this.#db
          .prepare(
            `INSERT INTO symbols (symbol, name, kind, exchange, currency, sector, covered_from, history_at, quote_at, price, prev_close, quote_date, quote_time, session_start, session_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (symbol) DO UPDATE SET name = excluded.name, kind = excluded.kind, exchange = excluded.exchange,
               sector = excluded.sector, covered_from = excluded.covered_from, history_at = excluded.history_at, quote_at = excluded.quote_at,
               price = excluded.price, prev_close = excluded.prev_close, quote_date = excluded.quote_date, quote_time = excluded.quote_time,
               session_start = excluded.session_start, session_end = excluded.session_end`,
          )
          .run(symbol, meta.longName ?? meta.shortName ?? symbol, meta.instrumentType ?? 'EQUITY', meta.fullExchangeName ?? '', meta.currency ?? 'USD', sector, coveredFrom, now, now, ...quote);
      } else {
        this.#db
          .prepare('UPDATE symbols SET quote_at = ?, price = ?, prev_close = ?, quote_date = ?, quote_time = ?, session_start = ?, session_end = ? WHERE symbol = ?')
          .run(now, ...quote, symbol);
      }
      const price = this.#db.prepare('INSERT INTO prices VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET close = excluded.close');
      for (const c of [...closes, ...filled]) price.run(symbol, c.date, c.close);
      const split = this.#db.prepare('INSERT INTO splits VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET ratio = excluded.ratio');
      for (const s of chart.splits) split.run(symbol, s.date, s.ratio);
      const div = this.#db.prepare('INSERT INTO dividends VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET per_share = excluded.per_share');
      for (const d of chart.dividends) div.run(symbol, d.date, d.perShare);
    });
    this.#closes.delete(symbol);
  }

  async search(q) {
    const json = await this.#get(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`);
    return (json?.quotes ?? [])
      .filter((x) => KINDS.has(x.quoteType) && US_EXCHANGES.has(x.exchange) && normalizeSymbol(x.symbol) === x.symbol)
      .slice(0, 8)
      .map((x) => ({ symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, kind: x.quoteType, exchange: x.exchDisp ?? '', sector: x.sector ?? null }));
  }
}
