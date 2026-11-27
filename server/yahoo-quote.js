import { MarketError } from './market.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const FIELDS = [
  'regularMarketPrice', 'regularMarketTime', 'marketState', 'preMarketPrice', 'preMarketTime',
  'postMarketPrice', 'postMarketTime', 'overnightMarketPrice', 'overnightMarketTime',
].join(',');
/** Oturum anahtarı kısa ömürlü değildir; yine de arada bir yenilenir. */
const SESSION_AGE = 6 * 3600_000;

async function get(url, headers = {}) {
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MarketError('Seans dışı fiyat servisine ulaşılamadı.');
  }
}

/**
 * Yahoo'nun kotasyon servisi. Gece seansı (Blue Ocean, 20:00-04:00 ET) fiyatı yalnızca burada
 * bulunur; servis bir oturum çerezi ve ona bağlı bir anahtar (crumb) ister.
 */
export class YahooQuotes {
  #session = null;
  #pending = null;

  async #open() {
    const home = await get('https://fc.yahoo.com/');
    const cookie = home.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
    if (!cookie) throw new MarketError('Seans dışı fiyat servisi oturum açmadı.');
    const res = await get('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie });
    const crumb = res.ok ? (await res.text()).trim() : '';
    if (!crumb || crumb.length > 64 || /[\s<{]/.test(crumb)) throw new MarketError(`Seans dışı fiyat servisi anahtar vermedi (HTTP ${res.status}).`);
    return { cookie, crumb, at: Date.now() };
  }

  async #ensure(renew) {
    if (renew || (this.#session && Date.now() - this.#session.at > SESSION_AGE)) this.#session = null;
    if (this.#session) return this.#session;
    this.#pending ??= this.#open().finally(() => {
      this.#pending = null;
    });
    return (this.#session = await this.#pending);
  }

  /** Semboller (Yahoo yazımıyla) → kotasyon listesi. */
  async quotes(symbols) {
    for (let attempt = 0; ; attempt++) {
      const { cookie, crumb } = await this.#ensure(attempt > 0);
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=${FIELDS}&overnightPrice=true&crumb=${encodeURIComponent(crumb)}`;
      const res = await get(url, { Cookie: cookie });
      // Süresi dolan oturum bir kez yenilenir.
      if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
      if (!res.ok) throw new MarketError(`Seans dışı fiyat servisi yanıt vermedi (HTTP ${res.status}).`);
      const list = (await res.json())?.quoteResponse?.result;
      return Array.isArray(list) ? list : [];
    }
  }
}

const yahooQuotes = new YahooQuotes();
export const getYahooQuotes = (symbols) => yahooQuotes.quotes(symbols);
