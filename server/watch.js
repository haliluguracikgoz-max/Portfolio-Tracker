import { HttpError } from './app.js';
import { getSetting, setSetting } from './db.js';
import { MarketError, US_EXCHANGES, yahoo } from './market.js';

const TTL = 30_000;
const MAX_ITEMS = 30;
const YAHOO_BATCH = 20;
const CNBC_QUOTE = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CNBC_SEARCH = 'https://symlookup.cnbc.com/symservice/symlookup.do';

const item = (id, symbol, name, unit) => ({ id, symbol, name, unit });
/** id: "sağlayıcı:kod". unit: yield (yüzde faiz), usd ya da plain. */
export const DEFAULTS = {
  macro: [
    item('cnbc:@CL.1', 'CL', 'Crude Oil WTI', 'usd'),
    item('cnbc:US2Y', 'US2YT', 'U.S. 2Y', 'yield'),
    item('cnbc:US10Y', 'US10YT', 'U.S. 10Y', 'yield'),
    item('cnbc:US30Y', 'US30YT', 'U.S. 30Y', 'yield'),
    item('cnbc:.DXY', 'DXY', 'US Dollar Index', 'plain'),
    item('cnbc:.VIX', 'VIX', 'S&P 500 VIX', 'plain'),
  ],
  etf: [
    item('yahoo:NCLD', 'NCLD', 'Roundhill Neocloud', 'usd'),
    item('yahoo:NASA', 'NASA', 'Tema Space Innovators', 'usd'),
    item('yahoo:DRAM', 'DRAM', 'Roundhill Memory', 'usd'),
    item('yahoo:LAZR', 'LAZR', 'Tema Photonics & Optical', 'usd'),
    item('yahoo:SOXX', 'SOXX', 'iShares Semiconductor', 'usd'),
    item('yahoo:QQQ', 'QQQ', 'Invesco QQQ Trust', 'usd'),
  ],
};

const KIND_LABEL = {
  EQUITY: 'Hisse', ETF: 'ETF', INDEX: 'Endeks', FUTURE: 'Vadeli', CURRENCY: 'Döviz', CRYPTOCURRENCY: 'Kripto', MUTUALFUND: 'Fon', BOND: 'Tahvil',
};
const YIELD_INDEXES = new Set(['^IRX', '^FVX', '^TNX', '^TYX']);
// Arama servisleri İngilizce çalışır; sık aranan Türkçe karşılıklar çevrilir.
const TURKISH = {
  'altın': 'gold', 'altin': 'gold', 'gümüş': 'silver', 'gumus': 'silver', 'petrol': 'crude oil', 'brent petrol': 'brent', 'doğalgaz': 'natural gas', 'doğal gaz': 'natural gas',
  'dogalgaz': 'natural gas', 'bakır': 'copper', 'bakir': 'copper', 'buğday': 'wheat', 'mısır': 'corn', 'platin': 'platinum', 'paladyum': 'palladium', 'dolar': 'TRY=X', 'dolar tl': 'TRY=X',
  'dolar/tl': 'TRY=X', 'usdtry': 'TRY=X', 'usd/try': 'TRY=X', 'euro': 'EURUSD=X', 'euro tl': 'EURTRY=X', 'euro/tl': 'EURTRY=X', 'bist 100': 'XU100.IS', 'bist100': 'XU100.IS', 'faiz': 'treasury',
};

const splitId = (id) => {
  const i = id.indexOf(':');
  return [id.slice(0, i), id.slice(i + 1)];
};
const validId = (id) => typeof id === 'string' && /^(yahoo:[A-Z0-9^][A-Z0-9^=.&-]{0,19}|cnbc:[A-Z0-9.@][A-Z0-9.@=-]{0,19})$/.test(id);
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const letters = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();

async function cnbc(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MarketError('Piyasa verisi servisine ulaşılamadı.');
  }
  if (!res.ok) throw new MarketError(`Piyasa verisi servisi yanıt vermedi (HTTP ${res.status}).`);
  return res.json();
}

const number = (text) => {
  const s = String(text ?? '').replace(/[%,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
/** Değişim her zaman önceki kapanıştan hesaplanır; CNBC'nin yüzde alanı faizlerde tutarsızdır. */
const quote = (value, prev, delayed) => ({
  value,
  change: value != null && prev != null ? value - prev : null,
  changePct: value != null && prev > 0 ? value / prev - 1 : null,
  delayed,
});

/** CNBC yanıtı → Map(kod → kotasyon). */
export function parseCnbc(json) {
  const list = json?.FormattedQuoteResult?.FormattedQuote;
  const out = new Map();
  for (const q of Array.isArray(list) ? list : []) {
    const value = number(q.last);
    if (value == null) continue;
    out.set(q.symbol, {
      ...quote(value, number(q.previous_day_closing), q.realTime === 'false'),
      name: q.name, unit: String(q.last).trim().endsWith('%') ? 'yield' : 'plain',
    });
  }
  return out;
}

/** Yahoo spark yanıtı → Map(kod → kotasyon). */
export function parseSpark(json) {
  const out = new Map();
  for (const [symbol, s] of Object.entries(json ?? {})) {
    const value = s?.close?.findLast?.((v) => v != null) ?? s?.fulldayPrice ?? null;
    // Vadeli kontratlar bu serviste yaklaşık 10 dakika gecikmelidir.
    if (Number.isFinite(value)) out.set(symbol, quote(value, s.chartPreviousClose ?? null, symbol.endsWith('=F')));
  }
  return out;
}

export class Watch {
  #db;
  #yahoo;
  #cnbc;
  #quotes = new Map();
  #providers = { yahoo: { asOf: 0, error: null }, cnbc: { asOf: 0, error: null } };
  #triedAt = -Infinity;
  #inflight = null;

  constructor(db, { getYahoo = yahoo, getCnbc = cnbc } = {}) {
    this.#db = db;
    this.#yahoo = getYahoo;
    this.#cnbc = getCnbc;
  }

  #items(list) {
    if (!Object.hasOwn(DEFAULTS, list)) throw new HttpError(400, 'Geçersiz liste.');
    return getSetting(this.#db, `watch.${list}`) ?? DEFAULTS[list];
  }
  #save(list, items) {
    setSetting(this.#db, `watch.${list}`, items);
  }

  /** Servis cevap vermezse son bilinen değerler `error` ile birlikte döner. */
  async get({ force = false } = {}) {
    if (force || Date.now() - this.#triedAt >= TTL) this.#inflight ??= this.#refresh().finally(() => (this.#inflight = null));
    await this.#inflight;
    return this.#snapshot();
  }

  #snapshot() {
    const view = (list) => {
      const items = this.#items(list);
      const used = [...new Set(items.map((x) => splitId(x.id)[0]))].map((p) => this.#providers[p]);
      return {
        items: items.map((x) => ({ ...x, value: null, change: null, changePct: null, delayed: false, ...this.#quotes.get(x.id) })),
        asOf: used.length ? Math.min(...used.map((p) => p.asOf)) || null : null,
        error: used.find((p) => p.error)?.error ?? null,
      };
    };
    return { macro: view('macro'), etf: view('etf') };
  }

  async #refresh() {
    this.#triedAt = Date.now();
    const ids = [...new Set([...this.#items('macro'), ...this.#items('etf')].map((x) => x.id))];
    const codes = (provider) => ids.map(splitId).filter(([p]) => p === provider).map(([, code]) => code);
    const run = async (provider, fetchQuotes) => {
      const wanted = codes(provider);
      if (!wanted.length) return;
      const state = this.#providers[provider];
      try {
        const found = await fetchQuotes(wanted);
        if (!wanted.some((code) => found.has(code))) throw new MarketError('Piyasa verisi servisi boş yanıt verdi.');
        // Yanıtta eksik kalan kodun son bilinen değeri korunur.
        for (const code of wanted) if (found.has(code)) this.#remember(`${provider}:${code}`, found.get(code));
        state.asOf = Date.now();
        state.error = null;
      } catch (e) {
        if (!(e instanceof MarketError)) console.error(e);
        state.error = e instanceof MarketError ? e.message : 'Piyasa verisi okunamadı.';
      }
    };
    await Promise.all([run('yahoo', (c) => this.#yahooQuotes(c)), run('cnbc', (c) => this.#cnbcQuotes(c))]);
  }

  #remember(id, { value, change, changePct, delayed }) {
    this.#quotes.set(id, { value, change, changePct, delayed });
  }
  async #yahooQuotes(codes) {
    const parts = await Promise.all(chunks(codes, YAHOO_BATCH).map((c) => this.#yahoo(`/v8/finance/spark?symbols=${encodeURIComponent(c.join(','))}&range=1d&interval=1d`)));
    return new Map(parts.flatMap((p) => [...parseSpark(p)]));
  }
  async #cnbcQuotes(codes) {
    return parseCnbc(await this.#cnbc(`${CNBC_QUOTE}?symbols=${encodeURIComponent(codes.join('|'))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`));
  }

  async search(list, q) {
    const listed = new Set(this.#items(list).map((x) => x.id));
    const text = String(q ?? '').trim().slice(0, 60);
    if (!text) return [];
    const query = list === 'macro' ? (TURKISH[text.toLocaleLowerCase('tr')] ?? text) : text;
    const fromYahoo = async () => {
      const json = await this.#yahoo(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=16&newsCount=0`);
      return (json?.quotes ?? [])
        .filter((x) => (list === 'etf' ? x.quoteType === 'ETF' && US_EXCHANGES.has(x.exchange) : KIND_LABEL[x.quoteType]))
        .map((x) => ({ id: `yahoo:${x.symbol}`, symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, kind: KIND_LABEL[x.quoteType], exchange: x.exchDisp ?? '' }));
    };
    // Tahvil faizleri ve bazı endeksler yalnızca CNBC'de bulunur.
    const fromCnbc = async () => {
      if (list !== 'macro') return [];
      const json = await this.#cnbc(`${CNBC_SEARCH}?prefix=${encodeURIComponent(query)}&partnerid=20064&pgok=1&pgsize=12&output=json`);
      return (Array.isArray(json) ? json : [])
        .filter((x) => x.issueType === 'BOND' || x.issueType === 'INDEX')
        .map((x) => ({ id: `cnbc:${x.symbolName}`, symbol: String(x.symbolName).replace(/^[.@]/, ''), name: x.companyName ?? x.symbolName, kind: KIND_LABEL[x.issueType], exchange: 'CNBC' }));
    };
    const [a, b] = await Promise.allSettled([fromYahoo(), fromCnbc()]);
    if (a.status === 'rejected' && (b.status === 'rejected' || list === 'etf')) throw a.reason;
    const y = (a.value ?? []).filter((x) => validId(x.id)).slice(0, 8);
    const seen = new Set(y.map((x) => letters(x.symbol)));
    const c = (b.value ?? []).filter((x) => validId(x.id) && !seen.has(letters(x.symbol))).slice(0, 5);
    const bonds = c.filter((x) => x.kind === KIND_LABEL.BOND);
    return [...bonds, ...y, ...c.filter((x) => !bonds.includes(x))].map((x) => ({ ...x, added: listed.has(x.id) }));
  }

  /** Verisi gerçekten alınabilen bir kodu listeye ekler. Ad ve birim servisten okunur. */
  async add(list, id) {
    const clean = typeof id === 'string' ? id.trim() : '';
    const check = () => {
      const items = this.#items(list);
      if (items.some((x) => x.id === clean)) throw new HttpError(409, 'Bu zaten listede.');
      if (items.length >= MAX_ITEMS) throw new HttpError(422, `Listede en fazla ${MAX_ITEMS} satır olabilir.`);
      return items;
    };
    check();
    const known = DEFAULTS[list].find((x) => x.id === clean);
    if (!validId(clean)) throw new HttpError(400, 'Geçersiz sembol.');
    const [provider, code] = splitId(clean);
    const info = provider === 'yahoo' ? await this.#yahooInfo(code) : (await this.#cnbcQuotes([code])).get(code);
    if (!info) throw new HttpError(404, `“${code}” için veri bulunamadı.`);
    if (list === 'etf' && info.kind !== 'ETF') throw new HttpError(422, 'Bu listeye yalnızca ETF eklenebilir.');
    if (info.value != null) this.#remember(clean, info);
    this.#providers[provider].asOf ||= Date.now();
    const entry = known ?? item(clean, code.replace(/^[.@]/, ''), String(info.name ?? code).slice(0, 80), info.unit);
    // Veri beklenirken liste değişmiş olabilir.
    this.#save(list, [...check(), entry]);
    return this.#snapshot();
  }

  async #yahooInfo(code) {
    const [json, quotes] = await Promise.all([this.#yahoo(`/v8/finance/chart/${encodeURIComponent(code)}?range=5d&interval=1d`), this.#yahooQuotes([code])]);
    const meta = json?.chart?.result?.[0]?.meta;
    if (meta?.symbol !== code || !quotes.has(code)) return null;
    const kind = meta.instrumentType;
    const usd = meta.currency === 'USD' && kind !== 'CURRENCY' && kind !== 'INDEX';
    return { ...quotes.get(code), kind, name: meta.longName ?? meta.shortName ?? code, unit: YIELD_INDEXES.has(code) ? 'yield' : usd ? 'usd' : 'plain' };
  }

  remove(list, id) {
    const items = this.#items(list);
    const index = items.findIndex((x) => x.id === id);
    if (index < 0) throw new HttpError(404, 'Listede bulunamadı.');
    this.#save(list, items.toSpliced(index, 1));
    return this.#snapshot();
  }

  /** Silmeyi geri alır: kayıt, listedeki eski yerine döner. */
  restore(list, entry, index) {
    const items = this.#items(list);
    const ok = validId(entry?.id) && ['yield', 'usd', 'plain'].includes(entry.unit) && typeof entry.symbol === 'string' && typeof entry.name === 'string';
    if (!ok) throw new HttpError(400, 'Geçersiz kayıt.');
    if (items.some((x) => x.id === entry.id)) return this.#snapshot();
    if (items.length >= MAX_ITEMS) throw new HttpError(422, `Listede en fazla ${MAX_ITEMS} satır olabilir.`);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(items.length, index)) : items.length;
    this.#save(list, items.toSpliced(at, 0, item(entry.id, entry.symbol.slice(0, 24), entry.name.slice(0, 80), entry.unit)));
    return this.#snapshot();
  }
}
