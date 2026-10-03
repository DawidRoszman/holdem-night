'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// checked against for unknown usernames, so a failed login takes as long either way
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Sessions are looked up by a hash of the token, so a leaked database holds no usable tokens.
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Users, login sessions and chip balances in SQLite. Every balance change is
 * written to the `transactions` table in the same database transaction.
 */
class Store {
  constructor(path = ':memory:', { welcomeChips = 1000, now = () => Date.now() } = {}) {
    this.db = new DatabaseSync(path);
    this.welcomeChips = welcomeChips;
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        chips         INTEGER NOT NULL DEFAULT 0 CHECK (chips >= 0),
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        balance    INTEGER NOT NULL,
        note       TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql = {
      insertUser: this.db.prepare('INSERT INTO users (username, password_hash, chips, created_at) VALUES (?, ?, 0, ?)'),
      userByName: this.db.prepare('SELECT * FROM users WHERE username = ?'),
      userById: this.db.prepare('SELECT id, username, chips FROM users WHERE id = ?'),
      insertSession: this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
      session: this.db.prepare(`
        SELECT u.id, u.username, u.chips FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      purgeSessions: this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      // the WHERE clause makes an overdraft a no-op instead of a negative balance
      adjust: this.db.prepare('UPDATE users SET chips = chips + ? WHERE id = ? AND chips + ? >= 0'),
      insertTx: this.db.prepare(
        'INSERT INTO transactions (user_id, kind, amount, balance, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      history: this.db.prepare(
        'SELECT kind, amount, balance, note, created_at AS createdAt FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      ),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async register(username, password) {
    const hash = await hashPassword(password);
    return this.transaction(() => {
      if (this.sql.userByName.get(username)) throw new AccountError(409, 'That username is taken');
      const { lastInsertRowid } = this.sql.insertUser.run(username, hash, this.now());
      const id = Number(lastInsertRowid);
      if (this.welcomeChips > 0) this.applyChange(id, this.welcomeChips, 'welcome', 'Welcome bonus');
      return this.user(id);
    });
  }

  // Returns the user for a correct username/password pair, otherwise null.
  async authenticate(username, password) {
    const row = this.sql.userByName.get(username);
    const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
    return row && ok ? this.user(row.id) : null;
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sql.purgeSessions.run(this.now());
    this.sql.insertSession.run(tokenHash(token), userId, this.now() + SESSION_TTL_MS);
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    return this.sql.session.get(tokenHash(token), this.now()) || null;
  }

  deleteSession(token) {
    this.sql.deleteSession.run(tokenHash(token));
  }

  user(id) {
    const row = this.sql.userById.get(id);
    return row ? { id: row.id, username: row.username, chips: row.chips } : null;
  }

  // Adds (or with a negative amount removes) chips; fails rather than going below zero.
  changeChips(userId, amount, kind, note = null) {
    if (!Number.isSafeInteger(amount) || amount === 0) throw new AccountError(400, 'Amount must be a non-zero whole number');
    return this.transaction(() => this.applyChange(userId, amount, kind, note));
  }

  applyChange(userId, amount, kind, note) {
    if (!this.user(userId)) throw new AccountError(404, 'No such user');
    const { changes } = this.sql.adjust.run(amount, userId, amount);
    if (changes === 0) throw new AccountError(409, 'Not enough chips in your bank');
    const { chips } = this.user(userId);
    this.sql.insertTx.run(userId, kind, amount, chips, note, this.now());
    return chips;
  }

  history(userId, limit = 20) {
    return this.sql.history.all(userId, limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, AccountError, hashPassword, verifyPassword };
