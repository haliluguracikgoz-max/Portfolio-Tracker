import { api } from './api.js';
import { h, newId } from './dom.js';
import * as f from './format.js';
import { icon } from './icons.js';

const LISTS = {
  stocks: { title: 'Takip Edilen Hisseler', add: 'Takip listesine ekle', hint: 'ABD borsalarındaki hisse ve ETF’leri sembol ya da adla arayın.', placeholder: 'NVDA, Tesla, VOO…', side: 'left', tickers: true },
  other: { title: 'Diğer Takip Edilenler', add: 'Takip edilenlere ekle', hint: 'Döviz, altın, kripto, emtia, endeks, hisse ya da ETF arayın.', placeholder: 'USDTRY, gram altın, ethereum…', side: 'left' },
  macro: { title: 'Makro Göstergeler', add: 'Makro göstergelere ekle', hint: 'Endeks, emtia, faiz, döviz, kripto, hisse ya da ETF arayın.', placeholder: 'altın, bitcoin, USDTRY, US5Y…', side: 'right' },
  etf: { title: 'ETFs', add: 'ETF ekle', hint: 'ABD borsalarındaki ETF’leri sembol ya da adla arayın.', placeholder: 'VOO, semiconductor…', side: 'right', tickers: true },
  sector: { title: 'Diğer Sektör ETF’leri', add: 'Sektör ETF’si ekle', hint: 'ABD borsalarındaki ETF’leri sembol ya da adla arayın.', placeholder: 'XLK, semiconductor…', side: 'right', symbolFirst: true },
};

/** Satırın koyu yazılan adı; sektör listesinde sembol öndedir, altında sektör yazar. */
const heading = (list, x) => (LISTS[list].symbolFirst ? x.symbol : x.name);

/** Piyasa panelleri. Yeniden çizilen sayfadan bağımsız, kalıcı kutulardır. */
export function createWatch({ toast }) {
  const left = h('aside', { class: 'side left', 'aria-label': 'Takip listesi' });
  const right = h('aside', { class: 'side right', 'aria-label': 'Piyasa verileri' });
  const indexes = ['S&P 500', 'Nasdaq', 'Nasdaq 100'].map((name) => h('div', { class: 'stat' }, h('span', { class: 'label' }, `${name} günlük`), h('span', { class: 'value' }, '–'), h('span', { class: 'note' })));
  const sections = {};
  for (const [key, { side, tickers }] of Object.entries(LISTS)) {
    sections[key] = h('section', { class: `watch ${key}${tickers ? ' tickers' : ''}`, 'aria-labelledby': `watch-${key}` });
    (side === 'left' ? left : right).append(sections[key]);
  }
  // Ekrandan uzun panel sayfayla birlikte kayar, sonuna gelince durur; içinde ayrı kaydırma çubuğu olmaz.
  const stick = () => {
    for (const side of [left, right]) side.style.setProperty('--stick', `${Math.min(64, window.innerHeight - side.offsetHeight)}px`);
  };
  const resized = new ResizeObserver(stick);
  resized.observe(left);
  resized.observe(right);
  window.addEventListener('resize', stick);
  const removing = new Set();
  let data = null;
  let failed = false;
  // Ekleme/çıkarma sırasında yola çıkmış eski bir yanıt, yeni listeyi geri almasın.
  let version = 0;

  function apply(next) {
    version++;
    data = next;
    failed = false;
    render();
  }

  async function remove(list, entry) {
    const index = data[list].items.findIndex((x) => x.id === entry.id);
    try {
      apply(await api.watchRemove(list, entry.id));
      toast(`${heading(list, entry)} çıkarıldı.`, { action: 'Geri al', onAction: async () => {
        try {
          apply(await api.watchRestore(list, entry, index));
        } catch (e) {
          toast(e.message, { error: true });
        }
      } });
    } catch (e) {
      toast(`Çıkarılamadı. ${e.message}`, { error: true });
    }
  }

  const change = (x) => {
    if (x.change == null) return null;
    const flat = Math.abs(x.change) < 1e-9;
    return h('span', { class: `delta ${f.tone(x.change)}` }, flat ? '' : x.change > 0 ? '▲ ' : '▼ ', f.watchChange(x));
  };

  function renderList(list) {
    const { title } = LISTS[list];
    const items = data?.[list].items ?? [];
    if (!items.length) removing.delete(list);
    const editing = removing.has(list);
    const bad = failed || data?.[list].error;
    const section = sections[list];
    section.classList.toggle('editing', editing);
    const focused = section.contains(document.activeElement) ? document.activeElement.dataset.key : null;

    section.replaceChildren(...[
      h('header', { class: 'watch-head' }, h('h2', { id: `watch-${list}` }, title),
        data && h('div', { class: 'watch-tools' },
          h('button', { class: 'ghost', 'data-key': 'add', 'aria-label': `${title}: ekle`, onclick: () => openAdd(list) }, 'Ekle'),
          items.length > 0 && h('button', { class: 'ghost', 'data-key': 'edit', 'aria-pressed': String(editing), 'aria-label': `${title}: ${editing ? 'bitti' : 'çıkar'}`, onclick: () => {
            if (editing) removing.delete(list);
            else removing.add(list);
            renderList(list);
          } }, editing ? 'Bitti' : 'Çıkar'))),
      items.length
        ? h('ul', null, items.map((x) => h('li', null,
          h('span', { class: 'watch-name', title: heading(list, x) }, LISTS[list].tickers || LISTS[list].symbolFirst ? h('a', { href: `#/hisse/${x.symbol}` }, heading(list, x)) : x.name),
          h('span', { class: 'watch-symbol' }, LISTS[list].symbolFirst ? x.name : x.symbol, x.delayed && h('span', { title: 'Yaklaşık 10 dakika gecikmeli' }, ' · gecikmeli')),
          h('span', { class: 'watch-value' }, x.value == null ? '–' : f.watchValue(x)),
          h('span', { class: 'watch-change' }, change(x)),
          editing && h('button', { class: 'watch-remove', 'data-key': x.id, 'aria-label': `${heading(list, x)}: çıkar`, onclick: () => remove(list, x) }, icon('close', 16)))))
        : h('p', { class: 'muted watch-empty' }, data ? (list === 'stocks' ? 'Henüz hisse yok. “Ekle” ile izlemek istediğiniz hisse ve ETF’leri ekleyin.' : 'Liste boş. “Ekle” ile başlayın.') : failed ? 'Veriler alınamadı. Yeniden denenecek.' : 'Yükleniyor…'),
      items.length > 0 && data[list].asOf && h('p', { class: `watch-foot${bad ? ' bad' : ''}` }, bad ? `Güncellenemedi. Son veri ${f.clock(data[list].asOf)}` : f.clock(data[list].asOf)),
    ].filter(Boolean));
    if (focused) [...section.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focused)?.focus({ preventScroll: true });
  }

  function renderIndexes() {
    if (!data) return;
    const { items, asOf, error } = data.index;
    indexes.forEach((el, i) => {
      const x = items[i];
      const [, value, note] = el.children;
      value.replaceChildren(x.changePct == null ? '–' : change(x));
      note.textContent = (failed || error) && asOf ? `Son veri ${f.clock(asOf)}` : x.value == null ? '' : f.watchValue(x);
    });
  }

  function render() {
    renderIndexes();
    for (const list of Object.keys(LISTS)) renderList(list);
  }

  async function load(force) {
    const started = version;
    try {
      const next = await api.watch(force);
      if (started !== version) return;
      data = next;
      failed = false;
    } catch {
      if (started !== version) return;
      failed = true;
    }
    render();
  }

  function openAdd(list) {
    const { add, hint, placeholder } = LISTS[list];
    const input = h('input', { type: 'search', id: newId('watch-q'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', placeholder });
    const results = h('ul', { class: 'watch-results' });
    const status = h('p', { class: 'hint', role: 'status' }, hint);
    const error = h('p', { class: 'error', role: 'alert', hidden: true });
    let timer;
    let token = 0;

    const row = (r) => {
      const button = h('button', { type: 'button', class: 'btn', 'aria-label': `${r.name}: ekle` });
      const mark = (done) => {
        button.disabled = done;
        button.textContent = done ? 'Eklendi' : 'Ekle';
      };
      mark(r.added);
      button.addEventListener('click', async () => {
        error.hidden = true;
        button.disabled = true;
        try {
          apply(await api.watchAdd(list, r.id));
          mark(true);
        } catch (e) {
          mark(false);
          error.textContent = e.message;
          error.hidden = false;
        }
      });
      return h('li', null, h('div', null, h('b', null, r.symbol), h('span', null, r.name)), h('small', null, [r.kind, r.exchange].filter(Boolean).join(' · ')), button);
    };

    async function search() {
      const text = input.value.trim();
      const mine = ++token;
      error.hidden = true;
      if (!text) {
        results.replaceChildren();
        status.textContent = hint;
        return;
      }
      status.textContent = 'Aranıyor…';
      try {
        const found = await api.watchSearch(list, text);
        if (mine !== token) return;
        results.replaceChildren(...found.map(row));
        status.textContent = found.length ? '' : `${{ etf: 'ETF', sector: 'ETF', stocks: 'Hisse ya da ETF' }[list] ?? 'Sonuç'} bulunamadı. Sembolü ya da İngilizce adı deneyin.`;
      } catch (e) {
        if (mine !== token) return;
        results.replaceChildren();
        status.textContent = '';
        error.textContent = e.message;
        error.hidden = false;
      }
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    });

    const form = h('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      clearTimeout(timer);
      search();
    } },
    h('div', { class: 'dialog-head' }, h('h2', null, add), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Kapat', onclick: () => dialog.close() }, icon('close'))),
    h('div', { class: 'watch-body' }, h('div', { class: 'field' }, h('label', { for: input.id }, 'Ara'), input), status, error, results),
    h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Kapat')));
    const dialog = h('dialog', { class: 'sheet watch-sheet', 'aria-label': add }, form);
    const viewport = window.visualViewport;
    const fit = () => {
      dialog.style.setProperty('--vv-top', `${viewport.offsetTop}px`);
      dialog.style.setProperty('--vv-height', `${viewport.height}px`);
    };
    if (viewport) {
      fit();
      viewport.addEventListener('resize', fit);
      viewport.addEventListener('scroll', fit);
    }
    dialog.addEventListener('close', () => {
      token++;
      clearTimeout(timer);
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  }

  render();
  return { left, right, indexes, load };
}
