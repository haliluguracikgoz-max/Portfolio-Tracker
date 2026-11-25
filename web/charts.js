import { daysBetween } from '/shared/dates.js';
import { h, newId, s } from './dom.js';
import { dayLabel, longDate, monthLabel } from './format.js';

/** Genişliği değiştikçe yeniden çizilen kutu. */
function responsive(className, draw) {
  const box = h('div', { class: className });
  let width = 0;
  new ResizeObserver(() => {
    const w = Math.floor(box.clientWidth);
    if (!w || w === width) return;
    width = w;
    draw(box, w);
  }).observe(box);
  return box;
}

const NARROW = 480;
const fitHeight = (height, W) => (W < NARROW ? Math.min(height, 250) : height);

// Dokunmatik ekranda ipucu parmak kalkınca kaybolmaz; başka yere dokununca ya da birkaç saniye sonra kapanır.
const TOUCH_TIP_MS = 6000;
let touchTip = null;
function closeTouchTip() {
  if (!touchTip) return;
  clearTimeout(touchTip.timer);
  const { hide } = touchTip;
  touchTip = null;
  hide();
}
document.addEventListener('pointerdown', (e) => {
  if (touchTip && !touchTip.el.contains(e.target)) closeTouchTip();
}, true);

/** Fare üzerine gelince, parmak dokununca ya da sürüklenince `show(x)` çağırır. */
function scrub(svg, show, hide) {
  const at = (e) => {
    show(e.clientX - svg.getBoundingClientRect().left);
    if (e.pointerType === 'mouse') return;
    if (touchTip && touchTip.el !== svg) closeTouchTip();
    clearTimeout(touchTip?.timer);
    touchTip = { el: svg, hide, timer: setTimeout(closeTouchTip, TOUCH_TIP_MS) };
  };
  svg.addEventListener('pointerdown', at);
  svg.addEventListener('pointermove', at);
  svg.addEventListener('pointercancel', () => (touchTip?.el === svg ? closeTouchTip() : hide()));
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
}

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw - 1e-12);
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) ticks.push(k * step);
  return { ticks, step };
}

/** Çizginin kenara yapışmaması için pay; sıfıra dayanan uç yerinde kalır. */
function padded(lo, hi) {
  const pad = (hi - lo) * 0.05;
  return [lo === 0 ? 0 : lo - pad, hi === 0 ? 0 : hi + pad];
}

function dateTicks(dates, width) {
  const max = Math.max(2, Math.floor(width / 92));
  const span = daysBetween(dates[0], dates.at(-1));
  if (span <= 130) {
    const step = Math.max(1, Math.ceil(dates.length / max));
    const out = [];
    for (let i = Math.floor(step / 2); i < dates.length; i += step) out.push({ i, label: dayLabel(dates[i]) });
    return out;
  }
  const starts = dates.map((d, i) => ({ i, d })).filter(({ d, i }) => i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7));
  const every = [1, 2, 3, 4, 6, 12, 24, 60].find((n) => starts.length / n <= max) ?? 120;
  return starts
    .filter(({ d }) => ((Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1) % every) === 0)
    .map(({ i, d }) => ({ i, label: every >= 12 ? d.slice(0, 4) : monthLabel(d) }));
}

function tooltipBox() {
  const el = h('div', { class: 'tip', hidden: true });
  return {
    el,
    show(x, y, width, title, rows) {
      el.replaceChildren(
        h('div', { class: 'tip-title' }, title),
        ...rows.map((r) =>
          h('div', { class: 'tip-row' }, r.color && h('i', { class: 'key-line', style: { background: r.color } }), h('b', null, r.value), h('span', null, r.label)),
        ),
      );
      el.hidden = false;
      const w = el.offsetWidth;
      const left = x + 14 + w > width ? x - 14 - w : x + 14;
      el.style.transform = `translate(${Math.max(0, Math.min(left, width - w))}px, ${Math.max(0, y)}px)`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

export function legend(series) {
  return h('div', { class: 'legend' }, series.map((x) => h('span', null, h('i', { class: 'key-line', style: { background: x.color } }), x.label)));
}

/**
 * Zaman serisi grafiği.
 * series: [{ label, color, values, area?, step? }]   markers: [{ i, kind: 'buy'|'sell', text }]
 */
export function lineChart({ dates, series, format, axis, height = 280, label, markers = [], zero = false, endLabel = null }) {
  return responsive('chart', (box, W) => {
    const H = fitHeight(height, W);
    const M = { t: 14, r: endLabel ? 68 : 12, b: 26, l: W < NARROW ? 50 : 58 };
    const iw = Math.max(40, W - M.l - M.r);
    const ih = H - M.t - M.b;
    const n = dates.length;
    const flat = series.flatMap((x) => x.values).filter((v) => v != null);
    let lo = Math.min(...flat, ...(zero ? [0] : []));
    let hi = Math.max(...flat, ...(zero ? [0] : []));
    if (hi - lo < 1e-9) {
      const pad = Math.abs(hi) * 0.05 || 0.01;
      lo -= pad;
      hi += pad;
    }
    [lo, hi] = padded(lo, hi);
    const { ticks, step } = niceTicks(lo, hi, 4);
    const X = (i) => M.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * ih;

    const svg = s('svg', { width: W, height: H, role: 'img', 'aria-label': `${label}. Sol ve sağ ok tuşlarıyla gezinin.`, tabindex: 0 });
    for (const t of ticks) {
      svg.append(
        s('line', { x1: M.l, x2: M.l + iw, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis-line' : 'grid-line' }),
        s('text', { x: M.l - 10, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, axis(t, step)),
      );
    }
    for (const t of dateTicks(dates, iw)) {
      svg.append(s('text', { x: X(t.i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, t.label));
    }

    // Vurgulanan seri en üstte kalsın diye sondan başa çizilir.
    for (const x of [...series].reverse()) {
      let d = '';
      let pen = false;
      x.values.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        if (!pen) d += `M${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        else d += x.step ? `H${X(i).toFixed(1)}V${Y(v).toFixed(1)}` : `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      if (x.area && n > 1) {
        const id = newId('wash');
        const floor = zero ? Y(0) : M.t + ih;
        const g = s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
        g.append(s('stop', { offset: 0, 'stop-color': x.color, 'stop-opacity': zero ? 0.1 : 0.16 }), s('stop', { offset: 1, 'stop-color': x.color, 'stop-opacity': zero ? 0.1 : 0 }));
        svg.append(s('defs', null, g), s('path', { d: `${d}L${X(n - 1)},${floor}L${X(0)},${floor}Z`, fill: `url(#${id})` }));
      }
      svg.append(s('path', { d, class: 'line', stroke: x.color }));
    }

    const endY = [];
    for (const x of series) {
      const v = x.values.at(-1);
      if (v == null) continue;
      svg.append(s('circle', { cx: X(n - 1), cy: Y(v), r: 4, fill: x.color, class: 'dot' }));
      // Üst üste binecek etiket yazılmaz; lejant ve ipucu zaten aynı bilgiyi verir.
      if (endLabel && endY.every((y) => Math.abs(y - Y(v)) >= 16)) {
        endY.push(Y(v));
        svg.append(s('text', { x: X(n - 1) + 10, y: Y(v) + 4, class: 'end-label' }, endLabel(v)));
      }
    }

    for (const m of markers) {
      const v = series[0].values[m.i];
      if (v == null) continue;
      const up = m.kind === 'buy';
      const cy = Y(v) + (up ? 15 : -15);
      const path = up ? `M${X(m.i)},${cy - 7}l7,12h-14z` : `M${X(m.i)},${cy + 7}l7,-12h-14z`;
      svg.append(s('path', { d: path, class: `marker ${m.kind}` }, s('title', null, m.text)));
    }

    const cross = s('g', { class: 'cross', visibility: 'hidden' });
    const rule = s('line', { y1: M.t, y2: M.t + ih });
    const dots = series.map((x) => s('circle', { r: 4.5, fill: x.color, class: 'dot' }));
    cross.append(rule, ...dots);
    svg.append(cross);

    const tip = tooltipBox();
    let current = -1;
    const show = (i) => {
      current = Math.max(0, Math.min(n - 1, i));
      const x = X(current);
      rule.setAttribute('x1', x);
      rule.setAttribute('x2', x);
      series.forEach((ser, k) => {
        const v = ser.values[current];
        dots[k].setAttribute('visibility', v == null ? 'hidden' : 'inherit');
        if (v == null) return;
        dots[k].setAttribute('cx', x);
        dots[k].setAttribute('cy', Y(v));
      });
      cross.setAttribute('visibility', 'visible');
      const rows = series.map((ser) => ({ color: ser.color, label: ser.label, value: ser.values[current] == null ? '–' : format(ser.values[current]) }));
      for (const m of markers) if (m.i === current) rows.push({ value: m.text, label: '' });
      tip.show(x, M.t, W, longDate(dates[current]), rows);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      tip.hide();
      current = -1;
    };
    scrub(svg, (x) => show(n === 1 ? 0 : Math.round(((x - M.l) / iw) * (n - 1))), hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const move = { ArrowLeft: -1, ArrowRight: 1, PageUp: -20, PageDown: 20 }[e.key];
      if (move) {
        e.preventDefault();
        show((current < 0 ? n - 1 : current) + move);
      } else if (e.key === 'Escape') hide();
    });
    box.replaceChildren(svg, tip.el);
  });
}

/** Sıfırın üstünde ve altında sütunlar. rows: [{ label, longLabel, value }] */
export function columnChart({ rows, format, axis, height = 220, label }) {
  return responsive('chart', (box, W) => {
    const H = fitHeight(height, W);
    const M = { t: 20, r: 10, b: 26, l: W < NARROW ? 50 : 58 };
    const iw = Math.max(40, W - M.l - M.r);
    const ih = H - M.t - M.b;
    const values = rows.map((r) => r.value);
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (hi - lo < 1e-9) hi = 0.01;
    [lo, hi] = padded(lo, hi);
    const { ticks, step } = niceTicks(lo, hi, 4);
    const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * ih;
    const band = iw / rows.length;
    const bw = Math.min(24, Math.max(2, band - 2));

    const svg = s('svg', { width: W, height: H, role: 'group', 'aria-label': label });
    for (const t of ticks) {
      svg.append(
        s('line', { x1: M.l, x2: M.l + iw, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis-line' : 'grid-line' }),
        s('text', { x: M.l - 10, y: Y(t) + 4, class: 'tick', 'text-anchor': 'end' }, axis(t, step)),
      );
    }
    const every = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 58)));
    const best = values.indexOf(Math.max(...values));
    const worst = values.indexOf(Math.min(...values));
    const tip = tooltipBox();
    const cols = [];
    const clampX = (x, half) => Math.max(half, Math.min(W - half, x));
    const showCol = (i) => {
      cols.forEach((c, k) => c.classList.toggle('on', k === i));
      tip.show(M.l + band * (i + 0.5), M.t, W, rows[i].longLabel, [{ value: format(rows[i].value), label: 'getiri' }]);
    };
    const hideCol = () => {
      for (const c of cols) c.classList.remove('on');
      tip.hide();
    };

    rows.forEach((r, i) => {
      const cx = M.l + band * (i + 0.5);
      const y0 = Y(0);
      const len = Math.abs(Y(r.value) - y0);
      const rad = Math.min(4, len, bw / 2);
      const dir = r.value >= 0 ? -1 : 1;
      const tipY = y0 + dir * len;
      const l = cx - bw / 2;
      const rr = cx + bw / 2;
      const d = `M${l},${y0}V${tipY - dir * rad}Q${l},${tipY} ${l + rad},${tipY}H${rr - rad}Q${rr},${tipY} ${rr},${tipY - dir * rad}V${y0}Z`;
      cols.push(
        s(
          'g',
          { class: 'col', tabindex: 0, role: 'img', 'aria-label': `${r.longLabel}: ${format(r.value)}`, onfocus: () => showCol(i), onblur: hideCol },
          s('path', { d, class: r.value >= 0 ? 'fill-gain' : 'fill-loss' }),
        ),
      );
      svg.append(cols[i]);
      if (i % every === Math.floor((rows.length - 1) % every)) svg.append(s('text', { x: clampX(cx, 20), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, r.label));
      if ((i === best && r.value > 0) || (i === worst && r.value < 0)) {
        svg.append(s('text', { x: clampX(cx, 26), y: tipY + (dir < 0 ? -6 : 14), class: 'end-label', 'text-anchor': 'middle' }, format(r.value)));
      }
    });
    scrub(svg, (x) => showCol(Math.max(0, Math.min(rows.length - 1, Math.floor((x - M.l) / band)))), hideCol);
    box.replaceChildren(svg, tip.el);
  });
}

export function sparkline(values, tone) {
  const W = 92;
  const H = 28;
  if (values.length < 2) return h('span', { class: 'muted' }, '–');
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (W - 6) + 3).toFixed(1)},${(H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1)}`);
  const [ex, ey] = pts.at(-1).split(',');
  return s('svg', { width: W, height: H, class: `spark ${tone}`, 'aria-hidden': 'true' }, s('polyline', { points: pts.join(' ') }), s('circle', { cx: ex, cy: ey, r: 2.5 }));
}

/** Kareye en yakın dikdörtgenlerle bölme (squarified treemap). items değere göre azalan olmalı. */
export function squarify(items, W, H) {
  const total = items.reduce((a, b) => a + b.value, 0);
  const out = [];
  if (!(total > 0)) return out;
  const areas = items.map((it) => (it.value / total) * W * H);
  let x = 0, y = 0, w = W, hh = H, i = 0;
  while (i < items.length) {
    const side = Math.min(w, hh);
    const worst = (sum, min, max) => Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
    let j = i + 1;
    let sum = areas[i];
    while (j < items.length && worst(sum + areas[j], areas[j], areas[i]) <= worst(sum, areas[j - 1], areas[i])) sum += areas[j++];
    const thick = sum / side;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = areas[k] / thick;
      out.push(w >= hh ? { item: items[k], x, y: y + off, w: thick, h: len } : { item: items[k], x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= hh) { x += thick; w -= thick; } else { y += thick; hh -= thick; }
    i = j;
  }
  return out;
}

/** items: [{ key, value, change, href, title, rows }] */
export function treemap({ items, height, format }) {
  return responsive('chart treemap', (box, W) => {
    const tip = tooltipBox();
    const tiles = squarify(items, W, height).map((t) => {
      const { item } = t;
      const strength = Math.min(1, Math.abs(item.change) / 0.04);
      const cls = item.change >= 0 ? 'up' : 'down';
      const size = Math.min(26, Math.max(11, Math.sqrt(t.w * t.h) / 7), (t.w - 8) / (item.key.length * 0.68));
      const named = size >= 9 && t.h > 20;
      const show = (e) => e.pointerType !== 'touch' && tip.show(t.x + t.w / 2, t.y + Math.min(12, t.h / 2), W, item.title, item.rows);
      return h(
        'a',
        {
          href: item.href, class: `tile ${cls}`, 'aria-label': `${item.key} ${format(item.change)}`,
          style: { left: `${t.x + 1}px`, top: `${t.y + 1}px`, width: `${Math.max(0, t.w - 2)}px`, height: `${Math.max(0, t.h - 2)}px`, '--k': strength.toFixed(3) },
          onpointerenter: show, onfocus: show, onpointerleave: () => tip.hide(), onblur: () => tip.hide(),
        },
        named && h('b', { style: { 'font-size': `${size}px` } }, item.key),
        named && t.w > 60 && t.h > 40 && h('span', null, format(item.change)),
      );
    });
    box.style.height = `${height}px`;
    box.replaceChildren(...tiles, tip.el);
  });
}
