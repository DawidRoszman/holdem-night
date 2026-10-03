'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

let server;
let base;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('GET /health reports ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('POST /rank returns winners', async () => {
  const res = await fetch(`${base}/rank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board: ['2c', '7d', '9h', 'Js', 'Kc'],
      players: [
        { id: 'p1', hole: ['Ah', 'Ad'] },
        { id: 'p2', hole: ['3h', '4d'] },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.winners, ['p1']);
  assert.equal(body.results.length, 2);
});

test('POST /rank validates input', async () => {
  const res = await fetch(`${base}/rank`, { method: 'POST', body: '{"board":"nope"}' });
  assert.equal(res.status, 400);
  const bad = await fetch(`${base}/rank`, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
  const badCard = await fetch(`${base}/rank`, {
    method: 'POST',
    body: JSON.stringify({ board: ['Zz', '2c', '3c', '4c', '5c'], players: [{ id: 'a', hole: ['Ah', 'Kh'] }] }),
  });
  assert.equal(badCard.status, 400);
});

test('unknown routes return 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
