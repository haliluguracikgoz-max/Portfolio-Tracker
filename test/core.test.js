import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compute, xirr } from '../server/analytics.js';
import { App, cleanTx } from '../server/app.js';
import { Auth, hashPassword, newSetupCode } from '../server/auth.js';
import { fromCsv, toCsv } from '../server/csv.js';
import { openDb } from '../server/db.js';
import { LedgerError, validateLedger } from '../server/ledger.js';
import { Market, normalizeSymbol, parseChart, previousClose } from '../server/market.js';
import { DEFAULTS, parseCnbc, parseSpark, Watch } from '../server/watch.js';
import { addMonths, isDate, nyDate } from '../shared/dates.js';
import { parseNumber } from '../shared/number.js';
import { monthlyReturns, rangeBaseDate } from '../shared/range.js';

let nextId = 1;
const tx = (date, type, rest = {}) => ({
  id: nextId++, date, type, symbol: null, quantity: null, price: null, amount: null, fee: 0, settle: 'CASH', note: '', ...rest,
});
const buy = (date, symbol, quantity, price, rest) => tx(date, 'BUY', { symbol, quantity, price, ...rest });
const sell = (date, symbol, quantity, price, rest) => tx(date, 'SELL', { symbol, quantity, price, ...rest });
const deposit = (date, amount) => tx(date, 'DEPOSIT', { amount });
const withdraw = (date, amount) => tx(date, 'WITHDRAW', { amount });

const points = (o) => Object.entries(o).map(([date, close]) => ({ date, close }));
function market({ closes = {}, splits = {}, dividends = {}, quotes = {}, bench }) {
  return {
    closes: (s) => points(closes[s] ?? {}),
    quote: (s) => quotes[s] ?? null,
    splits: (s) => splits[s] ?? [],
    dividends: (s) => dividends[s] ?? [],
    info: (s) => ({ symbol: s, name: s, kind: 'EQUITY', exchange: 'X', sector: null }),
    bench: () => points(bench),
  };
}
const BENCH = { '2025-12-31': 100, '2026-01-02': 101, '2026-01-05': 102, '2026-01-06': 103 };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b} bekleniyordu`);
const noSplits = () => [];

test('alım nakitten düşer, değer ve kazanç doğru hesaplanır', () => {
  const s = compute([deposit('2026-01-02', 1000), buy('2026-01-02', 'A', 10, 50, { fee: 5 })],
    market({ bench: BENCH, closes: { A: { '2026-01-02': 50, '2026-01-05': 60, '2026-01-06': 55 } } }), '2026-01-06');
  near(s.summary.cash, 495);
  near(s.summary.value, 495 + 550);
  near(s.summary.contributed, 1000);
  near(s.summary.totalGain, 45);
  near(s.positions[0].avgCost, 50.5);
  near(s.positions[0].unrealized, 45);
  assert.deepEqual(s.history.map((h) => h.value), [995, 1095, 1045]);
  near(s.summary.dayChange, -50);
  near(s.positions[0].dayChange, -50);
});

test('kazanç bileşenleri toplam kazanca eşittir', () => {
  const s = compute([
    deposit('2026-01-02', 5000), buy('2026-01-02', 'A', 10, 50, { fee: 1 }), buy('2026-01-02', 'B', 5, 20),
    sell('2026-01-05', 'A', 4, 60, { fee: 2 }), tx('2026-01-05', 'DIVIDEND', { symbol: 'B', amount: 7 }),
    tx('2026-01-05', 'INTEREST', { amount: 3 }), tx('2026-01-06', 'FEE', { amount: 4 }), withdraw('2026-01-06', 100),
  ], market({ bench: BENCH, closes: { A: { '2026-01-06': 66 }, B: { '2026-01-06': 18 } } }), '2026-01-06');
  const m = s.summary;
  near(m.unrealized + m.realized + m.dividends + m.interest - 4, m.totalGain);
});

test('FIFO: önce en eski lot satılır', () => {
  const s = compute([
    buy('2026-01-02', 'A', 10, 10, { settle: 'EXTERNAL' }), buy('2026-01-05', 'A', 10, 20, { settle: 'EXTERNAL' }),
    sell('2026-01-06', 'A', 15, 30),
  ], market({ bench: BENCH, closes: { A: { '2026-01-06': 30 } } }), '2026-01-06');
  near(s.summary.realized, 15 * 30 - (10 * 10 + 5 * 20));
  near(s.positions[0].quantity, 5);
  near(s.positions[0].avgCost, 20);
});

test('bölünme: eski adet ve fiyat bugünkü hisseye çevrilir, değer sıçramaz', () => {
  // 5 Ocak'ta 10:1 bölünme. Kapanışlar düzeltilmiş gelir: 2 Ocak'taki gerçek 1000$ → 100$.
  const s = compute([buy('2026-01-02', 'A', 2, 1000, { settle: 'EXTERNAL' }), sell('2026-01-06', 'A', 5, 110)],
    market({ bench: BENCH, splits: { A: [{ date: '2026-01-05', ratio: 10 }] }, closes: { A: { '2026-01-02': 100, '2026-01-05': 100, '2026-01-06': 110 } } }), '2026-01-06');
  near(s.history[0].value, 2000);
  near(s.history[1].value, 2000);
  near(s.positions[0].quantity, 15);
  near(s.positions[0].avgCost, 100);
  near(s.summary.realized, 50);
});

test('TWR para giriş çıkışından etkilenmez', () => {
  const closes = { A: { '2026-01-02': 100, '2026-01-05': 110, '2026-01-06': 121 } };
  const s = compute([
    buy('2026-01-02', 'A', 1, 100, { settle: 'EXTERNAL' }), buy('2026-01-05', 'A', 50, 110, { settle: 'EXTERNAL' }),
    sell('2026-01-06', 'A', 30, 121, { settle: 'EXTERNAL' }),
  ], market({ bench: BENCH, closes }), '2026-01-06');
  // 5 Ocak: girişler gün başında sayılır → (51×110) / (100 + 5500) − 1; 6 Ocak: %10
  near(s.history.at(-1).index, (5610 / 5600) * 1.1);
});

test('portföyün tamamı çekilip yeniden başlatılabilir', () => {
  const s = compute([deposit('2026-01-02', 100), withdraw('2026-01-05', 100), deposit('2026-01-06', 50)], market({ bench: BENCH }), '2026-01-06');
  assert.deepEqual(s.history.map((h) => h.value), [100, 0, 50]);
  near(s.history.at(-1).index, 1);
});

test('hafta sonu girilen işlem bir sonraki işlem gününe yansır', () => {
  const s = compute([deposit('2026-01-03', 100)], market({ bench: BENCH }), '2026-01-06');
  assert.equal(s.history[0].date, '2026-01-05');
  assert.deepEqual(s.base, { date: '2026-01-02', bench: 101 });
});

test('kapalı günde girilen işlem günlük değişimi silmez', () => {
  const s = compute([buy('2026-01-05', 'A', 1, 100, { settle: 'EXTERNAL' }), deposit('2026-01-07', 500)],
    market({ bench: BENCH, closes: { A: { '2026-01-05': 100, '2026-01-06': 103 } } }), '2026-01-07');
  near(s.summary.dayChange, 3);
  near(s.positions[0].dayChange, 3);
  near(s.summary.value, 603);
});

test('canlı fiyat günün kapanışının yerine geçer', () => {
  const s = compute([buy('2026-01-05', 'A', 1, 100, { settle: 'EXTERNAL' })], market({
    bench: BENCH, closes: { A: { '2026-01-05': 100, '2026-01-06': 103 } },
    quotes: { A: { price: 104, prevClose: 100, date: '2026-01-06', time: 0 } },
  }), '2026-01-06');
  near(s.summary.value, 104);
  near(s.positions[0].dayChangePct, 0.04);
});

test('fiyatı olmayan günlerde son işlem fiyatı kullanılır', () => {
  const s = compute([buy('2026-01-02', 'A', 2, 30, { settle: 'EXTERNAL' })], market({ bench: BENCH }), '2026-01-06');
  near(s.summary.value, 60);
});

test('doğrulama: eksik nakit ve eksik adet reddedilir', () => {
  assert.throws(() => validateLedger([deposit('2026-01-02', 100), buy('2026-01-02', 'A', 3, 50)], noSplits), LedgerError);
  assert.throws(() => validateLedger([buy('2026-01-02', 'A', 3, 50, { settle: 'EXTERNAL' }), sell('2026-01-05', 'A', 4, 50)], noSplits), LedgerError);
  assert.throws(() => validateLedger([sell('2026-01-02', 'A', 1, 5), buy('2026-01-05', 'A', 1, 5, { settle: 'EXTERNAL' })], noSplits), LedgerError);
});

test('doğrulama: aynı gün içindeki giriş sırası önemsizdir', () => {
  validateLedger([sell('2026-01-02', 'A', 1, 60), buy('2026-01-02', 'A', 1, 50), deposit('2026-01-02', 50)], noSplits);
});

test('xirr: bir yılda %10', () => {
  near(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]), 0.1, 1e-6);
  assert.equal(xirr([{ date: '2025-01-01', amount: -100 }]), null);
});

test('temettü önerisi: ex-date öncesi adet esas alınır, kayıtlı olan atlanır', () => {
  const m = market({ bench: BENCH, dividends: { A: [{ date: '2026-01-05', perShare: 0.5 }, { date: '2025-12-01', perShare: 9 }] } });
  const trades = [buy('2026-01-02', 'A', 10, 5, { settle: 'EXTERNAL' }), buy('2026-01-05', 'A', 99, 5, { settle: 'EXTERNAL' })];
  const s = compute(trades, m, '2026-01-06');
  assert.deepEqual(s.dividendSuggestions, [{ symbol: 'A', date: '2026-01-05', quantity: 10, perShare: 0.5, amount: 5 }]);
  const done = compute([...trades, tx('2026-01-06', 'DIVIDEND', { symbol: 'A', amount: 4 })], m, '2026-01-06');
  assert.equal(done.dividendSuggestions.length, 0);
});

test('dönem taban günü', () => {
  assert.equal(rangeBaseDate('1M', '2026-03-02'), '2026-02-02');
  assert.equal(rangeBaseDate('YTD', '2026-03-02'), '2025-12-31');
  assert.equal(rangeBaseDate('ALL', '2026-03-02'), null);
});

test('aylık getiriler bileşik olarak toplam getiriye eşittir', () => {
  const m = monthlyReturns([{ date: '2026-01-02', index: 1.1 }, { date: '2026-01-30', index: 1.2 }, { date: '2026-02-03', index: 0.9 }]);
  assert.deepEqual(m.map((x) => x.month), ['2026-01', '2026-02']);
  near(m.reduce((p, x) => p * (1 + x.value), 1), 0.9);
});

test('tarih yardımcıları', () => {
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', -12), '2025-01-15');
  assert.ok(!isDate('2026-02-30'));
  // New York'ta hâlâ bir önceki gün.
  assert.equal(nyDate(Date.parse('2026-01-06T03:00:00Z')), '2026-01-05');
});

test('sayı biçimleri', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('1.234.567'), 1234567);
  assert.equal(parseNumber(''), null);
  assert.ok(Number.isNaN(parseNumber('abc')));
});

test('girdi denetimi', () => {
  const t = '2026-01-06';
  assert.throws(() => cleanTx({ type: 'BUY', date: '2026-01-07', symbol: 'A', quantity: 1, price: 1 }, t), /gelecekte/);
  assert.throws(() => cleanTx({ type: 'BUY', date: t, symbol: 'A', quantity: -1, price: 1 }, t), /Adet/);
  assert.throws(() => cleanTx({ type: 'DEPOSIT', date: t, amount: 'abc' }, t), /Tutar/);
  assert.throws(() => cleanTx({ type: 'SELL', date: t, symbol: 'A', quantity: 1, price: 1, fee: 2 }, t), /Komisyon/);
  assert.equal(cleanTx({ type: 'BUY', date: t, symbol: 'brk.b', quantity: '0,5', price: '480', settle: 'EXTERNAL' }, t).symbol, 'BRK-B');
  assert.equal(normalizeSymbol('../x'), null);
});

test('CSV dışa aktarılan dosya aynen geri okunur; noktalı virgül desteklenir', () => {
  const rows = fromCsv(toCsv([buy('2026-01-02', 'A', 1.5, 10, { note: 'a,"b"\nc' })]));
  assert.equal(rows[0].note, 'a,"b"\nc');
  assert.equal(rows[0].quantity, '1.5');
  assert.equal(fromCsv('date;type;amount\n2026-01-02;DEPOSIT;1.000,50')[0].amount, '1.000,50');
});

// ---- Sahte fiyat servisiyle uçtan uca ----

const bar = (date, close) => [Date.parse(date + 'T14:30:00Z') / 1000, close];
const chart = (bars, { type = 'EQUITY', currency = 'USD', splits = {} } = {}) => ({
  chart: { result: [{
    meta: { currency, instrumentType: type, longName: 'Test', regularMarketPrice: bars.at(-1)[1], regularMarketTime: bars.at(-1)[0] },
    timestamp: bars.map((b) => b[0]), indicators: { quote: [{ close: bars.map((b) => b[1]) }] }, events: { splits },
  }] },
});
function makeApp(responses) {
  const db = openDb(':memory:');
  const get = async (path) => {
    if (path.includes('/search')) return { quotes: [] };
    const symbol = decodeURIComponent(/chart\/([^?]+)/.exec(path)[1]);
    return responses[symbol] ?? null;
  };
  return new App(db, new Market(db, get));
}
const bars = [bar('2026-01-02', 10), bar('2026-01-05', null), bar('2026-01-06', 12)];
const spx = chart([bar('2026-01-02', 100), bar('2026-01-06', 101)], { type: 'INDEX' });

test('parseChart boş kapanışları atlar', () => {
  assert.deepEqual(parseChart(chart(bars)).closes, [{ date: '2026-01-02', close: 10 }, { date: '2026-01-06', close: 12 }]);
  assert.equal(parseChart({ chart: { result: null } }), null);
});

test('App: ekle, düzenle, sil, geri al; tutarsız değişiklik geri alınır', async () => {
  const app = makeApp({ AAA: chart(bars), '^GSPC': spx });
  const dep = await app.addTx({ type: 'DEPOSIT', date: '2026-01-02', amount: 100 });
  const b = await app.addTx({ type: 'BUY', date: '2026-01-02', symbol: 'aaa', quantity: 5, price: 10 });
  await assert.rejects(app.addTx({ type: 'SELL', date: '2026-01-06', symbol: 'AAA', quantity: 6, price: 12 }), /Yetersiz adet/);
  await assert.rejects(app.addTx({ type: 'BUY', date: '2026-01-06', symbol: 'AAA', quantity: 6, price: 12 }), /Yetersiz nakit/);
  assert.throws(() => app.removeTx(dep.id), /Yetersiz nakit/);
  assert.equal(app.txs.all().length, 2);

  await app.updateTx(b.id, { type: 'BUY', date: '2026-01-02', symbol: 'AAA', quantity: 4, price: 10 });
  const s = await app.state();
  near(s.summary.value, 60 + 48);
  assert.deepEqual(s.warnings, []);

  const removed = app.removeTx(b.id);
  assert.equal((await app.state()).positions.length, 0);
  assert.equal((await app.addTx(removed)).id, b.id);
});

test('App: bilinmeyen ve desteklenmeyen semboller reddedilir', async () => {
  const app = makeApp({ EUR: chart(bars, { currency: 'EUR' }), '^GSPC': spx });
  await assert.rejects(app.addTx({ type: 'BUY', date: '2026-01-02', symbol: 'YOK', quantity: 1, price: 1, settle: 'EXTERNAL' }), /bulunamadı/);
  await assert.rejects(app.addTx({ type: 'BUY', date: '2026-01-02', symbol: 'EUR', quantity: 1, price: 1, settle: 'EXTERNAL' }), /desteklenmiyor/);
});

test('App: CSV içe aktarma ya hep ya hiç çalışır ve tekrarları atlar', async () => {
  const app = makeApp({ AAA: chart(bars), '^GSPC': spx });
  const csv = 'date,type,symbol,quantity,price,amount,fee,settle,note\n2026-01-02,DEPOSIT,,,,100,,,\n2026-01-02,BUY,AAA,5,10,,,,\n';
  assert.deepEqual(await app.importCsv(csv), { imported: 2, skipped: 0 });
  assert.deepEqual(await app.importCsv(app.exportCsv()), { imported: 0, skipped: 2 });
  await assert.rejects(app.importCsv(csv + '2026-01-06,SELL,AAA,99,12,,,,\n'), /Yetersiz adet/);
  await assert.rejects(app.importCsv(csv + '2026-01-06,XXX,,,,,,,\n'), /4\. satır/);
  assert.equal(app.txs.all().length, 2);
});

test('App: form fiyatı bölünme öncesi gerçek fiyatı verir', async () => {
  const date = Date.parse('2026-01-06T14:30:00Z') / 1000;
  const app = makeApp({ AAA: chart(bars, { splits: { x: { date, numerator: 4, denominator: 1 } } }), '^GSPC': spx });
  const p = await app.priceOn('AAA', '2026-01-03');
  near(p.price, 40);
  assert.equal(p.priceDate, '2026-01-02');
  assert.equal(p.factor, 4);
});

test('oturum: doğru parola, süre sonu, sahte çerez ve deneme sınırı', () => {
  const auth = new Auth({ password: 'cok-gizli-parola' });
  const cookie = auth.cookie(true).split(';')[0];
  assert.ok(auth.isValid(`x=1; ${cookie}`));
  assert.ok(!auth.isValid(cookie, Date.now() + 31 * 86_400_000));
  assert.ok(!auth.isValid(''));
  assert.ok(!auth.isValid(cookie.replace('=1', '=9')));
  assert.ok(!new Auth({ password: 'baska-bir-parola' }).isValid(cookie));
  assert.equal(auth.check('cok-gizli-parola', 'a'), 'ok');
  for (let i = 0; i < 8; i++) assert.equal(auth.check('yanlis', 'b'), 'wrong');
  assert.equal(auth.check('cok-gizli-parola', 'b'), 'blocked');
  assert.equal(auth.check('cok-gizli-parola', 'a'), 'ok');
  assert.equal(auth.check('cok-gizli-parola', 'b', Date.now() + 16 * 60_000), 'ok');
  assert.ok(new Auth().isValid(undefined));
});

test('ilk kurulum: kod doğrulanana kadar erişim yok, sonra kod geçersiz', () => {
  const code = newSetupCode();
  const auth = new Auth({ setupCode: code });
  assert.ok(auth.needsSetup && auth.enabled);
  assert.ok(!auth.isValid('pt_session=9999999999999.abc'));
  assert.equal(auth.check('', 'a'), 'wrong');
  assert.equal(auth.checkSetupCode('YANLIS', 'a'), 'wrong');
  assert.equal(auth.checkSetupCode(code.toLowerCase(), 'a'), 'ok');
  const record = hashPassword('yeni-parola-123');
  auth.setRecord(record);
  assert.ok(!auth.needsSetup);
  assert.equal(auth.checkSetupCode(code, 'a'), 'wrong');
  assert.equal(auth.check('yeni-parola-123', 'a'), 'ok');
  assert.ok(new Auth({ record, setupCode: newSetupCode() }).isValid(auth.cookie(true).split(';')[0]));
});

test('fiyat tazeliği: borsa açık ya da kapalı, her dakika bütün fiyatlar yenilenir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-06T14:00:00Z') });
  const open = Date.parse('2026-01-06T14:30:00Z') / 1000;
  const session = (c) => {
    c.chart.result[0].meta.currentTradingPeriod = { regular: { start: open, end: open + 6.5 * 3600 } };
    return c;
  };
  const calls = [];
  const data = { AAA: session(chart(bars)), '^GSPC': session(chart([bar('2026-01-02', 100), bar('2026-01-06', 101)], { type: 'INDEX' })) };
  const app = new App(openDb(':memory:'), new Market(openDb(':memory:'), async (path) => {
    const symbol = decodeURIComponent(/chart\/([^?]+)/.exec(path)?.[1] ?? '');
    calls.push(symbol);
    return path.includes('/search') ? { quotes: [] } : data[symbol];
  }));
  await app.addTx({ type: 'BUY', date: '2026-01-02', symbol: 'AAA', quantity: 1, price: 10, settle: 'EXTERNAL' });
  await app.state();
  const after = async (minutes) => {
    t.mock.timers.setTime(Date.parse('2026-01-06T14:00:00Z') + minutes * 60_000);
    calls.length = 0;
    await app.state();
    return calls.sort();
  };
  assert.deepEqual(await after(0.4), []);
  assert.deepEqual(await after(1), ['AAA', '^GSPC']);
  assert.deepEqual(await after(31), ['AAA', '^GSPC']);
  assert.deepEqual(await after(32), ['AAA', '^GSPC']);
  assert.deepEqual(await after(60 * 8), ['AAA', '^GSPC']);
  assert.deepEqual(await after(60 * 8 + 1), ['AAA', '^GSPC']);
});

const cnbcJson = (over = {}) => ({ FormattedQuoteResult: { FormattedQuote: [
  { symbol: '@CL.1', last: '83.61', previous_day_closing: '82.05', realTime: 'false' },
  { symbol: 'US10Y', last: '4.836%', previous_day_closing: '4.902%', change_pct: '+1.3%', realTime: 'true', ...over },
  { symbol: 'US5Y', name: 'U.S. 5 Year Treasury', last: '4.65%', previous_day_closing: '4.71%', realTime: 'true' },
] } });
const spark = (o) => Object.fromEntries(Object.entries(o).map(([k, [v, prev]]) => [k, { close: [null, v], chartPreviousClose: prev }]));

test('piyasa paneli: değişim önceki kapanıştan hesaplanır', () => {
  const c = parseCnbc(cnbcJson());
  near(c.get('@CL.1').changePct, 83.61 / 82.05 - 1);
  assert.equal(c.get('@CL.1').delayed, true);
  near(c.get('US10Y').change, -0.066);
  assert.equal(c.get('US10Y').unit, 'yield');
  const y = parseSpark({ ...spark({ QQQ: [630, 600], 'GC=F': [3500, 3550] }), BOS: { close: null } });
  near(y.get('QQQ').changePct, 0.05);
  assert.equal(y.get('GC=F').delayed, true);
  assert.ok(!y.has('BOS'));
});

function makeWatch(over = {}) {
  const calls = { yahoo: 0, cnbc: 0 };
  const src = {
    spark: () => spark({ QQQ: [630, 600], NCLD: [10, 11], VOO: [650, 640], 'GC=F': [3500, 3550], AAPL: [350, 340] }),
    cnbc: () => cnbcJson(),
    ...over,
  };
  const kinds = { VOO: 'ETF', 'GC=F': 'FUTURE', AAPL: 'EQUITY' };
  const getYahoo = async (path) => {
    if (path.includes('/search')) {
      return { quotes: [
        { symbol: 'VOO', longname: 'Vanguard S&P 500 ETF', quoteType: 'ETF', exchange: 'PCX' }, { symbol: 'VOO.MX', quoteType: 'ETF', exchange: 'MEX' },
        { symbol: 'AAPL', quoteType: 'EQUITY', exchange: 'NMS' }, { symbol: 'VOO261218C1', quoteType: 'OPTION', exchange: 'OPR' },
      ] };
    }
    if (path.includes('/chart/')) {
      const symbol = decodeURIComponent(/chart\/([^?]+)/.exec(path)[1]);
      return kinds[symbol] ? { chart: { result: [{ meta: { symbol, currency: 'USD', instrumentType: kinds[symbol], exchangeName: symbol === 'AAPL' ? 'NMS' : 'PCX', longName: `${symbol} adı` } }] } } : null;
    }
    calls.yahoo++;
    return src.spark();
  };
  const getCnbc = async (url) => {
    if (url.includes('symlookup')) return [{ ResultGenTime: 'x' }, { symbolName: 'US5Y', companyName: 'U.S. 5 Year Treasury', issueType: 'BOND' }, { symbolName: 'B', issueType: 'STOCK' }];
    calls.cnbc++;
    return src.cnbc();
  };
  const db = openDb(':memory:');
  return { watch: new Watch(db, { getYahoo, getCnbc }), again: () => new Watch(db, { getYahoo, getCnbc }), calls, src };
}
const idsOf = (list) => list.items.map((x) => x.id);

test('piyasa paneli: 30 saniye önbellek; bir kaynak kesilince diğeri çalışır, son değer korunur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { watch, calls, src } = makeWatch();
  await Promise.all([watch.get(), watch.get()]);
  const first = await watch.get();
  assert.deepEqual(calls, { yahoo: 1, cnbc: 1 });
  assert.deepEqual([first.macro.items.length, first.etf.items.length], [6, 6]);
  assert.equal(first.etf.items.find((x) => x.symbol === 'QQQ').value, 630);

  t.mock.timers.setTime(1_060_000);
  src.cnbc = () => ({});
  src.spark = () => spark({ QQQ: [640, 600] });
  const r = await watch.get();
  assert.match(r.macro.error, /boş yanıt/);
  assert.equal(r.macro.items.find((x) => x.symbol === 'US10YT').value, 4.836);
  assert.equal(r.macro.asOf, 1_000_000);
  assert.equal(r.etf.error, null);
  assert.equal(r.etf.items.find((x) => x.symbol === 'QQQ').value, 640);
  assert.equal(r.etf.items.find((x) => x.symbol === 'NCLD').value, 10);
});

test('piyasa paneli: ekle, çıkar, geri al; liste kalıcıdır', async () => {
  const { watch, again } = makeWatch();
  const added = await watch.add('etf', 'yahoo:VOO');
  assert.deepEqual(added.etf.items.at(-1), { id: 'yahoo:VOO', symbol: 'VOO', name: 'VOO adı', unit: 'usd', value: 650, change: 10, changePct: 650 / 640 - 1, delayed: false });
  await assert.rejects(watch.add('etf', 'yahoo:VOO'), /zaten listede/);
  await assert.rejects(watch.add('etf', 'yahoo:AAPL'), /ETF’ler eklenebilir/);
  await assert.rejects(watch.add('etf', 'yahoo:YOK'), /bulunamadı/);
  await assert.rejects(watch.add('macro', 'yahoo:../x?y'), /Geçersiz sembol/);
  await assert.rejects(watch.add('__proto__', 'yahoo:VOO'), /Geçersiz liste/);
  assert.equal((await watch.add('macro', 'yahoo:GC=F')).macro.items.at(-1).unit, 'usd');
  assert.equal((await watch.add('macro', 'cnbc:US5Y')).macro.items.at(-1).unit, 'yield');
  assert.equal((await watch.add('macro', 'yahoo:AAPL')).macro.items.length, 9);

  assert.deepEqual(idsOf((await watch.get()).stocks), []);
  await watch.add('stocks', 'yahoo:AAPL');
  assert.deepEqual(idsOf((await watch.add('stocks', 'yahoo:VOO')).stocks), ['yahoo:AAPL', 'yahoo:VOO']);
  await assert.rejects(watch.add('stocks', 'yahoo:GC=F'), /hisse ve ETF/);

  const entry = DEFAULTS.etf[1];
  assert.ok(!idsOf(watch.remove('etf', entry.id).etf).includes(entry.id));
  assert.throws(() => watch.remove('etf', entry.id), /bulunamadı/);
  assert.deepEqual(idsOf(watch.restore('etf', entry, 1).etf), [...idsOf({ items: DEFAULTS.etf }), 'yahoo:VOO']);
  assert.throws(() => watch.restore('etf', { ...entry, id: 'yahoo:A', unit: 'kötü' }, 0), /Geçersiz kayıt/);

  for (const x of DEFAULTS.etf) watch.remove('etf', x.id);
  assert.deepEqual(idsOf((await again().get()).etf), ['yahoo:VOO']);
  assert.deepEqual(idsOf(watch.remove('etf', 'yahoo:VOO').etf), []);
  assert.deepEqual(idsOf((await again().get()).etf), []);
  assert.equal((await watch.add('etf', 'yahoo:VOO')).etf.items.length, 1);
});

test('piyasa paneli: arama ETF listesinde yalnızca ABD ETF’lerini, makroda her şeyi gösterir', async () => {
  const { watch } = makeWatch();
  assert.deepEqual((await watch.search('etf', 'voo')).map((x) => x.id), ['yahoo:VOO']);
  assert.deepEqual((await watch.search('macro', 'altın')).map((x) => x.id), ['calc:GAUTRY', 'calc:GAUUSD', 'cnbc:XAU=', 'cnbc:US5Y', 'yahoo:VOO', 'yahoo:VOO.MX', 'yahoo:AAPL']);
  assert.deepEqual((await watch.search('stocks', 'a')).map((x) => x.id), ['yahoo:VOO', 'yahoo:AAPL']);
  await watch.add('etf', 'yahoo:VOO');
  assert.equal((await watch.search('etf', 'voo'))[0].added, true);
  assert.deepEqual(await watch.search('etf', '  '), []);
});

test('piyasa paneli: gram altın ons fiyatı ve kurdan hesaplanır, aramada çıkar', async () => {
  const { watch } = makeWatch({
    spark: () => spark({ 'TRY=X': [50, 49] }),
    cnbc: () => ({ FormattedQuoteResult: { FormattedQuote: [{ symbol: 'XAU=', last: '3,110.34768', previous_day_closing: '3,000.00', realTime: 'true' }] } }),
  });
  const other = (await watch.get()).other.items;
  const by = Object.fromEntries(other.map((x) => [x.name, x]));
  assert.equal(other.length, 8);
  near(by['GAU/USD'].value, 100);
  near(by['GAU/TRY'].value, 5000);
  near(by['GAU/TRY'].changePct, (3110.34768 * 50) / (3000 * 49) - 1);
  assert.deepEqual((await watch.search('other', 'Altın')).slice(0, 3).map((x) => x.id), ['calc:GAUTRY', 'calc:GAUUSD', 'cnbc:XAU=']);
  watch.remove('other', 'calc:GAUTRY');
  assert.equal((await watch.add('other', 'calc:GAUTRY')).other.items.at(-1).name, 'GAU/TRY');
  await assert.rejects(watch.add('other', 'calc:YOK'), /Geçersiz sembol/);
  await assert.rejects(watch.add('stocks', 'calc:GAUTRY'), /hisse ve ETF/);
});

test('piyasa paneli: toplu aktarım bir kez uygulanır, var olanı korur', async () => {
  const { watch, again } = makeWatch();
  await watch.add('stocks', 'yahoo:AAPL');
  const text = JSON.stringify({ stocks: { MSFT: 'Microsoft', AAPL: 'Apple', NVDA: 'NVIDIA', 'x y': 'bozuk' } });
  assert.deepEqual(watch.importOnce(text), { stocks: 2 });
  watch.remove('stocks', 'yahoo:MSFT');
  assert.equal(again().importOnce(text), null);
  assert.deepEqual(idsOf((await again().get()).stocks), ['yahoo:AAPL', 'yahoo:NVDA']);
  assert.throws(() => watch.importOnce('{"macro":{}}'), /aktarım yapılamaz/);
});

test('önceki kapanış: son mumlar boş gelirse bildirilen günlük değişim esas alınır', () => {
  near(previousClose({ regularMarketPrice: 72.88, regularMarketChangePercent: -6.504 }, 94.395), 72.88 / (1 - 0.06504));
  assert.equal(previousClose({ regularMarketPrice: 72.88, regularMarketChangePercent: -6.504 }, 77.95), 77.95);
  assert.equal(previousClose({ regularMarketPrice: 72.88 }, 77.95), 77.95);
  assert.equal(previousClose({ regularMarketPrice: 10 }, undefined), 10);
});
