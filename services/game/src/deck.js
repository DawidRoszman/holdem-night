'use strict';

const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

// Fisher-Yates shuffle using a cryptographically secure RNG.
function shuffledDeck(randomInt = crypto.randomInt) {
  const deck = freshDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = { freshDeck, shuffledDeck };
