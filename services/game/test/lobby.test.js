'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lobby, cleanName } = require('../src/lobby');
const bot = require('../src/bot');

const rankHands = async (board, players) => ({
  results: players.map((p, i) => ({ id: p.id, score: [i], name: 'High Card' })),
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await wait(5);
  }
}

function setup(options = {}) {
  const inbox = new Map();
  let n = 0;
  const lobby = new Lobby({
    rankHands,
    send: (id, msg) => {
      if (!inbox.has(id)) inbox.set(id, []);
      inbox.get(id).push(msg);
    },
    botDelayMs: 5,
    nextHandDelayMs: 5,
    turnTimeoutMs: 0,
    newId: () => `id-${++n}-xxxxxxxx`,
    ...options,
  });
  const last = (id, type) => (inbox.get(id) || []).filter((m) => m.type === type).at(-1);
  const all = (id, type) => (inbox.get(id) || []).filter((m) => m.type === type);
  return { lobby, inbox, last, all };
}

async function connectNamed(lobby, id, name) {
  lobby.connect(id);
  await lobby.handle(id, { type: 'hello', name });
}

test('cleanName trims, collapses whitespace and limits length', () => {
  assert.equal(cleanName('  Ann   Lee ', 'x'), 'Ann Lee');
  assert.equal(cleanName('', 'fallback'), 'fallback');
  assert.equal(cleanName('a'.repeat(50), 'x').length, 20);
});

test('bot checks when possible and calls otherwise', () => {
  assert.deepEqual(bot.decide({ canCheck: true }), { action: 'check' });
  assert.deepEqual(bot.decide({ canCheck: false, canCall: true }), { action: 'call' });
  assert.equal(bot.decide(null), null);
});

test('clients must say hello before anything else', async () => {
  const { lobby, last } = setup();
  lobby.connect('c1');
  await lobby.handle('c1', { type: 'listTables' });
  assert.match(last('c1', 'error').message, /hello/);
  await lobby.handle('c1', { type: 'hello', name: 'Alice' });
  assert.deepEqual(last('c1', 'welcome'), { type: 'welcome', playerId: 'c1', name: 'Alice', timing: { turnTimeoutMs: 0, nextHandDelayMs: 5, reconnectGraceMs: 0 } });
  await lobby.handle('c1', { nope: true });
  assert.match(last('c1', 'error').message, /Invalid message/);
  await lobby.handle('c1', { type: 'teleport' });
  assert.match(last('c1', 'error').message, /Unknown message type/);
  lobby.shutdown();
});

test('creating a table seats the creator and updates the lobby for others', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'High Rollers' });
  const state = last('c1', 'state').table;
  assert.equal(state.name, 'High Rollers');
  assert.equal(state.seats[0].name, 'Alice');
  const tables = last('c2', 'tables').tables;
  assert.equal(tables.length, 1);
  assert.equal(tables[0].players, 1);
  await lobby.handle('c1', { type: 'createTable' });
  assert.match(last('c1', 'error').message, /Leave your current table/);
  lobby.shutdown();
});

test('once the host starts the game, both players see only their own cards', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  const tableId = last('c1', 'state').table.id;
  await lobby.handle('c2', { type: 'joinTable', tableId });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.stage === 'preflop');
  const aliceView = last('c1', 'state').table;
  assert.notEqual(aliceView.seats[0].cards[0], '??');
  assert.deepEqual(aliceView.seats[1].cards, ['??', '??']);
  // heads-up: Alice is on the button and acts first
  assert.ok(aliceView.you.legal);
  await lobby.handle('c2', { type: 'action', action: 'call' });
  assert.match(last('c2', 'error').message, /Not your turn/);
  await lobby.handle('c1', { type: 'action', action: 'call' });
  assert.equal(last('c2', 'state').table.toAct, 1);
  lobby.shutdown();
});

test('joining a missing table or acting without a table reports an error', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await lobby.handle('c1', { type: 'joinTable', tableId: 'nope' });
  assert.match(last('c1', 'error').message, /not found/);
  await lobby.handle('c1', { type: 'action', action: 'check' });
  assert.match(last('c1', 'error').message, /Join a table/);
  await lobby.handle('c1', { type: 'addBot' });
  assert.match(last('c1', 'error').message, /Join a table/);
  await lobby.handle('c1', { type: 'leaveTable' });
  assert.match(last('c1', 'error').message, /not at a table/);
});

test('bots play hands automatically against a human', async () => {
  const { lobby, last, all } = setup({ nextHandDelayMs: 1000 });
  await connectNamed(lobby, 'c1', 'Alice');
  await lobby.handle('c1', { type: 'createTable', name: 'Bots', mode: 'bot' });
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'addBot' });
  const finished = () => all('c1', 'state').find((m) => m.table.lastResult);
  // Alice keeps checking/calling; bots respond until the hand is over
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => {
    const view = last('c1', 'state').table;
    if (view.you?.legal) {
      lobby.handle('c1', { type: 'action', action: view.you.legal.canCheck ? 'check' : 'call' });
    }
    return finished();
  });
  const { table } = finished();
  assert.equal(table.board.length, 5, 'nobody folds, so the hand goes to showdown');
  assert.equal(Object.keys(table.lastResult.shown).length, 3);
  assert.ok(table.lastResult.winners.length >= 1);
  const seats = table.seats.filter(Boolean);
  assert.equal(seats.reduce((s, p) => s + p.chips, 0), 3000, 'chips are conserved');
  lobby.shutdown();
});

test('turn timeout folds an idle player facing a bet', async () => {
  const { lobby, last } = setup({ turnTimeoutMs: 30 });
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.lastResult?.winners?.[0]?.name === 'Bob');
  lobby.shutdown();
});

test('leaving returns the player to the lobby and empty tables are removed', async () => {
  const { lobby, last, all } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await lobby.handle('c1', { type: 'createTable', name: 'T', mode: 'bot' });
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'leaveTable' });
  assert.equal(all('c1', 'left').length, 1);
  assert.equal(lobby.tables.size, 0, 'table with only bots is closed');
  assert.deepEqual(last('c1', 'tables').tables, []);
  lobby.shutdown();
});

test('disconnecting mid-hand folds the player and the other wins', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c2', 'state').table.stage === 'preflop');
  await lobby.disconnect('c1');
  const view = last('c2', 'state').table;
  assert.equal(view.lastResult.winners[0].name, 'Bob');
  assert.equal(view.seats.filter(Boolean).length, 1);
  assert.equal(lobby.clients.has('c1'), false);
  lobby.shutdown();
});

test('a table cannot take more players than seats', async () => {
  const { lobby, last } = setup({ tableOptions: { maxPlayers: 2 } });
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T', mode: 'bot' });
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'addBot' });
  assert.match(last('c1', 'error').message, /full/);
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  assert.match(last('c2', 'error').message, /full/);
  lobby.shutdown();
});

test('a player who leaves mid-hand stops receiving that table\'s state', async () => {
  const { lobby, inbox, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await lobby.handle('c1', { type: 'createTable', name: 'T', mode: 'bot' });
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.stage === 'preflop');
  await lobby.handle('c1', { type: 'leaveTable' });
  const afterLeave = inbox.get('c1').length;
  assert.equal(inbox.get('c1').at(-1).type, 'tables');
  await wait(100); // bots keep playing the hand
  assert.equal(inbox.get('c1').slice(afterLeave).filter((m) => m.type === 'state').length, 0);
  lobby.shutdown();
});

test('when a player busts, both players see the result and the loser can rebuy', async () => {
  const { lobby, last, all } = setup({ nextHandDelayMs: 50, tableOptions: { startingChips: 100 } });
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.you?.legal);
  await lobby.handle('c1', { type: 'action', action: 'allin' });
  await lobby.handle('c2', { type: 'action', action: 'call' });
  // fake evaluator ranks the second player higher: Bob wins everything
  const aliceView = last('c1', 'state').table;
  assert.equal(aliceView.lastResult.winners[0].name, 'Bob');
  assert.deepEqual(aliceView.lastResult.busted.map((b) => b.name), ['Alice']);
  assert.equal(aliceView.you.busted, true);
  assert.equal(all('c1', 'left').length, 0, 'the busted player is not kicked out');
  assert.equal(last('c2', 'state').table.lastResult.deltas[last('c2', 'welcome').playerId], 100);

  await wait(120);
  assert.equal(last('c2', 'state').table.stage, 'handOver', 'no new hand with one stack left');
  await lobby.handle('c2', { type: 'rebuy' });
  assert.match(last('c2', 'error').message, /only rebuy when you are out of chips/);
  await lobby.handle('c1', { type: 'rebuy' });
  await until(() => last('c1', 'state').table.stage === 'preflop');
  assert.equal(last('c1', 'state').table.you.busted, false);
  lobby.shutdown();
});

// In-memory stand-in for the accounts service: tokens are user ids.
function fakeBank(balances) {
  const bank = { balances: new Map(Object.entries(balances)), moves: [], down: false };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  bank.session = async (token) => {
    if (bank.down) throw new Error('ECONNREFUSED');
    if (!bank.balances.has(token)) throw fail(401, 'Your session has expired, please log in again');
    return { id: token, username: token.toUpperCase(), chips: bank.balances.get(token) };
  };
  bank.debit = async (userId, amount, note) => {
    if (bank.down) throw new Error('ECONNREFUSED');
    if (bank.balances.get(userId) < amount) throw fail(409, 'Not enough chips in your bank');
    bank.balances.set(userId, bank.balances.get(userId) - amount);
    bank.moves.push([userId, -amount, note]);
    return { chips: bank.balances.get(userId) };
  };
  bank.credit = async (userId, amount, note) => {
    bank.balances.set(userId, bank.balances.get(userId) + amount);
    bank.moves.push([userId, amount, note]);
    return { chips: bank.balances.get(userId) };
  };
  bank.games = [];
  bank.settle = async (userId, amount, note, game) => {
    bank.games.push([userId, game]);
    return amount > 0 ? bank.credit(userId, amount, note) : { chips: bank.balances.get(userId) };
  };
  return bank;
}

async function connectUser(lobby, id, token) {
  lobby.connect(id);
  await lobby.handle(id, { type: 'hello', token });
}

test('with accounts, hello takes a session token instead of a name', async () => {
  const bank = fakeBank({ ann: 1500 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  assert.deepEqual(last('c1', 'welcome'), {
    type: 'welcome', playerId: 'c1', name: 'ANN', chips: 1500, timing: { turnTimeoutMs: 0, nextHandDelayMs: 5, reconnectGraceMs: 60000 },
  });

  await connectUser(lobby, 'c2', 'expired');
  assert.equal(last('c2', 'welcome'), undefined);
  assert.match(last('c2', 'authError').message, /log in again/);
  await lobby.handle('c2', { type: 'listTables' });
  assert.equal(last('c2', 'error').message, 'Say hello first');
  lobby.shutdown();
});

test('sitting down buys chips from the bank and leaving pays the stack back', async () => {
  const bank = fakeBank({ ann: 1500, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, nextHandDelayMs: 10_000 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'Bank Table', buyIn: 600 });
  assert.equal(last('c1', 'account').chips, 900);
  const { table } = last('c1', 'state');
  assert.equal(table.seats[0].chips, 600);
  assert.equal(table.you.buyIn, 600);

  await lobby.handle('c2', { type: 'joinTable', tableId: table.id });
  assert.equal(last('c2', 'account').chips, 0, 'the default buy-in is the table stack');
  assert.equal(last('c2', 'state').table.seats[1].chips, 1000);

  await lobby.handle('c1', { type: 'leaveTable' });
  await until(() => bank.balances.get('ann') === 1500);
  assert.equal(last('c1', 'account').chips, 1500);
  assert.deepEqual(bank.moves.at(-1), ['ann', 600, 'Cash-out from Bank Table']);
  lobby.shutdown();
});

test('a buy-in the bank cannot cover is refused without leaving a table behind', async () => {
  const bank = fakeBank({ ann: 300 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  await lobby.handle('c1', { type: 'createTable', name: 'Too Rich' });
  assert.equal(last('c1', 'error').message, 'Not enough chips in your bank');
  assert.equal(lobby.tables.size, 0);
  assert.equal(last('c1', 'state'), undefined);

  await lobby.handle('c1', { type: 'createTable', name: 'Odd', buyIn: 150 });
  assert.match(last('c1', 'error').message, /Buy-in must be between 200 and 5000/);
  assert.equal(bank.moves.length, 0);

  await lobby.handle('c1', { type: 'createTable', name: 'Fits', buyIn: 300 });
  assert.equal(last('c1', 'state').table.name, 'Fits');
  assert.equal(bank.balances.get('ann'), 0);
  lobby.shutdown();
});

test('the same account cannot sit at two tables from two windows', async () => {
  const bank = fakeBank({ ann: 5000 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'ann');
  await lobby.handle('c1', { type: 'createTable', name: 'One' });
  await lobby.handle('c2', { type: 'createTable', name: 'Two' });
  assert.match(last('c2', 'error').message, /already playing/);
  assert.equal(bank.balances.get('ann'), 4000);
  lobby.shutdown();
});

test('a rebuy is paid from the bank, and refused when the bank is empty', async () => {
  const bank = fakeBank({ ann: 1000, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, nextHandDelayMs: 20 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T', buyIn: 400 });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id, buyIn: 1000 });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.you?.legal);
  await lobby.handle('c1', { type: 'action', action: 'allin' });
  await lobby.handle('c2', { type: 'action', action: 'call' });
  assert.equal(last('c1', 'state').table.you.busted, true); // the fake evaluator favours Bob

  bank.balances.set('ann', 100);
  await lobby.handle('c1', { type: 'rebuy' });
  assert.equal(last('c1', 'error').message, 'Not enough chips in your bank');
  assert.equal(last('c1', 'state').table.you.busted, true);

  bank.balances.set('ann', 600);
  await lobby.handle('c1', { type: 'rebuy' });
  assert.equal(last('c1', 'account').chips, 200);
  assert.deepEqual(bank.moves.at(-1), ['ann', -400, 'Rebuy at T']);
  await until(() => last('c1', 'state').table.stage === 'preflop');
  assert.equal(last('c1', 'state').table.seats[0].chips + last('c1', 'state').table.seats[0].bet, 400);
  lobby.shutdown();
});

test('an unreachable bank gives a friendly error', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  bank.down = true;
  const errorLog = console.error;
  console.error = () => {};
  try {
    await lobby.handle('c1', { type: 'createTable', name: 'T' });
  } finally {
    console.error = errorLog;
  }
  assert.equal(last('c1', 'error').message, 'The bank is unavailable, try again shortly');
  assert.equal(lobby.tables.size, 0);
  lobby.shutdown();
});

test('shutting down cancels the hand in play and pays every stake back', async () => {
  const bank = fakeBank({ ann: 1000, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, turnTimeoutMs: 0 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.stage === 'preflop');
  assert.equal(bank.balances.get('ann') + bank.balances.get('bob'), 0);

  await lobby.shutdown();
  assert.deepEqual(Object.fromEntries(bank.balances), { ann: 1000, bob: 1000 });
  assert.equal(lobby.tables.size, 0);
});

test('messages sent right after hello wait for the token check', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby, last } = setup({ accounts: bank });
  lobby.connect('c1');
  lobby.handle('c1', { type: 'hello', token: 'ann' });
  await lobby.handle('c1', { type: 'createTable', name: 'Quick' });
  assert.equal(last('c1', 'error'), undefined);
  assert.equal(last('c1', 'state').table.name, 'Quick');
  lobby.shutdown();
});

test('disconnecting while a buy-in is at the bank pays it straight back', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby } = setup({ accounts: bank, reconnectGraceMs: 0 });
  await connectUser(lobby, 'c1', 'ann');
  const creating = lobby.handle('c1', { type: 'createTable', name: 'Gone' });
  const leaving = lobby.disconnect('c1');
  await Promise.all([creating, leaving]);
  await until(() => bank.balances.get('ann') === 1000);
  assert.equal(lobby.tables.size, 0);
  assert.equal(lobby.clients.size, 0);
  lobby.shutdown();
});

test('bots can only join practice tables', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Ann');
  await lobby.handle('c1', { type: 'createTable', name: 'Real' });
  assert.equal(last('c1', 'state').table.mode, 'normal');
  await lobby.handle('c1', { type: 'addBot' });
  assert.equal(last('c1', 'error').message, 'Bots can only play at practice tables');

  await lobby.handle('c1', { type: 'leaveTable' });
  await lobby.handle('c1', { type: 'createTable', name: 'Odd', mode: 'ranked' });
  assert.equal(last('c1', 'error').message, 'Choose a normal or a practice table');
  await lobby.handle('c1', { type: 'createTable', name: 'Practice', mode: 'bot' });
  await lobby.handle('c1', { type: 'addBot' });
  assert.equal(last('c1', 'state').table.seats[1].isBot, true);
  lobby.shutdown();
});

test('practice tables never touch the bank but still record the game', async () => {
  const bank = fakeBank({ ann: 50 });
  const { lobby, last } = setup({ accounts: bank, nextHandDelayMs: 20 });
  await connectUser(lobby, 'c1', 'ann');
  // the bank can't cover a 1,000 buy-in, but practice chips are free
  await lobby.handle('c1', { type: 'createTable', name: 'Practice', mode: 'bot' });
  assert.equal(last('c1', 'error'), undefined);
  await lobby.handle('c1', { type: 'addBot' });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.you?.legal);
  await lobby.handle('c1', { type: 'action', action: 'fold' });
  await lobby.handle('c1', { type: 'leaveTable' });
  await until(() => bank.games.length === 1);

  assert.deepEqual(bank.moves, []);
  assert.equal(bank.balances.get('ann'), 50);
  const [userId, game] = bank.games[0];
  assert.equal(userId, 'ann');
  assert.equal(game.mode, 'bot');
  assert.equal(game.tableName, 'Practice');
  assert.equal(game.buyIn, 1000);
  assert.deepEqual([game.hands, game.handsWon], [1, 0]);
  lobby.shutdown();
});

test('leaving a normal table pays the stack back together with the game record', async () => {
  const bank = fakeBank({ ann: 1000, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, nextHandDelayMs: 50 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'Duel', buyIn: 500 });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id, buyIn: 500 });
  await lobby.handle('c1', { type: 'startGame' });
  await until(() => last('c1', 'state').table.you?.legal);
  await lobby.handle('c1', { type: 'action', action: 'fold' }); // Ann is small blind heads-up: -10
  await lobby.handle('c2', { type: 'leaveTable' });
  await lobby.handle('c1', { type: 'leaveTable' });
  await until(() => bank.games.length === 2);

  const games = Object.fromEntries(bank.games);
  const { handLog, startedAt, tableKey, participants, ...bob } = games.bob;
  assert.deepEqual(participants, ['ann', 'bob'], 'everyone who sat at this table session');
  assert.deepEqual(bob, {
    mode: 'normal', tableName: 'Duel', buyIn: 500, rebuys: 0, cashOut: 510, hands: 1, handsWon: 1, biggestWin: 10,
  });
  assert.equal(tableKey, games.ann.tableKey, 'both records point at the same table session');
  assert.deepEqual(handLog.map((h) => [h.hand, h.delta, h.stack]), [[1, 10, 510]]);
  assert.ok(startedAt > 0);
  assert.deepEqual([games.ann.cashOut, games.ann.handsWon, games.ann.biggestWin], [490, 0, 0]);
  assert.equal(bank.balances.get('bob'), 1010);
  lobby.shutdown();
});

test('nothing is dealt until the host starts the game', async () => {
  const { lobby, last } = setup();
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c1', { type: 'startGame' });
  assert.match(last('c1', 'error').message, /at least two players/);
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await wait(50);
  assert.equal(last('c1', 'state').table.stage, 'waiting');
  assert.equal(last('c2', 'state').table.hostName, 'Alice');
  await lobby.handle('c2', { type: 'startGame' });
  assert.match(last('c2', 'error').message, /Only the table's host/);

  await lobby.handle('c1', { type: 'startGame' });
  assert.equal(last('c1', 'state').table.stage, 'preflop', 'the first hand is dealt at once');
  lobby.shutdown();
});

test('when the host leaves, the next player can start the game', async () => {
  const { lobby, last } = setup();
  for (const [id, name] of [['c1', 'Alice'], ['c2', 'Bob'], ['c3', 'Cid']]) await connectNamed(lobby, id, name);
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  const tableId = last('c1', 'state').table.id;
  await lobby.handle('c2', { type: 'joinTable', tableId });
  await lobby.handle('c3', { type: 'joinTable', tableId });
  await lobby.handle('c1', { type: 'leaveTable' });
  assert.equal(last('c2', 'state').table.you.canStart, true);
  await lobby.handle('c2', { type: 'startGame' });
  assert.equal(last('c3', 'state').table.stage, 'preflop');
  lobby.shutdown();
});

test('players are told the turn clock and when the next hand is dealt', async () => {
  const { lobby, last } = setup({ turnTimeoutMs: 5000, nextHandDelayMs: 4000 });
  await connectNamed(lobby, 'c1', 'Alice');
  await connectNamed(lobby, 'c2', 'Bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  let { timing } = last('c1', 'state').table;
  assert.deepEqual(timing, {
    turnTimeoutMs: 5000, nextHandDelayMs: 4000, reconnectGraceMs: 0, turnEndsIn: null, nextHandIn: null,
  });

  await lobby.handle('c1', { type: 'startGame' });
  timing = last('c2', 'state').table.timing;
  assert.ok(timing.turnEndsIn > 4900 && timing.turnEndsIn <= 5000, 'everyone sees the clock of the player to act');
  await lobby.handle('c1', { type: 'action', action: 'fold' });
  timing = last('c1', 'state').table.timing;
  assert.equal(timing.turnEndsIn, null);
  assert.ok(timing.nextHandIn > 3900 && timing.nextHandIn <= 4000);
  lobby.shutdown();
});

test('the turn clock keeps running when someone else joins the table', async () => {
  const { lobby, last, all } = setup({ turnTimeoutMs: 150 });
  for (const [id, name] of [['c1', 'Alice'], ['c2', 'Bob'], ['c3', 'Cid']]) await connectNamed(lobby, id, name);
  await lobby.handle('c1', { type: 'createTable', name: 'T' });
  const tableId = last('c1', 'state').table.id;
  await lobby.handle('c2', { type: 'joinTable', tableId });
  await lobby.handle('c1', { type: 'startGame' });
  await wait(100);
  await lobby.handle('c3', { type: 'joinTable', tableId });
  assert.ok(last('c3', 'state').table.timing.turnEndsIn < 75, 'joining does not reset the clock');
  await until(() => last('c1', 'notice'));
  assert.equal(last('c1', 'notice').message, 'Time ran out, so you folded');
  assert.equal(all('c2', 'notice').length, 0);
  lobby.shutdown();
});

test('a logged-in player who reloads gets their seat, cards and turn clock back', async () => {
  const bank = fakeBank({ ann: 1000, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, turnTimeoutMs: 5000 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'Home Game' });
  const tableId = last('c1', 'state').table.id;
  await lobby.handle('c2', { type: 'joinTable', tableId });
  await lobby.handle('c1', { type: 'startGame' });
  const before = last('c1', 'state').table;
  assert.ok(before.you.legal, "it is Ann's turn");

  await lobby.disconnect('c1');
  const seen = last('c2', 'state').table;
  assert.equal(seen.seats[0].away, true, 'the others see the seat as away');
  assert.match(seen.log.at(-1), /ANN lost connection, seat held for 60s/);
  assert.equal(lobby.tables.size, 1);
  assert.equal(bank.games.length, 0, 'nothing is cashed out yet');

  await wait(50);
  await connectUser(lobby, 'c3', 'ann');
  const back = last('c3', 'state').table;
  assert.equal(back.id, tableId);
  assert.equal(back.you.seat, 0);
  assert.deepEqual(back.seats[0].cards, before.seats[0].cards);
  assert.equal(back.seats[0].away, false);
  assert.equal(back.you.isHost, true);
  assert.ok(back.timing.turnEndsIn < 4960, 'the turn clock kept running');
  assert.match(last('c3', 'notice').message, /still seated at Home Game/);
  await lobby.handle('c3', { type: 'action', action: 'fold' });
  assert.equal(last('c3', 'error'), undefined);
  lobby.shutdown();
});

test('a held seat is released, and its stack paid back, when the player does not return', async () => {
  const bank = fakeBank({ ann: 1000, bob: 1000 });
  const { lobby, last } = setup({ accounts: bank, reconnectGraceMs: 40 });
  await connectUser(lobby, 'c1', 'ann');
  await connectUser(lobby, 'c2', 'bob');
  await lobby.handle('c1', { type: 'createTable', name: 'T', buyIn: 500 });
  await lobby.handle('c2', { type: 'joinTable', tableId: last('c1', 'state').table.id });
  await lobby.disconnect('c1');
  assert.equal(bank.balances.get('ann'), 500);
  await until(() => bank.balances.get('ann') === 1000);
  assert.equal(last('c2', 'state').table.seats.filter(Boolean).length, 1);
  assert.equal(last('c2', 'state').table.you.isHost, true, 'Bob hosts the table now');

  // coming back too late just lands in the lobby
  await connectUser(lobby, 'c3', 'ann');
  assert.equal(last('c3', 'state'), undefined);
  assert.equal(last('c3', 'notice'), undefined);
  lobby.shutdown();
});

test('guests and players who leave on purpose do not keep their seat', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  await lobby.handle('c1', { type: 'createTable', name: 'T', mode: 'bot' });
  await lobby.handle('c1', { type: 'leaveTable' });
  await lobby.disconnect('c1');
  await connectUser(lobby, 'c2', 'ann');
  assert.equal(last('c2', 'state'), undefined);
  lobby.shutdown();

  const guests = setup();
  await connectNamed(guests.lobby, 'g1', 'Gus');
  await guests.lobby.handle('g1', { type: 'createTable', name: 'G' });
  await guests.lobby.disconnect('g1');
  assert.equal(guests.lobby.tables.size, 0, 'guests have no account to come back as');
  guests.lobby.shutdown();
});

test('a reload whose new page connects before the old one closes still gets the seat back', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby, last } = setup({ accounts: bank });
  await connectUser(lobby, 'c1', 'ann');
  await lobby.handle('c1', { type: 'createTable', name: 'Racy', mode: 'bot' });
  // the new page says hello while the old one is still seated
  await connectUser(lobby, 'c2', 'ann');
  assert.equal(last('c2', 'state'), undefined);
  await lobby.disconnect('c1');
  await until(() => last('c2', 'state'));
  assert.equal(last('c2', 'state').table.name, 'Racy');
  assert.equal(last('c2', 'state').table.you.seat, 0);
  assert.match(last('c2', 'notice').message, /still seated at Racy/);
  lobby.shutdown();
});

test('a seat is never handed to a connection that has already closed', async () => {
  const bank = fakeBank({ ann: 1000 });
  const { lobby } = setup({ accounts: bank, reconnectGraceMs: 40 });
  await connectUser(lobby, 'c1', 'ann');
  await lobby.handle('c1', { type: 'createTable', name: 'Gone', mode: 'bot' });
  await connectUser(lobby, 'c2', 'ann');
  // the browser closes: both pages go at once
  await Promise.all([lobby.disconnect('c1'), lobby.disconnect('c2')]);
  await until(() => lobby.tables.size === 0);
  assert.equal(lobby.clients.size, 0);
  lobby.shutdown();
});
