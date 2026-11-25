import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compute, xirr } from '../server/analytics.js';
import { App, cleanTx } from '../server/app.js';
import { Auth, hashPassword, newSetupCode } from '../server/auth.js';
import { fromCsv, toCsv } from '../server/csv.js';
import { openDb } from '../server/db.js';
import { LedgerError, validateLedger } from '../server/ledger.js';
import { Macro, parseMacro } from '../server/macro.js';
import { Market, normalizeSymbol, parseChart } from '../server/market.js';
import { addMonths, isDate, nyDate } from '../shared/dates.js';
import { parseNumber } from '../shared/number.js';
import { monthlyReturns, sliceRange } from '../shared/range.js';

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

test('dönem: getiri, net akış ve düşüş tabana göre hesaplanır', () => {
  const h = [
    { date: '2026-01-02', value: 100, contributed: 100, index: 1, bench: 100 },
    { date: '2026-02-02', value: 150, contributed: 120, index: 1.2, bench: 110 },
    { date: '2026-02-27', value: 130, contributed: 120, index: 1.08, bench: 121 },
    { date: '2026-03-02', value: 140, contributed: 120, index: 1.14, bench: 121 },
  ];
  const r = sliceRange(h, { date: '2025-12-31', bench: 99 }, '1M');
  assert.deepEqual(r.dates, ['2026-02-02', '2026-02-27', '2026-03-02']);
  near(r.gain, -10);
  near(r.twr, 1.14 / 1.2 - 1);
  near(r.benchReturn, 0.1);
  near(r.maxDrawdown, 1.08 / 1.2 - 1);
  const all = sliceRange(h, { date: '2025-12-31', bench: 99 }, 'ALL');
  near(all.gain, 20);
  assert.equal(all.returnDates[0], '2025-12-31');
  assert.equal(all.dates[0], '2026-01-02');
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

test('fiyat tazeliği: seansta hepsi, kapalıyken yalnızca endeks sık yenilenir', async (t) => {
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
  assert.deepEqual(await after(1), ['^GSPC']);
  assert.deepEqual(await after(31), ['AAA', '^GSPC']);
  assert.deepEqual(await after(32), ['AAA', '^GSPC']);
  assert.deepEqual(await after(60 * 8), ['AAA', '^GSPC']);
  assert.deepEqual(await after(60 * 8 + 1), ['^GSPC']);
});

const macroJson = (over = {}) => ({ FormattedQuoteResult: { FormattedQuote: [
  { symbol: '@CL.1', last: '83.61', previous_day_closing: '82.05', realTime: 'false', last_time: '2026-11-25T13:21:49.000-0500' },
  { symbol: 'US10Y', last: '4.836%', previous_day_closing: '4.902%', change_pct: '+1.3%', realTime: 'true', ...over },
] } });

test('makro: yüzde işareti ayıklanır, değişim önceki kapanıştan hesaplanır', () => {
  const by = Object.fromEntries(parseMacro(macroJson()).map((x) => [x.symbol, x]));
  assert.equal(Object.keys(by).length, 6);
  near(by.CL.changePct, 83.61 / 82.05 - 1);
  assert.equal(by.CL.delayed, true);
  assert.equal(by.CL.time, Date.parse('2026-11-25T18:21:49Z'));
  near(by.US10YT.value, 4.836);
  near(by.US10YT.change, -0.066);
  assert.equal(by.VIX.value, null);
});

test('makro: 30 saniye önbellek, hata ve eksik veride son değer korunur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let calls = 0;
  let next = () => macroJson();
  const macro = new Macro(async () => {
    calls++;
    return next();
  });
  const ten = (r) => r.items.find((x) => x.symbol === 'US10YT').value;
  await Promise.all([macro.get(), macro.get()]);
  await macro.get();
  assert.equal(calls, 1);

  t.mock.timers.setTime(1_060_000);
  next = () => macroJson({ last: 'UNCH' });
  assert.equal(ten(await macro.get()), 4.836);

  t.mock.timers.setTime(1_120_000);
  next = () => ({});
  const r = await macro.get();
  assert.equal(ten(r), 4.836);
  assert.match(r.error, /boş yanıt/);
  assert.equal(r.asOf, 1_060_000);
});
