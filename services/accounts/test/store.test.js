'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store, AccountError, hashPassword, verifyPassword, settleUp } = require('../src/store');

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

test('settling up pays every winner from the losers in as few transfers as needed', () => {
  const nets = (o) => Object.entries(o).map(([username, net]) => ({ username, net }));
  assert.deepEqual(settleUp(nets({ ann: 600, bob: -400, cid: -200 })), [
    { from: 'bob', to: 'ann', amount: 400 },
    { from: 'cid', to: 'ann', amount: 200 },
  ]);
  assert.deepEqual(settleUp(nets({ ann: 300, bob: 200, cid: -500, dee: 0 })), [
    { from: 'cid', to: 'ann', amount: 300 },
    { from: 'cid', to: 'bob', amount: 200 },
  ]);
  // someone still playing: only what is known is settled
  assert.deepEqual(settleUp(nets({ ann: 500, bob: -200 })), [{ from: 'bob', to: 'ann', amount: 200 }]);
  assert.deepEqual(settleUp(nets({ ann: 0 })), []);
});

test('a game in detail shows its hands, everyone at the table and how to settle up', async () => {
  let clock = 0;
  const store = new Store(':memory:', { welcomeChips: 1000, now: () => ++clock });
  const ann = (await store.register('Ann', 'secret1')).id;
  const bob = (await store.register('Bob', 'secret1')).id;
  const cid = (await store.register('Cid', 'secret1')).id;
  const hand = { hand: 1, endedAt: 5, hole: ['As', 'Kd'], board: [], folded: false, shown: null, pot: 30, delta: 10, stack: 1010, winners: [] };
  store.settleGame(ann, 0, game({ tableKey: 'k1', cashOut: 1700, handLog: [hand] }));
  store.settleGame(bob, 0, game({ tableKey: 'k1', cashOut: 500 }));
  // Cid sat down twice at the same table
  store.settleGame(cid, 0, game({ tableKey: 'k1', cashOut: 900 }));
  store.settleGame(cid, 0, game({ tableKey: 'k1', buyIn: 500, cashOut: 400, rebuys: 1 }));
  store.settleGame(cid, 0, game({ tableKey: 'other', cashOut: 5000 }));
  const [annGame] = store.games(ann);

  const { game: g, players, settlement } = store.gameDetail(ann, annGame.id);
  assert.equal(g.net, 700);
  assert.deepEqual(g.handLog, [hand]);
  assert.deepEqual(players.map((p) => [p.username, p.net, p.you]), [['Ann', 700, true], ['Cid', -200, false], ['Bob', -500, false]]);
  assert.deepEqual(settlement, {
    transfers: [{ from: 'Bob', to: 'Ann', amount: 500 }, { from: 'Cid', to: 'Ann', amount: 200 }],
    unbalanced: 0,
    pending: [],
  });
  assert.equal(store.games(cid)[1].rebuys, undefined, 'the list stays small');
  assert.equal(store.gameDetail(cid, store.games(cid)[1].id).game.rebuys, 1);

  // other people's games stay private
  assert.throws(() => store.gameDetail(bob, annGame.id), (err) => err.status === 404);
});

test('practice games have no settle-up, and old games without a table key list only you', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const { id } = await store.register('Ann', 'secret1');
  store.settleGame(id, 0, game({ mode: 'bot', tableKey: 'p1', cashOut: 2000 }));
  store.settleGame(id, 0, game({ cashOut: 1200 }));
  const [old, practice] = store.games(id);
  assert.equal(store.gameDetail(id, practice.id).settlement, null);
  const detail = store.gameDetail(id, old.id);
  assert.deepEqual(detail.players.map((p) => [p.username, p.net, p.you]), [['Ann', 200, true]]);
  assert.deepEqual(detail.game.handLog, []);
});

test('a database from before game details is upgraded in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-accounts-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
                        chips INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE games (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, mode TEXT NOT NULL, table_name TEXT NOT NULL,
                        buy_in INTEGER NOT NULL, cash_out INTEGER NOT NULL, hands INTEGER NOT NULL, hands_won INTEGER NOT NULL,
                        biggest_win INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'Ann', 'x', 0, 1);
    INSERT INTO games VALUES (1, 1, 'normal', 'Old Table', 1000, 1500, 4, 2, 300, 1, 2);
  `);
  old.close();
  const store = new Store(file);
  const { game: g, players } = store.gameDetail(1, 1);
  assert.deepEqual([g.tableName, g.net, g.rebuys, g.handLog], ['Old Table', 500, 0, []]);
  assert.equal(players.length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('players still at the table are named, even when the recorded results add up to zero', async () => {
  const store = new Store(':memory:', { welcomeChips: 1000 });
  const bea = (await store.register('Bea', 'secret1')).id;
  const rita = (await store.register('Rita', 'secret1')).id;
  // Bea broke even and left; Rita is still seated
  store.settleGame(bea, 0, game({ tableKey: 'k', cashOut: 1000, participants: [rita, bea] }));
  const { settlement } = store.gameDetail(bea, store.games(bea)[0].id);
  assert.deepEqual(settlement, { transfers: [], unbalanced: 0, pending: ['Rita'] });

  store.settleGame(rita, 0, game({ tableKey: 'k', cashOut: 1000, participants: [rita, bea] }));
  assert.deepEqual(store.gameDetail(bea, store.games(bea)[0].id).settlement.pending, []);
});
