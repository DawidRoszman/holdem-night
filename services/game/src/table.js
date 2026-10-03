'use strict';

const { shuffledDeck } = require('./deck');
const { describeScore, explainWin } = require('./describe');

const BETTING_STAGES = ['preflop', 'flop', 'turn', 'river'];
const LOG_LIMIT = 30;
// 'normal' tables are humans only and play for bank chips; 'bot' tables are free practice
const MODES = ['normal', 'bot'];

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

class GameError extends Error {}

/**
 * A single no-limit Texas Hold'em table.
 *
 * `rankHands(board, [{id, hole}])` is async and must resolve to
 * `{ results: [{ id, score: number[], name }] }` — in production it calls the
 * evaluator microservice.
 *
 * `mode` is 'normal' (humans only, chips come from the players' banks) or
 * 'bot' (practice: bots allowed, chips are free and never reach a bank).
 */
class Table {
  constructor({
    id,
    name,
    mode = 'normal',
    smallBlind = 10,
    bigBlind = 20,
    startingChips = 1000,
    maxPlayers = 6,
    rankHands,
    deckFactory = shuffledDeck,
    onEvent = () => {},
  }) {
    if (typeof rankHands !== 'function') throw new Error('rankHands is required');
    if (!MODES.includes(mode)) throw new GameError('Unknown table type');
    this.id = id;
    this.name = name;
    this.mode = mode;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.startingChips = startingChips;
    this.maxPlayers = maxPlayers;
    this.minBuyIn = bigBlind * 10;
    this.maxBuyIn = bigBlind * 250;
    this.rankHands = rankHands;
    this.deckFactory = deckFactory;
    this.onEvent = onEvent;

    this.seats = new Array(maxPlayers).fill(null);
    this.stage = 'waiting';
    this.button = -1;
    this.toAct = -1;
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.handNumber = 0;
    this.log = [];
    this.lastResult = null;
    // the host (first human seated) starts the game; until then no hand is dealt
    this.hostId = null;
    this.started = false;
  }

  // ---------------------------------------------------------------- seating

  get players() {
    return this.seats.filter(Boolean);
  }

  findPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  get isFull() {
    return this.players.length >= this.maxPlayers;
  }

  get inProgress() {
    return BETTING_STAGES.includes(this.stage) || this.stage === 'showdown';
  }

  // Validates a requested buy-in; no amount means the table's default.
  buyInAmount(raw) {
    if (raw === undefined || raw === null || raw === '') return this.startingChips;
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount < this.minBuyIn || amount > this.maxBuyIn) {
      throw new GameError(`Buy-in must be between ${this.minBuyIn} and ${this.maxBuyIn} chips`);
    }
    return amount;
  }

  get isPractice() {
    return this.mode === 'bot';
  }

  addPlayer({ id, name, isBot = false, chips = this.startingChips, userId = null, joinedAt = Date.now() }) {
    if (isBot && !this.isPractice) throw new GameError('Bots can only play at practice tables');
    if (this.findPlayer(id)) throw new GameError('Already seated at this table');
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new GameError('Table is full');
    this.seats[seat] = {
      id,
      name,
      isBot,
      userId,
      seat,
      buyIn: chips,
      chips,
      hole: [],
      bet: 0,
      totalBet: 0,
      inHand: false,
      folded: false,
      allIn: false,
      acted: false,
      leaving: false,
      // for the player's game history
      joinedAt,
      totalBuyIn: chips,
      handsPlayed: 0,
      handsWon: 0,
      biggestWin: 0,
    };
    this.addLog(`${name} sits down at seat ${seat + 1}`);
    if (!isBot && !this.hostId) this.hostId = id;
    return seat;
  }

  async removePlayer(id) {
    const p = this.findPlayer(id);
    if (!p) return;
    if (this.inProgress && p.inHand && !p.folded) {
      p.leaving = true;
      if (this.seats[this.toAct] === p) {
        await this.act(id, 'fold');
      } else {
        p.folded = true;
        this.addLog(`${p.name} folds`);
        await this.advance(false);
      }
      // the hand may have finished (and the player been removed) during the fold
      if (!this.findPlayer(id)) return;
    }
    if (this.inProgress && p.inHand) {
      // keep the folded player's chips in the pot until the hand ends
      p.leaving = true;
      return;
    }
    this.addLog(`${p.name} leaves the table`);
    this.vacate(p);
  }

  // Frees a seat; a departing host hands the table to the next human still playing.
  vacate(p) {
    this.seats[p.seat] = null;
    if (p.id === this.hostId) {
      const next = this.players.find((o) => !o.isBot && !o.leaving);
      this.hostId = next ? next.id : null;
      if (next) this.addLog(`${next.name} is now the host`);
    }
    this.onEvent('removed', p);
  }

  get host() {
    return this.hostId ? this.findPlayer(this.hostId) : null;
  }

  // Only the host starts the game, once enough players have chips. Later hands follow on their own.
  start(id) {
    if (this.started) throw new GameError('The game has already started');
    if (id !== this.hostId) throw new GameError("Only the table's host can start the game");
    if (!this.canStart()) throw new GameError('Need at least two players with chips to start');
    this.started = true;
    this.addLog(`${this.host.name} starts the game`);
  }

  canStart() {
    return !this.inProgress && this.players.filter((p) => p.chips > 0 && !p.leaving).length >= 2;
  }

  // Out-of-chips players sit out until they rebuy or leave; bots cannot rebuy.
  isBusted(p) {
    return p.chips === 0 && !(this.inProgress && p.inHand);
  }

  hasBustedBots() {
    return this.players.some((p) => p.isBot && this.isBusted(p));
  }

  // Removes busted bots. Called between hands, after everyone has seen the result.
  clearBusted() {
    for (const p of this.players) {
      if (p.isBot && this.isBusted(p)) {
        this.addLog(`${p.name} leaves the table`);
        this.vacate(p);
      }
    }
  }

  // Throws unless the player is seated and out of chips.
  checkRebuy(id) {
    const p = this.findPlayer(id);
    if (!p) throw new GameError('You are not at this table');
    if (!this.isBusted(p)) throw new GameError('You can only rebuy when you are out of chips');
    return p;
  }

  // A rebuy is for the same amount the player sat down with.
  rebuy(id) {
    const p = this.checkRebuy(id);
    p.chips = p.buyIn;
    p.totalBuyIn += p.buyIn;
    this.addLog(`${p.name} rebuys for ${p.buyIn}`);
  }

  // ---------------------------------------------------------------- helpers

  addLog(text) {
    this.log.push(text);
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  nextSeat(from, predicate) {
    for (let i = 1; i <= this.maxPlayers; i++) {
      const idx = (((from + i) % this.maxPlayers) + this.maxPlayers) % this.maxPlayers;
      const p = this.seats[idx];
      if (p && predicate(p)) return idx;
    }
    return -1;
  }

  livePlayers() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  canAct(p) {
    return p.inHand && !p.folded && !p.allIn;
  }

  pay(p, amount) {
    const paid = Math.min(amount, p.chips);
    p.chips -= paid;
    p.bet += paid;
    p.totalBet += paid;
    if (p.chips === 0) p.allIn = true;
    return paid;
  }

  get pot() {
    return this.players.reduce((sum, p) => sum + p.totalBet, 0);
  }

  // ---------------------------------------------------------------- hand flow

  async startHand() {
    this.clearBusted();
    if (!this.canStart()) throw new GameError('Need at least two players with chips');
    this.handNumber += 1;
    this.board = [];
    this.lastResult = null;
    for (const p of this.players) {
      Object.assign(p, {
        hole: [],
        bet: 0,
        totalBet: 0,
        folded: false,
        allIn: false,
        acted: false,
        inHand: p.chips > 0 && !p.leaving,
        startChips: p.chips,
      });
    }
    const inHand = (p) => p.inHand;
    const headsUp = this.players.filter(inHand).length === 2;

    this.button = this.nextSeat(this.button, inHand);
    const sbSeat = headsUp ? this.button : this.nextSeat(this.button, inHand);
    const bbSeat = this.nextSeat(sbSeat, inHand);

    this.addLog(`--- Hand #${this.handNumber} ---`);
    const sb = this.seats[sbSeat];
    const bb = this.seats[bbSeat];
    this.addLog(`${sb.name} posts small blind ${this.pay(sb, this.smallBlind)}`);
    this.addLog(`${bb.name} posts big blind ${this.pay(bb, this.bigBlind)}`);

    this.deck = this.deckFactory().slice();
    let seat = this.button;
    for (let i = 0; i < this.players.filter(inHand).length; i++) {
      seat = this.nextSeat(seat, inHand);
      this.seats[seat].hole = [this.deck.shift(), this.deck.shift()];
    }

    this.stage = 'preflop';
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.toAct = this.nextSeat(bbSeat, (p) => this.canAct(p));
    await this.advance(false);
  }

  legalActions(p) {
    if (!BETTING_STAGES.includes(this.stage) || this.seats[this.toAct] !== p) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.chips);
    const maxRaiseTo = p.bet + p.chips;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);
    return {
      toCall,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise: maxRaiseTo > this.currentBet,
      minRaiseTo,
      maxRaiseTo,
    };
  }

  async act(playerId, action, amount) {
    if (!BETTING_STAGES.includes(this.stage)) throw new GameError('No betting round in progress');
    const p = this.seats[this.toAct];
    if (!p || p.id !== playerId) throw new GameError('Not your turn');
    const legal = this.legalActions(p);

    switch (action) {
      case 'fold':
        p.folded = true;
        this.addLog(`${p.name} folds`);
        break;
      case 'check':
        if (!legal.canCheck) throw new GameError(`Cannot check, ${legal.toCall} to call`);
        this.addLog(`${p.name} checks`);
        break;
      case 'call':
        if (!legal.canCall) throw new GameError('Nothing to call');
        this.pay(p, legal.toCall);
        this.addLog(`${p.name} calls ${legal.toCall}${p.allIn ? ' (all-in)' : ''}`);
        break;
      case 'allin':
        if (p.bet + p.chips > this.currentBet) {
          this.raiseTo(p, p.bet + p.chips);
        } else {
          this.addLog(`${p.name} calls ${p.chips} (all-in)`);
          this.pay(p, p.chips);
        }
        break;
      case 'bet':
      case 'raise': {
        const target = Number(amount);
        if (!Number.isInteger(target)) throw new GameError('Raise amount must be a whole number');
        if (!legal.canRaise) throw new GameError('Cannot raise');
        if (target > legal.maxRaiseTo) throw new GameError('Not enough chips');
        if (target <= this.currentBet) throw new GameError(`Raise must be above ${this.currentBet}`);
        if (target < legal.minRaiseTo) throw new GameError(`Minimum raise is to ${legal.minRaiseTo}`);
        this.raiseTo(p, target);
        break;
      }
      default:
        throw new GameError(`Unknown action: ${action}`);
    }
    p.acted = true;
    await this.advance(true);
  }

  raiseTo(p, target) {
    const raiseSize = target - this.currentBet;
    const verb = this.currentBet === 0 ? 'bets' : 'raises to';
    // an all-in for less than a full raise does not change the minimum raise
    if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
    this.pay(p, target - p.bet);
    this.currentBet = target;
    for (const other of this.players) if (other !== p) other.acted = false;
    this.addLog(`${p.name} ${verb} ${target}${p.allIn ? ' (all-in)' : ''}`);
  }

  roundComplete() {
    const live = this.livePlayers();
    const actors = live.filter((p) => !p.allIn);
    if (actors.length === 0) return true;
    if (actors.length === 1) {
      const [actor] = actors;
      if (actor.acted && actor.bet >= this.currentBet) return true;
      const maxOther = Math.max(0, ...live.filter((p) => p !== actor).map((p) => p.bet));
      return actor.bet >= maxOther;
    }
    return actors.every((p) => p.acted && p.bet === this.currentBet);
  }

  async advance(moveTurn) {
    if (this.livePlayers().length === 1) {
      this.finishUncontested(this.livePlayers()[0]);
      return;
    }
    while (this.roundComplete()) {
      if (this.stage === 'river') {
        await this.showdown();
        return;
      }
      this.nextStreet();
      moveTurn = false;
    }
    if (moveTurn || !this.canAct(this.seats[this.toAct] || {})) {
      this.toAct = this.nextSeat(this.toAct, (p) => this.canAct(p));
    }
  }

  nextStreet() {
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.stage];
    const count = next === 'flop' ? 3 : 1;
    this.board.push(...this.deck.splice(0, count));
    this.stage = next;
    this.addLog(`${next[0].toUpperCase()}${next.slice(1)}: ${this.board.join(' ')}`);
    this.toAct = this.nextSeat(this.button, (p) => this.canAct(p));
  }

  // ---------------------------------------------------------------- payouts

  // Splits contributions into main pot and side pots, each with its eligible players.
  buildPots() {
    const contributors = this.players.filter((p) => p.totalBet > 0);
    const live = this.livePlayers();
    const levels = [...new Set(live.map((p) => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const amount = contributors.reduce(
        (sum, p) => sum + Math.max(0, Math.min(p.totalBet, level) - prev),
        0,
      );
      const eligible = live.filter((p) => p.totalBet >= level);
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length) last.amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // chips from folded players above every live player's contribution
    const leftover = contributors.reduce((sum, p) => sum + Math.max(0, p.totalBet - prev), 0);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  async showdown() {
    this.stage = 'showdown';
    this.toAct = -1;
    const live = this.livePlayers();
    let ranking;
    try {
      ranking = await this.rankHands(
        this.board,
        live.map((p) => ({ id: p.id, hole: p.hole })),
      );
    } catch (err) {
      this.addLog(`Hand evaluation failed (${err.message}); bets returned`);
      for (const p of this.players) p.chips += p.totalBet;
      this.endHand({ winners: [], shown: {}, error: err.message });
      return;
    }
    const byId = new Map(ranking.results.map((r) => [r.id, r]));
    const won = new Map();
    const reasons = new Map(); // winner id -> why they won (from the first pot they take)

    for (const pot of this.buildPots()) {
      let best = [];
      for (const p of pot.eligible) {
        const cmp = best.length ? compareScores(byId.get(p.id).score, byId.get(best[0].id).score) : 1;
        if (cmp > 0) best = [p];
        else if (cmp === 0) best.push(p);
      }
      // odd chips go to the first winner clockwise from the button
      best.sort(
        (a, b) =>
          ((a.seat - this.button + this.maxPlayers - 1) % this.maxPlayers) -
          ((b.seat - this.button + this.maxPlayers - 1) % this.maxPlayers),
      );
      if (!reasons.has(best[0].id)) {
        const beaten = pot.eligible
          .filter((p) => !best.includes(p))
          .sort((a, b) => compareScores(byId.get(b.id).score, byId.get(a.id).score))[0];
        const winner = { score: byId.get(best[0].id).score };
        let reason;
        if (best.length > 1) {
          reason = `Split pot: ${best.map((p) => p.name).join(' and ')} hold the same hand, ${describeScore(winner.score)}`;
        } else if (beaten) {
          reason = explainWin(winner, { name: beaten.name, score: byId.get(beaten.id).score });
        } else {
          reason = 'Uncalled chips returned';
        }
        for (const p of best) if (!reasons.has(p.id)) reasons.set(p.id, reason);
      }
      const share = Math.floor(pot.amount / best.length);
      let remainder = pot.amount - share * best.length;
      for (const w of best) {
        const amount = share + (remainder-- > 0 ? 1 : 0);
        w.chips += amount;
        won.set(w.id, (won.get(w.id) || 0) + amount);
      }
    }

    const shown = {};
    for (const p of live) {
      const r = byId.get(p.id);
      shown[p.id] = { hole: p.hole, hand: r.name, description: describeScore(r.score), best: r.cards || [] };
      this.addLog(`${p.name} shows ${p.hole.join(' ')} (${byId.get(p.id).name})`);
    }
    const winners = [...won.entries()].map(([id, amount]) => {
      const p = this.findPlayer(id);
      const r = byId.get(id);
      const why = reasons.get(id);
      this.addLog(`${p.name} wins ${amount} with ${r.name}${why ? ` (${why})` : ''}`);
      return {
        id,
        name: p.name,
        amount,
        hand: r.name,
        description: describeScore(r.score),
        best: r.cards || [],
        reason: reasons.get(id),
      };
    });
    this.endHand({ winners, shown });
  }

  finishUncontested(winner) {
    const amount = this.pot;
    winner.chips += amount;
    this.addLog(`${winner.name} wins ${amount}`);
    this.endHand({
      winners: [{ id: winner.id, name: winner.name, amount, hand: null, reason: 'Everyone else folded' }],
      shown: {},
    });
  }

  // The result stays visible (stage 'handOver') until the next hand starts.
  endHand(result) {
    this.stage = 'handOver';
    this.toAct = -1;
    // net chip change for everyone dealt in, so each player can see what they won or lost
    const deltas = {};
    const busted = [];
    for (const p of this.players) {
      p.bet = 0;
      p.totalBet = 0;
      if (!p.inHand) continue;
      deltas[p.id] = p.chips - p.startChips;
      // a cancelled hand (bets returned) doesn't count
      if (!result.error) {
        p.handsPlayed += 1;
        if (deltas[p.id] > 0) p.handsWon += 1;
        p.biggestWin = Math.max(p.biggestWin, deltas[p.id]);
      }
      if (p.chips === 0 && !p.leaving) {
        busted.push({ id: p.id, name: p.name });
        this.addLog(`${p.name} is out of chips`);
      }
    }
    this.lastResult = { ...result, deltas, busted };
    for (const p of this.players) {
      if (p.leaving) {
        this.vacate(p);
      }
    }
  }

  // ---------------------------------------------------------------- views

  // State as seen by one player: other players' hole cards stay hidden until showdown.
  view(forId) {
    const shown = (this.lastResult && this.lastResult.shown) || {};
    const me = this.findPlayer(forId);
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      started: this.started,
      hostId: this.hostId,
      hostName: this.host ? this.host.name : null,
      stage: this.stage,
      handNumber: this.handNumber,
      board: this.board,
      pot: this.pot,
      currentBet: this.currentBet,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      button: this.button,
      toAct: this.toAct,
      maxPlayers: this.maxPlayers,
      seats: this.seats.map((p) => {
        if (!p) return null;
        let cards = [];
        if (p.id === forId || shown[p.id]) cards = p.hole;
        else if (p.inHand && !p.folded && this.inProgress) cards = ['??', '??'];
        return {
          seat: p.seat,
          id: p.id,
          name: p.name,
          chips: p.chips,
          bet: p.bet,
          isBot: p.isBot,
          inHand: p.inHand,
          folded: p.folded,
          allIn: p.allIn,
          busted: this.isBusted(p),
          cards,
        };
      }),
      log: this.log,
      lastResult: this.lastResult,
      startingChips: this.startingChips,
      you: me
        ? {
          seat: me.seat,
          legal: this.legalActions(me),
          busted: this.isBusted(me),
          buyIn: me.buyIn,
          isHost: me.id === this.hostId,
          canStart: me.id === this.hostId && !this.started && this.canStart(),
        }
        : null,
    };
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      started: this.started,
      players: this.players.length,
      maxPlayers: this.maxPlayers,
      stage: this.stage,
      blinds: `${this.smallBlind}/${this.bigBlind}`,
      startingChips: this.startingChips,
      minBuyIn: this.minBuyIn,
      maxBuyIn: this.maxBuyIn,
    };
  }
}

module.exports = { Table, GameError, compareScores, MODES };
