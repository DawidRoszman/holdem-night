'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Table, GameError } = require('../src/table');
const { freshDeck } = require('../src/deck');

// Fake evaluator: each player's score comes from a fixed map (higher wins).
function fixedRanks(scores) {
  const calls = [];
  const rankHands = async (board, players) => {
    calls.push({ board, players });
    return { results: players.map((p) => ({ id: p.id, score: [scores[p.id] ?? 0], name: `rank ${scores[p.id] ?? 0}` })) };
  };
  rankHands.calls = calls;
  return rankHands;
}

function makeTable(ids, { scores = {}, chips, ...opts } = {}) {
  const events = [];
  const table = new Table({
    id: 't1',
    name: 'Test',
    rankHands: opts.rankHands || fixedRanks(scores),
    deckFactory: freshDeck,
    onEvent: (event, p) => events.push([event, p.id]),
    ...opts,
  });
  for (const id of ids) table.addPlayer({ id, name: id.toUpperCase() });
  if (chips) for (const [id, amount] of Object.entries(chips)) table.findPlayer(id).chips = amount;
  table.events = events;
  return table;
}

const chipsOf = (table) => Object.fromEntries(table.players.map((p) => [p.id, p.chips]));
const actor = (table) => table.seats[table.toAct].id;

test('seats players and rejects duplicates and overflow', () => {
  const table = makeTable(['a', 'b'], { maxPlayers: 2 });
  assert.equal(table.findPlayer('b').seat, 1);
  assert.throws(() => table.addPlayer({ id: 'a', name: 'A' }), GameError);
  assert.throws(() => table.addPlayer({ id: 'c', name: 'C' }), /full/);
});

test('cannot start a hand with fewer than two players', async () => {
  const table = makeTable(['a']);
  assert.equal(table.canStart(), false);
  await assert.rejects(table.startHand(), GameError);
});

test('heads-up: button posts small blind and acts first preflop, last postflop', async () => {
  const table = makeTable(['a', 'b']);
  await table.startHand();
  assert.equal(table.button, 0);
  assert.equal(table.findPlayer('a').bet, 10);
  assert.equal(table.findPlayer('b').bet, 20);
  assert.equal(actor(table), 'a');
  await table.act('a', 'call');
  assert.equal(actor(table), 'b', 'big blind gets the option');
  await table.act('b', 'check');
  assert.equal(table.stage, 'flop');
  assert.equal(table.board.length, 3);
  assert.equal(actor(table), 'b');
});

test('three players: blinds left of the button, under-the-gun acts first', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  assert.equal(table.findPlayer('b').bet, 10);
  assert.equal(table.findPlayer('c').bet, 20);
  assert.equal(actor(table), 'a');
  assert.equal(table.pot, 30);
});

test('deals two private cards each and keeps the deck consistent', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  const dealt = table.players.flatMap((p) => p.hole);
  assert.equal(dealt.length, 6);
  assert.equal(new Set([...dealt, ...table.deck]).size, 52);
});

test('everyone folding to one player awards the pot without a showdown', async () => {
  const rankHands = fixedRanks({});
  const table = makeTable(['a', 'b', 'c'], { rankHands });
  await table.startHand();
  await table.act('a', 'fold');
  await table.act('b', 'fold');
  assert.equal(table.stage, 'handOver');
  assert.deepEqual(chipsOf(table), { a: 1000, b: 990, c: 1010 });
  assert.equal(rankHands.calls.length, 0);
  assert.equal(table.lastResult.winners[0].id, 'c');
});

test('checking down reaches showdown with a five card board', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 1, b: 2 } });
  await table.startHand();
  await table.act('a', 'call');
  await table.act('b', 'check');
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(table.stage, street);
    await table.act('b', 'check');
    await table.act('a', 'check');
  }
  assert.equal(table.stage, 'handOver');
  assert.equal(table.rankHands.calls[0].board.length, 5);
  assert.deepEqual(chipsOf(table), { a: 980, b: 1020 });
  assert.deepEqual(Object.keys(table.lastResult.shown).sort(), ['a', 'b']);
});

test('rejects illegal actions', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  await assert.rejects(table.act('b', 'call'), /Not your turn/);
  await assert.rejects(table.act('a', 'check'), /Cannot check/);
  await assert.rejects(table.act('a', 'raise', 30), /Minimum raise is to 40/);
  await assert.rejects(table.act('a', 'raise', 5000), /Not enough chips/);
  await assert.rejects(table.act('a', 'raise', 'abc'), /whole number/);
  await assert.rejects(table.act('a', 'dance'), /Unknown action/);
  await table.act('a', 'call');
  await table.act('b', 'call');
  await assert.rejects(table.act('c', 'call'), /Nothing to call/);
});

test('minimum raise follows the size of the last raise', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  await table.act('a', 'raise', 60); // raise of 40
  assert.equal(table.legalActions(table.findPlayer('b')).minRaiseTo, 100);
  await assert.rejects(table.act('b', 'raise', 90), /Minimum raise is to 100/);
  await table.act('b', 'raise', 150); // raise of 90
  assert.equal(table.legalActions(table.findPlayer('c')).minRaiseTo, 240);
});

test('a raise reopens action for players who already acted', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  await table.act('a', 'call');
  await table.act('b', 'call');
  await table.act('c', 'raise', 60);
  assert.equal(table.stage, 'preflop');
  assert.equal(actor(table), 'a');
  await table.act('a', 'call');
  await table.act('b', 'fold');
  assert.equal(table.stage, 'flop');
  assert.equal(table.pot, 140);
});

test('all-in players create side pots that are awarded correctly', async () => {
  // a has the best hand but the shortest stack, b beats c
  const table = makeTable(['a', 'b', 'c'], {
    scores: { a: 3, b: 2, c: 1 },
    chips: { a: 100, b: 300, c: 500 },
  });
  await table.startHand();
  await table.act('a', 'allin');
  await table.act('b', 'allin');
  await table.act('c', 'call');
  assert.equal(table.stage, 'handOver', 'board runs out when no more betting is possible');
  // main pot 300 -> a, side pot 400 -> b, c keeps the remaining 200
  assert.deepEqual(chipsOf(table), { a: 300, b: 400, c: 200 });
});

test('side pots skip folded players but keep their chips in the pot', async () => {
  const table = makeTable(['a', 'b', 'c'], {
    scores: { a: 1, b: 3, c: 2 },
    chips: { a: 1000, b: 1000, c: 50 },
  });
  await table.startHand();
  await table.act('a', 'raise', 100);
  await table.act('b', 'call');
  await table.act('c', 'allin');
  // flop: b bets, a folds
  await table.act('b', 'bet', 200);
  await table.act('a', 'fold');
  assert.equal(table.stage, 'handOver');
  // b has the best hand: main pot 150 (50 each) plus side pot 300 (a's 50 + b's own 250)
  assert.deepEqual(chipsOf(table), { a: 900, b: 1150, c: 0 });
  assert.deepEqual(table.events, [], 'busted players keep their seat until they rebuy or leave');
  assert.deepEqual(table.lastResult.busted, [{ id: 'c', name: 'C' }]);
  assert.deepEqual(table.lastResult.deltas, { a: -100, b: 150, c: -50 });
});

test('short all-in blind ends betting and returns the uncalled amount', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 1, b: 2 }, chips: { b: 15 } });
  await table.startHand();
  // b (big blind) could only post 15; a completes to 20
  await table.act('a', 'call');
  assert.equal(table.stage, 'handOver');
  // pot was a 20 + b 15: b wins 30, a gets 5 back
  assert.deepEqual(chipsOf(table), { a: 985, b: 30 });
});

test('split pots share chips and give odd chips left of the button', async () => {
  const table = makeTable(['a', 'b', 'c'], { scores: { a: 5, b: 5, c: 1 } });
  await table.startHand();
  await table.act('a', 'call');
  await table.act('b', 'fold'); // small blind folds 10 -> pot 50
  await table.act('c', 'check');
  for (let i = 0; i < 3; i++) {
    await table.act('c', 'check');
    await table.act('a', 'check');
  }
  // only a and c contested; a wins all 50
  assert.equal(chipsOf(table).a, 1030);

  const split = makeTable(['a', 'b', 'c'], { scores: { a: 5, b: 1, c: 5 } });
  await split.startHand();
  await split.act('a', 'call');
  await split.act('b', 'call');
  await split.act('c', 'raise', 45);
  await split.act('a', 'call');
  await split.act('b', 'call'); // pot 135, odd chip
  for (let i = 0; i < 3; i++) for (const id of ['b', 'c', 'a']) await split.act(id, 'check');
  const c = chipsOf(split);
  assert.equal(c.b, 955);
  assert.equal(c.c, 955 + 68, 'c sits closer to the button and gets the odd chip');
  assert.equal(c.a, 955 + 67);
});

test('evaluator failure refunds everyone', async () => {
  const table = makeTable(['a', 'b'], {
    rankHands: async () => {
      throw new Error('evaluator down');
    },
  });
  await table.startHand();
  await table.act('a', 'raise', 100);
  await table.act('b', 'allin');
  await table.act('a', 'call');
  assert.equal(table.stage, 'handOver');
  assert.deepEqual(chipsOf(table), { a: 1000, b: 1000 });
  assert.equal(table.lastResult.error, 'evaluator down');
});

test('button moves between hands', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  await table.act('a', 'fold');
  await table.act('b', 'fold');
  await table.startHand();
  assert.equal(table.button, 1);
  assert.equal(actor(table), 'b');
});

test('a player leaving mid-hand folds and is removed when the hand ends', async () => {
  const table = makeTable(['a', 'b', 'c']);
  await table.startHand();
  await table.removePlayer('b'); // not b's turn
  assert.equal(table.findPlayer('b').folded, true);
  assert.equal(actor(table), 'a');
  await table.removePlayer('a'); // a's turn -> fold ends the hand
  assert.equal(table.stage, 'handOver', 'the result stays visible to whoever is left');
  assert.equal(table.lastResult.winners[0].id, 'c');
  assert.deepEqual(table.players.map((p) => p.id), ['c']);
  assert.deepEqual(table.events.map((e) => e[1]).sort(), ['a', 'b']);
});

test('a player leaving between hands is removed immediately', async () => {
  const table = makeTable(['a', 'b']);
  await table.removePlayer('a');
  assert.equal(table.findPlayer('a'), null);
  await table.removePlayer('nobody');
});

test('view hides other players cards until showdown', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 2, b: 1 } });
  await table.startHand();
  const view = table.view('a');
  assert.equal(view.seats[0].cards.length, 2);
  assert.notEqual(view.seats[0].cards[0], '??');
  assert.deepEqual(view.seats[1].cards, ['??', '??']);
  assert.deepEqual(view.you.legal, {
    toCall: 10, canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 1000,
  });
  assert.equal(table.view('b').you.legal, null, 'not b\'s turn');
  assert.equal(table.view('spectator').you, null);

  await table.act('a', 'call');
  await table.act('b', 'check');
  for (let i = 0; i < 3; i++) {
    await table.act('b', 'check');
    await table.act('a', 'check');
  }
  assert.notEqual(table.view('a').seats[1].cards[0], '??', 'cards revealed at showdown');
});

test('the result reports every player\'s net chip change', async () => {
  const table = makeTable(['a', 'b', 'c'], { scores: { a: 1, b: 2, c: 0 } });
  await table.startHand();
  await table.act('a', 'raise', 100);
  await table.act('b', 'call');
  await table.act('c', 'fold');
  for (let i = 0; i < 3; i++) {
    await table.act('b', 'check');
    await table.act('a', 'check');
  }
  assert.deepEqual(table.lastResult.deltas, { a: -100, b: 120, c: -20 });
  assert.deepEqual(table.lastResult.busted, []);
});

test('a busted human stays seated, sits out, and can rebuy', async () => {
  const table = makeTable(['a', 'b', 'c'], { scores: { a: 1, b: 2, c: 0 }, chips: { a: 100 } });
  await table.startHand();
  await table.act('a', 'allin');
  await table.act('b', 'call');
  await table.act('c', 'fold');
  assert.equal(table.stage, 'handOver');
  assert.equal(table.findPlayer('a').chips, 0);
  assert.equal(table.view('a').you.busted, true);
  assert.equal(table.view('a').seats[0].busted, true);
  assert.equal(table.lastResult.winners[0].id, 'b');

  // b and c play on while a sits out
  await table.startHand();
  assert.equal(table.findPlayer('a').inHand, false);
  assert.throws(() => table.rebuy('b'), /only rebuy when you are out of chips/);
  table.rebuy('a');
  assert.equal(table.findPlayer('a').chips, 1000);
  assert.equal(table.view('a').you.busted, false);
  assert.throws(() => table.rebuy('nobody'), /not at this table/);
});

test('busted bots are cleared between hands, not the moment they lose', async () => {
  const table = makeTable(['a'], { scores: { a: 2 }, mode: 'bot' });
  table.addPlayer({ id: 'bot', name: 'Bot', isBot: true });
  table.findPlayer('bot').chips = 50;
  await table.startHand();
  await table.act('a', 'raise', 100);
  await table.act('bot', 'call');
  assert.equal(table.stage, 'handOver');
  assert.ok(table.findPlayer('bot'), 'still visible while the result is shown');
  assert.equal(table.hasBustedBots(), true);
  table.clearBusted();
  assert.equal(table.findPlayer('bot'), null);
  assert.deepEqual(table.events, [['removed', 'bot']]);
  assert.equal(table.canStart(), false, 'a is the only player left with chips');
});

test('the result explains why the winner won', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 1, b: 2 } });
  await table.startHand();
  await table.act('a', 'call');
  await table.act('b', 'check');
  for (let i = 0; i < 3; i++) {
    await table.act('b', 'check');
    await table.act('a', 'check');
  }
  const [winner] = table.lastResult.winners;
  assert.equal(winner.id, 'b');
  // the fake evaluator scores only categories: 2 = Two Pair, 1 = One Pair
  assert.equal(winner.reason, "Two Pair beats A's One Pair");
  assert.equal(table.lastResult.shown.a.description, 'One Pair');

  await table.startHand();
  await table.act('b', 'fold');
  assert.equal(table.lastResult.winners[0].reason, 'Everyone else folded');
});

test('a split pot says the hands were the same', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 4, b: 4 } });
  await table.startHand();
  await table.act('a', 'call');
  await table.act('b', 'check');
  for (let i = 0; i < 3; i++) {
    await table.act('b', 'check');
    await table.act('a', 'check');
  }
  assert.equal(table.lastResult.winners.length, 2);
  assert.match(table.lastResult.winners[0].reason, /^Split pot: [AB] and [AB] hold the same hand/);
});

test('buy-ins default to the table stack and must fit the table limits', () => {
  const table = new Table({ id: 't', name: 'T', rankHands: async () => ({ results: [] }) });
  assert.equal(table.buyInAmount(undefined), 1000);
  assert.equal(table.buyInAmount('400'), 400);
  assert.throws(() => table.buyInAmount(199), /between 200 and 5000/);
  assert.throws(() => table.buyInAmount(5001), GameError);
  assert.throws(() => table.buyInAmount(250.5), GameError);
  table.addPlayer({ id: 'a', name: 'A', chips: 400, userId: 7 });
  const [a] = table.players;
  assert.deepEqual([a.chips, a.buyIn, a.userId], [400, 400, 7]);
  assert.deepEqual(table.summary().minBuyIn, 200);
});

test('a rebuy is for the amount the player sat down with', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 1, b: 0 } });
  table.findPlayer('b').buyIn = 300;
  await table.startHand();
  await table.act(actor(table), 'allin');
  await table.act(actor(table), 'call');
  assert.equal(table.findPlayer('b').chips, 0);
  assert.throws(() => table.rebuy('a'), /only rebuy/);
  table.rebuy('b');
  assert.equal(table.findPlayer('b').chips, 300);
  assert.equal(table.view('b').you.buyIn, 300);
});

test('normal tables are humans only; practice tables take bots', () => {
  const normal = makeTable(['a']);
  assert.equal(normal.mode, 'normal');
  assert.throws(() => normal.addPlayer({ id: 'bot', name: 'Bot', isBot: true }), /practice tables/);
  const practice = makeTable(['a'], { mode: 'bot' });
  practice.addPlayer({ id: 'bot', name: 'Bot', isBot: true });
  assert.equal(practice.summary().mode, 'bot');
  assert.equal(practice.view('a').mode, 'bot');
  assert.throws(() => makeTable([], { mode: 'ranked' }), /Unknown table type/);
});

test('each player keeps hands played, hands won, biggest win and total buy-in', async () => {
  const table = makeTable(['a', 'b'], { scores: { a: 2, b: 1 } });
  await table.startHand();
  await table.act(actor(table), 'allin');
  await table.act(actor(table), 'call');
  const [a, b] = ['a', 'b'].map((id) => table.findPlayer(id));
  assert.deepEqual([a.handsPlayed, a.handsWon, a.biggestWin], [1, 1, 1000]);
  assert.deepEqual([b.handsPlayed, b.handsWon, b.biggestWin], [1, 0, 0]);
  table.rebuy('b');
  assert.equal(b.totalBuyIn, 2000);
});

test('a hand cancelled by the evaluator does not count towards the stats', async () => {
  const table = makeTable(['a', 'b'], { rankHands: async () => { throw new Error('down'); } });
  await table.startHand();
  await table.act(actor(table), 'allin');
  await table.act(actor(table), 'call');
  assert.equal(table.findPlayer('a').handsPlayed, 0);
});

test('the first human seated hosts the table and only they can start it', async () => {
  const table = makeTable([], { mode: 'bot' });
  table.addPlayer({ id: 'bot', name: 'Bot', isBot: true });
  table.addPlayer({ id: 'a', name: 'A' });
  table.addPlayer({ id: 'b', name: 'B' });
  assert.equal(table.hostId, 'a', 'bots never host');
  assert.equal(table.view('a').you.isHost, true);
  assert.equal(table.view('a').you.canStart, true);
  assert.equal(table.view('b').you.canStart, false);
  assert.throws(() => table.start('b'), /Only the table's host/);
  table.start('a');
  assert.equal(table.summary().started, true);
  assert.throws(() => table.start('a'), /already started/);
});

test('the host cannot start alone, and hands the table on when leaving', async () => {
  const table = makeTable(['a']);
  assert.throws(() => table.start('a'), /at least two players/);
  table.addPlayer({ id: 'b', name: 'B' });
  table.addPlayer({ id: 'c', name: 'C' });
  await table.removePlayer('a');
  assert.equal(table.hostId, 'b');
  assert.equal(table.view('c').hostName, 'B');
  await table.removePlayer('b');
  await table.removePlayer('c');
  assert.equal(table.hostId, null);
});

test('a host who leaves mid-hand passes the table on once the hand ends', async () => {
  const table = makeTable(['a', 'b', 'c']);
  table.start('a');
  await table.startHand();
  await table.removePlayer('a');
  assert.equal(table.hostId, 'a', 'still seated until the hand is over');
  while (table.inProgress) await table.act(actor(table), 'fold');
  assert.equal(table.hostId, 'b');
});
