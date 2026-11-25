import { MarketError } from './market.js';

const TTL = 30_000;
const URL_BASE = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

/** source: servisteki kod. unit: 'yield' olanlar yüzde cinsinden faizdir, değişimi baz puanla gösterilir. */
export const INDICATORS = [
  { symbol: 'CL', name: 'Crude Oil WTI', source: '@CL.1', unit: 'usd' },
  { symbol: 'US2YT', name: 'U.S. 2Y', source: 'US2Y', unit: 'yield' },
  { symbol: 'US10YT', name: 'U.S. 10Y', source: 'US10Y', unit: 'yield' },
  { symbol: 'US30YT', name: 'U.S. 30Y', source: 'US30Y', unit: 'yield' },
  { symbol: 'DXY', name: 'US Dollar Index', source: '.DXY', unit: 'index' },
  { symbol: 'VIX', name: 'S&P 500 VIX', source: '.VIX', unit: 'index' },
];

async function cnbc() {
  const symbols = encodeURIComponent(INDICATORS.map((x) => x.source).join('|'));
  let res;
  try {
    res = await fetch(`${URL_BASE}?symbols=${symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MarketError('Makro veri servisine ulaşılamadı.');
  }
  if (!res.ok) throw new MarketError(`Makro veri servisi yanıt vermedi (HTTP ${res.status}).`);
  return res.json();
}

const number = (text) => {
  const s = String(text ?? '').replace(/[%,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

/** Değişim, servisin yüzde alanı faizlerde tutarsız olduğu için önceki kapanıştan hesaplanır. */
export function parseMacro(json) {
  const list = json?.FormattedQuoteResult?.FormattedQuote;
  const bySource = new Map((Array.isArray(list) ? list : []).map((q) => [q.symbol, q]));
  return INDICATORS.map(({ symbol, name, source, unit }) => {
    const q = bySource.get(source);
    const value = number(q?.last);
    const prev = number(q?.previous_day_closing);
    const time = Date.parse(String(q?.last_time ?? '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return {
      symbol, name, unit, value,
      change: value != null && prev != null ? value - prev : null,
      changePct: value != null && prev > 0 ? value / prev - 1 : null,
      time: Number.isFinite(time) ? time : null,
      delayed: q?.realTime === 'false',
    };
  });
}

export class Macro {
  #get;
  #items = null;
  #asOf = 0;
  #triedAt = -Infinity;
  #error = null;
  #inflight = null;

  constructor(get = cnbc) {
    this.#get = get;
  }

  /** Servis cevap vermezse son bilinen değerler `error` ile birlikte döner. */
  async get({ force = false } = {}) {
    if (force || Date.now() - this.#triedAt >= TTL) {
      this.#inflight ??= this.#refresh().finally(() => (this.#inflight = null));
    }
    await this.#inflight;
    return { items: this.#items ?? [], asOf: this.#asOf || null, error: this.#error };
  }

  async #refresh() {
    this.#triedAt = Date.now();
    try {
      const items = parseMacro(await this.#get());
      if (items.every((x) => x.value == null)) throw new MarketError('Makro veri servisi boş yanıt verdi.');
      // Tek bir göstergenin verisi eksik gelirse son bilinen değeri korunur.
      this.#items = items.map((x, i) => (x.value == null ? (this.#items?.[i] ?? x) : x));
      this.#asOf = Date.now();
      this.#error = null;
    } catch (e) {
      if (!(e instanceof MarketError)) console.error(e);
      this.#error = e instanceof MarketError ? e.message : 'Makro veriler okunamadı.';
    }
  }
}
