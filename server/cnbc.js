import { MarketError } from './market.js';

const QUOTE = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';

export async function cnbc(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MarketError('Piyasa verisi servisine ulaşılamadı.');
  }
  if (!res.ok) throw new MarketError(`Piyasa verisi servisi yanıt vermedi (HTTP ${res.status}).`);
  return res.json();
}

export const quoteUrl = (codes) => `${QUOTE}?symbols=${encodeURIComponent(codes.join('|'))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

/** Yanıttaki kotasyonlar; hiç yoksa boş dizi. */
export const quotesOf = (json) => {
  const list = json?.FormattedQuoteResult?.FormattedQuote;
  return Array.isArray(list) ? list : [];
};

export const number = (text) => {
  const s = String(text ?? '').replace(/[%,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

/** "2026-11-25T09:30:01.291-0500" → milisaniye. */
export const time = (text) => {
  const ms = Date.parse(String(text ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(ms) ? ms : null;
};
