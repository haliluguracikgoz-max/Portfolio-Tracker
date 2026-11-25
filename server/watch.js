import { createHash } from 'node:crypto';
import { HttpError } from './app.js';
import { cnbc, number, quotesOf, quoteUrl } from './cnbc.js';
import { getSetting, setSetting } from './db.js';
import { extendedSource } from './extended.js';
import { MarketError, normalizeSymbol, US_EXCHANGES, yahoo } from './market.js';

const TTL = 30_000;
const MAX_ITEMS = 50;
const YAHOO_BATCH = 20;
const CNBC_SEARCH = 'https://symlookup.cnbc.com/symservice/symlookup.do';

const item = (id, symbol, name, unit) => ({ id, symbol, name, unit });
/** id: "sağlayıcı:kod"; calc başka kodlardan hesaplanır. unit: yield (yüzde faiz), usd ya da plain. */
export const DEFAULTS = {
  stocks: [],
  other: [
    item('yahoo:TRY=X', 'Dolar / TL', 'USD/TRY', 'plain'),
    item('yahoo:EURTRY=X', 'Euro / TL', 'EUR/TRY', 'plain'),
    item('yahoo:EURUSD=X', 'Euro / dolar', 'EUR/USD', 'plain'),
    item('calc:GAUTRY', 'Gram altın / TL', 'GAU/TRY', 'plain'),
    item('yahoo:BTC-USD', 'Bitcoin / dolar', 'BTC/USD', 'usd'),
    item('yahoo:ETH-USD', 'Ethereum / dolar', 'ETH/USD', 'usd'),
    item('cnbc:XAU=', 'Ons altın / dolar', 'XAU/USD', 'usd'),
    item('calc:GAUUSD', 'Gram altın / dolar', 'GAU/USD', 'usd'),
  ],
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
  // Select Sector SPDR ailesi: S&P 500'ün 11 sektörü. Ad yerine sektör yazılır.
  sector: [
    item('yahoo:XLK', 'XLK', 'Teknoloji', 'usd'),
    item('yahoo:XLF', 'XLF', 'Finans', 'usd'),
    item('yahoo:XLC', 'XLC', 'İletişim', 'usd'),
    item('yahoo:XLY', 'XLY', 'Döngüsel tüketim', 'usd'),
    item('yahoo:XLV', 'XLV', 'Sağlık', 'usd'),
    item('yahoo:XLI', 'XLI', 'Sanayi', 'usd'),
    item('yahoo:XLP', 'XLP', 'Temel tüketim', 'usd'),
    item('yahoo:XLE', 'XLE', 'Enerji', 'usd'),
    item('yahoo:XLU', 'XLU', 'Kamu hizmetleri', 'usd'),
    item('yahoo:XLRE', 'XLRE', 'Gayrimenkul', 'usd'),
    item('yahoo:XLB', 'XLB', 'Temel malzemeler', 'usd'),
  ],
};

/** Genel bakışın üstündeki sabit endeksler; liste gibi düzenlenmez. CNBC'de gecikmesizdir. */
export const INDEXES = [
  item('cnbc:.SPX', 'SPX', 'S&P 500', 'plain'),
  item('cnbc:.IXIC', 'IXIC', 'Nasdaq', 'plain'),
  item('cnbc:.NDX', 'NDX', 'Nasdaq 100', 'plain'),
];

/** Hazır ad ve birim. Sektör adları yalnızca kendi listesinde geçerlidir. */
const known = (id, list) => {
  const { sector, ...shared } = DEFAULTS;
  return (list === 'sector' ? sector : Object.values(shared).flat()).find((x) => x.id === id);
};

/** Gram altın hiçbir serviste yok: ons fiyatından (dolar) ve gerekirse dolar kurundan hesaplanır. */
const OUNCE_GRAMS = 31.1034768;
const CALC = { GAUUSD: ['cnbc:XAU='], GAUTRY: ['cnbc:XAU=', 'yahoo:TRY=X'] };
const partsOf = (id) => (id.startsWith('calc:') ? CALC[id.slice(5)] : [id]);
/** Arama servislerinde çıkmayan altın kodları. */
const GOLD = ['calc:GAUTRY', 'calc:GAUUSD', 'cnbc:XAU='];
const GOLD_QUERY = /^(alt[ıi]n|gram|gold|ons|xau|gau)/;

/** Yalnızca ABD borsalarında işlem gören bu türleri kabul eden listeler. */
const US_ONLY = {
  stocks: { kinds: ['EQUITY', 'ETF'], error: 'Bu listeye yalnızca ABD borsalarındaki hisse ve ETF’ler eklenebilir.' },
  etf: { kinds: ['ETF'], error: 'Bu listeye yalnızca ABD borsalarındaki ETF’ler eklenebilir.' },
  sector: { kinds: ['ETF'], error: 'Bu listeye yalnızca ABD borsalarındaki ETF’ler eklenebilir.' },
};
const inScope = (list, symbol, kind, exchange) =>
  !US_ONLY[list] || (US_ONLY[list].kinds.includes(kind) && US_EXCHANGES.has(exchange) && normalizeSymbol(symbol) === symbol);

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
const validId = (id) => typeof id === 'string' && /^(yahoo:[A-Z0-9^][A-Z0-9^=.&-]{0,19}|cnbc:[A-Z0-9.@][A-Z0-9.@=-]{0,19}|calc:(GAUUSD|GAUTRY))$/.test(id);
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const letters = (s) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();

/** Değişim her zaman önceki kapanıştan hesaplanır; CNBC'nin yüzde alanı faizlerde tutarsızdır. */
const quote = (value, prev, delayed) => ({
  value,
  change: value != null && prev != null ? value - prev : null,
  changePct: value != null && prev > 0 ? value / prev - 1 : null,
  delayed,
});

/** CNBC yanıtı → Map(kod → kotasyon). */
export function parseCnbc(json) {
  const out = new Map();
  for (const q of quotesOf(json)) {
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
  #extended;
  #quotes = new Map();
  #providers = { yahoo: { asOf: 0, error: null }, cnbc: { asOf: 0, error: null } };
  #triedAt = -Infinity;
  #inflight = null;

  constructor(db, { getYahoo = yahoo, getCnbc = cnbc, extended = null } = {}) {
    this.#db = db;
    this.#yahoo = getYahoo;
    this.#cnbc = getCnbc;
    this.#extended = extended;
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
    const view = (items) => {
      const used = [...new Set(items.flatMap((x) => partsOf(x.id)).map((id) => splitId(id)[0]))].map((p) => this.#providers[p]);
      return {
        items: items.map((x) => ({ ...x, value: null, change: null, changePct: null, delayed: false, ...this.#quote(x.id), ...this.#ext(x) })),
        asOf: used.length ? Math.min(...used.map((p) => p.asOf)) || null : null,
        error: used.find((p) => p.error)?.error ?? null,
      };
    };
    return { ...Object.fromEntries(Object.keys(DEFAULTS).map((list) => [list, view(this.#items(list))])), index: view(INDEXES) };
  }

  /** Borsa kapalıyken ABD hisse, ETF ve endekslerinin seans dışı fiyatı. */
  #ext(x) {
    const from = extendedSource(x);
    const value = this.#quote(x.id)?.value;
    const ext = from && this.#extended?.of(from.symbol, from.index ? null : value);
    if (!ext) return null;
    if (!from.index) return { ext };
    return value == null ? null : { ext: { ...ext, price: value * (1 + ext.pct), via: from.symbol } };
  }

  #quote(id) {
    if (!id.startsWith('calc:')) return this.#quotes.get(id);
    const parts = partsOf(id).map((p) => this.#quotes.get(p));
    if (parts.some((p) => p?.value == null)) return undefined;
    const product = (pick) => parts.reduce((acc, p) => acc * pick(p), 1) / OUNCE_GRAMS;
    const prev = parts.every((p) => p.change != null) ? product((p) => p.value - p.change) : null;
    return quote(product((p) => p.value), prev, parts.some((p) => p.delayed));
  }

  async #refresh() {
    this.#triedAt = Date.now();
    const items = [...INDEXES, ...Object.keys(DEFAULTS).flatMap((list) => this.#items(list))];
    const ids = [...new Set(items.flatMap((x) => partsOf(x.id)))];
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
    await Promise.all([run('yahoo', (c) => this.#yahooQuotes(c)), run('cnbc', (c) => this.#cnbcQuotes(c)), this.#extended?.load(items.map((x) => extendedSource(x)?.symbol).filter(Boolean))]);
  }

  #remember(id, { value, change, changePct, delayed }) {
    this.#quotes.set(id, { value, change, changePct, delayed });
  }
  async #yahooQuotes(codes) {
    const parts = await Promise.all(chunks(codes, YAHOO_BATCH).map((c) => this.#yahoo(`/v8/finance/spark?symbols=${encodeURIComponent(c.join(','))}&range=1d&interval=1d`)));
    return new Map(parts.flatMap((p) => [...parseSpark(p)]));
  }
  async #cnbcQuotes(codes) {
    return parseCnbc(await this.#cnbc(quoteUrl(codes)));
  }

  async search(list, q) {
    const listed = new Set(this.#items(list).map((x) => x.id));
    const text = String(q ?? '').trim().slice(0, 60);
    if (!text) return [];
    const lower = text.toLocaleLowerCase('tr');
    const query = US_ONLY[list] ? text : (TURKISH[lower] ?? text);
    const gold = !US_ONLY[list] && GOLD_QUERY.test(lower)
      ? GOLD.map((id) => known(id)).map((x) => ({ id: x.id, symbol: x.name, name: x.symbol, kind: 'Altın', exchange: x.id.startsWith('calc:') ? 'Hesaplanan' : 'CNBC' })) : [];
    const fromYahoo = async () => {
      const json = await this.#yahoo(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=16&newsCount=0`);
      return (json?.quotes ?? [])
        .filter((x) => KIND_LABEL[x.quoteType] && inScope(list, x.symbol, x.quoteType, x.exchange))
        .map((x) => ({ id: `yahoo:${x.symbol}`, symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, kind: KIND_LABEL[x.quoteType], exchange: x.exchDisp ?? '' }));
    };
    // Tahvil faizleri ve bazı endeksler yalnızca CNBC'de bulunur.
    const fromCnbc = async () => {
      if (US_ONLY[list]) return [];
      const json = await this.#cnbc(`${CNBC_SEARCH}?prefix=${encodeURIComponent(query)}&partnerid=20064&pgok=1&pgsize=12&output=json`);
      return (Array.isArray(json) ? json : [])
        .filter((x) => x.issueType === 'BOND' || x.issueType === 'INDEX')
        .map((x) => ({ id: `cnbc:${x.symbolName}`, symbol: String(x.symbolName).replace(/^[.@]/, ''), name: x.companyName ?? x.symbolName, kind: KIND_LABEL[x.issueType], exchange: 'CNBC' }));
    };
    const [a, b] = await Promise.allSettled([fromYahoo(), fromCnbc()]);
    if (a.status === 'rejected' && (b.status === 'rejected' || US_ONLY[list])) throw a.reason;
    const y = (a.value ?? []).filter((x) => validId(x.id)).slice(0, 8);
    const seen = new Set(y.map((x) => letters(x.symbol)));
    const c = (b.value ?? []).filter((x) => validId(x.id) && !seen.has(letters(x.symbol)) && !gold.some((g) => g.id === x.id)).slice(0, 5);
    const bonds = c.filter((x) => x.kind === KIND_LABEL.BOND);
    return [...gold, ...bonds, ...y, ...c.filter((x) => !bonds.includes(x))].map((x) => ({ ...x, added: listed.has(x.id) }));
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
    if (!validId(clean)) throw new HttpError(400, 'Geçersiz sembol.');
    const [provider, code] = splitId(clean);
    if (provider === 'calc') {
      if (US_ONLY[list]) throw new HttpError(422, US_ONLY[list].error);
      this.#save(list, [...check(), known(clean)]);
      return this.get({ force: true });
    }
    const info = provider === 'yahoo' ? await this.#yahooInfo(code) : (await this.#cnbcQuotes([code])).get(code);
    if (!info) throw new HttpError(404, `“${code}” için veri bulunamadı.`);
    if (!inScope(list, code, info.kind, info.exchange)) throw new HttpError(422, US_ONLY[list].error);
    if (info.value != null) this.#remember(clean, info);
    this.#providers[provider].asOf ||= Date.now();
    const entry = known(clean, list) ?? item(clean, code.replace(/^[.@]/, ''), String(info.name ?? code).slice(0, 80), info.unit);
    await this.#extended?.load([extendedSource(entry)?.symbol].filter(Boolean));
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
    return { ...quotes.get(code), kind, exchange: meta.exchangeName, name: meta.longName ?? meta.shortName ?? code, unit: YIELD_INDEXES.has(code) ? 'yield' : usd ? 'usd' : 'plain' };
  }

  remove(list, id) {
    const items = this.#items(list);
    const index = items.findIndex((x) => x.id === id);
    if (index < 0) throw new HttpError(404, 'Listede bulunamadı.');
    this.#save(list, items.toSpliced(index, 1));
    return this.#snapshot();
  }

  /**
   * Toplu aktarım: {"stocks": {"MSFT": "Microsoft"}}. Aynı metin yalnızca bir kez uygulanır;
   * sonradan listeden çıkarılan satır yeniden başlatmada geri gelmez.
   */
  importOnce(text) {
    const hash = createHash('sha256').update(text).digest('hex');
    if (getSetting(this.#db, 'watch.imported') === hash) return null;
    const added = {};
    for (const [list, entries] of Object.entries(JSON.parse(text))) {
      if (!Object.hasOwn(US_ONLY, list)) throw new Error(`“${list}” listesine aktarım yapılamaz.`);
      const items = this.#items(list);
      const fresh = Object.entries(entries)
        .map(([symbol, name]) => item(`yahoo:${symbol}`, symbol, String(name).slice(0, 80), 'usd'))
        .filter((x) => validId(x.id) && normalizeSymbol(x.symbol) === x.symbol && !items.some((y) => y.id === x.id))
        .slice(0, Math.max(0, MAX_ITEMS - items.length));
      this.#save(list, [...items, ...fresh]);
      added[list] = fresh.length;
    }
    setSetting(this.#db, 'watch.imported', hash);
    return added;
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
