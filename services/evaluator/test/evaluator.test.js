'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreFive, bestHand, compareScores, rankPlayers, parseCard } = require('../src/evaluator');

const cat = (cards) => scoreFive(cards)[0];

test('parseCard parses rank and suit', () => {
  assert.deepEqual(parseCard('As'), { rank: 14, suit: 's' });
  assert.deepEqual(parseCard('Td'), { rank: 10, suit: 'd' });
  assert.throws(() => parseCard('1x'));
  assert.throws(() => parseCard('A'));
});

test('recognises every hand category', () => {
  assert.equal(cat(['As', 'Ks', 'Qs', 'Js', 'Ts']), 8);
  assert.equal(cat(['9c', '9d', '9h', '9s', '2c']), 7);
  assert.equal(cat(['Kc', 'Kd', 'Kh', '2s', '2c']), 6);
  assert.equal(cat(['2h', '7h', '9h', 'Jh', 'Ah']), 5);
  assert.equal(cat(['5c', '6d', '7h', '8s', '9c']), 4);
  assert.equal(cat(['7c', '7d', '7h', 'Ks', '2c']), 3);
  assert.equal(cat(['7c', '7d', '3h', '3s', 'Ac']), 2);
  assert.equal(cat(['7c', '7d', '3h', '4s', 'Ac']), 1);
  assert.equal(cat(['2c', '7d', '9h', 'Js', 'Ac']), 0);
});

test('wheel straight is five-high and loses to six-high', () => {
  const wheel = scoreFive(['Ac', '2d', '3h', '4s', '5c']);
  assert.deepEqual(wheel, [4, 5]);
  assert.ok(compareScores(scoreFive(['2c', '3d', '4h', '5s', '6c']), wheel) > 0);
});

test('A-K-Q-J-T is broadway, not a wrap-around', () => {
  assert.deepEqual(scoreFive(['Ac', 'Kd', 'Qh', 'Js', 'Tc']), [4, 14]);
  assert.equal(cat(['Qc', 'Kd', 'Ah', '2s', '3c']), 0);
});

test('kickers break ties', () => {
  const pairAceKicker = scoreFive(['8c', '8d', 'Ah', '4s', '3c']);
  const pairKingKicker = scoreFive(['8h', '8s', 'Kh', '4d', '3d']);
  assert.ok(compareScores(pairAceKicker, pairKingKicker) > 0);
  const twoPairHigh = scoreFive(['Jc', 'Jd', '4h', '4s', '9c']);
  const twoPairLow = scoreFive(['Th', 'Ts', '9h', '9d', 'Ac']);
  assert.ok(compareScores(twoPairHigh, twoPairLow) > 0);
});

test('bestHand picks the best five of seven cards', () => {
  const hand = bestHand(['Ah', 'Kh', '2h', '7h', '9h', 'Ac', 'Ad']);
  assert.equal(hand.name, 'Flush');
  assert.equal(hand.cards.length, 5);
});

test('bestHand rejects duplicates and wrong counts', () => {
  assert.throws(() => bestHand(['Ah', 'Ah', '2c', '3d', '4s']), /Duplicate/);
  assert.throws(() => bestHand(['Ah', '2c', '3d', '4s']));
});

test('rankPlayers finds a single winner', () => {
  const board = ['2c', '7d', '9h', 'Js', 'Kc'];
  const { winners, results } = rankPlayers(board, [
    { id: 'a', hole: ['Ah', 'Ad'] },
    { id: 'b', hole: ['Kh', 'Kd'] },
  ]);
  assert.deepEqual(winners, ['b']);
  assert.equal(results.find((r) => r.id === 'b').name, 'Three of a Kind');
});

test('rankPlayers splits when the board plays', () => {
  const board = ['Ts', 'Js', 'Qs', 'Ks', 'As'];
  const { winners } = rankPlayers(board, [
    { id: 'a', hole: ['2c', '3d'] },
    { id: 'b', hole: ['4c', '5d'] },
  ]);
  assert.deepEqual(winners.sort(), ['a', 'b']);
});
