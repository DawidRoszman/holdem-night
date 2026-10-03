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

const game = (over = {}) => ({
  mode: 'normal', tableName: 'T', buyIn: 1000, cashOut: 1000, hands: 5, handsWon: 2, biggestWin: 0, startedAt: 1, ...over,
});

test('settling a normal game pays the stack back and records it atomically', async () => {
  let clock = 1_000;
  const store = new Store(':memory:', { welcomeChips: 1000, now: () => clock });
  const { id } = await store.register('Ann', 'secret1');
  store.changeChips(id, -1000, 'buy-in', 'Buy-in at T');
  clock = 2_000;
  assert.equal(store.settleGame(id, 1600, game({ cashOut: 1600, biggestWin: 450 }), 'Cash-out from T'), 1600);
  assert.deepEqual(store.games(id).map((g) => [g.mode, g.buyIn, g.cashOut, g.net, g.biggestWin, g.endedAt]), [
    ['normal', 1000, 1600, 600, 450, 2_000],
  ]);
  assert.equal(store.history(id)[0].kind, 'cash-out');

  // the user is gone: neither the credit nor the game is kept
  assert.throws(() => store.settleGame(999, 10, game()), (err) => err.status === 404);
  assert.equal(store.games(id).length, 1);
});

test('practice games against bots are recorded but never touch the bank', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const { id } = await store.register('Ann', 'secret1');
  assert.equal(store.settleGame(id, 0, game({ mode: 'bot', cashOut: 3000 })), 1000);
  assert.throws(() => store.settleGame(id, 500, game({ mode: 'bot' })), (err) => err.status === 400);
  assert.equal(store.history(id).length, 1, 'only the welcome bonus');
  assert.equal(store.games(id)[0].mode, 'bot');
});

test('a sitting with no hands dealt pays back but is not a game', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const { id } = await store.register('Ann', 'secret1');
  store.changeChips(id, -500, 'buy-in');
  assert.equal(store.settleGame(id, 500, game({ buyIn: 500, cashOut: 500, hands: 0, handsWon: 0 })), 1000);
  assert.equal(store.games(id).length, 0);
});

test('the profile sums money stats from normal games only', async () => {
  let clock = 0;
  const store = new Store(':memory:', { welcomeChips: 1000, now: () => ++clock });
  const { id } = await store.register('Ann', 'secret1');
  store.changeChips(id, 500, 'purchase', 'Bought 500 chips');
  store.settleGame(id, 0, game({ cashOut: 1800, biggestWin: 700 })); // +800
  store.settleGame(id, 0, game({ cashOut: 700, biggestWin: 120 })); // -300
  store.settleGame(id, 0, game({ cashOut: 400 })); // -600
  store.settleGame(id, 0, game({ mode: 'bot', cashOut: 9000, hands: 40, handsWon: 30, biggestWin: 5000 }));

  const { user, stats, timeline, games, deposits } = store.profile(id);
  assert.equal(user.username, 'Ann');
  assert.equal(user.createdAt, 1);
  assert.deepEqual(stats.normal, {
    games: 3, hands: 15, handsWon: 6, earned: 800, lost: 900, net: -100, biggestWin: 700, bestGame: 800, worstGame: -600,
  });
  assert.deepEqual(stats.bot, { games: 1, hands: 40, handsWon: 30 });
  assert.equal(stats.deposited, 1500);
  assert.deepEqual(timeline.map((t) => t.balance), [1000, 1500], 'oldest first');
  assert.equal(games.length, 4);
  assert.equal(games[0].mode, 'bot', 'newest first');
  assert.deepEqual(deposits.map((d) => d.kind), ['purchase', 'welcome']);
});

test('a new player has an empty profile', async () => {
  const store = new Store(':memory:', { welcomeChips: 0 });
  const { id } = await store.register('Ann', 'secret1');
  const { stats, games, timeline } = store.profile(id);
  assert.deepEqual(stats.normal, {
    games: 0, hands: 0, handsWon: 0, earned: 0, lost: 0, net: 0, biggestWin: 0, bestGame: null, worstGame: null,
  });
  assert.deepEqual([games, timeline], [[], []]);
});
