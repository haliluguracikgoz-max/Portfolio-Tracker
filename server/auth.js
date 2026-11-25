import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const WINDOW = 15 * 60_000;
const MAX_FAILURES = 8;
const COOKIE = 'pt_session';
const ENV_SALT = 'portfolio-tracker-session';
// Karışabilen karakterler (0/O, 1/I/L) yok.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;

const derive = (password, salt) => scryptSync(password, salt, 32);
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/** Parolanın saklanacak özeti. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, key: derive(password, salt).toString('hex') };
}

/** İlk kurulumda isteği yapanın sunucu loglarını görebildiğini kanıtlayan tek kullanımlık kod. */
export const newSetupCode = () => Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

/**
 * Tek parolalı oturum. Çerez, paroladan türetilen anahtarla imzalanır; parola değişince
 * bütün oturumlar kendiliğinden geçersiz olur.
 */
export class Auth {
  #key = null;
  #salt = null;
  #setupCode = null;
  #failures = new Map();

  /** password: ortam değişkeni, record: veritabanındaki özet. İkisi de yoksa kurulum koduyla parola belirlenir. */
  constructor({ password, record, setupCode } = {}) {
    if (password) {
      this.#salt = ENV_SALT;
      this.#key = derive(password, ENV_SALT);
    } else if (record) this.setRecord(record);
    else this.#setupCode = setupCode ?? null;
  }

  setRecord({ salt, key }) {
    this.#salt = salt;
    this.#key = Buffer.from(key, 'hex');
    this.#setupCode = null;
  }

  get needsSetup() {
    return this.#setupCode != null;
  }

  get enabled() {
    return this.needsSetup || this.#key != null;
  }

  #sign(text) {
    return createHmac('sha256', this.#key).update(text).digest();
  }

  isValid(cookieHeader = '', now = Date.now()) {
    if (!this.enabled) return true;
    if (this.needsSetup) return false;
    const raw = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const [expires, mac] = raw?.split('.') ?? [];
    if (!/^\d{1,15}$/.test(expires ?? '') || !mac || Number(expires) < now) return false;
    return equal(Buffer.from(mac, 'base64url'), this.#sign(expires));
  }

  /** 'ok' | 'wrong' | 'blocked' */
  check(password, ip, now = Date.now()) {
    if (!this.#key) return 'wrong';
    return this.#attempt(ip, now, () => equal(derive(String(password ?? '').slice(0, MAX_PASSWORD), this.#salt), this.#key));
  }

  /** 'ok' | 'wrong' | 'blocked' */
  checkSetupCode(code, ip, now = Date.now()) {
    if (!this.needsSetup) return 'wrong';
    const given = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.#attempt(ip, now, () => equal(Buffer.from(given), Buffer.from(this.#setupCode)));
  }

  #attempt(ip, now, verify) {
    for (const [k, v] of this.#failures) if (now - v.since > WINDOW) this.#failures.delete(k);
    const entry = this.#failures.get(ip);
    if (entry && entry.count >= MAX_FAILURES) return 'blocked';
    if (verify()) {
      this.#failures.delete(ip);
      return 'ok';
    }
    this.#failures.set(ip, { since: entry?.since ?? now, count: (entry?.count ?? 0) + 1 });
    return 'wrong';
  }

  cookie(secure, now = Date.now()) {
    const expires = String(now + SESSION_DAYS * 86_400_000);
    return `${COOKIE}=${expires}.${this.#sign(expires).toString('base64url')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
