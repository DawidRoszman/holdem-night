'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { Store } = require('../src/store');

const KEY = 'test-internal-key';

async function start(options = {}) {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const server = createServer({ store, internalKey: KEY, ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, key } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['X-Internal-Key'] = key;
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { server, store, call };
}

test('register, check balance, buy a pack and log out', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());

  const reg = await call('POST', '/register', { body: { username: '  Ann  Lee ', password: 'secret1' } });
  assert.equal(reg.status, 201);
  assert.deepEqual(reg.body.user, { username: 'Ann Lee', chips: 1000 });
  const { token } = reg.body;

  const me = await call('GET', '/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.chips, 1000);
  assert.deepEqual(me.body.packs, [500, 1000, 5000]);

  assert.equal((await call('POST', '/buy', { token, body: { amount: 5000 } })).body.chips, 6000);
  assert.equal((await call('POST', '/buy', { token, body: { amount: 123 } })).status, 400);
  assert.deepEqual(
    (await call('GET', '/history', { token })).body.transactions.map((x) => x.kind),
    ['purchase', 'welcome'],
  );

  assert.equal((await call('POST', '/logout', { token })).status, 204);
  assert.equal((await call('GET', '/me', { token })).status, 401);
  assert.equal((await call('POST', '/buy', { token, body: { amount: 500 } })).status, 401);
});

test('registration validates input and rejects taken names', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  assert.equal((await call('POST', '/register', { body: { username: 'x', password: 'secret1' } })).status, 400);
  assert.equal((await call('POST', '/register', { body: { username: 'Ann', password: '123' } })).status, 400);
  assert.equal((await call('POST', '/register', { body: { username: '<b>Ann</b>', password: 'secret1' } })).status, 400);
  assert.equal((await call('POST', '/register', { body: { username: 'Ann', password: 'secret1' } })).status, 201);
  const taken = await call('POST', '/register', { body: { username: 'ANN', password: 'secret1' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, 'That username is taken');
});

test('login returns a new token and locks a name after repeated failures', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  await call('POST', '/register', { body: { username: 'Ann', password: 'secret1' } });

  const ok = await call('POST', '/login', { body: { username: 'ann', password: 'secret1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'Ann');
  assert.equal((await call('GET', '/me', { token: ok.body.token })).status, 200);

  for (let i = 0; i < 5; i++) {
    const bad = await call('POST', '/login', { body: { username: 'Ann', password: 'nope!!' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'Wrong username or password');
  }
  assert.equal((await call('POST', '/login', { body: { username: 'Ann', password: 'secret1' } })).status, 429);
});

test('internal endpoints need the shared key', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const { body } = await call('POST', '/register', { body: { username: 'Ann', password: 'secret1' } });
  assert.equal((await call('POST', '/internal/session', { body: { token: body.token } })).status, 403);
  assert.equal((await call('POST', '/internal/session', { body: { token: body.token }, key: 'wrong' })).status, 403);
});

test('the game service resolves sessions and moves chips to and from tables', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const { body } = await call('POST', '/register', { body: { username: 'Ann', password: 'secret1' } });

  const session = await call('POST', '/internal/session', { key: KEY, body: { token: body.token } });
  assert.equal(session.status, 200);
  assert.equal(session.body.username, 'Ann');
  const userId = session.body.id;

  assert.equal((await call('POST', '/internal/session', { key: KEY, body: { token: 'bogus' } })).status, 401);

  const debit = await call('POST', '/internal/debit', { key: KEY, body: { userId, amount: 800, note: 'Table A' } });
  assert.deepEqual(debit.body, { chips: 200 });
  const over = await call('POST', '/internal/debit', { key: KEY, body: { userId, amount: 201 } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'Not enough chips in your bank');
  assert.equal((await call('POST', '/internal/debit', { key: KEY, body: { userId, amount: -5 } })).status, 400);

  const credit = await call('POST', '/internal/credit', { key: KEY, body: { userId, amount: 1350, note: 'Table A' } });
  assert.deepEqual(credit.body, { chips: 1550 });
});

test('unknown routes and bad JSON are client errors', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/health')).body.service, 'accounts');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/login`, { method: 'POST', body: '{nope' });
  assert.equal(res.status, 400);
});
