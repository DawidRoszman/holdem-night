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

  // The session itself is an HttpOnly cookie that this script never sees: the
  // browser sends it with every API call and with the WebSocket handshake. This
  // tab only remembers who is logged in (sessionStorage), so a reload can draw
  // the right page before the server confirms it.
  const SESSION_KEY = 'holdem.session';
  const savedSession = {
    get() {
      try {
        const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
        return s && s.name ? s : null;
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
    loggedIn: Boolean(session),
    name: session && session.name,
    bank: null,
    playerId: null,
    table: null,
    screen: null,
    timing: null, // { turnTimeoutMs, nextHandDelayMs } from the server
    reconnectDelay: 500,
  };
  const CHIP_PACKS = [500, 1000, 5000];
  const formatChips = (n) => Number(n).toLocaleString('en-US');

  // ------------------------------------------------------------- accounts API

  async function api(path, { body, method = 'POST' } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    let res;
    try {
      // the session cookie goes along with every same-origin request
      res = await fetch(`/api/accounts${path}`, {
        method, headers, credentials: 'same-origin', body: body && JSON.stringify(body),
      });
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
      // the handshake carried the session cookie, if there is one: the server answers welcome or authError
      send({ type: 'hello' });
    };
    ws.onmessage = (event) => handle(JSON.parse(event.data));
    ws.onclose = () => {
      setConnection('Disconnected – reconnecting…', 'bad');
      // a held seat comes back after the reconnect; until then the page stays as it is
      state.table = null;
      state.playerId = null;
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
        state.loggedIn = true;
        savedSession.set({ name: msg.name });
        $('welcome').textContent = `Welcome, ${msg.name}`;
        state.timing = msg.timing || null;
        renderLobbyTiming();
        setBank(msg.chips);
        route();
        break;
      case 'authError':
        // only news if this tab thought it was logged in; otherwise the login page is already right
        if (state.loggedIn) expireSession(msg.message);
        else route();
        break;
      case 'account':
        setBank(msg.chips);
        break;
      case 'tables':
        renderTables(msg.tables);
        break;
      case 'state': {
        const first = !state.table;
        state.table = msg.table;
        clearTimeout(seatTimer);
        // sitting down (or getting a held seat back) moves to the table's address
        const path = `/tables/${msg.table.id}`;
        if (first && location.pathname !== path) {
          history[location.pathname.startsWith('/tables/') ? 'replaceState' : 'pushState'](null, '', path);
        }
        show('table');
        renderTable(msg.table);
        break;
      }
      case 'left': {
        const tablePath = state.table && `/tables/${state.table.id}`;
        state.table = null;
        clocks.turnEnds = null;
        clocks.nextHand = null;
        closeBustedDialog();
        // left with the button: the lobby takes the table's place in the history;
        // left by navigating away: the address already says where to go
        if (location.pathname === tablePath) history.replaceState(null, '', '/');
        route({ force: true });
        break;
      }
      case 'error':
        toast(msg.message);
        break;
      case 'notice':
        toast(msg.message, 'info');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- rendering

  function renderUser() {
    const loggedIn = Boolean(state.loggedIn && state.name);
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

  // Connects again at once, so the new handshake carries the current cookie.
  function reconnect() {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    connect();
  }

  function signedIn(user) {
    state.loggedIn = true;
    state.name = user.username;
    state.bank = null;
    savedSession.set({ name: user.username });
    $('password-input').value = '';
    $('auth-error').hidden = true;
    // the socket was opened before the login set the cookie; the new one says hello with it
    reconnect();
  }

  function signedOut({ keepPage = false } = {}) {
    if (!keepPage) history.replaceState(null, '', '/');
    savedSession.clear();
    state.loggedIn = false;
    state.name = null;
    state.bank = null;
    state.playerId = null;
    // logging out leaves the table for good (a dropped connection would hold the seat for a while)
    if (state.table) send({ type: 'leaveTable' });
    state.table = null;
    closeBustedDialog();
    renderUser();
    $('password-input').value = '';
    show('login');
    // the server cashes our stack out; a fresh connection carries no session any more
    reconnect();
  }

  async function logOut() {
    // the server clears the cookie; wait for that, or the reconnect would log straight back in
    await api('/logout').catch(() => {});
    signedOut();
  }

  function expireSession(message) {
    signedOut({ keepPage: true });
    showAuthError(message || 'Please log in again');
  }

  function showAuthError(message) {
    $('auth-error').textContent = message;
    $('auth-error').hidden = false;
  }

  // ------------------------------------------------------------- pages and addresses

  // Each page has its own address, so back/forward move between pages and a
  // refresh stays on the page: / (lobby, or login), /profile, /games/<id>, /tables/<id>.
  function currentRoute() {
    const path = location.pathname;
    let m;
    if (path === '/profile') return { screen: 'profile', path };
    if ((m = /^\/games\/(\d+)$/.exec(path))) return { screen: 'game', id: Number(m[1]), path };
    if ((m = /^\/tables\/([\w-]+)$/.exec(path))) return { screen: 'table', id: m[1], path };
    return { screen: 'lobby', path: '/' };
  }

  const TITLES = { lobby: 'Lobby', profile: 'Profile', game: 'Game', table: 'Table', login: 'Log in' };

  function navigate(path, { replace = false } = {}) {
    if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    route();
  }

  let routed = null; // the path whose page is showing
  let seatTimer = null;

  // Shows the page for the current address.
  function route({ force = false } = {}) {
    const r = currentRoute();
    if (!state.loggedIn) {
      routed = null;
      return show('login');
    }
    if (state.table) {
      if (r.screen === 'table' && r.id === state.table.id) return show('table');
      // the address left the table (back/forward, or the logo): leaving needs a yes
      return confirmLeave();
    }
    if (!force && routed === r.path && state.screen === r.screen) return;
    routed = r.path;
    if (r.path !== location.pathname) history.replaceState(null, '', r.path);
    if (r.screen === 'profile') return openProfile();
    if (r.screen === 'game') return openGame(r.id);
    if (r.screen === 'table') return awaitSeat();
    return show('lobby');
  }

  // A refresh at /tables/<id>: the server gives a held seat back right after the
  // welcome. If none comes, the seat is gone and the lobby is the place to be.
  function awaitSeat() {
    if (state.screen !== 'table') show('lobby');
    clearTimeout(seatTimer);
    if (!state.playerId) return; // not welcomed yet: the welcome routes again
    seatTimer = setTimeout(() => {
      if (state.table || currentRoute().screen !== 'table') return;
      toast("You're no longer seated at that table", 'info');
      navigate('/', { replace: true });
    }, 2500);
  }

  function confirmLeave() {
    const dialog = $('leave-dialog');
    if (!dialog.open) dialog.showModal();
  }

  function stayAtTable() {
    if ($('leave-dialog').open) $('leave-dialog').close();
    // put the table's address back where the history had moved on from it
    if (state.table) history.pushState(null, '', `/tables/${state.table.id}`);
  }

  // the profile and a game's details are pages of their own, kept across reconnects
  const onAccountPage = () => state.screen === 'profile' || state.screen === 'game';

  function show(screen) {
    if (onAccountPage() && screen !== state.screen) closeProfile();
    // a different screen starts at the top, not wherever the last one was scrolled to
    if (screen !== state.screen) window.scrollTo(0, 0);
    state.screen = screen;
    for (const s of ['login', 'lobby', 'table', 'profile', 'game']) $(`screen-${s}`).hidden = s !== screen;
    document.title = `${TITLES[screen]} · Hold'em Night`;
    $('profile-button').disabled = Boolean(state.table);
    $('home-link').title = state.table ? 'Leave the table to go back to the lobby' : 'Home';
  }

  let toastTimer;
  function toast(text, tone = 'error') {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast ${tone}`;
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
      if (t.started) {
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

  // ------------------------------------------------------------- timings

  const seconds = (ms) => `${Math.round(ms / 1000)}s`;

  // The rules, in plain words: how long a turn lasts and what happens when it runs out.
  function timingRules(timing) {
    if (!timing) return '';
    const turn = timing.turnTimeoutMs > 0
      ? `Each turn lasts ${seconds(timing.turnTimeoutMs)}; when time runs out you check, or fold if you face a bet.`
      : 'Turns have no time limit.';
    const parts = [turn, `Once the host starts the game, the next hand is dealt ${seconds(timing.nextHandDelayMs)} after the last one ends.`];
    if (timing.reconnectGraceMs > 0) {
      parts.push(`If you lose connection or reload the page, your seat is held for ${seconds(timing.reconnectGraceMs)}.`);
    }
    return parts.join(' ');
  }

  function renderLobbyTiming() {
    $('lobby-timing').textContent = timingRules(state.timing);
    $('lobby-timing').hidden = !state.timing;
  }

  // Countdowns run on the local clock from the time left the server reported,
  // so they tick smoothly between messages and ignore any clock difference.
  const clocks = { turnEnds: null, turnTotal: 0, nextHand: null, announced: false };

  function setClocks(t) {
    const timing = t.timing || {};
    const now = performance.now();
    const turnEnds = timing.turnEndsIn == null ? null : now + timing.turnEndsIn;
    // a new turn may be announced again
    if (turnEnds === null || clocks.turnEnds === null || Math.abs(turnEnds - clocks.turnEnds) > 1500) clocks.announced = false;
    clocks.turnEnds = turnEnds;
    clocks.turnTotal = timing.turnTimeoutMs || 0;
    clocks.nextHand = timing.nextHandIn == null ? null : now + timing.nextHandIn;
    tickClocks();
  }

  // Writes a property only when it changes: the countdowns tick four times a second
  // but show whole seconds, so the page changes once a second, not on every tick.
  function put(el, prop, value) {
    if (el[prop] !== value) el[prop] = value;
  }

  function tickClocks() {
    const now = performance.now();
    const t = state.table;
    const turnLeft = clocks.turnEnds === null ? null : Math.ceil(Math.max(0, clocks.turnEnds - now) / 1000);
    const urgent = turnLeft !== null && turnLeft <= 10;
    const bar = $('turn-clock');
    if (bar) {
      if (bar.classList.contains('urgent') !== urgent) bar.classList.toggle('urgent', urgent);
      const total = Math.ceil(clocks.turnTotal / 1000);
      put(bar.firstChild.style, 'width', `${total ? (100 * (turnLeft ?? 0)) / total : 0}%`);
      put(bar, 'title', turnLeft === null ? '' : `${turnLeft}s left to act`);
    }
    const mine = Boolean(t && t.you && t.you.legal && turnLeft !== null);
    const timer = $('turn-timer');
    put(timer, 'hidden', !mine);
    if (mine) {
      const fallback = t.you.legal.canCheck ? 'check' : 'fold';
      put(timer, 'textContent', `${turnLeft}s left`);
      put(timer, 'title', `When time runs out you ${fallback} automatically`);
      if (timer.classList.contains('urgent') !== urgent) timer.classList.toggle('urgent', urgent);
      if (urgent && !clocks.announced) {
        clocks.announced = true;
        $('timer-announcer').textContent = `${turnLeft} seconds left, then you ${fallback} automatically`;
      }
    }
    const next = $('next-hand');
    const nextLeft = clocks.nextHand === null ? null : Math.ceil(Math.max(0, clocks.nextHand - now) / 1000);
    put(next, 'hidden', nextLeft === null);
    if (nextLeft !== null) put(next, 'textContent', `Next hand in ${nextLeft}s`);
  }
  setInterval(tickClocks, 250);

  function statusText(t) {
    if (!t.started) {
      const you = t.you || {};
      if (you.canStart) return 'Press Start game when everyone is seated';
      if (you.isHost || t.seats.filter(Boolean).length < 2) return 'Waiting for players…';
      return `Waiting for ${t.hostName || 'the host'} to start the game`;
    }
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
    document.title = `${t.name} · Hold'em Night`;
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
    $('start-button').hidden = !(t.you && t.you.isHost && !t.started);
    $('start-button').disabled = !(t.you && t.you.canStart);
    $('start-button').title = t.you && t.you.canStart ? '' : 'Needs at least two players with chips';
    $('table-rules').textContent = [t.hostName ? `Host: ${t.hostName}.` : '', timingRules(t.timing)].filter(Boolean).join(' ');

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
      if (p.away) el.classList.add('away');
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
        name.append(tag); // spaced by the row's gap, so the name's text stays exact
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
      if (p.away) {
        const away = document.createElement('div');
        away.className = 'away-label';
        away.textContent = 'Reconnecting…';
        away.title = `${p.name} lost connection; their seat is held for a while`;
        el.append(away);
      }
      // the player to act has a draining clock under their seat
      if (i === t.toAct && t.timing && t.timing.turnEndsIn != null) {
        const clock = document.createElement('div');
        clock.id = 'turn-clock';
        clock.className = 'turn-clock';
        clock.setAttribute('aria-hidden', 'true');
        clock.append(document.createElement('span'));
        el.append(clock);
      }
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
    setClocks(t);
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
  // a signed share of what was put in: +60%, −3.5% (one decimal below 10%)
  const signedPercent = (part, whole) => {
    if (!whole) return '–';
    const pct = (part / whole) * 100;
    const abs = Math.abs(pct);
    const text = abs > 0 && abs < 10 ? abs.toFixed(1).replace(/\.0$/, '') : String(Math.round(abs));
    return pct > 0 ? `+${text}%` : pct < 0 ? `\u2212${text}%` : '0%';
  };
  const plural = (n, word) => `${formatChips(n)} ${word}${n === 1 ? '' : 's'}`;
  // " (46%)" after a count, joined to it by a no-break space so the two never wrap apart;
  // nothing at all when there's no whole to take a share of
  const share = (part, whole) => (whole ? `\u00a0(${percent(part, whole)})` : '');
  const signedShare = (part, whole) => (whole ? `\u00a0(${signedPercent(part, whole)})` : '');
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
    // one line, or several (an array) each on its own line
    for (const line of [sub].flat().filter(Boolean)) {
      const note = document.createElement('span');
      note.className = 'sub';
      note.textContent = line;
      dd.append(note);
    }
    return wrap;
  }

  async function openProfile() {
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

    // counts first, with the share in brackets: "13 of 28 hands won (46%)"
    const handsWon = (s) => `${formatChips(s.handsWon)} of ${plural(s.hands, 'hand')} won${share(s.handsWon, s.hands)}`;
    $('profile-stats').replaceChildren(
      stat('Net result', formatSigned(money.net), {
        className: tone(money.net),
        sub: `on ${formatChips(money.boughtIn)} bought in${signedShare(money.net, money.boughtIn)}`,
      }),
      stat('Chips won', formatChips(money.earned), {
        sub: `in ${plural(money.won, 'winning game')}${share(money.won, money.games)}`,
      }),
      stat('Chips lost', formatChips(money.lost), {
        sub: `in ${plural(money.lostGames, 'losing game')}${share(money.lostGames, money.games)}`,
      }),
      stat('Biggest hand win', formatChips(money.biggestWin)),
      stat('Real-chip games', formatChips(money.games), {
        sub: [`${formatChips(money.won)} won${share(money.won, money.games)}`, handsWon(money)],
      }),
      stat('Best game', money.bestGame === null ? '–' : formatSigned(money.bestGame), { className: tone(money.bestGame) }),
      stat('Chips added', formatChips(stats.deposited), { sub: 'welcome bonus and packs' }),
      stat('Practice games', formatChips(stats.bot.games), { sub: handsWon(stats.bot) }),
    );
    $('profile-stats').setAttribute('aria-busy', 'false');

    // the chart reads left to right, oldest first; the history table lists newest first
    const moneyGames = games.filter((g) => g.mode === 'normal').reverse();
    // a single balance (just the welcome bonus) is a point, not a history
    const history = timeline.length > 1;
    $('balance-empty').hidden = history;
    $('balance-chart').hidden = !history;
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
      const name = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'game-link';
      open.id = `game-${g.id}`;
      open.textContent = g.tableName;
      open.title = 'See this game in detail';
      open.addEventListener('click', () => navigate(`/games/${g.id}`));
      name.append(open);
      tr.append(
        name,
        cell(practice ? 'Practice' : 'Real chips', 'wide-only'),
        cell(`${g.handsWon}/${g.hands}${share(g.handsWon, g.hands)}`, 'num'),
        cell(formatChips(g.buyIn), 'num wide-only'),
        // practice results are shown, but never reached the bank
        cell(
          practice ? `${formatSigned(g.net)} (free)` : `${formatSigned(g.net)}${signedShare(g.net, g.buyIn)}`,
          `num ${practice ? '' : tone(g.net)}`,
        ),
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

  // ------------------------------------------------------------- one game

  async function openGame(id) {
    closeProfile();
    show('game');
    const request = profileRequest;
    $('game-error').hidden = true;
    $('game-stats').setAttribute('aria-busy', 'true');
    let detail;
    let charts;
    try {
      [detail, charts] = await Promise.all([api(`/games/${id}`, { method: 'GET' }), import('./profile-charts.js')]);
    } catch (err) {
      if (request !== profileRequest) return;
      if (err.status === 401) return expireSession(err.message);
      $('game-error').textContent = err.status ? err.message : 'Could not load this game, try again shortly';
      $('game-error').hidden = false;
      return;
    }
    if (request !== profileRequest) return;
    renderGame(detail, charts);
  }

  const duration = (ms) => {
    const minutes = Math.max(1, Math.round(ms / 60000));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  };

  function renderGame({ game, players, settlement }, charts) {
    const practice = game.mode === 'bot';
    $('game-name').textContent = game.tableName;
    document.title = `${game.tableName} · Hold'em Night`;
    $('game-mode').textContent = practice ? 'Practice' : 'Real chips';
    $('game-mode').className = `mode-badge${practice ? ' practice' : ''}`;
    $('game-when').textContent = `${formatWhen(game.startedAt)} – ${formatWhen(game.endedAt)} · ${duration(game.endedAt - game.startedAt)}`;
    const rebuys = game.rebuys ? `incl. ${game.rebuys} rebuy${game.rebuys === 1 ? '' : 's'}` : 'no rebuys';
    $('game-stats').replaceChildren(
      stat('Result', practice ? `${formatSigned(game.net)} (free)` : formatSigned(game.net), {
        className: practice ? '' : tone(game.net),
        sub: `on a ${formatChips(game.buyIn)} buy-in${signedShare(game.net, game.buyIn)}`,
      }),
      stat('Bought in', formatChips(game.buyIn), { sub: rebuys }),
      stat('Cashed out', formatChips(game.cashOut)),
      stat('Hands won', formatChips(game.handsWon), { sub: `of ${plural(game.hands, 'hand')}${share(game.handsWon, game.hands)}` }),
    );
    $('game-stats').setAttribute('aria-busy', 'false');

    $('game-players').replaceChildren(...players.map((p) => {
      const tr = document.createElement('tr');
      if (p.you) tr.className = 'you';
      tr.append(
        cell(p.you ? `${p.username} (you)` : p.username),
        cell(`${p.handsWon}/${p.hands}${share(p.handsWon, p.hands)}`, 'num'),
        cell(formatChips(p.buyIn), 'num wide-only'),
        cell(formatChips(p.cashOut), 'num wide-only'),
        cell(`${formatSigned(p.net)}${signedShare(p.net, p.buyIn)}`, `num ${practice ? '' : tone(p.net)}`),
      );
      return tr;
    }));
    // results are final once everyone who sat at the table has left it
    const pending = settlement ? settlement.pending : [];
    const unbalanced = settlement && settlement.unbalanced;
    $('game-unbalanced').hidden = !pending.length && !unbalanced;
    if (pending.length) {
      $('game-unbalanced').textContent = `${stillSeated(pending)}, so their result isn't in yet.`;
    } else if (unbalanced) {
      $('game-unbalanced').textContent = `The results add up to ${formatSigned(unbalanced)} chips rather than zero, so only part of this table can be settled.`;
    }

    $('settle-panel').hidden = !settlement;
    currentSettlement = settlement;
    renderSettlement();

    destroyCharts = charts.mountGameChart($('game-chart'), game.handLog);
    $('game-chart').hidden = game.handLog.length === 0;
    $('game-chart-empty').hidden = game.handLog.length > 0;
    renderHands(game.handLog);
  }

  const stillSeated = (names) => `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} still at the table`;

  // "You showed Two Pair · Bob won 120 with a Flush"
  function handOutcome(h) {
    const you = (name) => (name === state.name ? 'You' : name);
    const winners = h.winners.map((w) => `${you(w.name)} won ${formatChips(w.amount)}${w.hand ? ` with ${w.hand}` : ''}`);
    // a winning hand is already named in the win
    const won = h.winners.some((w) => w.name === state.name);
    const mine = h.folded ? 'You folded' : h.shown && !won ? `You showed ${h.shown}` : null;
    return [mine, ...winners].filter(Boolean).join(' · ') || '–';
  }

  function cardsCell(list) {
    const td = document.createElement('td');
    const wrap = document.createElement('span');
    wrap.className = 'mini-cards';
    wrap.append(...list.map(cardEl));
    if (!list.length) wrap.textContent = '–';
    td.append(wrap);
    return td;
  }

  function renderHands(hands) {
    $('game-hands-empty').hidden = hands.length > 0;
    $('game-hands').replaceChildren(...[...hands].reverse().map((h) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(`${h.hand}`, 'num'),
        cardsCell(h.hole),
        cardsCell(h.board),
        cell(handOutcome(h), 'outcome'),
        cell(formatSigned(h.delta), `num ${tone(h.delta)}`),
      );
      return tr;
    }));
  }

  // ------------------------------------------------------------- settle up

  let currentSettlement = null;
  const RATE_KEY = 'holdem.settleRate';
  try {
    const saved = JSON.parse(localStorage.getItem(RATE_KEY));
    if (saved) {
      $('settle-chips').value = saved.chips;
      $('settle-value').value = saved.value;
      $('settle-currency').value = saved.currency;
    }
  } catch { /* storage unavailable: keep the defaults */ }

  const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function renderSettlement() {
    const list = $('settle-list');
    if (!currentSettlement) return list.replaceChildren();
    const chips = Number($('settle-chips').value);
    const value = Number($('settle-value').value);
    const currency = $('settle-currency').value.trim();
    const valid = chips > 0 && value >= 0;
    try {
      localStorage.setItem(RATE_KEY, JSON.stringify({ chips: $('settle-chips').value, value: $('settle-value').value, currency }));
    } catch { /* not saved, still works */ }
    const item = (children) => {
      const li = document.createElement('li');
      li.append(...children);
      return li;
    };
    const span = (text, className = '') => {
      const el = document.createElement('span');
      el.textContent = text;
      if (className) el.className = className;
      return el;
    };
    const { transfers, pending } = currentSettlement;
    if (pending.length) {
      return list.replaceChildren(item([span(`Nothing to settle yet: ${stillSeated(pending)}.`)]));
    }
    if (!transfers.length) return list.replaceChildren(item([span('Nobody owes anybody anything.')]));
    const you = (name) => (name === state.name ? 'You' : name);
    list.replaceChildren(...transfers.map((t) => {
      const amount = valid ? `${money.format((t.amount * value) / chips)}${currency ? ` ${currency}` : ''}` : '–';
      const from = you(t.from);
      return item([
        span(`${from} ${from === 'You' ? 'pay' : 'pays'} ${you(t.to) === 'You' ? 'you' : t.to}`, 'font-semibold'),
        span(`${formatChips(t.amount)} chips`, 'text-base text-muted-foreground'),
        span(amount, 'amount'),
      ]);
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
  $('profile-button').addEventListener('click', () => navigate('/profile'));
  $('home-link').addEventListener('click', (e) => {
    // ordinary clicks stay in the page; ctrl/cmd/middle-click still open a new tab
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate('/');
  });
  $('profile-back').addEventListener('click', () => navigate('/'));
  $('game-back').addEventListener('click', () => navigate('/profile'));
  window.addEventListener('popstate', () => route());
  $('leave-stay').addEventListener('click', stayAtTable);
  $('leave-confirm').addEventListener('click', () => {
    $('leave-dialog').close('leave');
    send({ type: 'leaveTable' });
  });
  // Esc or a click outside means stay
  $('leave-dialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    stayAtTable();
  });
  $('leave-dialog').addEventListener('click', (e) => {
    if (e.target === $('leave-dialog')) stayAtTable();
  });
  $('settle-form').addEventListener('input', renderSettlement);
  $('settle-form').addEventListener('submit', (e) => e.preventDefault());

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
      const { user } = await api(`/${mode}`, { body: { username, password } });
      signedIn(user);
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
  $('start-button').addEventListener('click', () => send({ type: 'startGame' }));
  $('fold-button').addEventListener('click', () => send({ type: 'action', action: 'fold' }));
  $('check-button').addEventListener('click', () => send({ type: 'action', action: 'check' }));
  $('call-button').addEventListener('click', () => send({ type: 'action', action: 'call' }));
  $('allin-button').addEventListener('click', () => send({ type: 'action', action: 'allin' }));
  $('raise-button').addEventListener('click', () => {
    const amount = Number($('raise-input').value);
    send({ type: 'action', action: state.table && state.table.currentBet === 0 ? 'bet' : 'raise', amount });
  });

  // Leaving the page (reload, another address, closing the tab) closes the socket
  // at once, so the server holds the seat for the next page straight away instead
  // of noticing only when the connection times out. A page restored from the
  // back/forward cache connects again.
  window.addEventListener('pagehide', () => {
    if (!state.ws) return;
    state.ws.onclose = null;
    state.ws.close();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) connect();
  });

  renderRankings();
  // returning player: skip the login screen; the profile and game pages load
  // straight away, a table waits for the server to give the seat back
  if (state.loggedIn && state.name) $('welcome').textContent = `Welcome, ${state.name}`;
  route();
  renderUser();
  connect();
})();
