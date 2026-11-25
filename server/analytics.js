import { addDays, daysBetween } from '../shared/dates.js';
import { groupByDate, Ledger, QTY_EPS, splitFactor } from './ledger.js';

/** Tarih sırasıyla ilerleyen, boş günlerde son bilinen kapanışı veren imleç. */
class PriceCursor {
  #points;
  #i = 0;
  last = null;
  constructor(points) {
    this.#points = points;
  }
  advance(date) {
    while (this.#i < this.#points.length && this.#points[this.#i].date <= date) this.last = this.#points[this.#i++].close;
    return this.last;
  }
}

/** Günlük kapanışların üstüne canlı fiyatı yerleştirir. */
export function withQuote(points, quote) {
  if (!quote) return points;
  const out = points.filter((p) => p.date < quote.date);
  out.push({ date: quote.date, close: quote.price });
  return out;
}

const emptySummary = {
  value: 0, cash: 0, invested: 0, contributed: 0, totalGain: 0, unrealized: 0, realized: 0,
  dividends: 0, interest: 0, fees: 0, dayChange: 0, dayChangePct: 0, xirr: null,
};

/**
 * İşlemlerden portföyün bugünkü hâlini ve günlük geçmişini üretir.
 *
 * market: { closes(symbol), quote(symbol), splits(symbol), dividends(symbol), info(symbol), bench() }
 * Kapanışlar tarihe göre artan sıralı ve bölünmeye göre düzeltilmiş olmalıdır.
 */
export function compute(txs, market, today) {
  const days = groupByDate(txs.filter((t) => t.date <= today));
  const benchPoints = market.bench();
  const lastTradingDate = benchPoints.at(-1)?.date ?? today;
  if (!days.length) {
    return { summary: emptySummary, positions: [], closed: [], history: [], base: null, lastTradingDate, dividendSuggestions: [] };
  }

  const ledger = new Ledger((s) => market.splits(s), false);
  const applied = days.flatMap(([, list]) => list);
  const firstDate = days[0][0];
  const lastTxDate = days.at(-1)[0];
  const symbols = [...new Set(applied.filter((t) => t.symbol).map((t) => t.symbol))];
  const cursors = new Map(symbols.map((s) => [s, new PriceCursor(withQuote(market.closes(s), market.quote(s)))]));
  // Borsa verisi olmayan günler için son çare: bilinen son işlem fiyatı (bugünkü hisse cinsinden).
  const lastPaid = new Map();

  const calendar = benchPoints.filter((p) => p.date >= firstDate).map((p) => p.date);
  // Hafta sonu ya da tatilde girilen son işlemler de görünsün.
  const extraDay = !calendar.length || lastTxDate > calendar.at(-1) ? lastTxDate : null;
  if (extraDay) calendar.push(extraDay);
  const bench = new PriceCursor(benchPoints);
  const basePoint = benchPoints.filter((p) => p.date < firstDate).at(-1) ?? benchPoints[0] ?? null;

  const history = [];
  const cashflows = [];
  let next = 0;
  let prevValue = 0;
  let index = 1;
  let dayChange = 0;
  let dayChangePct = 0;
  // Son günün açılış değeri ve o günkü net alımlar: hisse bazında günlük değişim için.
  let openValue = new Map();
  let netBuys = new Map();

  for (const date of calendar) {
    // İşlem günü olmayan ek gün, son işlem gününün günlük değişimini silmesin.
    const merge = date === extraDay && history.length > 0;
    if (!merge) {
      openValue = new Map(symbols.map((s) => [s, ledger.quantity(s) * (cursors.get(s).last ?? lastPaid.get(s) ?? 0)]));
      netBuys = new Map();
    }
    let inflow = 0;
    let outflow = 0;
    while (next < days.length && days[next][0] <= date) {
      const [d, list] = days[next++];
      const flow = ledger.applyDay(d, list);
      inflow += flow.inflow;
      outflow += flow.outflow;
      if (flow.inflow !== flow.outflow) cashflows.push({ date: d, amount: flow.outflow - flow.inflow });
      for (const t of list) {
        if (t.type !== 'BUY' && t.type !== 'SELL') continue;
        lastPaid.set(t.symbol, t.price / splitFactor(market.splits(t.symbol), t.date));
        const gross = t.quantity * t.price;
        netBuys.set(t.symbol, (netBuys.get(t.symbol) ?? 0) + (t.type === 'BUY' ? gross + t.fee : t.fee - gross));
      }
    }

    let value = ledger.cash;
    for (const s of symbols) value += ledger.quantity(s) * (cursors.get(s).advance(date) ?? lastPaid.get(s) ?? 0);

    // Girişler gün başında, çıkışlar gün sonunda sayılır; böylece tam çekim paydayı sıfırlamaz.
    const opening = prevValue + inflow;
    const closing = value + outflow;
    const r = opening > 0.005 ? closing / opening - 1 : 0;
    index *= 1 + r;
    dayChange = merge ? dayChange + closing - opening : closing - opening;
    dayChangePct = merge ? (1 + dayChangePct) * (1 + r) - 1 : r;
    prevValue = value;
    history.push({ date, value, cash: ledger.cash, contributed: ledger.contributed, index, bench: bench.advance(date) });
  }

  const total = history.at(-1).value;
  const positions = [];
  const closed = [];
  let unrealized = 0;
  let realized = 0;
  let dividends = 0;

  for (const s of symbols) {
    const info = market.info(s);
    const qty = ledger.quantity(s);
    const gain = ledger.realized.get(s) ?? 0;
    const div = ledger.dividends.get(s) ?? 0;
    realized += gain;
    dividends += div;
    if (qty <= QTY_EPS) {
      closed.push({
        symbol: s, name: info.name, realized: gain, dividends: div, totalGain: gain + div,
        lastDate: ledger.lastTradeDate.get(s) ?? firstDate,
      });
      continue;
    }
    const quote = market.quote(s);
    const price = cursors.get(s).last ?? lastPaid.get(s) ?? 0;
    const value = qty * price;
    const cost = ledger.cost(s);
    unrealized += value - cost;
    positions.push({
      symbol: s, name: info.name, kind: info.kind, sector: info.sector,
      quantity: qty, avgCost: cost / qty, cost, price, value,
      weight: total > 0 ? value / total : 0,
      dayChange: value - openValue.get(s) - (netBuys.get(s) ?? 0),
      dayChangePct: quote && quote.prevClose > 0 ? quote.price / quote.prevClose - 1 : 0,
      unrealized: value - cost,
      unrealizedPct: cost > 0 ? value / cost - 1 : 0,
      realized: gain, dividends: div, totalGain: value - cost + gain + div,
      spark: withQuote(market.closes(s), quote).slice(-30).map((p) => p.close),
      firstDate: ledger.lots.get(s)[0].date,
    });
  }
  positions.sort((a, b) => b.value - a.value);
  closed.sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));

  const endDate = history.at(-1).date;
  return {
    summary: {
      value: total, cash: ledger.cash, invested: total - ledger.cash, contributed: ledger.contributed,
      totalGain: total - ledger.contributed, unrealized, realized, dividends,
      interest: ledger.interest, fees: ledger.fees, dayChange, dayChangePct,
      // Bir yıldan kısa dönemi yıllıklandırmak yanıltıcı olur.
      xirr: daysBetween(firstDate, endDate) >= 365 ? xirr([...cashflows, { date: endDate, amount: total }]) : null,
    },
    positions, closed, history,
    base: basePoint ? { date: basePoint.date, bench: basePoint.close } : null,
    lastTradingDate,
    dividendSuggestions: suggestDividends(applied, market, today),
  };
}

/** Yıllık iç verim oranı (ikiye bölme). Negatif tutar = portföye giren para. Çözüm yoksa null. */
export function xirr(flows) {
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  const t0 = flows[0].date;
  const npv = (r) => flows.reduce((sum, f) => sum + f.amount / (1 + r) ** (daysBetween(t0, f.date) / 365), 0);
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (f * fLo < 0) hi = mid;
    else {
      lo = mid;
      fLo = f;
    }
  }
  return (lo + hi) / 2;
}

/** Hak edilmiş ama deftere girilmemiş temettüler. Hak, ex-date'ten önceki gün eldeki adede göredir. */
export function suggestDividends(txs, market, today) {
  const out = [];
  const symbols = new Set(txs.filter((t) => t.type === 'BUY').map((t) => t.symbol));
  for (const symbol of symbols) {
    const trades = txs.filter((t) => t.symbol === symbol && (t.type === 'BUY' || t.type === 'SELL'));
    const recorded = txs.filter((t) => t.symbol === symbol && t.type === 'DIVIDEND').map((t) => t.date).sort();
    const events = [...market.dividends(symbol)].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const d of events) {
      if (d.date > today) continue;
      let qty = 0;
      for (const t of trades) {
        if (t.date >= d.date) continue;
        const q = t.quantity * splitFactor(market.splits(symbol), t.date);
        qty += t.type === 'BUY' ? q : -q;
      }
      if (qty <= QTY_EPS) continue;
      // Ödeme ex-date'ten birkaç hafta sonra yapılır; her kayıt en fazla bir temettüyle eşleşir.
      const match = recorded.findIndex((r) => r >= addDays(d.date, -3) && r <= addDays(d.date, 60));
      if (match >= 0) recorded.splice(match, 1);
      else out.push({ symbol, date: d.date, quantity: qty, perShare: d.perShare, amount: qty * d.perShare });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}
