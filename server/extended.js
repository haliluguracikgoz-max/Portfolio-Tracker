import { nyDate } from '../shared/dates.js';
import { cnbc, number, quotesOf, quoteUrl, time } from './cnbc.js';
import { MarketError, normalizeSymbol } from './market.js';
import { getYahooQuotes } from './yahoo-quote.js';

const TTL = 30_000;
/** Servis uzun süre cevap vermezse eski fiyat, borsa açıldıktan sonra ekranda kalmasın. */
const MAX_AGE = 5 * 60_000;
const BATCH = 60;
const YAHOO_BATCH = 50;
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

const SESSIONS = [['pre', 'preMarket'], ['post', 'postMarket'], ['night', 'overnightMarket']];

/** Yahoo kotasyonu → { regAt, state, list }. list: fiyatı ve saati bilinen seans dışı işlemler. */
export function parseYahoo(q) {
  const list = [];
  for (const [session, key] of SESSIONS) {
    const price = q[`${key}Price`];
    const at = q[`${key}Time`];
    if (price > 0 && at > 0) list.push({ price, at: at * 1000, session });
  }
  return { regAt: q.regularMarketTime > 0 ? q.regularMarketTime * 1000 : null, close: q.regularMarketPrice, state: q.marketState, list };
}

const later = (a, b) => (!a || (b && b.at > a.at) ? b : a);

/**
 * ABD hisse ve ETF'lerinin açılış öncesi, kapanış sonrası ve gece seansı fiyatları.
 * CNBC açılış öncesi ile kapanış sonrasını verir; gece seansı (20:00-04:00 ET) yalnızca
 * Yahoo'da vardır. İki kaynaktan hangisi daha yeni geçerli bir işlem gösteriyorsa o kullanılır;
 * biri erişilemezse diğeriyle devam edilir.
 */
export class Extended {
  #get;
  #getYahoo;
  #quotes = new Map();
  #yahoo = new Map();
  #inflight = new Map();
  #yahooError;

  constructor(get = cnbc, getYahoo = getYahooQuotes) {
    this.#get = get;
    this.#getYahoo = getYahoo;
  }

  /** Sembollerin fiyatını tazeler. Hata fırlatmaz: bu ek bilgi gelmezse sayfanın geri kalanı etkilenmez. */
  async load(symbols, { force = false } = {}) {
    await this.#both([REF], force);
    if (this.#open() === false) await this.#both(symbols.filter((s) => s !== REF), force);
  }

  #both(symbols, force) {
    const quiet = (job) => job.catch((e) => {
      if (!(e instanceof MarketError)) console.error(e);
    });
    const yahoo = this.#fetch('yahoo', this.#yahoo, symbols, force, YAHOO_BATCH, (part) => this.#requestYahoo(part)).then(
      () => this.#yahooStatus(null),
      (e) => this.#yahooStatus(e instanceof MarketError ? e.message : (console.error(e), 'Beklenmeyen hata.')),
    );
    return Promise.all([quiet(this.#fetch('cnbc', this.#quotes, symbols, force, BATCH, (part) => this.#request(part))), yahoo]);
  }

  /** Gece seansı kaynağının durumu yalnızca değiştiğinde günlüğe yazılır. */
  #yahooStatus(error) {
    if (error === this.#yahooError) return;
    this.#yahooError = error;
    if (error) console.warn(`Gece seansı fiyatları alınamıyor: ${error}`);
    else console.log('Gece seansı fiyatları alınıyor.');
  }

  async #fetch(source, store, symbols, force, size, request) {
    const now = Date.now();
    const stale = [...new Set(symbols)].filter((s) => force || now - (store.get(s)?.fetchedAt ?? -Infinity) >= TTL);
    const jobs = [];
    for (let i = 0; i < stale.length; i += size) {
      const part = stale.slice(i, i + size);
      const key = `${source}:${part.join()}`;
      if (!this.#inflight.has(key)) this.#inflight.set(key, request(part).finally(() => this.#inflight.delete(key)));
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

  async #requestYahoo(symbols) {
    const found = new Map((await this.#getYahoo(symbols)).map((q) => [q.symbol, parseYahoo(q)]));
    const fetchedAt = Date.now();
    for (const s of symbols) this.#yahoo.set(s, { ...found.get(s), fetchedAt });
  }

  #fresh(store, symbol) {
    const q = store.get(symbol);
    return q && Date.now() - q.fetchedAt < MAX_AGE ? q : null;
  }

  #ref() {
    const q = this.#fresh(this.#quotes, REF);
    return q?.date ? q : null;
  }

  #yahooRef() {
    const q = this.#fresh(this.#yahoo, REF);
    return q?.regAt ? q : null;
  }

  /** Normal seans sürüyor mu? Hiçbir kaynaktan bilinmiyorsa null. */
  #open() {
    const ref = this.#ref();
    if (ref) return ref.open;
    const y = this.#yahooRef();
    return y ? y.state === 'REGULAR' : null;
  }

  /** CNBC'deki son seans dışı işlem; son seanstan önceyse null. */
  #fromCnbc(symbol) {
    const ref = this.#ref();
    const q = this.#fresh(this.#quotes, symbol);
    if (!ref || !q?.ext) return null;
    // Son seanstan önceki işlem eskidir: o günün sabahı ya da bir önceki günün akşamı.
    const day = nyDate(q.ext.at);
    return (q.ext.session === 'pre' ? day <= ref.date : day < ref.date) ? null : q.ext;
  }

  /** Yahoo'daki en yeni seans dışı işlem; son normal seansın kapanışından önceyse sayılmaz. */
  #fromYahoo(symbol) {
    const ref = this.#yahooRef();
    const q = this.#fresh(this.#yahoo, symbol);
    if (!ref || !q?.list) return null;
    return q.list.filter((x) => x.at > ref.regAt).reduce(later, null);
  }

  /** Borsa kapalıyken son seans dışı fiyat: { price, pct, at, session }. Borsa açıkken ya da işlem yoksa null. Yüzde, verilirse ekranda görünen kapanışa göredir. */
  of(symbol, shown = null) {
    if (this.#open() !== false) return null;
    const ext = later(this.#fromCnbc(symbol), this.#fromYahoo(symbol));
    const close = shown > 0 ? shown : this.#fresh(this.#quotes, symbol)?.close ?? this.#fresh(this.#yahoo, symbol)?.close;
    if (!ext || !(close > 0)) return null;
    return { price: ext.price, pct: ext.price / close - 1, at: ext.at, session: ext.session };
  }
}
