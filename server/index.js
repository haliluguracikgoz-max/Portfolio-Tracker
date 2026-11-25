import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, nyDate } from '../shared/dates.js';
import { App, HttpError } from './app.js';
import { Auth, hashPassword, MAX_PASSWORD, MIN_PASSWORD, newSetupCode } from './auth.js';
import { defaultDbPath, getSetting, openDb, setSetting } from './db.js';
import { BENCH, Market, MarketError } from './market.js';
import { Watch } from './watch.js';

const PORT = Number(process.env.PORT ?? 4517);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Barındırılan ortamda uygulama internete açıktır: parola ve kalıcı disk olmadan veri göstermez.
const HOSTED = !!process.env.RAILWAY_ENVIRONMENT_ID;
const PASSWORD = process.env.APP_PASSWORD ?? '';
const setupProblems = [];
if (HOSTED && PASSWORD && PASSWORD.length < MIN_PASSWORD) {
  setupProblems.push(`APP_PASSWORD en az ${MIN_PASSWORD} karakter olmalı.`);
}
if (HOSTED && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  setupProblems.push('Bu servise bir Volume bağlayın. Aksi hâlde her deploy’da veriler silinir.');
}

let auth = null;
let db = null;
let app = null;
let watch = null;
if (!setupProblems.length) {
  const dbPath = defaultDbPath();
  db = openDb(dbPath);
  app = new App(db, new Market(db));
  watch = new Watch(db);
  if (process.env.WATCH_IMPORT) {
    try {
      const added = watch.importOnce(process.env.WATCH_IMPORT);
      if (added) console.log(`Takip listesine aktarıldı: ${JSON.stringify(added)}`);
    } catch (e) {
      console.error(`WATCH_IMPORT aktarılamadı: ${e.message}`);
    }
  }
  console.log(`Veritabanı: ${dbPath}`);
  const setupCode = HOSTED ? newSetupCode() : null;
  auth = new Auth({ password: PASSWORD, record: getSetting(db, 'password'), setupCode });
  if (auth.needsSetup) console.log(`İlk kurulum kodu: ${setupCode}`);
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer',
    ...(HOSTED && { 'Strict-Transport-Security': 'max-age=31536000' }), ...headers,
  });
  res.end(body);
}
const json = (res, data, status = 200, headers) => send(res, status, JSON.stringify(data), undefined, headers);

async function readJson(req) {
  // JSON zorunluluğu, başka sitelerin sıradan form gönderimlerini engeller.
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON bekleniyor.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new HttpError(413, 'Dosya çok büyük.');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
}

/** Başka sitelerden gelen istekler ve (yerelde) DNS rebinding reddedilir. */
function assertSameOrigin(req) {
  const { host, origin } = req.headers;
  if (!HOSTED && ![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(host)) throw new HttpError(403, 'Erişim reddedildi.');
  if (origin && origin !== `${HOSTED ? 'https' : 'http'}://${host}`) throw new HttpError(403, 'Erişim reddedildi.');
}

const clientIp = (req) => (HOSTED && req.headers['x-real-ip']) || req.socket.remoteAddress;

function assertAttempt(result, message) {
  if (result === 'blocked') throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  if (result !== 'ok') throw new HttpError(401, message);
}

async function login(req, res) {
  const { password } = await readJson(req);
  assertAttempt(auth.check(password, clientIp(req)), 'Parola hatalı.');
  json(res, { ok: true }, 200, { 'Set-Cookie': auth.cookie(HOSTED) });
}

async function setup(req, res) {
  const { code, password } = await readJson(req);
  if (!auth.needsSetup) throw new HttpError(409, 'Parola zaten belirlenmiş.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new HttpError(400, `Parola en az ${MIN_PASSWORD} karakter olmalı.`);
  }
  assertAttempt(auth.checkSetupCode(code, clientIp(req)), 'Kurulum kodu hatalı.');
  const record = hashPassword(password);
  setSetting(db, 'password', record);
  auth.setRecord(record);
  json(res, { ok: true }, 200, { 'Set-Cookie': auth.cookie(HOSTED) });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (auth.enabled) {
    if (route === 'GET /api/auth') return json(res, { needsSetup: auth.needsSetup });
    if (route === 'POST /api/setup') return setup(req, res);
    if (route === 'POST /api/login') return login(req, res);
    if (route === 'POST /api/logout') return json(res, { ok: true }, 200, { 'Set-Cookie': auth.clearCookie() });
    if (!auth.isValid(req.headers.cookie)) throw new HttpError(401, 'Oturum açın.');
  }
  switch (route) {
    case 'GET /api/state':
      return json(res, { ...(await app.state(url.searchParams.get('refresh') === '1')), canLogout: auth.enabled });
    case 'GET /api/watch':
      return json(res, await watch.get({ force: url.searchParams.get('refresh') === '1' }));
    case 'GET /api/watch/search':
      return json(res, await watch.search(url.searchParams.get('list'), url.searchParams.get('q')));
    case 'POST /api/watch/add': {
      const { list, id } = await readJson(req);
      return json(res, await watch.add(list, id));
    }
    case 'POST /api/watch/remove': {
      const { list, id } = await readJson(req);
      return json(res, watch.remove(list, id));
    }
    case 'POST /api/watch/restore': {
      const { list, item, index } = await readJson(req);
      return json(res, watch.restore(list, item, index));
    }
    case 'GET /api/search':
      return json(res, await app.search(url.searchParams.get('q')));
    case 'GET /api/price':
      return json(res, await app.priceOn(url.searchParams.get('symbol'), url.searchParams.get('date')));
    case 'GET /api/symbol':
      return json(res, await app.symbolDetail(url.searchParams.get('symbol')));
    case 'GET /api/export':
      return send(res, 200, app.exportCsv(), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="portfolio-${nyDate()}.csv"`,
      });
    case 'POST /api/import':
      return json(res, await app.importCsv((await readJson(req)).csv));
    case 'POST /api/transactions':
      return json(res, await app.addTx(await readJson(req)), 201);
  }
  const m = /^\/api\/transactions\/(\d+)$/.exec(url.pathname);
  if (m && req.method === 'PUT') return json(res, await app.updateTx(Number(m[1]), await readJson(req)));
  if (m && req.method === 'DELETE') return json(res, app.removeTx(Number(m[1])));
  throw new HttpError(404, 'Bulunamadı.');
}

async function handleStatic(res, pathname) {
  const rel = pathname.startsWith('/shared/') ? pathname : `/web${pathname === '/' ? '/index.html' : pathname}`;
  let path;
  try {
    path = normalize(join(ROOT, decodeURIComponent(rel)));
  } catch {
    throw new HttpError(400, 'Geçersiz adres.');
  }
  const inside = ['web', 'shared'].some((d) => path.startsWith(join(ROOT, d) + sep));
  const type = MIME[extname(path)];
  if (!inside || !type) throw new HttpError(404, 'Bulunamadı.');
  let body;
  try {
    body = await readFile(path);
  } catch {
    throw new HttpError(404, 'Bulunamadı.');
  }
  send(res, 200, body, type);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return json(res, { ok: true });
    if (setupProblems.length) {
      const text = ['Portfolio Tracker henüz kurulmadı.', '', ...setupProblems.map((p) => `• ${p}`)].join('\n');
      return send(res, 503, text, 'text/plain; charset=utf-8');
    }
    assertSameOrigin(req);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') await handleStatic(res, url.pathname);
    else throw new HttpError(405, 'Desteklenmiyor.');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof MarketError ? 502 : 500;
    if (status === 500) console.error(e);
    json(res, { error: status === 500 ? 'Beklenmeyen bir hata oluştu.' : e.message }, status);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`${PORT} portu kullanımda. Uygulama zaten açık olabilir: http://localhost:${PORT}`);
    process.exit(1);
  }
  throw e;
});
// Yerelde yalnızca bu bilgisayardan erişilir.
server.listen(PORT, HOSTED ? '::' : '127.0.0.1', () => {
  console.log(`Portfolio Tracker: http://localhost:${PORT}`);
  for (const p of setupProblems) console.error(p);
  if (HOSTED) checkPriceService();
});

/** Fiyat servisi veri merkezi adreslerini engelleyebilir; durum açılışta loglara yazılır. */
async function checkPriceService() {
  const probe = new Market(openDb(':memory:'));
  try {
    await probe.ensure(BENCH, addDays(nyDate(), -30));
    const found = await probe.search('AAPL');
    console.log(`Fiyat servisi çalışıyor: ${probe.bench().length} S&P 500 kapanışı, ${found.length} arama sonucu.`);
  } catch (e) {
    console.error(`Fiyat servisi kontrolü başarısız: ${e.message}`);
  }
  if (!watch) return;
  for (const [list, { items, error }] of Object.entries(await watch.get())) {
    const ready = items.filter((x) => x.value != null).length;
    (error ? console.error : console.log)(`Piyasa paneli ${list}: ${ready}/${items.length} satır${error ? `, ${error}` : ''}`);
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
