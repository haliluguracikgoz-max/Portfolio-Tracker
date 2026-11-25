import { nyDate } from '/shared/dates.js';
import { parseNumber } from '/shared/number.js';
import { api } from './api.js';
import { h, newId } from './dom.js';
import { icon } from './icons.js';
import { inputNumber, longDate, money, price as fmtPrice, qty as fmtQty } from './format.js';

const TYPES = [
  ['BUY', 'Hisse al'], ['SELL', 'Hisse sat'], ['DEPOSIT', 'Nakit ekle'], ['WITHDRAW', 'Nakit çek'],
  ['DIVIDEND', 'Temettü'], ['INTEREST', 'Faiz'], ['FEE', 'Ücret'],
];
const SUBMIT = {
  BUY: 'Alışı kaydet', SELL: 'Satışı kaydet', DEPOSIT: 'Nakit ekle', WITHDRAW: 'Nakit çek', DIVIDEND: 'Temettüyü kaydet', INTEREST: 'Faizi kaydet', FEE: 'Ücreti kaydet',
};

/**
 * İşlem ekleme / düzenleme penceresi.
 * preset: { type, symbol, ... }  edit: mevcut işlem  onSaved(message) kayıttan sonra çağrılır.
 */
export function openTxForm({ state, preset = {}, edit = null, onSaved }) {
  const init = edit ?? preset;
  const positions = state?.positions ?? [];
  const cash = state?.summary.cash ?? 0;
  let type = init.type ?? 'BUY';
  let priceTouched = edit != null;
  let priceInfo = null;
  let lookup = 0;

  const field = (label, control, hint) => {
    control.id ||= newId('f');
    return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint);
  };
  // Dokunmatik ekranda alanı kendiliğinden seçmek klavyeyi açıp formu örter.
  const touch = matchMedia('(pointer: coarse)').matches;
  const focus = (el) => touch || el.focus();
  const decimal = (value) => h('input', { inputmode: 'decimal', autocomplete: 'off', value: inputNumber(value), placeholder: '0,00' });

  const date = h('input', { type: 'date', max: nyDate(), min: '1970-01-01', required: true, value: init.date ?? nyDate() });
  const symbol = h('input', { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'AAPL ya da şirket adı', value: init.symbol ?? '', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list' });
  const quantity = decimal(init.quantity);
  const price = decimal(init.price);
  const amount = decimal(init.amount);
  const fee = decimal(init.fee || null);
  const note = h('input', { maxlength: 500, autocomplete: 'off', value: init.note ?? '' });

  const list = h('div', { class: 'suggest', role: 'listbox', hidden: true, id: newId('list') });
  symbol.setAttribute('aria-controls', list.id);
  const symbolHint = h('p', { class: 'hint' });
  const priceHint = h('p', { class: 'hint' });
  const qtyHint = h('p', { class: 'hint' });
  const symbolField = field('Hisse', symbol, symbolHint);
  symbolField.classList.add('wide', 'combo');
  symbol.after(list);
  const quantityField = field('Adet', quantity, qtyHint);
  const priceField = field('Birim fiyat ($)', price, priceHint);
  const feeField = field('Komisyon ($)', fee);
  const amountField = field('Tutar ($)', amount);
  const dateField = field('Tarih', date);
  const noteField = field('Not (isteğe bağlı)', note);
  noteField.classList.add('wide');

  const settleName = newId('settle');
  const radio = (value) => h('input', { type: 'radio', name: settleName, value });
  const viaCash = radio('CASH');
  const viaExternal = radio('EXTERNAL');
  const cashText = h('span');
  const externalText = h('span');
  const settleField = h('fieldset', { class: 'settle wide' }, h('legend', null, 'Para hareketi'), h('label', null, viaCash, cashText), h('label', null, viaExternal, externalText));
  // Nakit takibi yapmayan kullanıcı ilk alımda "yetersiz nakit" hatasına takılmasın.
  if (edit ? edit.settle === 'EXTERNAL' : type === 'BUY' && cash <= 0.005) viaExternal.checked = true;
  else viaCash.checked = true;

  const preview = h('div', { class: 'preview wide', 'aria-live': 'polite' });
  const error = h('p', { class: 'error wide', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' });
  const tabs = h('div', { class: 'type-tabs wide', role: 'group', 'aria-label': 'İşlem türü' });

  const isTrade = () => type === 'BUY' || type === 'SELL';
  const cleanSymbol = () => symbol.value.trim().toUpperCase().replaceAll('.', '-');
  const held = () => positions.find((p) => p.symbol === cleanSymbol());

  function renderType() {
    tabs.replaceChildren(
      ...TYPES.map(([key, label]) =>
        h('button', { type: 'button', class: 'chip', 'aria-pressed': String(key === type), onclick: () => {
          type = key;
          renderType();
          focus(isTrade() || type === 'DIVIDEND' ? symbol : amount);
        } }, label),
      ),
    );
    symbolField.hidden = !(isTrade() || type === 'DIVIDEND');
    quantityField.hidden = priceField.hidden = feeField.hidden = settleField.hidden = !isTrade();
    amountField.hidden = isTrade();
    cashText.textContent = type === 'SELL' ? 'Satış tutarını portföy nakdine ekle' : 'Portföy nakdinden öde';
    externalText.textContent = type === 'SELL' ? 'Portföyden dışarı çıktı, nakde ekleme' : 'Dışarıdan ödendi, nakde dokunma';
    submit.textContent = edit ? 'Değişikliği kaydet' : SUBMIT[type];
    error.hidden = true;
    closeList();
    updateHints();
  }

  function updateHints() {
    const p = held();
    symbolHint.textContent = p ? `${p.name} · elde ${fmtQty(p.quantity)} adet` : priceInfo?.symbol === cleanSymbol() ? priceInfo.name : '';
    const info = priceInfo?.symbol === cleanSymbol() && priceInfo.date === date.value ? priceInfo : null;
    priceHint.textContent = info?.price ? `${longDate(info.priceDate)} ${info.priceDate === nyDate() ? 'fiyatı' : 'kapanışı'}: ${fmtPrice(Number(info.price.toFixed(info.price >= 1 ? 2 : 4)))}` : '';
    if (info?.price && !priceTouched) price.value = inputNumber(Number(info.price.toFixed(info.price >= 1 ? 2 : 4)));

    const q = parseNumber(quantity.value);
    qtyHint.replaceChildren();
    if (isTrade() && info && info.factor !== 1 && q > 0) {
      qtyHint.append(`Sonradan bölündü: bugünkü karşılığı ${fmtQty(q * info.factor)} adet. Alım günündeki adedi girin.`);
    } else if (type === 'SELL' && p && !edit) {
      qtyHint.append(h('button', { type: 'button', class: 'link', onclick: () => {
        quantity.value = inputNumber(p.quantity / (info?.factor ?? 1));
        updateHints();
      } }, `Tümünü sat (${fmtQty(p.quantity)})`));
    }
    updatePreview();
  }

  function updatePreview() {
    const cell = (label, value) => h('div', null, h('span', null, label), h('b', null, value));
    const cells = [];
    let delta = null;
    if (isTrade()) {
      const q = parseNumber(quantity.value);
      const p = parseNumber(price.value);
      const f = parseNumber(fee.value) ?? 0;
      if (q > 0 && p > 0 && f >= 0) {
        const total = type === 'BUY' ? q * p + f : q * p - f;
        cells.push(cell(type === 'BUY' ? 'Toplam maliyet' : 'Ele geçen', money(total)));
        delta = viaCash.checked ? (type === 'BUY' ? -total : total) : 0;
      }
    } else {
      const a = parseNumber(amount.value);
      if (a > 0) delta = type === 'WITHDRAW' || type === 'FEE' ? -a : a;
    }
    if (delta != null && !edit) {
      const after = cash + delta;
      cells.push(cell('İşlem sonrası nakit', money(after)));
      preview.classList.toggle('short', after < -0.005);
      if (after < -0.005) cells.push(h('p', null, isTrade() ? 'Portföydeki nakit yetmiyor. “Dışarıdan ödendi” seçeneğini kullanın ya da önce nakit ekleyin.' : 'Portföydeki nakit yetmiyor.'));
    }
    preview.replaceChildren(...cells);
    preview.hidden = cells.length === 0;
  }

  // --- Sembol arama ---
  let options = [];
  let active = -1;
  let timer;
  function closeList() {
    clearTimeout(timer);
    list.hidden = true;
    symbol.setAttribute('aria-expanded', 'false');
    active = -1;
  }
  function pick(o) {
    symbol.value = o.symbol;
    lookup++;
    closeList();
    fetchPrice();
    (quantityField.hidden ? amount : quantity).focus();
  }
  function showOptions(items) {
    options = items;
    active = -1;
    list.replaceChildren(
      ...items.map((o) =>
        h('button', { type: 'button', role: 'option', tabindex: -1, 'aria-selected': 'false', onpointerdown: (e) => e.preventDefault(), onclick: () => pick(o) },
          h('b', null, o.symbol), h('span', null, o.name), h('small', null, o.kind === 'ETF' ? 'ETF' : (o.exchange ?? ''))),
      ),
    );
    list.hidden = !items.length;
    symbol.setAttribute('aria-expanded', String(items.length > 0));
  }
  const mine = (text) =>
    positions
      .filter((p) => !text || p.symbol.startsWith(text.toUpperCase()) || p.name.toLocaleLowerCase('tr').includes(text.toLocaleLowerCase('tr')))
      .map((p) => ({ symbol: p.symbol, name: p.name, kind: p.kind, exchange: 'Portföyde' }));
  symbol.addEventListener('input', () => {
    const text = symbol.value.trim();
    priceTouched = false;
    price.value = '';
    updateHints();
    clearTimeout(timer);
    const token = ++lookup;
    if (type !== 'BUY') return showOptions(mine(text));
    if (!text) return closeList();
    timer = setTimeout(async () => {
      try {
        const found = await api.search(text);
        if (token === lookup && document.activeElement === symbol) showOptions(found);
      } catch {
        // Arama yardımcıdır; sembol elle yazılabilir.
      }
    }, 220);
  });
  symbol.addEventListener('focus', () => {
    if (type !== 'BUY' && !symbol.value) showOptions(mine(''));
  });
  symbol.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      [...list.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
      list.children[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList();
    }
  });
  symbol.addEventListener('blur', () => {
    // Dokunulan öneri, liste kapanmadan seçilebilsin.
    setTimeout(() => document.activeElement === symbol || closeList(), 200);
    symbol.value = symbol.value.trim().toUpperCase();
    fetchPrice();
  });

  let priceToken = 0;
  async function fetchPrice() {
    const sym = cleanSymbol();
    const day = date.value;
    if (!sym || !day || symbolField.hidden) return;
    if (priceInfo?.symbol === sym && priceInfo.date === day) return updateHints();
    const token = ++priceToken;
    try {
      const info = await api.price(sym, day);
      if (token === priceToken) priceInfo = { ...info, date: day };
    } catch {
      if (token === priceToken) priceInfo = null;
    }
    if (token === priceToken) updateHints();
  }
  date.addEventListener('change', fetchPrice);
  price.addEventListener('input', () => {
    priceTouched = price.value.trim() !== '';
  });
  for (const el of [quantity, price, fee, amount, viaCash, viaExternal]) el.addEventListener('input', updateHints);

  const form = h('form', { novalidate: true },
    h('div', { class: 'dialog-head' }, h('h2', null, edit ? 'İşlemi düzenle' : 'İşlem ekle'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Kapat', onclick: () => dialog.close() }, icon('close'))),
    h('div', { class: 'form-grid' }, tabs, symbolField, dateField, quantityField, priceField, amountField, feeField, settleField, noteField, preview, error),
    h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Vazgeç'), submit),
  );
  const dialog = h('dialog', { class: 'sheet', 'aria-label': 'İşlem' }, form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.hidden = true;
    const body = {
      type, date: date.value, symbol: cleanSymbol(), quantity: quantity.value, price: price.value, amount: amount.value, fee: fee.value,
      settle: viaExternal.checked ? 'EXTERNAL' : 'CASH', note: note.value,
    };
    try {
      if (edit) await api.updateTx(edit.id, body);
      else await api.addTx(body);
      dialog.close();
      onSaved(edit ? 'İşlem güncellendi.' : 'İşlem kaydedildi.');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
    }
  });
  // Telefonda klavye açılınca form, klavyenin üstünde kalan alana sığar.
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
    viewport?.removeEventListener('resize', fit);
    viewport?.removeEventListener('scroll', fit);
    dialog.remove();
  });
  document.body.append(dialog);
  renderType();
  dialog.showModal();
  focus(symbolField.hidden ? amount : symbol.value ? quantity : symbol);
  fetchPrice();
}
