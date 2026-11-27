import { rangeBaseDate, RANGES, monthlyReturns } from '/shared/range.js';
import { parseNumber } from '/shared/number.js';
import { api } from './api.js';
import { columnChart, legend, lineChart, sparkline, treemap } from './charts.js';
import { h } from './dom.js';
import { extPrice, SESSION_NAME } from './ext.js';
import * as f from './format.js';
import { openTxForm } from './form.js';
import { icon } from './icons.js';
import { createWatch } from './watch.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const shell = document.getElementById('shell');
const tabbar = document.getElementById('tabbar');
const toasts = document.getElementById('toasts');

let state = null;
let detail = null;
let loadError = null;
let loadingSince = 0;
let spinning = false;
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
/** Telefondaki Varlıklar görünümleri; icon ve title düğmenin götüreceği görünümü anlatır. */
const HOLDINGS_VIEWS = {
  folded: { next: 'compact', icon: 'chevron', title: 'Varlıkları göster' },
  compact: { next: 'full', icon: 'chevrons', title: 'Ayrıntıları göster' },
  full: { next: 'folded', icon: 'chevronUp', title: 'Tabloyu tek satır yap' },
};

const ui = {
  range: store.get('range', 'ALL'),
  holdingsView: Object.hasOwn(HOLDINGS_VIEWS, store.get('holdingsView', '')) ? store.get('holdingsView', '') : store.get('holdingsFull', '0') === '1' ? 'full' : 'compact',
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
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '', 'data-label': heads[i] || null }, c)))))));
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

// Piyasa panelleri geniş ekranda iki yanda, dar ekranda genel bakışın içinde durur.
const wideScreen = matchMedia('(min-width: 1440px)');
wideScreen.addEventListener('change', () => render(true));
const watch = createWatch({ toast });

/** Yan paneller, sayfanın ilk kartıyla (genel bakışta Varlıklar) aynı hizadan başlar. */
function alignPanels() {
  const card = wideScreen.matches && state && view.querySelector(':scope > .card');
  const top = card ? card.getBoundingClientRect().top - view.getBoundingClientRect().top : 28;
  shell.style.setProperty('--side-top', `${Math.max(0, top - 28)}px`);
}
new ResizeObserver(alignPanels).observe(view);

function emptyState() {
  return h('section', { class: 'empty' },
    h('h1', null, 'Portföyünüzü kurun'),
    h('p', null, 'Elinizdeki hisseleri alış tarihiyle ekleyin. Geçmiş değerler o günden bugüne otomatik hesaplanır.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle'),
      h('button', { class: 'btn', onclick: () => openForm({ type: 'ADJUST' }) }, 'Nakit düzenle'),
      importButton('btn', 'CSV’den aktar')));
}

function overview() {
  const watchInline = wideScreen.matches ? [] : [watch.left, watch.right];
  if (!state.transactions.length) return [emptyState(), ...watchInline];
  const { summary: m, positions } = state;
  return [
    h('section', { class: 'hero' },
      h('div', { class: 'hero-main' },
        h('h1', { class: 'label' }, 'Portföy değeri'),
        h('p', { class: 'hero-value' }, f.money(m.value)),
        h('p', { class: 'hero-day' }, delta(m.dayChange, `${f.signedMoney(m.dayChange)} (${f.signedPct(m.dayChangePct)})`), h('span', { class: 'muted' }, ` ${f.longDate(state.lastTradingDate)}`))),
      h('div', { class: 'stats' },
        stat('Nakit', f.money(m.cash), m.value > 0 ? `${f.pct1(m.cash / m.value)} pay` : null),
        watch.indexes)),

    positions.length > 0 && holdingsCard(),
    ...watchInline,

    h('div', { class: 'grid' },
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
  // Telefonda düğme üç görünüm arasında döner: tablo tek satır → her varlık bir satır → ayrıntılı. Geniş ekranda görünmez.
  const toggle = h('button', { class: 'icon-btn holdings-toggle', onclick: () => {
    ui.holdingsView = HOLDINGS_VIEWS[ui.holdingsView].next;
    store.set('holdingsView', ui.holdingsView);
    mark();
  } });
  const mark = () => {
    const view = HOLDINGS_VIEWS[ui.holdingsView];
    section.classList.toggle('folded', ui.holdingsView === 'folded');
    section.classList.toggle('compact', ui.holdingsView === 'compact');
    toggle.replaceChildren(icon(view.icon, 18));
    toggle.setAttribute('aria-expanded', String(ui.holdingsView !== 'folded'));
    toggle.title = view.title;
    toggle.setAttribute('aria-label', `Varlıklar: ${view.title}`);
  };
  const section = h('section', { class: 'card wide' },
    h('header', { class: 'card-head' }, h('div', null, h('h2', null, 'Varlıklar')),
      h('p', { class: 'holdings-sum' }, delta(state.summary.dayChange, f.signedPct(state.summary.dayChangePct)), h('b', null, f.money(state.summary.value))),
      h('div', { class: 'card-tools' }, h('button', { class: 'ghost', onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle'), toggle)),
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
          h('td', { class: 'c-spark' }, sparkline(p.spark, f.tone(p.spark.at(-1) - p.spark[0]))),
          h('td', { class: 'num c-a', 'data-label': 'Adet' }, f.qty(p.quantity)),
          h('td', { class: 'num c-b', 'data-label': 'Maliyet' }, f.price(p.avgCost)),
          h('td', { class: 'num c-c', 'data-label': 'Fiyat' }, f.price(p.price), extPrice(p.ext, f.price)),
          h('td', { class: 'num c-day' }, delta(p.dayChangePct, f.signedPct(p.dayChangePct)), p.ext && h('span', { class: `ext ext-pct ${f.tone(p.ext.pct)}` }, `(${f.signedPct(p.ext.pct)})`), h('small', null, f.signedMoney(p.dayChange))),
          h('td', { class: 'num strong c-value' }, f.money(p.value)),
          h('td', { class: 'num c-weight' }, f.pct1(p.weight)),
          h('td', { class: 'num c-d', 'data-label': 'Kâr / zarar' }, delta(p.unrealized, f.signedMoney(p.unrealized)), h('small', null, f.signedPct(p.unrealizedPct))),
          h('td', { class: 'row-actions' },
            h('button', { class: 'ghost', 'aria-label': `${p.symbol} al`, onclick: () => openForm({ type: 'BUY', symbol: p.symbol }) }, 'Al'),
            h('button', { class: 'ghost', 'aria-label': `${p.symbol} sat`, onclick: () => openForm({ type: 'SELL', symbol: p.symbol }) }, 'Sat')))),
        h('tr', { class: 'cash-row' },
          h('th', { scope: 'row' }, h('b', null, 'Nakit'), h('span', null, 'ABD doları')),
          h('td', { class: 'c-gap c-spark' }), h('td', { class: 'c-gap', colspan: 4 }), h('td', { class: 'num strong c-value' }, f.money(state.summary.cash)),
          h('td', { class: 'num c-weight' }, state.summary.value > 0 ? f.pct1(state.summary.cash / state.summary.value) : '–'), h('td', { class: 'c-gap' }),
          h('td', { class: 'row-actions' },
            h('button', { class: 'ghost', onclick: () => openForm({ type: 'DEPOSIT' }) }, 'Ekle'),
            h('button', { class: 'ghost', onclick: () => openForm({ type: 'WITHDRAW' }) }, 'Çek'),
            h('button', { class: 'ghost', onclick: () => openForm({ type: 'ADJUST' }) }, 'Düzenle')))))));
  mark();
  return section;
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
    ]), 'stack'));
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

/** Ana ekrana eklenmiş uygulamada indirme sayfası geri dönüşsüz açılabildiği için paylaşım menüsü kullanılır. */
async function shareCsv(e) {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone || !navigator.canShare?.({ files: [new File([''], 'a.csv', { type: 'text/csv' })] })) return;
  e.preventDefault();
  try {
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error('CSV hazırlanamadı.');
    await navigator.share({ files: [new File([await res.blob()], `portfolio-${state.lastTradingDate ?? 'islemler'}.csv`, { type: 'text/csv' })] });
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, { error: true });
  }
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
        h('td', { class: 'nowrap c-date' }, f.longDate(t.date)),
        h('td', { class: 'c-type' }, h('span', { class: `tag ${t.type.toLowerCase()}` }, f.TYPE_LABEL[t.type])),
        withSymbol && h('td', { class: `c-symbol${t.symbol ? '' : ' none'}` }, t.symbol ? h('a', { href: symbolHref(t.symbol) }, t.symbol) : '–'),
        h('td', { class: `num c-qty${trade ? '' : ' none'}`, 'data-label': 'Adet' }, trade ? f.qty(t.quantity) : '–'),
        h('td', { class: `num c-price${trade ? '' : ' none'}`, 'data-label': 'Fiyat' }, trade ? f.price(t.price) : '–'),
        h('td', { class: `num c-fee${t.fee ? '' : ' none'}`, 'data-label': 'Komisyon' }, t.fee ? f.money(t.fee) : '–'),
        h('td', { class: 'num strong c-amount' }, f.money(trade ? t.quantity * t.price : t.amount)),
        h('td', { class: 'num c-effect' }, effect ? delta(effect, f.signedMoney(effect)) : h('span', { class: 'muted' }, 'dışarıdan')),
        h('td', { class: `note-cell${t.note ? '' : ' none'}`, title: t.note || null }, t.note),
        h('td', { class: 'row-actions' },
          h('button', { class: 'ghost', onclick: () => openForm({}, t) }, 'Düzenle'),
          h('button', { class: 'ghost danger', onclick: () => removeTx(t) }, 'Sil')));
    }))));
}

function transactionsView() {
  const rows = h('div');
  const draw = () => {
    const text = ui.txText.trim().toUpperCase().replaceAll('.', '-');
    // Nakit düzeltmeleri işlem sayılmaz, listede görünmez.
    rows.replaceChildren(txTable(state.transactions.filter((t) => t.type !== 'ADJUST' && (!ui.txType || t.type === ui.txType) && (!text || (t.symbol ?? '').includes(text)))));
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
      h('a', { class: 'btn', href: '/api/export', download: '', onclick: shareCsv }, 'CSV indir'))),
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
  ]), 'scroll short stack'));
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
        d.ext && h('p', { class: 'hero-ext' }, extPrice(d.ext, f.price), h('span', { class: 'muted' }, ` ${SESSION_NAME[d.ext.session].toLocaleLowerCase('tr')}`)),
        d.quote && h('p', { class: 'hero-day' }, delta(dayChange, `${f.signedMoney(dayChange)} (${f.signedPct(d.quote.price / d.quote.prevClose - 1)})`), h('span', { class: 'muted' }, ` ${d.info.exchange} · ${f.sectorName(d.info)}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => openForm({ type: 'BUY', symbol }) }, 'Al'),
          p && h('button', { class: 'btn', onclick: () => openForm({ type: 'SELL', symbol }) }, 'Sat'))),
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

const isDark = () => document.documentElement.dataset.theme === 'dark';

// Çubuklar bir kez kurulur; her yenilemede yalnızca değişen parçaları güncellenir.
const bars = (() => {
  const link = (href, text, glyph) => h('a', { href }, glyph && icon(glyph, 22), glyph ? h('span', null, text) : text);
  const home = [link('#/', 'Genel bakış'), link('#/', 'Genel bakış', 'home')];
  const tx = [link('#/islemler', 'İşlemler'), link('#/islemler', 'İşlemler', 'list')];
  const marketDot = h('i');
  const marketText = h('span');
  const market = h('span', { class: 'market', hidden: true, title: 'Veriler 60 saniyede bir yenilenir' }, marketDot, marketText);
  const refresh = h('button', { class: 'icon-btn', title: 'Fiyatları yenile', 'aria-label': 'Fiyatları yenile', onclick: () => load({ force: true, spin: true }) }, icon('refresh'));
  const theme = h('button', { class: 'icon-btn', title: 'Temayı değiştir', 'aria-label': 'Temayı değiştir', onclick: () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    renderBars();
  } });
  const logout = h('button', { class: 'icon-btn', title: 'Çıkış yap', 'aria-label': 'Çıkış yap', hidden: true, onclick: async () => {
    await api.logout().catch(() => {});
    location.replace('/login.html');
  } }, icon('logout'));
  const add = [
    h('button', { class: 'btn', onclick: () => openForm({ type: 'ADJUST' }) }, 'Nakit düzenle'),
    h('button', { class: 'btn primary', onclick: () => openForm({ type: 'BUY' }) }, 'Hisse ekle'),
    h('button', { class: 'tab-add', onclick: () => openForm({ type: 'BUY' }) }, icon('plus', 24), h('span', null, 'Ekle')),
  ];
  topbar.append(
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }), h('span', null, 'Portfolio Tracker')),
    h('nav', { 'aria-label': 'Ana menü' }, home[0], tx[0]),
    h('div', { class: 'top-tools' }, market, refresh, theme, logout, add[0], add[1]));
  tabbar.append(home[1], add[2], tx[1]);
  return { home, tx, market, marketDot, marketText, refresh, theme, logout, add };
})();

function renderBars() {
  const name = route().name;
  for (const [links, on] of [[bars.home, name !== 'tx'], [bars.tx, name === 'tx']]) {
    for (const a of links) on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
  bars.market.hidden = !state;
  if (state) {
    bars.marketDot.className = state.marketOpen ? 'on' : '';
    bars.marketText.replaceChildren(h('span', { class: 'market-word' }, state.marketOpen ? 'Borsa açık ' : 'Borsa kapalı '), h('span', { class: 'muted' }, f.clock(state.asOf)));
  }
  bars.refresh.classList.toggle('busy', spinning);
  bars.theme.replaceChildren(icon(isDark() ? 'sun' : 'moon'));
  bars.logout.hidden = !state?.canLogout;
  for (const b of bars.add) b.disabled = !state;
}

const SCROLLERS = '.table-wrap, .holdings thead';
let renderedHash = null;
let renderTimer;
let deferredSince = 0;

/** Kullanıcı bir alana yazarken ya da grafikte değer okurken ekran altından kaymasın. */
function interacting() {
  if (view.contains(document.activeElement) && document.activeElement.matches('input, select')) return true;
  if (!view.querySelector('.tip:not([hidden])')) return false;
  deferredSince ||= Date.now();
  return Date.now() - deferredSince < 10_000;
}

function render(force = false) {
  renderBars();
  if (wideScreen.matches && watch.left.parentNode !== shell) {
    shell.prepend(watch.left);
    shell.append(watch.right);
  }
  if (!state) {
    view.replaceChildren(loadError
      ? h('div', { class: 'banner bad' }, loadError, h('button', { class: 'link', onclick: () => load() }, 'Yeniden dene'))
      : h('p', { class: 'loading' }, 'Portföy ve fiyatlar yükleniyor…'));
    return;
  }
  // Veri değişmediyse ekrana dokunma: imleç altındaki grafik ve kaydırma konumu korunsun.
  const r = route();
  const { asOf, ...data } = state;
  const shown = r.name === 'tx' ? [state.transactions, state.dividendSuggestions, state.warnings] : data;
  const key = location.hash + JSON.stringify(shown) + (detail ? JSON.stringify(detail) : '') + loadError;
  if (!force && key === renderedKey) return;
  if (!force && interacting()) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render(), 1000);
    return;
  }
  deferredSince = 0;
  const samePage = renderedHash === location.hash;
  renderedKey = key;
  renderedHash = location.hash;
  const scrolls = samePage ? [...view.querySelectorAll(SCROLLERS)].map((el) => [el.scrollLeft, el.scrollTop]) : [];

  const body = r.name === 'tx' ? transactionsView() : r.name === 'symbol' ? symbolView(r.symbol) : overview();
  const banners = [...state.warnings, ...(loadError ? [loadError] : [])].map((w) => h('p', { class: 'banner', role: 'status' }, w));
  // Yeniden çizimde sayfa kısalıp kaydırma konumu kaybolmasın.
  view.style.minHeight = `${view.offsetHeight}px`;
  view.replaceChildren(...banners, ...body.filter(Boolean));
  alignPanels();
  [...view.querySelectorAll(SCROLLERS)].forEach((el, i) => {
    if (scrolls[i]) [el.scrollLeft, el.scrollTop] = scrolls[i];
  });
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
async function load({ force = false, spin = false } = {}) {
  const seq = ++loadSeq;
  loadingSince = Date.now();
  spinning = spin;
  renderBars();
  watch.load(force);
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
  loadingSince = 0;
  spinning = false;
  render();
}

// Hisse sayfasından dönünce genel bakışta kalınan yere gidilir.
history.scrollRestoration = 'manual';
let homeScroll = 0;
window.addEventListener('scroll', () => {
  if (renderedHash === location.hash && route().name === 'home') homeScroll = window.scrollY;
}, { passive: true });

window.addEventListener('hashchange', async (e) => {
  const fromSymbol = e.oldURL.includes('#/hisse/');
  const back = fromSymbol && route().name === 'home' ? homeScroll : 0;
  if (route().symbol !== detail?.symbol) detail = null;
  render(true);
  view.focus({ preventScroll: true });
  window.scrollTo(0, back);
  // Grafikler bir sonraki karede çizilir; sayfa boyu o zaman kesinleşir.
  if (back) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, back)));
  if (route().name === 'symbol') {
    await loadDetail();
    render();
  }
});

const REFRESH_MS = 60_000;
const STALLED_MS = 90_000;
let lastPoll = Date.now();
function poll() {
  const now = Date.now();
  if (document.hidden || now - lastPoll < REFRESH_MS) return;
  if (loadingSince && now - loadingSince < STALLED_MS) return;
  lastPoll = now;
  load();
}
setInterval(poll, 1000);
// Telefon uykudan ya da başka uygulamadan dönünce beklemeden tazelenir.
document.addEventListener('visibilitychange', poll);
window.addEventListener('pageshow', poll);
window.addEventListener('online', () => {
  lastPoll = 0;
  poll();
});

render();
load({ spin: true });
