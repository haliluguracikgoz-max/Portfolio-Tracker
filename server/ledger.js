export const QTY_EPS = 1e-7;
const CASH_EPS = 0.005;

/**
 * İşlem (tx) alanları:
 *   type     BUY | SELL | DEPOSIT | WITHDRAW | DIVIDEND | INTEREST | FEE
 *   quantity, price   işlem günündeki gerçek adet ve fiyat (sonraki bölünmelerden önceki hâli)
 *   amount   nakit hareketlerinde tutar
 *   settle   CASH: portföydeki nakitten geçer. EXTERNAL: para dışarıdan gelir / dışarı çıkar.
 */
export const TX_TYPES = ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'DIVIDEND', 'INTEREST', 'FEE'];

export class LedgerError extends Error {}

/** Tarihten SONRA gerçekleşen bölünmelerin çarpımı: eski adet × faktör = bugünkü adet. */
export function splitFactor(splits, date) {
  let f = 1;
  for (const s of splits) if (s.date > date) f *= s.ratio;
  return f;
}

const usd = (n) => '$' + n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (n) => n.toLocaleString('tr-TR', { maximumFractionDigits: 6 });
const trDate = (d) => d.split('-').reverse().join('.');
const bump = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n);

/**
 * İşlemleri gün gün uygulayan defter. Tüm adetler bugünkü (bölünme sonrası) hisse
 * cinsinden tutulur; böylece bölünmeye göre düzeltilmiş kapanışlarla doğrudan çarpılır.
 * Satışlarda maliyet FIFO ile düşülür.
 */
export class Ledger {
  cash = 0;
  contributed = 0;
  interest = 0;
  fees = 0;
  lots = new Map();
  realized = new Map();
  dividends = new Map();
  lastTradeDate = new Map();

  /** @param splits sembol → bölünme listesi  @param strict tutarsızlıkta hata fırlat */
  constructor(splits, strict) {
    this.splits = splits;
    this.strict = strict;
  }

  quantity(symbol) {
    let q = 0;
    for (const l of this.lots.get(symbol) ?? []) q += l.qty;
    return q;
  }

  cost(symbol) {
    let c = 0;
    for (const l of this.lots.get(symbol) ?? []) c += l.qty * l.unitCost;
    return c;
  }

  adjustedQty(tx) {
    return tx.quantity * splitFactor(this.splits(tx.symbol), tx.date);
  }

  /**
   * Bir günün işlemleri, giriş sırasıyla. Elde yeterli hisse olmayan satış günün sonuna
   * ertelenir: aynı gün içinde önce satışın girilmiş olması hata sayılmaz. Nakit de gün
   * sonunda denetlenir.
   */
  applyDay(date, txs) {
    const flow = { inflow: 0, outflow: 0 };
    const deferred = [];
    for (const tx of txs) {
      if (tx.type === 'SELL' && this.adjustedQty(tx) > this.quantity(tx.symbol) + QTY_EPS) deferred.push(tx);
      else this.#apply(tx, flow);
    }
    for (const tx of deferred) this.#apply(tx, flow);

    if (this.strict && this.cash < -CASH_EPS) {
      throw new LedgerError(
        `Yetersiz nakit: ${trDate(date)} tarihinde nakit bakiyesi −${usd(-this.cash)} oluyor. ` +
          'Önce nakit ekleyin ya da alımı “dışarıdan ödendi” olarak kaydedin.',
      );
    }
    this.contributed += flow.inflow - flow.outflow;
    return flow;
  }

  #apply(tx, flow) {
    switch (tx.type) {
      case 'BUY': {
        const total = tx.quantity * tx.price + tx.fee;
        const qty = this.adjustedQty(tx);
        if (!this.lots.has(tx.symbol)) this.lots.set(tx.symbol, []);
        this.lots.get(tx.symbol).push({ date: tx.date, qty, unitCost: total / qty });
        this.lastTradeDate.set(tx.symbol, tx.date);
        this.fees += tx.fee;
        if (tx.settle === 'CASH') this.cash -= total;
        else flow.inflow += total;
        return;
      }
      case 'SELL': {
        const proceeds = tx.quantity * tx.price - tx.fee;
        const held = this.quantity(tx.symbol);
        let left = this.adjustedQty(tx);
        if (this.strict && left > held + QTY_EPS) {
          throw new LedgerError(
            `Yetersiz adet: ${trDate(tx.date)} tarihinde ${qtyText(left)} adet ${tx.symbol} satışı var, elde ${qtyText(held)} adet bulunuyor.`,
          );
        }
        let cost = 0;
        const lots = this.lots.get(tx.symbol) ?? [];
        while (left > QTY_EPS && lots.length) {
          const lot = lots[0];
          const take = Math.min(lot.qty, left);
          cost += take * lot.unitCost;
          lot.qty -= take;
          left -= take;
          if (lot.qty <= QTY_EPS) lots.shift();
        }
        bump(this.realized, tx.symbol, proceeds - cost);
        this.lastTradeDate.set(tx.symbol, tx.date);
        this.fees += tx.fee;
        if (tx.settle === 'CASH') this.cash += proceeds;
        else flow.outflow += proceeds;
        return;
      }
      case 'DEPOSIT':
        this.cash += tx.amount;
        flow.inflow += tx.amount;
        return;
      case 'WITHDRAW':
        this.cash -= tx.amount;
        flow.outflow += tx.amount;
        return;
      case 'DIVIDEND':
        this.cash += tx.amount;
        bump(this.dividends, tx.symbol, tx.amount);
        return;
      case 'INTEREST':
        this.cash += tx.amount;
        this.interest += tx.amount;
        return;
      case 'FEE':
        this.cash -= tx.amount;
        this.fees += tx.amount;
        return;
    }
  }
}

export function groupByDate(txs) {
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const days = new Map();
  for (const tx of sorted) {
    if (!days.has(tx.date)) days.set(tx.date, []);
    days.get(tx.date).push(tx);
  }
  return [...days];
}

/** Defterin tamamını baştan oynatır; tutarsızlıkta LedgerError fırlatır. */
export function validateLedger(txs, splits) {
  const ledger = new Ledger(splits, true);
  for (const [date, day] of groupByDate(txs)) ledger.applyDay(date, day);
}
