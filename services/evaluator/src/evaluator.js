'use strict';

// Cards are two-character strings: rank + suit, e.g. "As", "Td", "2c".
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

const CATEGORY_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

function parseCard(card) {
  if (typeof card !== 'string' || card.length !== 2) {
    throw new Error(`Invalid card: ${JSON.stringify(card)}`);
  }
  const rank = RANKS.indexOf(card[0].toUpperCase()) + 2;
  const suit = card[1].toLowerCase();
  if (rank < 2 || !SUITS.includes(suit)) {
    throw new Error(`Invalid card: ${JSON.stringify(card)}`);
  }
  return { rank, suit };
}

// Returns the top rank of a straight in the given (descending, unique) ranks, or 0.
function straightHigh(uniqueDesc) {
  const ranks = uniqueDesc.includes(14) ? [...uniqueDesc, 1] : uniqueDesc;
  for (let i = 0; i + 4 < ranks.length; i++) {
    if (ranks[i] - ranks[i + 4] === 4) return ranks[i];
  }
  return 0;
}

// Scores exactly five cards. Higher score arrays (compared lexicographically) win.
function scoreFive(cards) {
  const parsed = cards.map(parseCard);
  const ranks = parsed.map((c) => c.rank).sort((a, b) => b - a);
  const isFlush = parsed.every((c) => c.suit === parsed[0].suit);
  const unique = [...new Set(ranks)];
  const high = unique.length === 5 ? straightHigh(unique) : 0;

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Group by count desc, then rank desc: e.g. full house KKK22 -> [[3,13],[2,2]]
  const groups = [...counts.entries()]
    .map(([rank, count]) => [count, rank])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const byGroup = groups.map((g) => g[1]);

  if (high && isFlush) return [8, high];
  if (groups[0][0] === 4) return [7, ...byGroup];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
  if (isFlush) return [5, ...ranks];
  if (high) return [4, high];
  if (groups[0][0] === 3) return [3, ...byGroup];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
  if (groups[0][0] === 2) return [1, ...byGroup];
  return [0, ...ranks];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function* combinations(items, k, start = 0, picked = []) {
  if (picked.length === k) {
    yield picked;
    return;
  }
  for (let i = start; i <= items.length - (k - picked.length); i++) {
    yield* combinations(items, k, i + 1, [...picked, items[i]]);
  }
}

// Finds the best five-card hand out of 5..7 cards.
function bestHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error('bestHand requires between 5 and 7 cards');
  }
  if (new Set(cards.map((c) => c.toUpperCase())).size !== cards.length) {
    throw new Error('Duplicate cards');
  }
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const score = scoreFive(combo);
    if (!best || compareScores(score, best.score) > 0) {
      best = { score, cards: combo };
    }
  }
  return { ...best, name: CATEGORY_NAMES[best.score[0]] };
}

// Ranks several players sharing a board. Returns results plus the ids of the winners.
function rankPlayers(board, players) {
  const results = players.map((p) => {
    const hand = bestHand([...p.hole, ...board]);
    return { id: p.id, score: hand.score, name: hand.name, cards: hand.cards };
  });
  let winners = [];
  for (const r of results) {
    if (!winners.length) winners = [r];
    else {
      const cmp = compareScores(r.score, winners[0].score);
      if (cmp > 0) winners = [r];
      else if (cmp === 0) winners.push(r);
    }
  }
  return { results, winners: winners.map((w) => w.id) };
}

module.exports = { parseCard, scoreFive, bestHand, compareScores, rankPlayers, CATEGORY_NAMES };
