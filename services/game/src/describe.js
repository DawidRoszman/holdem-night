'use strict';

// Turns evaluator scores ([category, ...ranks], ace = 14) into plain-English
// explanations of hands and of why one hand beat another.

const SINGULAR = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const PLURAL = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const CATEGORY = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

// How many leading ranks (after the category) define the made hand; the rest are kickers.
const MADE_RANKS = [1, 1, 2, 1, 1, 5, 2, 1, 1];

function describeScore(score) {
  const [cat, a, b] = score;
  if (!SINGULAR[a]) return CATEGORY[cat] || 'Unknown hand';
  switch (cat) {
    case 0: return `${SINGULAR[a]} high`;
    case 1: return `Pair of ${PLURAL[a]}`;
    case 2: return `Two Pair, ${PLURAL[a]} and ${PLURAL[b]}`;
    case 3: return `Three ${PLURAL[a]}`;
    case 4: return `${SINGULAR[a]}-high Straight`;
    case 5: return `${SINGULAR[a]}-high Flush`;
    case 6: return `Full House, ${PLURAL[a]} full of ${PLURAL[b]}`;
    case 7: return `Four ${PLURAL[a]}`;
    case 8: return a === 14 ? 'Royal Flush' : `${SINGULAR[a]}-high Straight Flush`;
    default: return 'Unknown hand';
  }
}

// One sentence on why `winner` beat `loser` ({ name, score } each).
function explainWin(winner, loser) {
  const w = winner.score;
  const l = loser.score;
  const wDesc = describeScore(w);
  const lDesc = describeScore(l);
  if (w[0] !== l[0]) return `${wDesc} beats ${loser.name}'s ${lDesc}`;
  let i = 1;
  while (i < Math.max(w.length, l.length) && (w[i] || 0) === (l[i] || 0)) i++;
  if (i >= Math.max(w.length, l.length)) return `${wDesc} ties ${loser.name}`;
  if (i <= MADE_RANKS[w[0]] && wDesc !== lDesc) return `${wDesc} beats ${loser.name}'s ${lDesc}`;
  // same made hand: the first different card decides
  const label = w[0] === 5 || w[0] === 0 ? 'card' : 'kicker';
  return `${wDesc} with a ${SINGULAR[w[i]]} ${label} beats ${loser.name}'s ${SINGULAR[l[i]]} ${label}`;
}

module.exports = { describeScore, explainWin };
