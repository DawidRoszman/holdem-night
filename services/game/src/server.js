'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Lobby } = require('./lobby');

const MAX_MESSAGE_BYTES = 4 * 1024;

// Calls the evaluator microservice to rank the players' hands at showdown.
function evaluatorClient(baseUrl, { timeoutMs = 3000, retries = 1 } = {}) {
  return async function rankHands(board, players) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/rank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ board, players }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`evaluator responded ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
}

// Calls the accounts microservice's internal API: sessions and chip transfers.
function accountsClient(baseUrl, internalKey, { timeoutMs = 3000 } = {}) {
  async function call(path, body) {
    const res = await fetch(`${baseUrl}/internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': internalKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `accounts responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return {
    session: (token) => call('/session', { token }),
    debit: (userId, amount, note) => call('/debit', { userId, amount, note }),
    credit: (userId, amount, note) => call('/credit', { userId, amount, note }),
  };
}

function createGameServer({ rankHands, accounts = null, lobbyOptions = {} } = {}) {
  const sockets = new Map();
  const lobby = new Lobby({
    rankHands,
    accounts,
    send: (clientId, msg) => {
      const ws = sockets.get(clientId);
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    ...lobbyOptions,
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'game', tables: lobby.tables.size, clients: sockets.size }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const clientId = crypto.randomUUID();
    sockets.set(clientId, ws);
    lobby.connect(clientId);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }
      lobby.handle(clientId, msg);
    });
    ws.on('close', () => {
      sockets.delete(clientId);
      lobby.disconnect(clientId);
    });
  });

  // drop connections that stop answering pings
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  server.on('close', () => {
    clearInterval(heartbeat);
    lobby.shutdown();
  });

  return { server, wss, lobby };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4000;
  const evaluatorUrl = process.env.EVALUATOR_URL || 'http://localhost:4001';
  const accountsUrl = process.env.ACCOUNTS_URL;
  if (accountsUrl && !process.env.ACCOUNTS_INTERNAL_KEY) {
    console.error('ACCOUNTS_INTERNAL_KEY must be set when ACCOUNTS_URL is');
    process.exit(1);
  }
  const { server, wss, lobby } = createGameServer({
    rankHands: evaluatorClient(evaluatorUrl),
    // without ACCOUNTS_URL the game runs in guest mode: pick a name, free chips
    accounts: accountsUrl ? accountsClient(accountsUrl, process.env.ACCOUNTS_INTERNAL_KEY) : null,
    lobbyOptions: {
      botDelayMs: Number(process.env.BOT_DELAY_MS) || 700,
      nextHandDelayMs: Number(process.env.NEXT_HAND_DELAY_MS) || 5000,
      turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS) || 30000,
    },
  });
  server.listen(port, () => {
    console.log(`game service listening on :${port} (evaluator: ${evaluatorUrl}, accounts: ${accountsUrl || 'off, guest mode'})`);
  });
  // pay everyone's table chips back to their bank before exiting
  const stop = async () => {
    await lobby.shutdown();
    for (const ws of wss.clients) ws.terminate();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createGameServer, evaluatorClient, accountsClient };
