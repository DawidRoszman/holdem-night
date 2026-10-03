'use strict';

// A deliberately simple "calling station" bot: it never folds when it can
// check and always calls a bet. Predictable behaviour keeps games (and e2e
// tests) moving without a second human.
function decide(legal) {
  if (!legal) return null;
  if (legal.canCheck) return { action: 'check' };
  return { action: 'call' };
}

module.exports = { decide };
