import { api } from './api.js';
import { h, newId } from './dom.js';
import * as f from './format.js';
import { icon } from './icons.js';

const LISTS = {
  stocks: { title: 'Takip Edilen Hisseler', add: 'Takip listesine ekle', hint: 'ABD borsalarındaki hisse ve ETF’leri sembol ya da adla arayın.', placeholder: 'NVDA, Tesla, VOO…', side: 'left', tickers: true },
  other: { title: 'Diğer Takip Edilenler', add: 'Takip edilenlere ekle', hint: 'Döviz, altın, kripto, emtia, endeks, hisse ya da ETF arayın.', placeholder: 'USDTRY, gram altın, ethereum…', side: 'left' },
  macro: { title: 'Makro Göstergeler', add: 'Makro göstergelere ekle', hint: 'Endeks, emtia, faiz, döviz, kripto, hisse ya da ETF arayın.', placeholder: 'altın, bitcoin, USDTRY, US5Y…', side: 'right' },
  etf: { title: 'ETFs', add: 'ETF ekle', hint: 'ABD borsalarındaki ETF’leri sembol ya da adla arayın.', placeholder: 'VOO, semiconductor…', side: 'right', tickers: true },
};

/** Piyasa panelleri. Yeniden çizilen sayfadan bağımsız, kalıcı kutulardır. */
export function createWatch({ toast }) {
  const left = h('aside', { class: 'side left', 'aria-label': 'Takip listesi' });
  const right = h('aside', { class: 'side right', 'aria-label': 'Piyasa verileri' });
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
      toast(`${entry.name} çıkarıldı.`, { action: 'Geri al', onAction: async () => {
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
          h('span', { class: 'watch-name', title: x.name }, LISTS[list].tickers ? h('a', { href: `#/hisse/${x.symbol}` }, x.name) : x.name),
          h('span', { class: 'watch-symbol' }, x.symbol, x.delayed && h('span', { title: 'Yaklaşık 10 dakika gecikmeli' }, ' · gecikmeli')),
          h('span', { class: 'watch-value' }, x.value == null ? '–' : f.watchValue(x)),
          h('span', { class: 'watch-change' }, change(x)),
          editing && h('button', { class: 'watch-remove', 'data-key': x.id, 'aria-label': `${x.name}: çıkar`, onclick: () => remove(list, x) }, icon('close', 16)))))
        : h('p', { class: 'muted watch-empty' }, data ? (list === 'stocks' ? 'Henüz hisse yok. “Ekle” ile izlemek istediğiniz hisse ve ETF’leri ekleyin.' : 'Liste boş. “Ekle” ile başlayın.') : failed ? 'Veriler alınamadı. Yeniden denenecek.' : 'Yükleniyor…'),
      items.length > 0 && data[list].asOf && h('p', { class: `watch-foot${bad ? ' bad' : ''}` }, bad ? `Güncellenemedi. Son veri ${f.clock(data[list].asOf)}` : f.clock(data[list].asOf)),
    ].filter(Boolean));
    if (focused) [...section.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focused)?.focus({ preventScroll: true });
  }

  function render() {
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
        status.textContent = found.length ? '' : `${{ etf: 'ETF', stocks: 'Hisse ya da ETF' }[list] ?? 'Sonuç'} bulunamadı. Sembolü ya da İngilizce adı deneyin.`;
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
  return { left, right, load };
}
