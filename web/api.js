async function request(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.');
  }
  if (res.status === 401) {
    location.replace('/login.html');
    return new Promise(() => {});
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? 'Beklenmeyen bir hata oluştu.');
  return data;
}

const q = encodeURIComponent;
export const api = {
  state: (force) => request(`/api/state${force ? '?refresh=1' : ''}`),
  watch: (force) => request(`/api/watch${force ? '?refresh=1' : ''}`),
  watchSearch: (list, text) => request(`/api/watch/search?list=${list}&q=${q(text)}`),
  watchAdd: (list, id) => request('/api/watch/add', 'POST', { list, id }),
  watchRemove: (list, id) => request('/api/watch/remove', 'POST', { list, id }),
  watchRestore: (list, item, index) => request('/api/watch/restore', 'POST', { list, item, index }),
  search: (text) => request(`/api/search?q=${q(text)}`),
  price: (symbol, date) => request(`/api/price?symbol=${q(symbol)}&date=${q(date)}`),
  symbol: (symbol) => request(`/api/symbol?symbol=${q(symbol)}`),
  addTx: (tx) => request('/api/transactions', 'POST', tx),
  updateTx: (id, tx) => request(`/api/transactions/${id}`, 'PUT', tx),
  removeTx: (id) => request(`/api/transactions/${id}`, 'DELETE'),
  logout: () => request('/api/logout', 'POST'),
  importCsv: (csv) => request('/api/import', 'POST', { csv }),
};
