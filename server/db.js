import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Veri bilerek proje klasörünün dışında durur: bulut eşitlemesi (OneDrive vb.) SQLite
 * dosyasını bozabilir ve kişisel portföy verisi git deposuna karışmamalıdır.
 */
export function defaultDbPath() {
  if (process.env.PORTFOLIO_DB) return process.env.PORTFOLIO_DB;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'portfolio.db');
  const base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  return join(base, 'PortfolioTracker', 'portfolio.db');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    symbol TEXT,
    quantity REAL,
    price REAL,
    amount REAL,
    fee REAL NOT NULL DEFAULT 0,
    settle TEXT NOT NULL DEFAULT 'CASH',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS symbols (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    exchange TEXT NOT NULL,
    currency TEXT NOT NULL,
    sector TEXT,
    covered_from TEXT,
    history_at INTEGER NOT NULL DEFAULT 0,
    quote_at INTEGER NOT NULL DEFAULT 0,
    price REAL,
    prev_close REAL,
    quote_date TEXT,
    quote_time INTEGER,
    session_start INTEGER,
    session_end INTEGER
  );
  CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
    PRIMARY KEY (symbol, date)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS splits (
    symbol TEXT NOT NULL, date TEXT NOT NULL, ratio REAL NOT NULL,
    PRIMARY KEY (symbol, date)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS dividends (
    symbol TEXT NOT NULL, date TEXT NOT NULL, per_share REAL NOT NULL,
    PRIMARY KEY (symbol, date)
  ) WITHOUT ROWID;
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const TX_COLUMNS = 'id, date, type, symbol, quantity, price, amount, fee, settle, note';
const TX_FIELDS = ['date', 'type', 'symbol', 'quantity', 'price', 'amount', 'fee', 'settle', 'note'];

export class TxStore {
  constructor(db) {
    this.db = db;
  }
  all() {
    return this.db.prepare(`SELECT ${TX_COLUMNS} FROM transactions ORDER BY date, id`).all().map((r) => ({ ...r }));
  }
  get(id) {
    const row = this.db.prepare(`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ?`).get(id);
    return row ? { ...row } : null;
  }
  /** id verilirse (silmeyi geri alma) kayıt eski sırasına döner. */
  insert(tx, id = null) {
    const r = this.db
      .prepare(`INSERT INTO transactions (id, ${TX_FIELDS.join(', ')}) VALUES (?, ${TX_FIELDS.map(() => '?').join(', ')})`)
      .run(id, ...TX_FIELDS.map((f) => tx[f]));
    return Number(r.lastInsertRowid);
  }
  update(id, tx) {
    this.db
      .prepare(`UPDATE transactions SET ${TX_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...TX_FIELDS.map((f) => tx[f]), id);
  }
  remove(id) {
    this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  }
}
