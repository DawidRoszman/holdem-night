'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeScore, explainWin } = require('../src/describe');

test('describes every hand category', () => {
  assert.equal(describeScore([0, 14, 11, 9, 6, 3]), 'Ace high');
  assert.equal(describeScore([1, 12, 14, 9, 3]), 'Pair of Queens');
  assert.equal(describeScore([2, 13, 7, 2]), 'Two Pair, Kings and Sevens');
  assert.equal(describeScore([3, 8, 13, 3]), 'Three Eights');
  assert.equal(describeScore([4, 5]), 'Five-high Straight');
  assert.equal(describeScore([5, 14, 11, 8, 5, 2]), 'Ace-high Flush');
  assert.equal(describeScore([6, 10, 4]), 'Full House, Tens full of Fours');
  assert.equal(describeScore([7, 9, 2]), 'Four Nines');
  assert.equal(describeScore([8, 9]), 'Nine-high Straight Flush');
  assert.equal(describeScore([8, 14]), 'Royal Flush');
});

test('falls back to the category when ranks are missing', () => {
  assert.equal(describeScore([3]), 'Three of a Kind');
});

test('explains a win by a better category', () => {
  assert.equal(
    explainWin({ score: [3, 12, 9, 4] }, { name: 'Bob', score: [2, 13, 7, 2] }),
    "Three Queens beats Bob's Two Pair, Kings and Sevens",
  );
});

test('explains a win by a higher made hand in the same category', () => {
  assert.equal(
    explainWin({ score: [1, 14, 9, 5, 3] }, { name: 'Bob', score: [1, 13, 14, 9, 5] }),
    "Pair of Aces beats Bob's Pair of Kings",
  );
  assert.equal(
    explainWin({ score: [2, 13, 9, 4] }, { name: 'Bob', score: [2, 13, 7, 14] }),
    "Two Pair, Kings and Nines beats Bob's Two Pair, Kings and Sevens",
  );
});

test('explains a win on a kicker', () => {
  assert.equal(
    explainWin({ score: [1, 14, 13, 7, 3] }, { name: 'Bob', score: [1, 14, 10, 7, 3] }),
    "Pair of Aces with a King kicker beats Bob's Ten kicker",
  );
  assert.equal(
    explainWin({ score: [5, 14, 12, 8, 5, 2] }, { name: 'Bob', score: [5, 14, 11, 8, 5, 2] }),
    "Ace-high Flush with a Queen card beats Bob's Jack card",
  );
  assert.equal(
    explainWin({ score: [0, 14, 12, 8, 5, 2] }, { name: 'Bob', score: [0, 14, 11, 8, 5, 2] }),
    "Ace high with a Queen card beats Bob's Jack card",
  );
});

test('reports a tie', () => {
  assert.equal(explainWin({ score: [4, 9] }, { name: 'Bob', score: [4, 9] }), 'Nine-high Straight ties Bob');
});
