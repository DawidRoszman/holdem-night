'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createGameServer, evaluatorClient, accountsClient } = require('../src/server');

const rankHands = async (board, players) => ({
  results: players.map((p) => ({ id: p.id, score: [1], name: 'High Card' })),
});

let game;
let port;

test.before(async () => {
  game = createGameServer({ rankHands, lobbyOptions: { botDelayMs: 5, nextHandDelayMs: 5, turnTimeoutMs: 0 } });
  await new Promise((resolve) => game.server.listen(0, resolve));
  port = game.server.address().port;
});

test.after(() => new Promise((resolve) => game.server.close(resolve)));

// Minimal client that records messages and can wait for a matching one.
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const client = {
    ws,
    messages,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (match, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const found = messages.find(match);
        if (found) {
          messages.splice(messages.indexOf(found), 1);
          return resolve(found);
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); resolve(m); } });
      }),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

test('GET /health reports service status', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'game');
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
});

test('invalid JSON over the socket returns an error message', async () => {
  const c = await connect();
  c.ws.send('not json');
  const err = await c.next((m) => m.type === 'error');
  assert.match(err.message, /Invalid JSON/);
  c.close();
});

test('two players play over websockets and see each other at the table', async () => {
  const alice = await connect();
  const bob = await connect();
  alice.send({ type: 'hello', name: 'Alice' });
  bob.send({ type: 'hello', name: 'Bob' });
  await alice.next((m) => m.type === 'welcome');
  await bob.next((m) => m.type === 'welcome');

  alice.send({ type: 'createTable', name: 'Socket table' });
  const created = await alice.next((m) => m.type === 'state');
  const lobbyUpdate = await bob.next((m) => m.type === 'tables' && m.tables.some((t) => t.id === created.table.id));
  assert.equal(lobbyUpdate.tables.find((t) => t.id === created.table.id).name, 'Socket table');

  bob.send({ type: 'joinTable', tableId: created.table.id });
  const started = await alice.next((m) => m.type === 'state' && m.table.stage === 'preflop');
  assert.deepEqual(started.table.seats.filter(Boolean).map((s) => s.name), ['Alice', 'Bob']);

  alice.send({ type: 'action', action: 'fold' });
  const over = await bob.next((m) => m.type === 'state' && m.table.lastResult);
  assert.equal(over.table.lastResult.winners[0].name, 'Bob');

  alice.close();
  bob.close();
});

test('evaluatorClient posts to the evaluator and retries failures', async () => {
  let calls = 0;
  const stub = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { players } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: players.map((p) => ({ id: p.id, score: [0], name: 'High Card' })) }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const rank = evaluatorClient(`http://127.0.0.1:${stub.address().port}`, { retries: 1 });
  const out = await rank(['2c', '3d', '4h', '5s', '7c'], [{ id: 'a', hole: ['As', 'Kd'] }]);
  assert.equal(out.results[0].id, 'a');
  assert.equal(calls, 2);

  const failing = evaluatorClient(`http://127.0.0.1:${stub.address().port}/missing`, { retries: 0 });
  calls = 0;
  await assert.rejects(failing([], [{ id: 'a', hole: [] }]), /evaluator responded 500/);
  stub.close();
});

test('accountsClient calls the internal API with the shared key and surfaces errors', async () => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push([req.url, req.headers['x-internal-key'], JSON.parse(body)]);
      if (req.url === '/internal/debit') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not enough chips in your bank' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chips: 42 }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const bank = accountsClient(`http://127.0.0.1:${stub.address().port}`, 'sekret');
  assert.deepEqual(await bank.credit(7, 100, 'Cash-out'), { chips: 42 });
  await assert.rejects(bank.debit(7, 5000, 'Buy-in'), (err) => err.status === 409 && /Not enough chips/.test(err.message));
  assert.deepEqual(seen, [
    ['/internal/credit', 'sekret', { userId: 7, amount: 100, note: 'Cash-out' }],
    ['/internal/debit', 'sekret', { userId: 7, amount: 5000, note: 'Buy-in' }],
  ]);
  stub.close();
});
