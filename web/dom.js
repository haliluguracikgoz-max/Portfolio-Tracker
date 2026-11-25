const SVG_NS = 'http://www.w3.org/2000/svg';

function fill(el, props, children) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  // Metin her zaman düğüm olarak eklenir; dış kaynaklı adlar HTML olarak yorumlanamaz.
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export const h = (tag, props, ...children) => fill(document.createElement(tag), props, children);
export const s = (tag, props, ...children) => fill(document.createElementNS(SVG_NS, tag), props, children);

let uid = 0;
export const newId = (prefix) => `${prefix}-${++uid}`;
