'use strict';

const http = require('http');
const crypto = require('crypto');
const { Store, AccountError } = require('./store');

const MAX_BODY = 8 * 1024;
// play-money packs a player can buy from the lobby
const CHIP_PACKS = [500, 1000, 5000];
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,18}[A-Za-z0-9]$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
// failed logins allowed per username before it is locked for the rest of the window
const LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new AccountError(413, 'Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(data || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new AccountError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function credentials(body) {
  const username = String(body.username || '').trim().replace(/\s+/g, ' ');
  const password = String(body.password || '');
  return { username, password };
}

const publicUser = (u) => ({ username: u.username, chips: u.chips });

const GAME_MODES = new Set(['normal', 'bot']);
const count = (v) => Number.isSafeInteger(v) && v >= 0;

// A finished game as reported by the game service.
function gameRecord(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const ints = ['buyIn', 'cashOut', 'hands', 'handsWon', 'biggestWin', 'startedAt'];
  if (!GAME_MODES.has(g.mode) || !ints.every((k) => count(g[k])) || g.handsWon > g.hands) {
    throw new AccountError(400, 'Invalid game record');
  }
  const tableName = String(g.tableName || '').slice(0, 40) || 'Table';
  return { ...Object.fromEntries(ints.map((k) => [k, g[k]])), mode: g.mode, tableName };
}

/**
 * Public API (proxied by the web gateway at /api/accounts/):
 *   POST /register, POST /login, POST /logout, GET /me, GET /history, GET /profile, POST /buy
 * Internal API for the game service (requires X-Internal-Key, never proxied):
 *   POST /internal/session, POST /internal/debit, POST /internal/credit, POST /internal/game
 */
function createServer({ store = new Store(), internalKey, now = () => Date.now() } = {}) {
  if (!internalKey) throw new Error('internalKey is required');
  const failures = new Map(); // lower-cased username -> { count, since }

  function lockedOut(username) {
    const f = failures.get(username.toLowerCase());
    if (!f) return false;
    if (now() - f.since > LOGIN_WINDOW_MS) {
      failures.delete(username.toLowerCase());
      return false;
    }
    return f.count >= LOGIN_ATTEMPTS;
  }

  function recordFailure(username) {
    const key = username.toLowerCase();
    const f = failures.get(key);
    if (f && now() - f.since <= LOGIN_WINDOW_MS) f.count += 1;
    else failures.set(key, { count: 1, since: now() });
  }

  function requireUser(req) {
    const user = store.userForToken(bearer(req));
    if (!user) throw new AccountError(401, 'Please log in');
    return user;
  }

  const routes = {
    'GET /health': () => [200, { status: 'ok', service: 'accounts' }],

    'POST /register': async (req) => {
      const { username, password } = credentials(await readJson(req));
      if (!USERNAME_RE.test(username)) {
        throw new AccountError(400, 'Username must be 3-20 letters, digits, spaces, dots, dashes or underscores');
      }
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new AccountError(400, `Password must be at least ${PASSWORD_MIN} characters`);
      }
      const user = await store.register(username, password);
      return [201, { token: store.createSession(user.id), user: publicUser(user) }];
    },

    'POST /login': async (req) => {
      const { username, password } = credentials(await readJson(req));
      if (!username || !password) throw new AccountError(400, 'Enter your username and password');
      if (lockedOut(username)) throw new AccountError(429, 'Too many failed attempts, try again in a few minutes');
      const user = await store.authenticate(username, password);
      if (!user) {
        recordFailure(username);
        throw new AccountError(401, 'Wrong username or password');
      }
      failures.delete(username.toLowerCase());
      return [200, { token: store.createSession(user.id), user: publicUser(user) }];
    },

    'POST /logout': (req) => {
      const token = bearer(req);
      if (token) store.deleteSession(token);
      return [204];
    },

    'GET /me': (req) => [200, { ...publicUser(requireUser(req)), packs: CHIP_PACKS }],

    'GET /history': (req) => [200, { transactions: store.history(requireUser(req).id) }],

    'GET /profile': (req) => [200, store.profile(requireUser(req).id)],

    // Play money: buying a pack just credits it, there is no payment step.
    'POST /buy': async (req) => {
      const user = requireUser(req);
      const amount = Number((await readJson(req)).amount);
      if (!CHIP_PACKS.includes(amount)) throw new AccountError(400, `Choose a pack of ${CHIP_PACKS.join(', ')} chips`);
      return [200, { chips: store.changeChips(user.id, amount, 'purchase', `Bought ${amount} chips`) }];
    },

    'POST /internal/session': async (req) => {
      const user = store.userForToken((await readJson(req)).token);
      if (!user) throw new AccountError(401, 'Your session has expired, please log in again');
      return [200, user];
    },

    'POST /internal/debit': async (req) => {
      const { userId, amount, note } = await readJson(req);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new AccountError(400, 'Amount must be positive');
      return [200, { chips: store.changeChips(Number(userId), -amount, 'buy-in', note) }];
    },

    'POST /internal/credit': async (req) => {
      const { userId, amount, note } = await readJson(req);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new AccountError(400, 'Amount must be positive');
      return [200, { chips: store.changeChips(Number(userId), amount, 'cash-out', note) }];
    },

    // A player left a table: pay their stack back (normal games) and record the game.
    'POST /internal/game': async (req) => {
      const { userId, amount, note, game } = await readJson(req);
      if (!count(amount)) throw new AccountError(400, 'Amount must be a whole number');
      return [200, { chips: store.settleGame(Number(userId), amount, gameRecord(game), note) }];
    },
  };

  return http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const route = routes[`${req.method} ${path}`];
    try {
      if (!route) throw new AccountError(404, 'Not found');
      if (path.startsWith('/internal/') && !sameSecret(req.headers['x-internal-key'], internalKey)) {
        throw new AccountError(403, 'Forbidden');
      }
      const [status, body] = await route(req);
      send(res, status, body);
    } catch (err) {
      if (err instanceof AccountError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Server error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4002;
  const dbPath = process.env.DB_PATH || './accounts.db';
  const internalKey = process.env.INTERNAL_KEY;
  if (!internalKey) {
    console.error('INTERNAL_KEY must be set');
    process.exit(1);
  }
  const store = new Store(dbPath, { welcomeChips: Number(process.env.WELCOME_CHIPS ?? 1000) });
  const server = createServer({ store, internalKey });
  server.listen(port, () => console.log(`accounts service listening on :${port} (db: ${dbPath})`));
  const stop = () => server.close(() => {
    store.close();
    process.exit(0);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createServer, CHIP_PACKS };
