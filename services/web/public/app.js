import { Table3D } from './table3d.js';

(() => {
  const $ = (id) => document.getElementById(id);
  const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  // seat positions (percent of the felt) for up to six players, index 0 = bottom centre
  const POSITIONS = [
    [50, 100], [3, 72], [12, 8], [50, -4], [88, 8], [97, 72],
  ];

  // strongest first; example hands are rendered as cards in the cheat sheet
  const HAND_RANKINGS = [
    ['Royal Flush', 'A, K, Q, J, 10, all of the same suit.', ['As', 'Ks', 'Qs', 'Js', 'Ts']],
    ['Straight Flush', 'Five cards in sequence, all of the same suit.', ['9h', '8h', '7h', '6h', '5h']],
    ['Four of a Kind', 'Four cards of the same rank.', ['Qc', 'Qd', 'Qh', 'Qs', '3d']],
    ['Full House', 'Three of a kind plus a pair.', ['Kd', 'Kh', 'Ks', '7c', '7d']],
    ['Flush', 'Any five cards of the same suit, not in sequence.', ['Ad', 'Jd', '8d', '5d', '2d']],
    ['Straight', 'Five cards in sequence of mixed suits. A-2-3-4-5 is the lowest.', ['Tc', '9d', '8s', '7h', '6c']],
    ['Three of a Kind', 'Three cards of the same rank.', ['8c', '8d', '8s', 'Kh', '3c']],
    ['Two Pair', 'Two different pairs.', ['Jc', 'Jh', '4d', '4s', 'Ac']],
    ['One Pair', 'Two cards of the same rank.', ['Ts', 'Td', 'Kc', '7h', '2s']],
    ['High Card', 'None of the above: the highest card plays.', ['Ah', 'Jc', '9d', '6s', '3h']],
  ];

  // casino chip colours by denomination, largest first
  const DENOMINATIONS = [
    [1000, 'gold'], [500, 'purple'], [100, 'black'], [25, 'green'], [5, 'red'], [1, 'white'],
  ];
  const CHIPS_PER_COLUMN = 5;
  // how far a bet sits from its seat towards the centre of the felt
  const BET_PULL = 0.42;

  // three.js table; the CSS felt is the fallback when WebGL is unavailable
  let table3d = null;
  try {
    if (Table3D.supported()) table3d = new Table3D($('felt'));
  } catch (err) {
    console.warn('3D table unavailable, using the 2D table', err);
  }
  $('felt').classList.add(table3d ? 'felt-3d' : 'felt');

  // The login session (token + username) survives a page refresh within this
  // tab (sessionStorage), so a reload logs straight back in.
  const SESSION_KEY = 'holdem.session';
  const savedSession = {
    get() {
      try {
        const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
        return s && s.token ? s : null;
      } catch { return null; }
    },
    set(session) {
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* storage unavailable: just won't persist */ }
    },
    clear() {
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    },
  };

  const session = savedSession.get();
  const state = {
    ws: null,
    token: session && session.token,
    name: session && session.name,
    bank: null,
    playerId: null,
    table: null,
    screen: null,
    reconnectDelay: 500,
  };
  const CHIP_PACKS = [500, 1000, 5000];
  const formatChips = (n) => Number(n).toLocaleString('en-US');

  // ------------------------------------------------------------- accounts API

  async function api(path, { body, method = 'POST' } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(`/api/accounts${path}`, { method, headers, body: body && JSON.stringify(body) });
    } catch {
      throw new Error('Cannot reach the server');
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setBank(chips) {
    const changed = state.bank !== null && chips !== state.bank;
    state.bank = chips;
    renderUser();
    if (changed) {
      const pill = $('bank');
      pill.classList.remove('bump');
      void pill.offsetWidth; // restart the animation
      pill.classList.add('bump');
    }
  }

  // Buys a play-money pack; resolves to true when it went through.
  async function buyChips(amount) {
    try {
      const { chips } = await api('/buy', { body: { amount } });
      setBank(chips);
      toast(`Bought ${formatChips(amount)} chips`);
      return true;
    } catch (err) {
      if (err.status === 401) expireSession(err.message);
      else toast(err.message);
      return false;
    }
  }

  // ------------------------------------------------------------- transport

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    const ws = new WebSocket(wsUrl());
    state.ws = ws;
    ws.onopen = () => {
      setConnection('Connected', 'ok');
      state.reconnectDelay = 500;
      if (state.token) send({ type: 'hello', token: state.token });
    };
    ws.onmessage = (event) => handle(JSON.parse(event.data));
    ws.onclose = () => {
      setConnection('Disconnected – reconnecting…', 'bad');
      state.table = null;
      if (state.token && state.screen !== 'profile') show('lobby');
      setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 5000);
    };
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
  }

  function setConnection(text, cls) {
    const el = $('connection');
    el.textContent = text;
    el.className = `connection ${cls}`;
  }

  // ------------------------------------------------------------- messages

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        state.playerId = msg.playerId;
        state.name = msg.name;
        savedSession.set({ token: state.token, name: msg.name });
        $('welcome').textContent = `Welcome, ${msg.name}`;
        setBank(msg.chips);
        if (!state.table && state.screen !== 'profile') show('lobby');
        break;
      case 'authError':
        expireSession(msg.message);
        break;
      case 'account':
        setBank(msg.chips);
        break;
      case 'tables':
        renderTables(msg.tables);
        break;
      case 'state':
        state.table = msg.table;
        show('table');
        renderTable(msg.table);
        break;
      case 'left':
        state.table = null;
        closeBustedDialog();
        show('lobby');
        break;
      case 'error':
        toast(msg.message);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- rendering

  function renderUser() {
    const loggedIn = Boolean(state.token && state.name);
    $('user-name').textContent = state.name || '';
    $('user-initial').textContent = state.name ? state.name.trim()[0].toUpperCase() : '';
    $('user-menu').hidden = !loggedIn;
    // the profile is opened from the lobby; leave the table first
    $('profile-button').disabled = Boolean(state.table);
    const bank = state.bank === null ? '…' : formatChips(state.bank);
    $('bank-amount').textContent = bank;
    $('shop-balance').textContent = bank;
    if (state.table) renderBustedBank(state.table);
  }

  function signedIn(token, user) {
    state.token = token;
    state.name = user.username;
    state.bank = null;
    savedSession.set({ token, name: user.username });
    $('password-input').value = '';
    $('auth-error').hidden = true;
    // the server answers with a welcome, which opens the lobby
    if (state.ws && state.ws.readyState === WebSocket.OPEN) send({ type: 'hello', token });
  }

  function signedOut() {
    savedSession.clear();
    state.token = null;
    state.name = null;
    state.bank = null;
    state.playerId = null;
    state.table = null;
    closeBustedDialog();
    renderUser();
    $('password-input').value = '';
    show('login');
    // dropping the connection makes the server release our seat (and pay it back); we reconnect anonymously
    if (state.ws) state.ws.close();
  }

  function logOut() {
    // fire and forget: the token is dropped locally either way
    api('/logout').catch(() => {});
    signedOut();
  }

  function expireSession(message) {
    signedOut();
    showAuthError(message || 'Please log in again');
  }

  function showAuthError(message) {
    $('auth-error').textContent = message;
    $('auth-error').hidden = false;
  }

  function show(screen) {
    if (state.screen === 'profile' && screen !== 'profile') closeProfile();
    state.screen = screen;
    for (const s of ['login', 'lobby', 'table', 'profile']) $(`screen-${s}`).hidden = s !== screen;
    $('profile-button').disabled = Boolean(state.table);
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function renderTables(tables) {
    const list = $('table-list');
    list.replaceChildren();
    $('no-tables').hidden = tables.length > 0;
    for (const t of tables) {
      const li = document.createElement('li');
      li.className = 'lobby-row';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = '♠';
      const details = document.createElement('div');
      details.className = 'details';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.name;
      if (t.stage !== 'waiting') {
        const live = document.createElement('span');
        live.className = 'live';
        live.textContent = 'In play';
        name.append(live);
      }
      const mode = document.createElement('span');
      mode.className = `mode-badge${t.mode === 'bot' ? ' practice' : ''}`;
      mode.textContent = t.mode === 'bot' ? 'Practice' : 'Real chips';
      name.append(mode);
      const info = document.createElement('span');
      info.className = 'meta';
      info.textContent = `${t.players}/${t.maxPlayers} players · blinds ${t.blinds}`;
      details.append(name, info);
      const join = document.createElement('button');
      join.className = 'btn btn-secondary';
      join.textContent = t.players >= t.maxPlayers ? 'Full' : 'Join';
      join.id = `join-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      join.disabled = t.players >= t.maxPlayers;
      join.addEventListener('click', () => send({ type: 'joinTable', tableId: t.id, buyIn: buyIn() }));
      li.append(avatar, details, join);
      list.append(li);
    }
  }

  function cardEl(card) {
    const el = document.createElement('span');
    if (card === '??') {
      el.className = 'card back';
      el.textContent = '?';
      return el;
    }
    const rank = card[0] === 'T' ? '10' : card[0];
    const suit = card[1];
    el.className = `card${suit === 'h' || suit === 'd' ? ' red' : ''}`;
    el.textContent = `${rank}${SUIT_SYMBOLS[suit]}`;
    el.title = card;
    return el;
  }

  function chipEl(color) {
    const chip = document.createElement('span');
    chip.className = `chip chip-${color}`;
    return chip;
  }

  // Breaks an amount into denominations and draws them as stacked columns.
  function chipStack(amount, { label = String(amount), className = '' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `chip-stack ${className}`.trim();
    const columns = document.createElement('div');
    columns.className = 'chip-columns';
    columns.setAttribute('aria-hidden', 'true');
    let rest = amount;
    for (const [value, color] of DENOMINATIONS) {
      const count = Math.floor(rest / value);
      rest -= count * value;
      if (!count) continue;
      const col = document.createElement('span');
      col.className = 'chip-col';
      col.title = `${count} × ${value}`;
      // a face-up chip on top of the chips below it, seen edge-on
      col.append(chipEl(color));
      for (let i = 1; i < Math.min(count, CHIPS_PER_COLUMN); i++) {
        const edge = chipEl(color);
        edge.classList.add('edge');
        col.append(edge);
      }
      columns.append(col);
    }
    const text = document.createElement('span');
    text.className = 'chip-amount';
    text.textContent = label;
    wrap.append(columns, text);
    return wrap;
  }

  function statusText(t) {
    if (t.stage === 'waiting') return 'Waiting for players…';
    if (t.stage === 'handOver' && t.lastResult) {
      if (!t.lastResult.winners.length) return 'Hand cancelled';
      return t.lastResult.winners
        .map((w) => `${w.name} wins ${w.amount}${w.hand ? ` with ${w.hand}` : ''}`)
        .join(' · ');
    }
    if (t.stage === 'showdown') return 'Showdown…';
    const current = t.seats[t.toAct];
    if (!current) return '';
    return current.id === state.playerId ? 'Your turn' : `Waiting for ${current.name}`;
  }

  function renderTable(t) {
    $('table-title').textContent = t.name;
    $('blinds').textContent = `Blinds ${t.smallBlind}/${t.bigBlind} · Hand #${t.handNumber}`;
    // at showdown the cards that make the winning hand glow, the rest dim
    const winning = new Set(
      t.stage === 'handOver' && t.lastResult ? t.lastResult.winners.flatMap((w) => w.best || []) : [],
    );
    const markCard = (card) => {
      const el = cardEl(card);
      if (winning.size && card !== '??') el.classList.add(winning.has(card) ? 'win-card' : 'dim-card');
      return el;
    };
    $('board').replaceChildren(...t.board.map(markCard));
    $('pot').textContent = `Pot: ${t.pot}`;
    $('status').textContent = statusText(t);
    const practice = t.mode === 'bot';
    $('practice-badge').hidden = !practice;
    // bots only sit at practice tables
    $('add-bot-button').hidden = !practice;
    $('add-bot-button').disabled = t.seats.every(Boolean);

    // chips already in the middle; this street's bets are drawn in front of each seat
    const collected = t.pot - t.seats.reduce((sum, p) => sum + (p ? p.bet : 0), 0);
    const winners = (t.stage === 'handOver' && t.lastResult && t.lastResult.winners) || [];
    const stacks = [];
    if (table3d) {
      table3d.clearPins();
      table3d.pin($('table-center'), table3d.boardPoint);
      if (collected > 0) stacks.push({ key: 'pot', amount: collected, point: table3d.potPoint });
    } else {
      $('pot-chips').replaceChildren(...(collected > 0 ? [chipStack(collected, { label: '', className: 'pot' })] : []));
    }

    // rotate seats so that the local player sits at the bottom
    const mySeat = t.you ? t.you.seat : 0;
    const seatsEl = $('seats');
    seatsEl.replaceChildren();
    t.seats.forEach((p, i) => {
      if (!p) return;
      const rel = (i - mySeat + t.maxPlayers) % t.maxPlayers;
      const [x, y] = POSITIONS[Math.round((rel * POSITIONS.length) / t.maxPlayers) % POSITIONS.length];
      const el = document.createElement('div');
      el.className = 'seat';
      if (p.id === state.playerId) el.classList.add('me');
      if (i === t.toAct) el.classList.add('turn');
      if (p.folded) el.classList.add('folded');
      if (p.busted) el.classList.add('busted');
      if (winners.some((w) => w.id === p.id)) el.classList.add('winner');
      if (table3d) {
        table3d.pin(el, table3d.seatPoint(rel, t.maxPlayers));
      } else {
        el.style.left = `${x}%`;
        el.style.top = `${y}%`;
      }

      const name = document.createElement('div');
      name.className = 'pname';
      name.textContent = p.name;
      if (i === t.button) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'D';
        tag.title = 'Dealer button';
        name.append(' ', tag);
      }
      const cards = document.createElement('div');
      cards.className = 'cards';
      cards.append(...p.cards.map(markCard));
      const shownHand = t.stage === 'handOver' && t.lastResult && t.lastResult.shown
        ? t.lastResult.shown[p.id] : null;
      const chips = document.createElement('div');
      chips.className = 'chips';
      const icon = chipEl('black');
      icon.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span');
      count.textContent = p.busted
        ? 'Out of chips'
        : `${p.chips} chips${p.allIn ? ' · ALL-IN' : ''}${p.folded ? ' · folded' : ''}`;
      chips.append(icon, count);
      el.append(name, cards);
      if (shownHand) {
        const hand = document.createElement('div');
        hand.className = 'hand-label';
        hand.textContent = shownHand.description || shownHand.hand;
        el.append(hand);
      }
      el.append(chips);
      const delta = t.stage === 'handOver' && t.lastResult && t.lastResult.deltas
        ? t.lastResult.deltas[p.id] : undefined;
      if (delta) {
        const badge = document.createElement('div');
        badge.className = `delta ${delta > 0 ? 'up' : 'down'}`;
        badge.textContent = formatDelta(delta);
        badge.title = delta > 0 ? `${p.name} won ${delta} this hand` : `${p.name} lost ${-delta} this hand`;
        el.append(badge);
      }
      seatsEl.append(el);

      // bets and winnings sit on the felt between the seat and the pot
      const won = winners.find((w) => w.id === p.id);
      const amount = won ? won.amount : p.bet;
      if (!amount) return;
      const label = won ? `+${won.amount}` : `${p.bet}`;
      const title = won ? `${p.name} wins ${won.amount}` : `${p.name} bets ${p.bet}`;
      if (table3d) {
        const point = table3d.betPoint(rel, t.maxPlayers);
        stacks.push({ key: `${won ? 'win' : 'bet'}:${i}`, amount, point });
        const tag = document.createElement('span');
        tag.className = `chip-amount felt-label${won ? ' win' : ''}`;
        tag.textContent = label;
        tag.title = title;
        seatsEl.append(tag);
        table3d.pin(tag, point);
      } else {
        const pile = chipStack(amount, { label, className: won ? 'win' : 'bet' });
        pile.classList.add('on-felt');
        pile.style.left = `${x + (50 - x) * BET_PULL}%`;
        pile.style.top = `${y + (50 - y) * BET_PULL}%`;
        pile.title = title;
        seatsEl.append(pile);
      }
    });

    if (table3d) {
      // bets slide into the pot at the end of a street; the pot slides to the winner
      const winKey = winners.length ? `win:${t.seats.findIndex((p) => p && p.id === winners[0].id)}` : null;
      const flows = t.seats.map((_, i) => ({ from: `bet:${i}`, to: collected > 0 ? 'pot' : winKey }));
      flows.push({ from: 'pot', to: winKey });
      table3d.update({ stacks, flows });
    }

    renderActions(t);
    renderResult(t);
    const log = $('log');
    log.replaceChildren(...t.log.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
    log.scrollTop = log.scrollHeight;
  }

  const formatDelta = (n) => (n > 0 ? `+${n}` : `\u2212${-n}`);
  const describeWin = (w) => `${w.name} wins ${w.amount}${w.hand ? ` with ${w.description || w.hand}` : ''}`;

  // "...beats Dawid's Pair of Jacks" reads better as "...beats your Pair of Jacks" for Dawid
  const personal = (text) => (text && state.name ? text.split(`${state.name}'s`).join('your') : text);

  // Tells the player, in plain words, how the last hand went for them and why.
  function resultSummary(t) {
    const me = state.playerId;
    const you = t.you;
    const r = t.lastResult;
    if (you && you.busted) {
      const by = r && r.winners.length ? r.winners.map((w) => w.name).join(' and ') : null;
      const why = r && r.winners.length && r.winners[0].reason ? ` (${personal(r.winners[0].reason)})` : '';
      return {
        tone: 'loss',
        icon: '0',
        title: "You're out of chips",
        detail: `${by ? `${by} took your last chips${why}. ` : ''}Rebuy for ${(t.you && t.you.buyIn) || t.startingChips} to keep playing, or go back to the lobby.`,
        bust: true,
      };
    }
    if (t.stage !== 'handOver' || !r) return null;
    if (!r.winners.length) {
      return { tone: 'neutral', icon: '↺', title: 'Hand cancelled', detail: 'All bets were returned.' };
    }
    const others = t.seats.filter((p) => p && p.id !== me);
    const meSeat = t.seats.find((p) => p && p.id === me);
    const top = r.winners[0];
    const cards = top.best || [];
    // everyone else lost their chips (busted bots are cleared away, but the result remembers them)
    const knockedOut = others.length ? others : (r.busted || []).filter((b) => b.id !== me);
    if (meSeat && meSeat.chips > 0 && knockedOut.length && others.every((p) => p.busted)) {
      const names = knockedOut.map((p) => p.name).join(', ');
      return {
        tone: 'win',
        icon: '★',
        title: 'You won the table!',
        detail: [
          top.id === me && top.reason ? top.reason : '',
          `${names} ${knockedOut.length === 1 ? 'is' : 'are'} out of chips. Wait for a rebuy or add a bot to keep playing.`,
        ].filter(Boolean).join('. '),
        cards,
      };
    }
    const delta = r.deltas ? r.deltas[me] : undefined;
    const mine = r.winners.find((w) => w.id === me);
    if (mine) {
      const how = mine.hand ? ` with ${mine.description || mine.hand}` : ' — everyone else folded';
      return {
        tone: 'win',
        icon: '✓',
        title: `You win ${mine.amount}${how}`,
        detail: [mine.hand ? mine.reason : '', delta ? `${formatDelta(delta)} chips this hand` : '']
          .filter(Boolean).join(' · '),
        cards: mine.best || [],
      };
    }
    const title = r.winners.map(describeWin).join(' · ');
    const reason = top.hand ? personal(top.reason) : '';
    if (delta === undefined) return { tone: 'neutral', icon: '♠', title, detail: reason, cards };
    return {
      tone: delta < 0 ? 'loss' : 'neutral',
      icon: delta < 0 ? '✕' : '♠',
      title,
      detail: [reason, delta < 0 ? `You lost ${-delta} chips this hand` : 'You broke even this hand']
        .filter(Boolean).join(' · '),
      cards,
    };
  }

  let bustTimer = null;
  let bustDismissed = false;
  function closeBustedDialog() {
    clearTimeout(bustTimer);
    bustTimer = null;
    // returnValue marks a close made by the page rather than by the player (Esc)
    if ($('busted-dialog').open) $('busted-dialog').close('auto');
  }

  function renderResult(t) {
    const summary = resultSummary(t);
    const banner = $('result-banner');
    banner.hidden = !summary;
    if (summary) {
      banner.className = `result-banner ${summary.tone}`;
      $('result-icon').textContent = summary.icon;
      $('result-title').textContent = summary.title;
      $('result-detail').textContent = summary.detail;
      $('result-detail').hidden = !summary.detail;
      $('result-actions').hidden = !summary.bust;
      $('result-cards').replaceChildren(...(summary.cards || []).map(cardEl));
      $('result-cards').hidden = !(summary.cards && summary.cards.length);
    }
    // out of chips: pop up a dialog once the player has had a moment to see the showdown
    if (summary && summary.bust) {
      $('busted-detail').textContent = summary.detail;
      renderBustedBank(t);
      if (!bustDismissed && !bustTimer && !$('busted-dialog').open) {
        bustTimer = setTimeout(() => {
          bustTimer = null;
          if (state.table && state.table.you && state.table.you.busted) $('busted-dialog').showModal();
        }, 1800);
      }
    } else {
      bustDismissed = false;
      closeBustedDialog();
    }
  }

  // A rebuy costs the original buy-in; if the bank is short, the button buys a pack first.
  // At practice tables it's free.
  function rebuyPlan(t) {
    const cost = (t.you && t.you.buyIn) || t.startingChips;
    if (t.mode === 'bot') return { cost, pack: 0, free: true };
    const short = state.bank === null ? 0 : Math.max(0, cost - state.bank);
    const pack = short > 0 ? CHIP_PACKS.find((p) => p >= short) || CHIP_PACKS.at(-1) : 0;
    return { cost, pack };
  }

  function renderBustedBank(t) {
    if (!t.you || !t.you.busted) return;
    const { cost, pack, free } = rebuyPlan(t);
    $('rebuy-button').textContent = pack ? `Buy ${formatChips(pack)} & rebuy` : `Rebuy ${cost} chips`;
    $('rebuy-inline').textContent = pack ? `Buy & rebuy` : `Rebuy ${cost}`;
    if (free) {
      $('busted-bank').textContent = 'Practice chips are free: your bank is not touched.';
      return;
    }
    $('busted-bank').textContent = state.bank === null ? '' : pack
      ? `Your bank has ${formatChips(state.bank)} chips, not enough for a ${formatChips(cost)} rebuy.`
      : `Your bank has ${formatChips(state.bank)} chips.`;
  }

  const tableMode = () => ($('mode-bot').checked ? 'bot' : 'normal');

  // ------------------------------------------------------------- profile

  let destroyCharts = null;
  let profileRequest = 0;

  function closeProfile() {
    profileRequest += 1; // ignore a response still on its way
    if (destroyCharts) destroyCharts();
    destroyCharts = null;
  }

  const formatSigned = (n) => (n > 0 ? `+${formatChips(n)}` : n < 0 ? `\u2212${formatChips(-n)}` : '0');
  const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const formatWhen = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
  const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

  function cell(text, className = '') {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function stat(label, value, { className = '', sub = '' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'stat';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (className) dd.className = className;
    wrap.append(dt, dd);
    if (sub) {
      const note = document.createElement('span');
      note.className = 'sub';
      note.textContent = sub;
      dd.append(note);
      note.before(document.createElement('br'));
    }
    return wrap;
  }

  async function openProfile() {
    if (state.table) return;
    closeProfile();
    show('profile');
    const request = profileRequest;
    $('profile-name').textContent = state.name || 'Profile';
    $('profile-initial').textContent = state.name ? state.name.trim()[0].toUpperCase() : '';
    $('profile-error').hidden = true;
    $('profile-stats').setAttribute('aria-busy', 'true');
    let profile;
    let charts;
    try {
      [profile, charts] = await Promise.all([api('/profile', { method: 'GET' }), import('./profile-charts.js')]);
    } catch (err) {
      if (request !== profileRequest) return;
      if (err.status === 401) return expireSession(err.message);
      $('profile-error').textContent = err.status ? err.message : 'Could not load your profile, try again shortly';
      $('profile-error').hidden = false;
      return;
    }
    if (request !== profileRequest) return;
    renderProfile(profile, charts);
  }

  function renderProfile({ user, stats, timeline, games, deposits }, charts) {
    const money = stats.normal;
    $('profile-name').textContent = user.username;
    $('profile-since').textContent = `Playing since ${formatDate(user.createdAt)}`;
    setBank(user.chips);

    const hands = (s) => `${formatChips(s.handsWon)} of ${formatChips(s.hands)} hands won`;
    $('profile-stats').replaceChildren(
      stat('Net result', formatSigned(money.net), { className: tone(money.net) }),
      stat('Chips won', formatChips(money.earned), { sub: 'in winning games' }),
      stat('Chips lost', formatChips(money.lost), { sub: 'in losing games' }),
      stat('Biggest hand win', formatChips(money.biggestWin)),
      stat('Real-chip games', formatChips(money.games), { sub: `${percent(money.handsWon, money.hands)} · ${hands(money)}` }),
      stat('Best game', money.bestGame === null ? '–' : formatSigned(money.bestGame), { className: tone(money.bestGame) }),
      stat('Chips added', formatChips(stats.deposited), { sub: 'welcome bonus and packs' }),
      stat('Practice games', formatChips(stats.bot.games), { sub: hands(stats.bot) }),
    );
    $('profile-stats').setAttribute('aria-busy', 'false');

    // the chart reads left to right, oldest first; the history table lists newest first
    const moneyGames = games.filter((g) => g.mode === 'normal').reverse();
    $('balance-empty').hidden = timeline.length > 0;
    $('balance-chart').hidden = timeline.length === 0;
    $('games-empty').hidden = moneyGames.length > 0;
    $('games-chart').hidden = moneyGames.length === 0;
    destroyCharts = charts.mountProfileCharts({
      balanceEl: $('balance-chart'),
      gamesEl: $('games-chart'),
      timeline,
      games: moneyGames,
    });

    $('history-empty').hidden = games.length > 0;
    $('history-body').replaceChildren(...games.map((g) => {
      const tr = document.createElement('tr');
      const practice = g.mode === 'bot';
      tr.append(
        cell(g.tableName),
        cell(practice ? 'Practice' : 'Real chips', 'wide-only'),
        cell(`${g.handsWon}/${g.hands}`, 'num'),
        cell(formatChips(g.buyIn), 'num wide-only'),
        // practice results are shown, but never reached the bank
        cell(practice ? `${formatSigned(g.net)} (free)` : formatSigned(g.net), `num ${practice ? '' : tone(g.net)}`),
        cell(formatWhen(g.endedAt)),
      );
      return tr;
    }));

    $('deposits-total').textContent = formatChips(stats.deposited);
    $('deposits-body').replaceChildren(...deposits.map((d) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(d.kind === 'welcome' ? 'Welcome bonus' : 'Chip pack'),
        cell(`+${formatChips(d.amount)}`, 'num'),
        cell(formatChips(d.balance), 'num wide-only'),
        cell(formatWhen(d.createdAt)),
      );
      return tr;
    }));
  }

  function buyIn() {
    const value = Number($('buy-in-input').value);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }

  function renderActions(t) {
    const legal = t.you && t.you.legal;
    $('actions').hidden = !legal;
    if (!legal) return;
    $('check-button').hidden = !legal.canCheck;
    $('call-button').hidden = !legal.canCall;
    $('call-button').textContent = `Call ${legal.toCall}`;
    const canFullRaise = legal.canRaise && legal.maxRaiseTo > legal.minRaiseTo;
    $('raise-button').textContent = t.currentBet === 0 ? 'Bet' : 'Raise';
    $('raise-button').parentElement.hidden = !canFullRaise;
    const input = $('raise-input');
    input.min = legal.minRaiseTo;
    input.max = legal.maxRaiseTo;
    input.step = t.bigBlind;
    input.value = legal.minRaiseTo;
    $('allin-button').hidden = !legal.canRaise && !legal.canCall;
  }

  function renderRankings() {
    $('rankings-list').replaceChildren(...HAND_RANKINGS.map(([name, desc, cards], i) => {
      const li = document.createElement('li');
      const no = document.createElement('span');
      no.className = 'rank-no';
      no.textContent = `${i + 1}.`;
      const title = document.createElement('span');
      title.className = 'rank-name';
      title.textContent = name;
      const text = document.createElement('span');
      text.className = 'rank-desc';
      text.textContent = desc;
      const example = document.createElement('span');
      example.className = 'rank-cards';
      example.append(...cards.map(cardEl));
      li.append(no, title, text, example);
      return li;
    }));
  }

  // ------------------------------------------------------------- events

  const rebuy = async () => {
    closeBustedDialog();
    const { pack } = state.table ? rebuyPlan(state.table) : { pack: 0 };
    if (pack && !(await buyChips(pack))) return;
    send({ type: 'rebuy' });
  };
  const leaveTable = () => {
    closeBustedDialog();
    send({ type: 'leaveTable' });
  };
  $('rebuy-button').addEventListener('click', rebuy);
  $('rebuy-inline').addEventListener('click', rebuy);
  $('bust-leave-button').addEventListener('click', leaveTable);
  $('bust-leave-inline').addEventListener('click', leaveTable);
  // Esc closes the dialog; the banner keeps offering the same two choices
  $('busted-dialog').addEventListener('close', (e) => {
    if (e.target.returnValue !== 'auto') bustDismissed = true;
    e.target.returnValue = '';
  });

  const rankings = $('rankings-dialog');
  $('rankings-button').addEventListener('click', () => rankings.showModal());
  $('rankings-close').addEventListener('click', () => rankings.close());
  // clicking the backdrop (outside the dialog box) closes it too
  rankings.addEventListener('click', (e) => {
    if (e.target === rankings) rankings.close();
  });

  $('logout-button').addEventListener('click', logOut);
  $('profile-button').addEventListener('click', openProfile);
  $('profile-back').addEventListener('click', () => show(state.table ? 'table' : 'lobby'));

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter && e.submitter.value === 'register' ? 'register' : 'login';
    const username = $('username-input').value.trim();
    const password = $('password-input').value;
    if (!username || !password) return;
    const buttons = [$('login-button'), $('register-button')];
    buttons.forEach((b) => { b.disabled = true; });
    $('auth-error').hidden = true;
    try {
      const { token, user } = await api(`/${mode}`, { body: { username, password } });
      signedIn(token, user);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  });

  // typing into a number field replaces its value instead of appending to it
  for (const id of ['buy-in-input', 'raise-input']) {
    $(id).addEventListener('focus', (e) => e.target.select());
  }

  for (const btn of document.querySelectorAll('.pack')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await buyChips(Number(btn.dataset.amount));
      btn.disabled = false;
    });
  }

  $('create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send({ type: 'createTable', name: $('table-name-input').value.trim(), buyIn: buyIn(), mode: tableMode() });
    $('table-name-input').value = '';
  });

  $('leave-button').addEventListener('click', () => send({ type: 'leaveTable' }));
  $('add-bot-button').addEventListener('click', () => send({ type: 'addBot' }));
  $('fold-button').addEventListener('click', () => send({ type: 'action', action: 'fold' }));
  $('check-button').addEventListener('click', () => send({ type: 'action', action: 'check' }));
  $('call-button').addEventListener('click', () => send({ type: 'action', action: 'call' }));
  $('allin-button').addEventListener('click', () => send({ type: 'action', action: 'allin' }));
  $('raise-button').addEventListener('click', () => {
    const amount = Number($('raise-input').value);
    send({ type: 'action', action: state.table && state.table.currentBet === 0 ? 'bet' : 'raise', amount });
  });

  renderRankings();
  // returning player: skip the login screen and wait for the server's welcome
  if (state.token && state.name) {
    $('welcome').textContent = `Welcome, ${state.name}`;
    show('lobby');
  }
  renderUser();
  connect();
})();
