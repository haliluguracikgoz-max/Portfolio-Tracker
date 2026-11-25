import { addDays, addMonths, isDate, nyDate } from '../shared/dates.js';
import { parseNumber } from '../shared/number.js';
import { compute } from './analytics.js';
import { fromCsv, toCsv } from './csv.js';
import { transaction, TxStore } from './db.js';
import { LedgerError, splitFactor, TX_TYPES, validateLedger } from './ledger.js';
import { BENCH, MarketError, normalizeSymbol } from './market.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

const MAX = 1e12;

export function cleanTx(raw, today = nyDate()) {
  if (!raw || typeof raw !== 'object') throw bad('Geçersiz işlem.');
  const type = String(raw.type ?? '').trim().toUpperCase();
  if (!TX_TYPES.includes(type)) throw bad('Geçersiz işlem türü.');
  if (!isDate(raw.date) || raw.date < '1970-01-01') throw bad('Geçerli bir tarih girin.');
  if (raw.date > today) throw bad('İşlem tarihi gelecekte olamaz.');

  const positive = (v, label) => {
    const n = parseNumber(v);
    if (n == null || !(n > 0) || n > MAX) throw bad(`${label} sıfırdan büyük bir sayı olmalı.`);
    return n;
  };
  const isTrade = type === 'BUY' || type === 'SELL';
  const tx = {
    date: raw.date, type, symbol: null, quantity: null, price: null, amount: null, fee: 0,
    settle: isTrade && raw.settle === 'EXTERNAL' ? 'EXTERNAL' : 'CASH',
    note: String(raw.note ?? '').trim().slice(0, 500),
  };
  if (isTrade || type === 'DIVIDEND') {
    tx.symbol = normalizeSymbol(raw.symbol);
    if (!tx.symbol) throw bad('Geçerli bir hisse sembolü girin.');
  }
  if (isTrade) {
    tx.quantity = positive(raw.quantity, 'Adet');
    tx.price = positive(raw.price, 'Fiyat');
    const fee = parseNumber(raw.fee) ?? 0;
    if (!(fee >= 0) || fee > MAX) throw bad('Komisyon sıfır ya da daha büyük olmalı.');
    if (type === 'SELL' && fee > tx.quantity * tx.price) throw bad('Komisyon satış tutarından büyük olamaz.');
    tx.fee = fee;
  } else {
    tx.amount = positive(raw.amount, 'Tutar');
  }
  return tx;
}

export class App {
  constructor(db, market, extended = null) {
    this.db = db;
    this.market = market;
    this.extended = extended;
    this.txs = new TxStore(db);
  }

  /** İşlem gören her sembol için veri aralığını hazırlar; hataları uyarı olarak döndürür. */
  async refresh(txs, force = false) {
    const today = nyDate();
    const yearAgo = addMonths(today, -13);
    const start = new Map([[BENCH, yearAgo]]);
    for (const t of txs) {
      for (const s of t.symbol ? [t.symbol, BENCH] : [BENCH]) {
        const cur = start.get(s) ?? yearAgo;
        start.set(s, t.date < cur ? t.date : cur);
      }
    }
    const queue = [...start];
    const failed = [];
    let reason = '';
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          await this.market.ensure(job[0], job[1], { force });
        } catch (e) {
          if (!(e instanceof MarketError)) console.error(e);
          failed.push(job[0] === BENCH ? 'S&P 500' : job[0]);
          reason = e instanceof MarketError ? e.message : 'Beklenmeyen hata.';
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return failed.length ? [`Fiyatlar güncellenemedi (${failed.join(', ')}). ${reason} Son bilinen fiyatlar gösteriliyor.`] : [];
  }

  async state(force = false) {
    const txs = this.txs.all();
    const held = [...new Set(txs.map((t) => t.symbol).filter(Boolean))];
    const [warnings] = await Promise.all([this.refresh(txs, force), this.extended?.load(held, { force })]);
    const result = compute(txs, this.market.snapshot(), nyDate());
    for (const p of result.positions) p.ext = this.extended?.of(p.symbol, p.price) ?? null;
    return {
      ...result,
      transactions: txs,
      asOf: Date.now(),
      marketOpen: this.market.isOpen(),
      warnings,
    };
  }

  #validate(txs) {
    try {
      validateLedger(txs, this.market.snapshot().splits);
    } catch (e) {
      if (e instanceof LedgerError) throw new HttpError(422, e.message);
      throw e;
    }
  }

  async #ensureSymbol(tx) {
    if (!tx.symbol) return;
    try {
      await this.market.ensure(tx.symbol, tx.date);
    } catch (e) {
      // Servis geçici olarak kapalıysa tanınan sembollerle çalışmaya devam edilir.
      if (!(e instanceof MarketError) || !this.market.quote(tx.symbol)) throw e;
    }
  }

  /** Değişikliği uygular; defter tutarsız hâle gelirse geri alır. */
  #commit(change) {
    return transaction(this.db, () => {
      const result = change();
      this.#validate(this.txs.all());
      return result;
    });
  }

  async addTx(raw) {
    const tx = cleanTx(raw);
    await this.#ensureSymbol(tx);
    const restoreId = Number.isInteger(raw.id) && raw.id > 0 && !this.txs.get(raw.id) ? raw.id : null;
    return { id: this.#commit(() => this.txs.insert(tx, restoreId)) };
  }

  async updateTx(id, raw) {
    if (!this.txs.get(id)) throw new HttpError(404, 'İşlem bulunamadı.');
    const tx = cleanTx(raw);
    await this.#ensureSymbol(tx);
    this.#commit(() => this.txs.update(id, tx));
    return { id };
  }

  removeTx(id) {
    const tx = this.txs.get(id);
    if (!tx) throw new HttpError(404, 'İşlem bulunamadı.');
    this.#commit(() => this.txs.remove(id));
    return tx;
  }

  /** Ya hepsi ya hiçbiri. Defterde zaten bulunan satırlar atlanır. */
  async importCsv(text) {
    let rows;
    try {
      rows = fromCsv(String(text ?? ''));
    } catch (e) {
      throw bad(e.message);
    }
    if (!rows.length) throw bad('Dosyada işlem bulunamadı.');
    if (rows.length > 20_000) throw bad('Tek seferde en fazla 20.000 işlem içe aktarılabilir.');
    const key = (t) => JSON.stringify([t.date, t.type, t.symbol, t.quantity, t.price, t.amount, t.fee, t.settle, t.note]);
    const existing = new Map();
    for (const t of this.txs.all()) existing.set(key(t), (existing.get(key(t)) ?? 0) + 1);

    const fresh = [];
    rows.forEach((row, i) => {
      let tx;
      try {
        tx = cleanTx({ ...row, settle: row.settle?.toUpperCase() });
      } catch (e) {
        throw bad(`${i + 2}. satır: ${e.message}`);
      }
      const count = existing.get(key(tx)) ?? 0;
      if (count > 0) existing.set(key(tx), count - 1);
      else fresh.push(tx);
    });

    const earliest = new Map();
    for (const t of fresh) if (t.symbol && (!earliest.has(t.symbol) || t.date < earliest.get(t.symbol).date)) earliest.set(t.symbol, t);
    for (const t of earliest.values()) await this.#ensureSymbol(t);
    this.#commit(() => fresh.forEach((t) => this.txs.insert(t)));
    return { imported: fresh.length, skipped: rows.length - fresh.length };
  }

  exportCsv() {
    return toCsv(this.txs.all());
  }

  async symbolDetail(raw) {
    const symbol = normalizeSymbol(raw);
    if (!symbol) throw bad('Geçersiz sembol.');
    const txs = this.txs.all().filter((t) => t.symbol === symbol);
    const fiveYears = addMonths(nyDate(), -60);
    const from = txs.length && txs[0].date < fiveYears ? txs[0].date : fiveYears;
    await Promise.all([this.#ensureSymbol({ symbol, date: from }), this.extended?.load([symbol])]);
    const splits = this.market.splits(symbol);
    return {
      info: this.market.info(symbol),
      quote: this.market.quote(symbol),
      ext: this.extended?.of(symbol, this.market.quote(symbol)?.price) ?? null,
      prices: this.market.closes(symbol),
      transactions: txs.map((t) => ({ ...t, factor: splitFactor(splits, t.date) })),
    };
  }

  /** Form için: verilen gündeki (bölünme öncesi, gerçek) kapanış ve bugüne bölünme faktörü. */
  async priceOn(raw, date) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || !isDate(date)) throw bad('Geçersiz istek.');
    await this.#ensureSymbol({ symbol, date: date < nyDate() ? date : nyDate() });
    const factor = splitFactor(this.market.splits(symbol), date);
    const close = this.market.closes(symbol).filter((p) => p.date <= date && p.date >= addDays(date, -7)).at(-1);
    return { symbol, name: this.market.info(symbol).name, price: close ? close.close * factor : null, priceDate: close?.date ?? null, factor };
  }

  async search(q) {
    const text = String(q ?? '').trim().slice(0, 60);
    return text ? this.market.search(text) : [];
  }
}
