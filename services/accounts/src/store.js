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
      CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, id);
      -- one row per sitting at a table; only 'normal' games move chips
      CREATE TABLE IF NOT EXISTS games (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode        TEXT NOT NULL CHECK (mode IN ('normal', 'bot')),
        table_name  TEXT NOT NULL,
        buy_in      INTEGER NOT NULL,
        cash_out    INTEGER NOT NULL,
        hands       INTEGER NOT NULL,
        hands_won   INTEGER NOT NULL,
        biggest_win INTEGER NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_user ON games(user_id, id);
    `);
    // columns added after the first release: upgrade databases created before them
    const columns = new Set(this.db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
    for (const [name, type] of [
      ['table_key', 'TEXT'], ['rebuys', 'INTEGER NOT NULL DEFAULT 0'], ['hand_log', 'TEXT'], ['participants', 'TEXT'],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS games_table ON games(table_key)');
    this.sql = {
      insertUser: this.db.prepare('INSERT INTO users (username, password_hash, chips, created_at) VALUES (?, ?, 0, ?)'),
      userByName: this.db.prepare('SELECT * FROM users WHERE username = ?'),
      userById: this.db.prepare('SELECT id, username, chips FROM users WHERE id = ?'),
      createdAt: this.db.prepare('SELECT created_at AS createdAt FROM users WHERE id = ?'),
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
      insertGame: this.db.prepare(`
        INSERT INTO games (user_id, mode, table_name, table_key, buy_in, rebuys, cash_out, hands, hands_won, biggest_win,
                           started_at, ended_at, hand_log, participants)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      // who sat at a table session, as each record saw it, and who has been recorded
      sessionRecords: this.db.prepare('SELECT user_id AS userId, participants FROM games WHERE table_key = ?'),
      usernames: this.db.prepare("SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))"),
      gameById: this.db.prepare(`
        SELECT id, mode, table_name AS tableName, table_key AS tableKey, buy_in AS buyIn, rebuys, cash_out AS cashOut,
               cash_out - buy_in AS net, hands, hands_won AS handsWon, biggest_win AS biggestWin,
               started_at AS startedAt, ended_at AS endedAt, hand_log AS handLog
        FROM games WHERE id = ? AND user_id = ?`),
      // everyone's totals from one table session (a player may have sat down more than once)
      tablePlayers: this.db.prepare(`
        SELECT u.username, SUM(g.buy_in) AS buyIn, SUM(g.cash_out) AS cashOut, SUM(g.cash_out - g.buy_in) AS net,
               SUM(g.hands) AS hands, SUM(g.hands_won) AS handsWon, MAX(g.ended_at) AS leftAt, g.user_id = ? AS you
        FROM games g JOIN users u ON u.id = g.user_id
        WHERE g.table_key = ? GROUP BY g.user_id ORDER BY net DESC, u.username`),
      games: this.db.prepare(`
        SELECT id, mode, table_name AS tableName, buy_in AS buyIn, cash_out AS cashOut, cash_out - buy_in AS net,
               hands, hands_won AS handsWon, biggest_win AS biggestWin, started_at AS startedAt, ended_at AS endedAt
        FROM games WHERE user_id = ? ORDER BY id DESC LIMIT ?`),
      moneyStats: this.db.prepare(`
        SELECT COUNT(*) AS games,
               COALESCE(SUM(hands), 0) AS hands,
               COALESCE(SUM(hands_won), 0) AS handsWon,
               COALESCE(SUM(MAX(cash_out - buy_in, 0)), 0) AS earned,
               COALESCE(SUM(MAX(buy_in - cash_out, 0)), 0) AS lost,
               COALESCE(MAX(biggest_win), 0) AS biggestWin,
               MAX(cash_out - buy_in) AS bestGame,
               MIN(cash_out - buy_in) AS worstGame
        FROM games WHERE user_id = ? AND mode = 'normal'`),
      botStats: this.db.prepare(`
        SELECT COUNT(*) AS games, COALESCE(SUM(hands), 0) AS hands, COALESCE(SUM(hands_won), 0) AS handsWon
        FROM games WHERE user_id = ? AND mode = 'bot'`),
      deposited: this.db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND kind IN ('welcome', 'purchase')",
      ),
      deposits: this.db.prepare(`
        SELECT kind, amount, balance, note, created_at AS createdAt FROM transactions
        WHERE user_id = ? AND kind IN ('welcome', 'purchase') ORDER BY id DESC LIMIT ?`),
      // the most recent balances, oldest first
      timeline: this.db.prepare(`
        SELECT * FROM (
          SELECT id, kind, amount, balance, created_at AS createdAt FROM transactions
          WHERE user_id = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id`),
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

  /**
   * Ends a player's sitting at a table: pays `payout` chips back to the bank
   * (normal games only; practice games against bots never touch the bank) and
   * records the game, in one database transaction. Returns the bank balance.
   */
  settleGame(userId, payout, game, note = null) {
    if (!Number.isSafeInteger(payout) || payout < 0) throw new AccountError(400, 'Payout must be a whole number');
    if (game.mode === 'bot' && payout > 0) throw new AccountError(400, 'Practice games do not pay out');
    return this.transaction(() => {
      const chips = payout > 0 ? this.applyChange(userId, payout, 'cash-out', note) : this.user(userId)?.chips;
      if (chips === undefined) throw new AccountError(404, 'No such user');
      // sitting down and leaving before a hand was dealt is not a game
      if (game.hands > 0) {
        this.sql.insertGame.run(
          userId, game.mode, game.tableName, game.tableKey ?? null, game.buyIn, game.rebuys ?? 0, game.cashOut,
          game.hands, game.handsWon, game.biggestWin, game.startedAt, this.now(), JSON.stringify(game.handLog ?? []),
          JSON.stringify(game.participants ?? []),
        );
      }
      return chips;
    });
  }

  /**
   * One game in detail: the record with its hand log, everyone's totals at that
   * table session, and for real-chip games who pays whom to settle up (in chips).
   * Only a player who sat in the game can see it.
   */
  gameDetail(userId, gameId) {
    const row = this.sql.gameById.get(gameId, userId);
    if (!row) throw new AccountError(404, 'No such game');
    const { handLog, tableKey, ...game } = row;
    game.handLog = handLog ? JSON.parse(handLog) : [];
    const players = tableKey
      ? this.sql.tablePlayers.all(userId, tableKey).map((p) => ({ ...p, you: Boolean(p.you) }))
      : [{ username: this.user(userId).username, buyIn: game.buyIn, cashOut: game.cashOut, net: game.net,
        hands: game.hands, handsWon: game.handsWon, leftAt: game.endedAt, you: true }];
    const settlement = game.mode === 'normal'
      ? {
        transfers: settleUp(players),
        unbalanced: players.reduce((sum, p) => sum + p.net, 0),
        pending: tableKey ? this.stillPlaying(tableKey) : [],
      }
      : null;
    return { game, players, settlement };
  }

  // Players who sat at a table session but whose game isn't recorded yet: they're still at the table.
  stillPlaying(tableKey) {
    const records = this.sql.sessionRecords.all(tableKey);
    const recorded = new Set(records.map((r) => r.userId));
    const seen = new Set(records.flatMap((r) => JSON.parse(r.participants || '[]')));
    const missing = [...seen].filter((id) => !recorded.has(id));
    if (!missing.length) return [];
    return this.sql.usernames.all(JSON.stringify(missing)).map((u) => u.username).sort();
  }

  games(userId, limit = 50) {
    return this.sql.games.all(userId, limit);
  }

  // Everything the profile page shows: lifetime stats, bank timeline, games and deposits.
  profile(userId, { games = 50, timeline = 500, deposits = 50 } = {}) {
    const user = this.user(userId);
    if (!user) throw new AccountError(404, 'No such user');
    const money = { ...this.sql.moneyStats.get(userId) };
    money.net = money.earned - money.lost;
    return {
      user: { username: user.username, chips: user.chips, createdAt: this.sql.createdAt.get(userId).createdAt },
      stats: {
        normal: money,
        bot: { ...this.sql.botStats.get(userId) },
        deposited: this.sql.deposited.get(userId).total,
      },
      timeline: this.sql.timeline.all(userId, timeline).map(({ id, ...row }) => row),
      games: this.games(userId, games),
      deposits: this.sql.deposits.all(userId, deposits),
    };
  }

  close() {
    this.db.close();
  }
}

/**
 * Who pays whom so every loser pays and every winner is paid, in at most
 * n - 1 transfers: the biggest loser pays the biggest winner, and so on.
 * `players` are [{ username, net }]; amounts are in chips. If the results
 * don't sum to zero (someone is still playing), the excess stays unsettled.
 */
function settleUp(players) {
  const queue = (sign) => players
    .filter((p) => Math.sign(p.net) === sign)
    .map((p) => ({ name: p.username, left: Math.abs(p.net) }))
    .sort((a, b) => b.left - a.left || a.name.localeCompare(b.name));
  const losers = queue(-1);
  const winners = queue(1);
  const transfers = [];
  for (let i = 0, j = 0; i < losers.length && j < winners.length;) {
    const amount = Math.min(losers[i].left, winners[j].left);
    transfers.push({ from: losers[i].name, to: winners[j].name, amount });
    losers[i].left -= amount;
    winners[j].left -= amount;
    if (losers[i].left === 0) i += 1;
    if (winners[j].left === 0) j += 1;
  }
  return transfers;
}

module.exports = { Store, AccountError, hashPassword, verifyPassword, settleUp };
