import { rangeBaseDate, RANGES, monthlyReturns, sliceRange } from '/shared/range.js';
import { parseNumber } from '/shared/number.js';
import { api } from './api.js';
import { columnChart, legend, lineChart, sparkline, treemap } from './charts.js';
import { h } from './dom.js';
import * as f from './format.js';
import { openTxForm } from './form.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const toasts = document.getElementById('toasts');

let state = null;
let detail = null;
let loadError = null;
let loading = false;
let renderedKey = '';

const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Tercih saklanamazsa uygulama yine çalışır.
    }
  },
};
const ui = {
  range: store.get('range', 'ALL'),
  alloc: 'symbol',
  tables: new Set(),
  sort: { key: 'value', dir: -1 },
  txType: '',
  txText: '',
  withholding: store.get('withholding', '0'),
};
if (!RANGES.some((r) => r.key === ui.range)) ui.range = 'ALL';

// ---------------------------------------------------------------- Yardımcılar

function toast(message, { action, onAction, error } = {}) {
  const el = h('div', { class: `toast${error ? ' bad' : ''}` }, h('span', null, message), action && h('button', { class: 'link', onclick: () => {
    el.remove();
    onAction();
  } }, action));
  toasts.append(el);
  setTimeout(() => el.remove(), action || error ? 9000 : 4000);
}

const delta = (value, text) => h('span', { class: `delta ${f.tone(value)}` }, Math.abs(value) < 1e-9 ? '' : value > 0 ? '▲ ' : '▼ ', text);
const symbolHref = (symbol) => `#/hisse/${symbol}`;

const openForm = (preset, edit = null) =>
  openTxForm({ state, preset, edit, onSaved: (message) => {
    toast(message);
    load();
  } });

async function removeTx(t) {
  try {
    const removed = await api.removeTx(t.id);
    toast('İşlem silindi.', { action: 'Geri al', onAction: async () => {
      try {
        await api.addTx(removed);
      } catch (e) {
        toast(e.message, { error: true });
      }
      load();
    } });
    load();
  } catch (e) {
    toast(`Silinemedi. ${e.message}`, { error: true });
  }
}

/** Başlık + grafik/tablo geçişi olan kart. */
function card({ id, title, sub, chart, table, legendOf, wide, extra }) {
  const el = h('section', { class: `card${wide ? ' wide' : ''}` });
  const draw = () => {
    const asTable = table && ui.tables.has(id);
    el.replaceChildren(...[
      h('header', { class: 'card-head' },
        h('div', null, h('h2', null, title), sub && h('p', { class: 'sub' }, sub)),
        h('div', { class: 'card-tools' }, extra, table && h('button', { class: 'ghost', 'aria-pressed': String(asTable), onclick: () => {
          if (asTable) ui.tables.delete(id);
          else ui.tables.add(id);
          draw();
        } }, asTable ? 'Grafik' : 'Tablo'))),
      !asTable && legendOf && legendOf.length > 1 && legend(legendOf),
      asTable ? table() : chart(),
    ].filter(Boolean));
  };
  draw();
  return el;
}

function dataTable(heads, rows, className = '') {
  return h('div', { class: `table-wrap ${className}` },
    h('table', null,
      h('thead', null, h('tr', null, heads.map((c, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, c)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '' }, c)))))));
}

const seriesTable = (dates, series, format) =>
  dataTable(['Tarih', ...series.map((x) => x.label)], dates.map((d, i) => [f.longDate(d), ...series.map((x) => (x.values[i] == null ? '–' : format(x.values[i])))]).reverse(), 'scroll');

function rangePicker(label) {
  return h('div', { class: 'segments', role: 'group', 'aria-label': label }, RANGES.map((r) =>
    h('button', { title: r.title, 'aria-pressed': String(r.key === ui.range), onclick: () => {
      ui.range = r.key;
      store.set('range', r.key);
      render(true);
    } }, r.label)));
}

const stat = (label, value, extra) => h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), extra && h('span', { class: 'note' }, extra));

// ---------------------------------------------------------------- Genel bakış

function emptyState() {
  return h('section', { class: 'empty' },
    h('h1', null, 'Portföyünüzü kurun'),
    h('p', null, 'Elinizdeki hisseleri alış tarihiyle ekleyin. Geçmiş değerler o günden bugüne otomatik hesaplanır.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle'),
      h('button', { class: 'btn', onclick: () => openForm({ type: 'DEPOSIT' }) }, 'Nakit ekle'),
      importButton('btn', 'CSV’den aktar')));
}

function overview() {
  if (!state.transactions.length) return [emptyState()];
  const { summary: m, history, positions } = state;
  const r = sliceRange(history, state.base, ui.range);
  const rangeTitle = RANGES.find((x) => x.key === ui.range).title;
  const C = { portfolio: 'var(--series-1)', bench: 'var(--series-2)', muted: 'var(--ink-3)' };

  const valueSeries = [
    { label: 'Portföy değeri', color: C.portfolio, values: r.value, area: true },
    { label: 'Yatırılan net para', color: C.muted, values: r.contributed, step: true },
  ];
  const perfSeries = [
    { label: 'Portföy', color: C.portfolio, values: r.portfolio },
    { label: 'S&P 500', color: C.bench, values: r.bench },
  ];
  const ddSeries = [{ label: 'Zirveden düşüş', color: C.portfolio, values: r.drawdown, area: true }];

  return [
    h('section', { class: 'hero' },
      h('div', { class: 'hero-main' },
        h('h1', { class: 'label' }, 'Portföy değeri'),
        h('p', { class: 'hero-value' }, f.money(m.value)),
        h('p', { class: 'hero-day' }, delta(m.dayChange, `${f.signedMoney(m.dayChange)} (${f.signedPct(m.dayChangePct)})`), h('span', { class: 'muted' }, ` ${f.longDate(state.lastTradingDate)}`))),
      h('div', { class: 'stats' },
        stat('Toplam kazanç', f.signedMoney(m.totalGain), m.contributed > 0 ? delta(m.totalGain, f.signedPct(m.totalGain / m.contributed)) : null),
        stat('Nakit', f.money(m.cash), m.value > 0 ? `${f.pct1(m.cash / m.value)} pay` : null),
        stat('Gerçekleşen kazanç', f.signedMoney(m.realized), 'satışlardan'),
        stat('Temettü ve faiz', f.money(m.dividends + m.interest), null),
        stat('Yıllık getiri (XIRR)', m.xirr == null ? '–' : f.signedPct(m.xirr), m.xirr == null ? '1 yıl dolunca' : 'para ağırlıklı'))),

    h('div', { class: 'range-row' }, rangePicker('Dönem'), h('p', { class: 'range-summary' },
      h('span', null, rangeTitle, ': '), delta(r.gain, f.signedMoney(r.gain)),
      h('span', null, ' · getiri '), h('b', null, f.signedPct(r.twr)),
      r.benchReturn != null && [h('span', null, ' · S&P 500 '), h('b', null, f.signedPct(r.benchReturn))],
      h('span', null, ' · en büyük düşüş '), h('b', null, f.pct(r.maxDrawdown)))),

    h('div', { class: 'grid' },
      card({
        id: 'value', title: 'Portföy değeri', wide: true, legendOf: valueSeries,
        sub: r.netFlow ? `Dönemde net para ${r.netFlow > 0 ? 'girişi' : 'çıkışı'}: ${f.money(Math.abs(r.netFlow))}` : 'Dönemde para girişi ya da çıkışı yok',
        chart: () => lineChart({ dates: r.dates, series: valueSeries, format: f.money, axis: f.axisMoney, height: 340, label: 'Portföy değeri zaman grafiği' }),
        table: () => seriesTable(r.dates, valueSeries, f.money),
      }),
      card({
        id: 'perf', title: 'S&P 500 ile karşılaştırma', sub: 'Para giriş çıkışından arındırılmış getiri. Endeks temettüsüz.', legendOf: perfSeries,
        chart: () => lineChart({ dates: r.returnDates, series: perfSeries, format: f.signedPct, axis: f.axisPct, label: 'Portföy ve S&P 500 getirisi', endLabel: f.signedPct }),
        table: () => seriesTable(r.returnDates, perfSeries, f.signedPct),
      }),
      card({
        id: 'dd', title: 'Zirveden düşüş', sub: 'Dönem içindeki en yüksek noktaya göre',
        chart: () => lineChart({ dates: r.returnDates, series: ddSeries, format: f.pct, axis: f.axisPct, zero: true, label: 'Zirveden düşüş grafiği' }),
        table: () => seriesTable(r.returnDates, ddSeries, f.pct),
      }),
      positions.length > 0 && holdingsCard(),
      positions.length > 0 && heatCard(),
      allocationCard(),
      gainCard(),
      monthlyCard(),
      state.closed.length > 0 && closedCard()),
  ];
}

function holdingsCard() {
  const cols = [
    { key: 'symbol', label: 'Hisse', get: (p) => p.symbol },
    { key: 'spark', label: 'Son 30 gün' },
    { key: 'quantity', label: 'Adet', get: (p) => p.quantity },
    { key: 'avgCost', label: 'Ort. maliyet', get: (p) => p.avgCost },
    { key: 'price', label: 'Fiyat', get: (p) => p.price },
    { key: 'dayChangePct', label: 'Bugün', get: (p) => p.dayChangePct },
    { key: 'value', label: 'Değer', get: (p) => p.value },
    { key: 'weight', label: 'Pay', get: (p) => p.weight },
    { key: 'unrealized', label: 'Kâr / zarar', get: (p) => p.unrealized },
    { key: 'actions', label: '' },
  ];
  const { key, dir } = ui.sort;
  const get = cols.find((c) => c.key === key).get;
  const rows = [...state.positions].sort((a, b) => (get(a) < get(b) ? -dir : get(a) > get(b) ? dir : 0));
  return h('section', { class: 'card wide' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Varlıklar')), h('div', { class: 'card-tools' }, h('button', { class: 'ghost', onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle'))),
    h('div', { class: 'table-wrap' }, h('table', { class: 'holdings' },
      h('thead', null, h('tr', null, cols.map((c, i) =>
        h('th', { scope: 'col', class: i > 1 ? 'num' : '', 'aria-sort': c.key === key ? (dir < 0 ? 'descending' : 'ascending') : null },
          c.get ? h('button', { onclick: () => {
            ui.sort = { key: c.key, dir: c.key === key ? -dir : c.key === 'symbol' ? 1 : -1 };
            render(true);
          } }, c.label, c.key === key ? (dir < 0 ? ' ↓' : ' ↑') : '') : c.label)))),
      h('tbody', null,
        rows.map((p) => h('tr', null,
          h('th', { scope: 'row' }, h('a', { href: symbolHref(p.symbol) }, h('b', null, p.symbol), h('span', null, p.name))),
          h('td', null, sparkline(p.spark, f.tone(p.spark.at(-1) - p.spark[0]))),
          h('td', { class: 'num' }, f.qty(p.quantity)),
          h('td', { class: 'num' }, f.price(p.avgCost)),
          h('td', { class: 'num' }, f.price(p.price)),
          h('td', { class: 'num' }, delta(p.dayChangePct, f.signedPct(p.dayChangePct)), h('small', null, f.signedMoney(p.dayChange))),
          h('td', { class: 'num strong' }, f.money(p.value)),
          h('td', { class: 'num' }, f.pct1(p.weight)),
          h('td', { class: 'num' }, delta(p.unrealized, f.signedMoney(p.unrealized)), h('small', null, f.signedPct(p.unrealizedPct))),
          h('td', { class: 'row-actions' },
            h('button', { class: 'ghost', 'aria-label': `${p.symbol} al`, onclick: () => openForm({ type: 'BUY', symbol: p.symbol }) }, 'Al'),
            h('button', { class: 'ghost', 'aria-label': `${p.symbol} sat`, onclick: () => openForm({ type: 'SELL', symbol: p.symbol }) }, 'Sat')))),
        h('tr', { class: 'cash-row' },
          h('th', { scope: 'row' }, h('b', null, 'Nakit'), h('span', null, 'ABD doları')),
          h('td', { colspan: 5 }), h('td', { class: 'num strong' }, f.money(state.summary.cash)),
          h('td', { class: 'num' }, state.summary.value > 0 ? f.pct1(state.summary.cash / state.summary.value) : '–'), h('td'),
          h('td', { class: 'row-actions' },
            h('button', { class: 'ghost', onclick: () => openForm({ type: 'DEPOSIT' }) }, 'Ekle'),
            h('button', { class: 'ghost', onclick: () => openForm({ type: 'WITHDRAW' }) }, 'Çek')))))));
}

function heatCard() {
  const items = state.positions.map((p) => ({
    key: p.symbol, value: p.value, change: p.dayChangePct, href: symbolHref(p.symbol), title: p.name,
    rows: [
      { value: f.signedPct(p.dayChangePct), label: 'günlük değişim' },
      { value: f.signedMoney(p.dayChange), label: 'portföye etkisi' },
      { value: f.money(p.value), label: `${f.pct1(p.weight)} pay` },
    ],
  }));
  return card({
    id: 'heat', title: 'Günün ısı haritası', sub: `Alan: pozisyon büyüklüğü. Renk: ${f.longDate(state.lastTradingDate)} değişimi.`, wide: true,
    chart: () => h('div', null, treemap({ items, height: 260, format: f.signedPct }),
      h('div', { class: 'scale', 'aria-hidden': 'true' }, h('span', null, '−%4'), h('i'), h('span', null, '+%4'))),
    table: () => dataTable(['Hisse', 'Günlük değişim', 'Etki', 'Değer'], state.positions.map((p) => [p.symbol, f.signedPct(p.dayChangePct), f.signedMoney(p.dayChange), f.money(p.value)])),
  });
}

function allocationCard() {
  const { positions, summary: m } = state;
  let rows;
  if (ui.alloc === 'symbol') rows = positions.map((p) => ({ label: p.symbol, value: p.value, href: symbolHref(p.symbol) }));
  else {
    const by = new Map();
    for (const p of positions) by.set(f.sectorName(p), (by.get(f.sectorName(p)) ?? 0) + p.value);
    rows = [...by].map(([label, value]) => ({ label, value }));
  }
  if (m.cash > 0.005) rows.push({ label: 'Nakit', value: m.cash, cash: true });
  rows.sort((a, b) => b.value - a.value);
  const max = Math.max(...rows.map((x) => x.value), 1);
  const total = m.value || 1;
  const toggle = h('div', { class: 'segments small', role: 'group', 'aria-label': 'Dağılım türü' }, [['symbol', 'Hisse'], ['sector', 'Sektör']].map(([k, label]) =>
    h('button', { 'aria-pressed': String(ui.alloc === k), onclick: () => {
      ui.alloc = k;
      render(true);
    } }, label)));
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Dağılım')), h('div', { class: 'card-tools' }, toggle)),
    h('ul', { class: 'bars' }, rows.map((x) => h('li', null,
      x.href ? h('a', { href: x.href, class: 'bar-name' }, x.label) : h('span', { class: 'bar-name' }, x.label),
      h('span', { class: 'bar-track' }, h('i', { class: x.cash ? 'cash' : '', style: { width: `${(x.value / max) * 100}%` } })),
      h('span', { class: 'bar-value' }, f.pct1(x.value / total)), h('span', { class: 'bar-sub' }, f.money(x.value))))));
}

function gainCard() {
  const rows = [...state.positions, ...state.closed].map((p) => ({ label: p.symbol, value: p.totalGain })).sort((a, b) => b.value - a.value);
  const top = Math.max(0, ...rows.map((x) => x.value));
  const bottom = Math.max(0, ...rows.map((x) => -x.value));
  const span = top + bottom || 1;
  const zero = `${(bottom / span) * 100}%`;
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Kazancın kaynağı'), h('p', { class: 'sub' }, 'Açık kâr, gerçekleşen kâr ve temettü toplamı'))),
    rows.length
      ? h('ul', { class: 'bars diverging', style: { '--zero': zero } }, rows.map((x) => h('li', null,
        h('a', { href: symbolHref(x.label), class: 'bar-name' }, x.label),
        h('span', { class: 'bar-track' }, h('i', { class: x.value >= 0 ? 'pos' : 'neg', style: { width: `${(Math.abs(x.value) / span) * 100}%` } })),
        h('span', { class: 'bar-value' }, f.signedMoney(x.value)))))
      : h('p', { class: 'muted' }, 'Henüz hisse işlemi yok.'));
}

function monthlyCard() {
  const rows = monthlyReturns(state.history).slice(-36).map((x) => ({ label: f.monthLabel(x.month), longLabel: f.monthLong(x.month), value: x.value }));
  return card({
    id: 'monthly', title: 'Aylık getiriler', sub: 'Para giriş çıkışından arındırılmış', wide: true,
    chart: () => columnChart({ rows, format: f.signedPct, axis: f.axisPct, label: 'Aylık getiriler' }),
    table: () => dataTable(['Ay', 'Getiri'], rows.map((x) => [x.longLabel, f.signedPct(x.value)]).reverse(), 'scroll'),
  });
}

function closedCard() {
  return h('section', { class: 'card wide' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Kapanan pozisyonlar'))),
    dataTable(['Hisse', 'Son işlem', 'Gerçekleşen', 'Temettü', 'Toplam'], state.closed.map((p) => [
      h('a', { href: symbolHref(p.symbol) }, p.symbol), f.longDate(p.lastDate), delta(p.realized, f.signedMoney(p.realized)), f.money(p.dividends), delta(p.totalGain, f.signedMoney(p.totalGain)),
    ])));
}

// ---------------------------------------------------------------- İşlemler

function importButton(className, label) {
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const r = await api.importCsv(await file.text());
      toast(`${r.imported} işlem aktarıldı.${r.skipped ? ` ${r.skipped} işlem zaten kayıtlıydı.` : ''}`);
      load();
    } catch (e) {
      toast(`Aktarılamadı. ${e.message}`, { error: true });
    }
  } });
  return h('span', null, input, h('button', { class: className, onclick: () => input.click() }, label));
}

/** İşlemin portföydeki nakde etkisi. */
function cashEffect(t) {
  if (t.type === 'BUY') return t.settle === 'CASH' ? -(t.quantity * t.price + t.fee) : 0;
  if (t.type === 'SELL') return t.settle === 'CASH' ? t.quantity * t.price - t.fee : 0;
  return t.type === 'WITHDRAW' || t.type === 'FEE' ? -t.amount : t.amount;
}

function txTable(list, { withSymbol = true } = {}) {
  if (!list.length) return h('p', { class: 'muted pad' }, 'Gösterilecek işlem yok.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'tx' },
    h('thead', null, h('tr', null, ['Tarih', 'İşlem', withSymbol && 'Hisse', 'Adet', 'Fiyat', 'Komisyon', 'Tutar', 'Nakde etkisi', 'Not', ''].filter((x) => x !== false).map((c) =>
      h('th', { scope: 'col', class: ['Adet', 'Fiyat', 'Komisyon', 'Tutar', 'Nakde etkisi'].includes(c) ? 'num' : '' }, c)))),
    h('tbody', null, [...list].reverse().map((t) => {
      const trade = t.type === 'BUY' || t.type === 'SELL';
      const effect = cashEffect(t);
      return h('tr', null,
        h('td', { class: 'nowrap' }, f.longDate(t.date)),
        h('td', null, h('span', { class: `tag ${t.type.toLowerCase()}` }, f.TYPE_LABEL[t.type])),
        withSymbol && h('td', null, t.symbol ? h('a', { href: symbolHref(t.symbol) }, t.symbol) : '–'),
        h('td', { class: 'num' }, trade ? f.qty(t.quantity) : '–'),
        h('td', { class: 'num' }, trade ? f.price(t.price) : '–'),
        h('td', { class: 'num' }, t.fee ? f.money(t.fee) : '–'),
        h('td', { class: 'num strong' }, f.money(trade ? t.quantity * t.price : t.amount)),
        h('td', { class: 'num' }, effect ? delta(effect, f.signedMoney(effect)) : h('span', { class: 'muted' }, 'dışarıdan')),
        h('td', { class: 'note-cell', title: t.note || null }, t.note),
        h('td', { class: 'row-actions' },
          h('button', { class: 'ghost', onclick: () => openForm({}, t) }, 'Düzenle'),
          h('button', { class: 'ghost danger', onclick: () => removeTx(t) }, 'Sil')));
    }))));
}

function transactionsView() {
  const rows = h('div');
  const draw = () => {
    const text = ui.txText.trim().toUpperCase().replaceAll('.', '-');
    rows.replaceChildren(txTable(state.transactions.filter((t) => (!ui.txType || t.type === ui.txType) && (!text || (t.symbol ?? '').includes(text)))));
  };
  draw();
  const typeSelect = h('select', { 'aria-label': 'İşlem türü', onchange: (e) => {
    ui.txType = e.target.value;
    draw();
  } }, h('option', { value: '' }, 'Tüm işlemler'), Object.entries(f.TYPE_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  typeSelect.value = ui.txType;

  return [
    h('div', { class: 'page-head' }, h('h1', null, 'İşlemler'), h('div', { class: 'actions' },
      importButton('btn', 'CSV’den aktar'),
      h('a', { class: 'btn', href: '/api/export', download: '' }, 'CSV indir'))),
    dividendCard(),
    h('section', { class: 'card wide' },
      h('div', { class: 'filters' }, typeSelect, h('input', { type: 'search', placeholder: 'Sembol ara', 'aria-label': 'Sembol ara', value: ui.txText, oninput: (e) => {
        ui.txText = e.target.value;
        draw();
      } })),
      rows),
  ];
}

function dividendCard() {
  const list = state.dividendSuggestions;
  if (!list.length) return null;
  const rate = () => Math.min(100, Math.max(0, parseNumber(ui.withholding) || 0)) / 100;
  const body = h('div');
  const add = async (items) => {
    let done = 0;
    try {
      for (const d of items) {
        const net = d.amount * (1 - rate());
        if (net < 0.005) continue;
        await api.addTx({ type: 'DIVIDEND', date: d.date, symbol: d.symbol, amount: Number(net.toFixed(2)), note: `Hisse başı $${d.perShare}${rate() ? `, %${ui.withholding} stopaj düşüldü` : ''}` });
        done++;
      }
      toast(`${done} temettü kaydedildi.`);
    } catch (e) {
      toast(e.message, { error: true });
    }
    load();
  };
  const draw = () => body.replaceChildren(dataTable(['Hisse', 'Hak ediş', 'Adet', 'Hisse başı', 'Net tutar', ''], list.map((d) => [
    d.symbol, f.longDate(d.date), f.qty(d.quantity), f.price(d.perShare), f.money(d.amount * (1 - rate())), h('button', { class: 'ghost', onclick: () => add([d]) }, 'Ekle'),
  ]), 'scroll short'));
  draw();
  return h('section', { class: 'card wide' },
    h('header', { class: 'card-head' },
      h('div', null, h('h2', null, 'Kaydedilmemiş temettüler'), h('p', { class: 'sub' }, 'Elinizdeki adede göre hesaplandı. Eklediğinizde nakde geçer.')),
      h('div', { class: 'card-tools' },
        h('label', { class: 'inline' }, 'Stopaj %', h('input', { inputmode: 'decimal', value: ui.withholding, oninput: (e) => {
          ui.withholding = e.target.value;
          store.set('withholding', ui.withholding);
          draw();
        } })),
        h('button', { class: 'btn', onclick: () => add([...list].reverse()) }, 'Tümünü ekle'))),
    body);
}

// ---------------------------------------------------------------- Hisse sayfası

function symbolView(symbol) {
  if (!detail || detail.symbol !== symbol) return [h('p', { class: 'loading' }, 'Yükleniyor…')];
  if (detail.error) return [h('a', { href: '#/', class: 'back' }, '← Genel bakış'), h('p', { class: 'banner bad' }, detail.error)];
  const d = detail.data;
  const p = state.positions.find((x) => x.symbol === symbol);
  const closed = state.closed.find((x) => x.symbol === symbol);
  const from = rangeBaseDate(ui.range, d.prices.at(-1)?.date ?? '');
  const prices = from ? d.prices.filter((x) => x.date >= from) : d.prices;
  const dates = prices.map((x) => x.date);
  const series = [{ label: 'Kapanış', color: 'var(--series-1)', values: prices.map((x) => x.close), area: true }];
  const markers = d.transactions
    .filter((t) => (t.type === 'BUY' || t.type === 'SELL') && t.date >= (dates[0] ?? '9'))
    .map((t) => {
      let i = dates.findIndex((x) => x >= t.date);
      if (i < 0) i = dates.length - 1;
      return { i, kind: t.type.toLowerCase(), text: `${f.TYPE_LABEL[t.type]} ${f.qty(t.quantity * t.factor)} × ${f.price(t.price / t.factor)}` };
    });
  const dayChange = d.quote ? d.quote.price - d.quote.prevClose : 0;
  const change = prices.length > 1 ? prices.at(-1).close / prices[0].close - 1 : 0;

  return [
    h('a', { href: '#/', class: 'back' }, '← Genel bakış'),
    h('section', { class: 'hero' },
      h('div', { class: 'hero-main' },
        h('h1', { class: 'label' }, h('b', null, d.info.symbol), ` ${d.info.name}`),
        h('p', { class: 'hero-value' }, d.quote ? f.price(d.quote.price) : '–'),
        d.quote && h('p', { class: 'hero-day' }, delta(dayChange, `${f.signedMoney(dayChange)} (${f.signedPct(d.quote.price / d.quote.prevClose - 1)})`), h('span', { class: 'muted' }, ` ${d.info.exchange} · ${f.sectorName(d.info)}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => openForm({ type: 'BUY', symbol }) }, 'Al'),
          p && h('button', { class: 'btn', onclick: () => openForm({ type: 'SELL', symbol }) }, 'Sat'),
          p && h('button', { class: 'btn', onclick: () => openForm({ type: 'DIVIDEND', symbol }) }, 'Temettü'))),
      p ? h('div', { class: 'stats' },
        stat('Değer', f.money(p.value), `${f.qty(p.quantity)} adet`),
        stat('Ortalama maliyet', f.price(p.avgCost), `toplam ${f.money(p.cost)}`),
        stat('Açık kâr / zarar', f.signedMoney(p.unrealized), delta(p.unrealized, f.signedPct(p.unrealizedPct))),
        stat('Gerçekleşen', f.signedMoney(p.realized), p.dividends ? `temettü ${f.money(p.dividends)}` : null),
        stat('Portföy payı', f.pct1(p.weight), null))
        : closed && h('div', { class: 'stats' }, stat('Gerçekleşen', f.signedMoney(closed.realized), 'pozisyon kapalı'), stat('Temettü', f.money(closed.dividends), null))),
    h('div', { class: 'range-row' }, rangePicker('Dönem'), h('p', { class: 'range-summary' }, h('span', null, 'Fiyat değişimi '), delta(change, f.signedPct(change)))),
    h('div', { class: 'grid' },
      prices.length > 0 && card({
        id: 'price', title: 'Fiyat', sub: markers.length ? 'Bölünmeye göre düzeltilmiş kapanış. ▲ alış, ▼ satış.' : 'Bölünmeye göre düzeltilmiş kapanış', wide: true,
        chart: () => lineChart({ dates, series, format: f.price, axis: f.axisMoney, height: 340, label: `${symbol} fiyat grafiği`, markers }),
        table: () => seriesTable(dates, series, f.price),
      }),
      h('section', { class: 'card wide' }, h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Bu hissenin işlemleri'))), txTable(d.transactions, { withSymbol: false }))),
  ];
}

// ---------------------------------------------------------------- Çatı

function route() {
  const m = /^#\/hisse\/([A-Za-z0-9-]+)$/.exec(location.hash);
  if (m) return { name: 'symbol', symbol: m[1].toUpperCase() };
  return { name: location.hash === '#/islemler' ? 'tx' : 'home' };
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

function renderTopbar() {
  const name = route().name;
  topbar.replaceChildren(
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }), 'Portfolio Tracker'),
    h('nav', { 'aria-label': 'Ana menü' },
      h('a', { href: '#/', 'aria-current': name === 'home' ? 'page' : null }, 'Genel bakış'),
      h('a', { href: '#/islemler', 'aria-current': name === 'tx' ? 'page' : null }, 'İşlemler')),
    h('div', { class: 'top-tools' },
      state && h('span', { class: 'market' }, h('i', { class: state.marketOpen ? 'on' : '' }), state.marketOpen ? 'Borsa açık' : 'Borsa kapalı', h('span', { class: 'muted' }, ` ${f.clock(state.asOf)}`)),
      h('button', { class: `icon-btn${loading ? ' busy' : ''}`, title: 'Fiyatları yenile', 'aria-label': 'Fiyatları yenile', onclick: () => load(true) }, '↻'),
      h('button', { class: 'icon-btn', title: 'Temayı değiştir', 'aria-label': 'Temayı değiştir', onclick: () => {
        const next = isDark() ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        store.set('theme', next);
        renderTopbar();
      } }, isDark() ? '☀' : '☾'),
      state?.canLogout && h('button', { class: 'icon-btn', title: 'Çıkış yap', 'aria-label': 'Çıkış yap', onclick: async () => {
        await api.logout().catch(() => {});
        location.replace('/login.html');
      } }, '⏻'),
      h('button', { class: 'btn', disabled: !state, onclick: () => openForm({ type: 'DEPOSIT' }) }, 'Nakit ekle'),
      h('button', { class: 'btn primary', disabled: !state, onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle')));
}

function render(force = false) {
  renderTopbar();
  if (!state) {
    view.replaceChildren(loadError
      ? h('div', { class: 'banner bad' }, loadError, h('button', { class: 'link', onclick: () => load() }, 'Yeniden dene'))
      : h('p', { class: 'loading' }, 'Portföy ve fiyatlar yükleniyor…'));
    return;
  }
  // Veri değişmediyse ekrana dokunma: imleç altındaki grafik ve kaydırma konumu korunsun.
  const { asOf, ...data } = state;
  const key = location.hash + JSON.stringify(data) + (detail ? JSON.stringify(detail) : '') + loadError;
  if (!force && key === renderedKey) return;
  renderedKey = key;

  const r = route();
  const body = r.name === 'tx' ? transactionsView() : r.name === 'symbol' ? symbolView(r.symbol) : overview();
  const banners = [...state.warnings, ...(loadError ? [loadError] : [])].map((w) => h('p', { class: 'banner', role: 'status' }, w));
  // Yeniden çizimde sayfa kısalıp kaydırma konumu kaybolmasın.
  view.style.minHeight = `${view.offsetHeight}px`;
  view.replaceChildren(...banners, ...body.filter(Boolean));
  requestAnimationFrame(() => requestAnimationFrame(() => (view.style.minHeight = '')));
  document.title = r.name === 'symbol' ? `${r.symbol} · Portfolio Tracker` : r.name === 'tx' ? 'İşlemler · Portfolio Tracker' : 'Portfolio Tracker';
}

async function loadDetail() {
  const r = route();
  if (r.name !== 'symbol') {
    detail = null;
    return;
  }
  try {
    const data = await api.symbol(r.symbol);
    if (route().symbol === r.symbol) detail = { symbol: r.symbol, data };
  } catch (e) {
    if (route().symbol === r.symbol) detail = { symbol: r.symbol, error: e.message };
  }
}

let loadSeq = 0;
async function load(force = false) {
  const seq = ++loadSeq;
  loading = true;
  renderTopbar();
  try {
    const [next] = await Promise.all([api.state(force), loadDetail()]);
    // Daha yeni bir istek başladıysa eski yanıt ekranı geri sarmasın.
    if (seq !== loadSeq) return;
    state = next;
    loadError = null;
  } catch (e) {
    if (seq !== loadSeq) return;
    loadError = e.message;
  }
  loading = false;
  render();
}

window.addEventListener('hashchange', async () => {
  window.scrollTo(0, 0);
  if (route().symbol !== detail?.symbol) detail = null;
  render(true);
  view.focus({ preventScroll: true });
  if (route().name === 'symbol') {
    await loadDetail();
    render();
  }
});

let lastPoll = Date.now();
function poll() {
  const wait = state?.marketOpen ? 60_000 : 10 * 60_000;
  if (document.hidden || document.querySelector('dialog[open]') || Date.now() - lastPoll < wait) return;
  lastPoll = Date.now();
  load();
}
setInterval(poll, 15_000);
document.addEventListener('visibilitychange', poll);

render();
load();
