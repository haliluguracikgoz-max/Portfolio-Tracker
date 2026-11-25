import { nyDate } from '../shared/dates.js';
import { cnbc, number, quotesOf, quoteUrl, time } from './cnbc.js';
import { MarketError, normalizeSymbol } from './market.js';

const TTL = 30_000;
/** Servis uzun süre cevap vermezse eski fiyat, borsa açıldıktan sonra ekranda kalmasın. */
const MAX_AGE = 5 * 60_000;
const BATCH = 60;
/** Seans sürerken SPY her saniye işlem görür; bundan eski bir işlem, durum ne derse desin seansın bittiğini gösterir. */
const QUIET = 15 * 60_000;
/** Borsanın açık olup olmadığı ve son seansın günü, en çok işlem gören bu fondan okunur. */
const REF = 'SPY';

/** Endekslerin kendisi seans dışında hesaplanmaz; onu izleyen fonun hareketi endekse uygulanır. */
const INDEX_FUND = {
  'cnbc:.SPX': 'SPY', 'yahoo:^GSPC': 'SPY', 'cnbc:.NDX': 'QQQ', 'yahoo:^NDX': 'QQQ', 'cnbc:.IXIC': 'QQQ', 'yahoo:^IXIC': 'QQQ',
  'cnbc:.DJI': 'DIA', 'yahoo:^DJI': 'DIA', 'cnbc:.RUT': 'IWM', 'yahoo:^RUT': 'IWM', 'cnbc:.SOX': 'SOXX', 'yahoo:^SOX': 'SOXX',
};

/** Panel satırının seans dışı fiyatı hangi sembolden okunur? ABD hissesi, ETF'si ya da endeksi değilse null. */
export function extendedSource({ id, unit }) {
  if (INDEX_FUND[id]) return { symbol: INDEX_FUND[id], index: true };
  const symbol = id.startsWith('yahoo:') ? id.slice(6) : null;
  return symbol && unit === 'usd' && normalizeSymbol(symbol) === symbol && !symbol.endsWith('-USD') ? { symbol, index: false } : null;
}

const toCode = (symbol) => symbol.replaceAll('-', '.');

/** CNBC yanıtı → Map(kod → { open, date, close, ext }). ext: son seans dışı işlem. */
export function parseExtended(json) {
  const out = new Map();
  for (const q of quotesOf(json)) {
    const close = number(q.last);
    const at = time(q.last_time);
    if (close == null || at == null || q.countryCode !== 'US' || q.type !== 'STOCK') continue;
    const e = q.ExtendedMktQuote;
    const price = number(e?.last);
    const extAt = time(e?.last_time);
    const session = { PRE_MKT: 'pre', POST_MKT: 'post' }[e?.type];
    out.set(q.symbol, {
      open: q.curmktstatus === 'REG_MKT' && Date.now() - at < QUIET, date: nyDate(at), close,
      ext: price > 0 && extAt != null && session ? { price, at: extAt, session } : null,
    });
  }
  return out;
}

/** ABD hisse ve ETF'lerinin açılış öncesi ve kapanış sonrası fiyatları. */
export class Extended {
  #get;
  #quotes = new Map();
  #inflight = new Map();

  constructor(get = cnbc) {
    this.#get = get;
  }

  /** Sembollerin fiyatını tazeler. Hata fırlatmaz: bu ek bilgi gelmezse sayfanın geri kalanı etkilenmez. */
  async load(symbols, { force = false } = {}) {
    try {
      await this.#fetch([REF], force);
      if (this.#ref()?.open === false) await this.#fetch(symbols.filter((s) => s !== REF), force);
    } catch (e) {
      if (!(e instanceof MarketError)) console.error(e);
    }
  }

  async #fetch(symbols, force) {
    const now = Date.now();
    const stale = [...new Set(symbols)].filter((s) => force || now - (this.#quotes.get(s)?.fetchedAt ?? -Infinity) >= TTL);
    const jobs = [];
    for (let i = 0; i < stale.length; i += BATCH) {
      const part = stale.slice(i, i + BATCH);
      const key = part.join();
      if (!this.#inflight.has(key)) this.#inflight.set(key, this.#request(part).finally(() => this.#inflight.delete(key)));
      jobs.push(this.#inflight.get(key));
    }
    await Promise.all(jobs);
  }

  async #request(symbols) {
    const found = parseExtended(await this.#get(quoteUrl(symbols.map(toCode))));
    const fetchedAt = Date.now();
    // Yanıtta olmayan sembol de kaydedilir; her soruşta yeniden istenmez.
    for (const s of symbols) this.#quotes.set(s, { ...found.get(toCode(s)), fetchedAt });
  }

  #ref() {
    const q = this.#quotes.get(REF);
    return q?.date && Date.now() - q.fetchedAt < MAX_AGE ? q : null;
  }

  /** Borsa kapalıyken son seans dışı fiyat: { price, pct, at, session }. Borsa açıkken ya da işlem yoksa null. Yüzde, verilirse ekranda görünen kapanışa göredir. */
  of(symbol, shown = null) {
    const ref = this.#ref();
    const q = this.#quotes.get(symbol);
    if (!ref || ref.open || !q?.ext || !(q.close > 0) || Date.now() - q.fetchedAt >= MAX_AGE) return null;
    // Son seanstan önceki işlem eskidir: o günün sabahı ya da bir önceki günün akşamı.
    const day = nyDate(q.ext.at);
    if (q.ext.session === 'pre' ? day <= ref.date : day < ref.date) return null;
    return { price: q.ext.price, pct: q.ext.price / (shown > 0 ? shown : q.close) - 1, at: q.ext.at, session: q.ext.session };
  }
}
