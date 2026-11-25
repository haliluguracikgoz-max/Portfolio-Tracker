import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const WINDOW = 15 * 60_000;
const MAX_FAILURES = 8;
const COOKIE = 'pt_session';
export const MIN_PASSWORD = 10;

const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Tek parolalı oturum. Çerez, paroladan türetilen anahtarla imzalanır; parola değişince
 * bütün oturumlar kendiliğinden geçersiz olur.
 */
export class Auth {
  #key;
  #failures = new Map();

  constructor(password) {
    this.enabled = !!password;
    if (password) this.#key = scryptSync(password, 'portfolio-tracker-session', 32);
  }

  #sign(text) {
    return createHmac('sha256', this.#key).update(text).digest();
  }

  isValid(cookieHeader = '', now = Date.now()) {
    if (!this.enabled) return true;
    const raw = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const [expires, mac] = raw?.split('.') ?? [];
    if (!/^\d{1,15}$/.test(expires ?? '') || !mac || Number(expires) < now) return false;
    return equal(Buffer.from(mac, 'base64url'), this.#sign(expires));
  }

  /** 'ok' | 'wrong' | 'blocked' */
  check(password, ip, now = Date.now()) {
    for (const [k, v] of this.#failures) if (now - v.since > WINDOW) this.#failures.delete(k);
    const entry = this.#failures.get(ip);
    if (entry && entry.count >= MAX_FAILURES) return 'blocked';
    const given = scryptSync(String(password ?? '').slice(0, 256), 'portfolio-tracker-session', 32);
    if (equal(given, this.#key)) {
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
