import { addDays, nyDate } from '../shared/dates.js';
import { transaction } from './db.js';

export const BENCH = '^GSPC';
const BASE = 'https://query1.finance.yahoo.com';
const HISTORY_TTL = 12 * 3600_000;
const QUOTE_TTL_OPEN = 30_000;
const QUOTE_TTL_CLOSED = 10 * 60_000;
// Kapanıştan sonra resmî kapanış fiyatının oturması için tanınan süre (saniye).
const CLOSE_GRACE = 30 * 60;
const KINDS = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
// Yahoo'nun ABD borsa kodları: NASDAQ, NYSE, AMEX, Arca, Cboe ve tezgâh üstü pazarlar.
const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'ASE', 'PCX', 'BTS', 'CBO', 'PNK', 'OQB', 'OQX', 'OEM', 'YHD']);

export class MarketError extends Error {}

/** BRK.B → BRK-B. Geçersizse null. */
export function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replaceAll('.', '-');
  return /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s) ? s : null;
}

async function yahoo(path) {
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

export class Market {
  #db;
  #get;
  #inflight = new Map();
  #closes = new Map();

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

  /**
   * Fiyatın tazelik süresi. Seans saatlerinde her fiyat, kapalıyken yalnızca endeks sık yenilenir:
   * endeks sonraki seansın saatini verdiği için açılış gecikmeden fark edilir.
   */
  #quoteTtl(symbol, now) {
    const r = this.#row(BENCH);
    const t = now / 1000;
    const session = r?.session_start && t >= r.session_start && t < r.session_end + CLOSE_GRACE;
    return session || symbol === BENCH ? QUOTE_TTL_OPEN : QUOTE_TTL_CLOSED;
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
    if (!force && now - row.quote_at < this.#quoteTtl(symbol, now)) return;

    const chart = parseChart(await this.#get(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&events=split%2Cdiv`));
    if (!chart) return;
    // Yeni bölünme, saklanan tüm eski kapanışları geçersiz kılar.
    const known = new Set(this.splits(symbol).map((s) => s.date));
    if (chart.splits.some((s) => !known.has(s.date))) return this.#fetchHistory(symbol, start);
    this.#store(symbol, chart, {});
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
  }

  #store(symbol, chart, { coveredFrom, sector }) {
    const { meta, closes } = chart;
    const now = Date.now();
    const quoteDate = meta.regularMarketTime ? nyDate(meta.regularMarketTime * 1000) : (closes.at(-1)?.date ?? nyDate());
    const prev = closes.filter((c) => c.date < quoteDate).at(-1)?.close ?? meta.regularMarketPrice;
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
      for (const c of closes) price.run(symbol, c.date, c.close);
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
