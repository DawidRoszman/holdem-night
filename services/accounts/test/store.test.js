'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, AccountError, hashPassword, verifyPassword } = require('../src/store');

test('passwords are salted scrypt hashes that verify', async () => {
  const a = await hashPassword('hunter22');
  const b = await hashPassword('hunter22');
  assert.match(a, /^scrypt\$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('hunter22', a), true);
  assert.equal(await verifyPassword('hunter23', a), false);
  assert.equal(await verifyPassword('hunter22', 'garbage'), false);
});

test('registering creates a user with the welcome chips and a ledger entry', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const user = await store.register('Ann', 'secret1');
  assert.deepEqual(user, { id: user.id, username: 'Ann', chips: 1000 });
  assert.deepEqual(store.history(user.id).map((t) => [t.kind, t.amount, t.balance]), [['welcome', 1000, 1000]]);
});

test('usernames are unique regardless of case', async () => {
  const store = new Store();
  await store.register('Ann', 'secret1');
  await assert.rejects(store.register('ann', 'secret2'), (err) => err instanceof AccountError && err.status === 409);
});

test('authenticate checks the password and is case-insensitive on the name', async () => {
  const store = new Store();
  await store.register('Ann', 'secret1');
  assert.equal((await store.authenticate('ANN', 'secret1')).username, 'Ann');
  assert.equal(await store.authenticate('Ann', 'wrong!!'), null);
  assert.equal(await store.authenticate('Nobody', 'secret1'), null);
});

test('sessions resolve to their user until deleted or expired', async () => {
  let now = 1_000;
  const store = new Store(':memory:', { now: () => now });
  const user = await store.register('Ann', 'secret1');
  const token = store.createSession(user.id);
  assert.equal(store.userForToken(token).username, 'Ann');
  assert.equal(store.userForToken('not-a-token'), null);
  assert.equal(store.userForToken(null), null);

  store.deleteSession(token);
  assert.equal(store.userForToken(token), null);

  const other = store.createSession(user.id);
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(store.userForToken(other), null);
});

test('chip changes update the balance and never overdraw', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const { id } = await store.register('Ann', 'secret1');
  assert.equal(store.changeChips(id, 500, 'purchase'), 1500);
  assert.equal(store.changeChips(id, -1200, 'buy-in', 'Table A'), 300);
  assert.throws(() => store.changeChips(id, -301, 'buy-in'), (err) => err.status === 409);
  assert.equal(store.user(id).chips, 300);
  assert.throws(() => store.changeChips(id, 1.5, 'purchase'), (err) => err.status === 400);
  assert.throws(() => store.changeChips(9999, 10, 'purchase'), (err) => err.status === 404);
  assert.deepEqual(
    store.history(id).map((t) => [t.kind, t.amount, t.balance, t.note]),
    [['buy-in', -1200, 300, 'Table A'], ['purchase', 500, 1500, null], ['welcome', 1000, 1000, 'Welcome bonus']],
  );
});
