'use strict';

const crypto = require('crypto');
const { Table, GameError } = require('./table');
const bot = require('./bot');

const NAME_MAX = 20;
const MAX_BOTS_NAMES = ['Ada', 'Bender', 'Cortana', 'Data', 'HAL', 'Marvin', 'Robby', 'Wall-E'];

function cleanName(raw, fallback) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return name || fallback;
}

// Errors from the accounts service that the player should see as-is.
const USER_FACING = new Set([400, 401, 409]);

/**
 * Transport-independent lobby: manages connected clients, tables, bots and
 * timers. `send(clientId, message)` delivers a message to one client.
 *
 * With `accounts` (see accountsClient in server.js) players log in with a
 * session token, and table chips are bought from and paid back to their bank.
 * Without it players just pick a name and every seat gets free chips.
 */
class Lobby {
  constructor({
    rankHands,
    send,
    accounts = null,
    botDelayMs = 700,
    nextHandDelayMs = 3000,
    turnTimeoutMs = 30000,
    tableOptions = {},
    newId = () => crypto.randomUUID(),
  }) {
    this.rankHands = rankHands;
    this.send = send;
    this.accounts = accounts;
    this.pending = new Set(); // in-flight cash-outs, awaited on shutdown
    this.botDelayMs = botDelayMs;
    this.nextHandDelayMs = nextHandDelayMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.tableOptions = tableOptions;
    this.newId = newId;
    this.clients = new Map();
    this.tables = new Map();
  }

  // ---------------------------------------------------------------- clients

  connect(clientId) {
    this.clients.set(clientId, { id: clientId, name: null, userId: null, tableId: null, inbox: Promise.resolve() });
  }

  // Runs after anything the client sent before closing, e.g. a buy-in still at the bank.
  disconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return Promise.resolve();
    client.inbox = client.inbox.then(async () => {
      if (client.tableId) await this.leaveTable(client);
      this.clients.delete(clientId);
    });
    return client.inbox;
  }

  // Messages from one client are processed in order: a hello that is still
  // checking its token with the accounts service finishes before the next one.
  handle(clientId, msg) {
    const client = this.clients.get(clientId);
    if (!client) return Promise.resolve();
    client.inbox = client.inbox.then(() => this.process(client, msg));
    return client.inbox;
  }

  async process(client, msg) {
    const clientId = client.id;
    if (!this.clients.has(clientId)) return;
    try {
      if (!msg || typeof msg.type !== 'string') throw new GameError('Invalid message');
      if (msg.type !== 'hello' && !client.name) throw new GameError('Say hello first');
      switch (msg.type) {
        case 'hello':
          await this.hello(client, msg);
          break;
        case 'listTables':
          this.send(clientId, { type: 'tables', tables: this.tableList() });
          break;
        case 'createTable':
          await this.createTable(client, msg.name, msg.buyIn);
          break;
        case 'joinTable':
          await this.joinTable(client, msg.tableId, msg.buyIn);
          break;
        case 'leaveTable':
          if (!client.tableId) throw new GameError('You are not at a table');
          await this.leaveTable(client);
          break;
        case 'addBot':
          await this.addBot(client);
          break;
        case 'rebuy':
          await this.rebuy(client);
          break;
        case 'action':
          await this.playerAction(client, msg.action, msg.amount);
          break;
        default:
          throw new GameError(`Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      this.send(clientId, { type: 'error', message: err instanceof GameError ? err.message : 'Server error' });
    }
  }

  async hello(client, msg) {
    if (client.tableId) throw new GameError('Leave your table first');
    if (this.accounts) {
      let user;
      try {
        user = await this.accounts.session(String(msg.token || ''));
      } catch (err) {
        if (err.status === 401) {
          this.send(client.id, { type: 'authError', message: err.message });
          return;
        }
        throw this.accountsError(err);
      }
      client.userId = user.id;
      client.name = user.username;
      this.send(client.id, { type: 'welcome', playerId: client.id, name: client.name, chips: user.chips });
    } else {
      client.name = cleanName(msg.name, `Player-${client.id.slice(0, 4)}`);
      this.send(client.id, { type: 'welcome', playerId: client.id, name: client.name });
    }
    this.send(client.id, { type: 'tables', tables: this.tableList() });
  }

  // ---------------------------------------------------------------- bank

  accountsError(err) {
    if (err instanceof GameError) return err;
    if (USER_FACING.has(err.status)) return new GameError(err.message);
    console.error('accounts service error', err);
    return new GameError('The bank is unavailable, try again shortly');
  }

  async withdraw(client, amount, note) {
    if (!this.accounts) return;
    try {
      const { chips } = await this.accounts.debit(client.userId, amount, note);
      this.send(client.id, { type: 'account', chips });
    } catch (err) {
      throw this.accountsError(err);
    }
  }

  // Pays chips back to a player's bank; failures are logged, never thrown at the table.
  deposit(userId, amount, note) {
    if (!this.accounts || !userId || amount <= 0) return Promise.resolve();
    const job = this.accounts
      .credit(userId, amount, note)
      .then(({ chips }) => {
        // tell every open connection of this user, e.g. a second tab in the lobby
        for (const c of this.clients.values()) {
          if (c.userId === userId) this.send(c.id, { type: 'account', chips });
        }
      })
      .catch((err) => console.error(`could not return ${amount} chips to user ${userId} (${note})`, err))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
    return job;
  }

  // ---------------------------------------------------------------- tables

  tableList() {
    return [...this.tables.values()].map((e) => e.table.summary());
  }

  broadcastLobby() {
    const tables = this.tableList();
    for (const c of this.clients.values()) {
      if (c.name && !c.tableId) this.send(c.id, { type: 'tables', tables });
    }
  }

  // Runs table operations one at a time; showdowns await the evaluator service.
  enqueue(entry, fn) {
    entry.queue = entry.queue.then(fn).catch((err) => console.error('table task failed', err));
    return entry.queue;
  }

  async createTable(client, rawName, buyIn) {
    if (client.tableId) throw new GameError('Leave your current table first');
    const id = this.newId().slice(0, 8);
    const entry = { table: null, queue: Promise.resolve(), timers: {}, bots: 0 };
    entry.table = new Table({
      id,
      name: cleanName(rawName, `${client.name}'s table`),
      rankHands: this.rankHands,
      onEvent: (event, player) => this.onTableEvent(entry, event, player),
      ...this.tableOptions,
    });
    this.tables.set(id, entry);
    try {
      await this.joinTable(client, id, buyIn);
    } catch (err) {
      // e.g. not enough chips in the bank: don't leave an empty table behind
      if (entry.table.players.length === 0) this.destroyTable(entry);
      throw err;
    }
  }

  async joinTable(client, tableId, rawBuyIn) {
    if (client.tableId) throw new GameError('Leave your current table first');
    const entry = this.tables.get(tableId);
    if (!entry) throw new GameError('Table not found');
    const { table } = entry;
    if (table.isFull) throw new GameError('Table is full');
    if (this.accounts && this.isPlaying(client.userId)) {
      throw new GameError('You are already playing at a table in another window');
    }
    const chips = table.buyInAmount(rawBuyIn);
    await this.withdraw(client, chips, `Buy-in at ${table.name}`);
    try {
      // the table may have filled up or closed, or the player gone, while the bank was busy
      if (!this.tables.has(tableId)) throw new GameError('Table not found');
      if (!this.clients.has(client.id)) throw new GameError('Disconnected');
      table.addPlayer({ id: client.id, name: client.name, chips, userId: client.userId });
    } catch (err) {
      await this.deposit(client.userId, chips, `Refund for ${table.name}`);
      throw err;
    }
    client.tableId = tableId;
    this.afterChange(entry);
  }

  isPlaying(userId) {
    for (const entry of this.tables.values()) {
      if (entry.table.players.some((p) => p.userId === userId && !p.leaving)) return true;
    }
    return false;
  }

  async leaveTable(client) {
    const entry = this.tables.get(client.tableId);
    client.tableId = null;
    if (entry) {
      await this.enqueue(entry, () => entry.table.removePlayer(client.id));
      this.afterChange(entry);
    }
    this.send(client.id, { type: 'left' });
    this.send(client.id, { type: 'tables', tables: this.tableList() });
  }

  async addBot(client) {
    const entry = this.tables.get(client.tableId);
    if (!entry) throw new GameError('Join a table first');
    if (entry.table.isFull) throw new GameError('Table is full');
    const name = `${MAX_BOTS_NAMES[entry.bots % MAX_BOTS_NAMES.length]} (bot)`;
    entry.bots += 1;
    entry.table.addPlayer({ id: `bot-${this.newId()}`, name, isBot: true });
    this.afterChange(entry);
  }

  async rebuy(client) {
    const entry = this.tables.get(client.tableId);
    if (!entry) throw new GameError('Join a table first');
    const { buyIn } = entry.table.checkRebuy(client.id);
    await this.withdraw(client, buyIn, `Rebuy at ${entry.table.name}`);
    try {
      entry.table.rebuy(client.id);
    } catch (err) {
      // the player left while the bank was busy
      await this.deposit(client.userId, buyIn, `Refund for ${entry.table.name}`);
      throw err;
    }
    this.afterChange(entry);
  }

  async playerAction(client, action, amount) {
    const entry = this.tables.get(client.tableId);
    if (!entry) throw new GameError('Join a table first');
    let error = null;
    await this.enqueue(entry, async () => {
      try {
        await entry.table.act(client.id, action, amount);
      } catch (err) {
        error = err;
      }
    });
    if (error) throw error;
    this.afterChange(entry);
  }

  onTableEvent(entry, event, player) {
    if (event !== 'removed' || player.isBot) return;
    // whatever is left in front of the player goes back to their bank
    this.deposit(player.userId, player.chips, `Cash-out from ${entry.table.name}`);
    const client = this.clients.get(player.id);
    if (client && client.tableId === entry.table.id) {
      client.tableId = null;
      this.send(client.id, { type: 'left' });
      this.send(client.id, { type: 'tables', tables: this.tableList() });
    }
  }

  // ---------------------------------------------------------------- timers

  clearTimer(entry, name) {
    clearTimeout(entry.timers[name]);
    delete entry.timers[name];
  }

  setTimer(entry, name, ms, fn) {
    this.clearTimer(entry, name);
    entry.timers[name] = setTimeout(() => {
      delete entry.timers[name];
      fn();
    }, ms);
  }

  destroyTable(entry) {
    for (const name of Object.keys(entry.timers)) this.clearTimer(entry, name);
    this.tables.delete(entry.table.id);
  }

  // Broadcasts state and schedules whatever should happen next at this table.
  afterChange(entry) {
    const { table } = entry;
    if (!this.tables.has(table.id)) return;

    const humans = table.players.filter((p) => !p.isBot);
    if (humans.length === 0) {
      this.destroyTable(entry);
      this.broadcastLobby();
      return;
    }
    // players who left mid-hand stay seated until it ends but no longer get updates
    for (const p of humans) {
      if (this.clients.get(p.id)?.tableId === table.id) {
        this.send(p.id, { type: 'state', table: table.view(p.id) });
      }
    }
    this.broadcastLobby();

    this.clearTimer(entry, 'bot');
    this.clearTimer(entry, 'turn');
    const current = table.seats[table.toAct];
    if (table.inProgress && current) {
      if (current.isBot) {
        this.setTimer(entry, 'bot', this.botDelayMs, () => this.runBot(entry, current.id));
      } else if (this.turnTimeoutMs > 0) {
        this.setTimer(entry, 'turn', this.turnTimeoutMs, () => this.autoAct(entry, current.id));
      }
    }
    // between hands: after a pause to show the result, clear out busted bots and deal again
    if (!table.inProgress && !entry.timers.next && (table.canStart() || table.hasBustedBots())) {
      this.setTimer(entry, 'next', this.nextHandDelayMs, () => {
        this.enqueue(entry, async () => {
          table.clearBusted();
          if (table.canStart()) await table.startHand();
        }).then(() => this.afterChange(entry));
      });
    }
  }

  runBot(entry, botId) {
    this.enqueue(entry, async () => {
      const p = entry.table.seats[entry.table.toAct];
      if (!p || p.id !== botId) return;
      const choice = bot.decide(entry.table.legalActions(p));
      if (choice) await entry.table.act(botId, choice.action, choice.amount);
    }).then(() => this.afterChange(entry));
  }

  // A human who runs out of time checks if possible, otherwise folds.
  autoAct(entry, playerId) {
    this.enqueue(entry, async () => {
      const p = entry.table.seats[entry.table.toAct];
      if (!p || p.id !== playerId) return;
      const legal = entry.table.legalActions(p);
      await entry.table.act(playerId, legal.canCheck ? 'check' : 'fold');
    }).then(() => this.afterChange(entry));
  }

  // Closes every table and pays players back: their stack plus anything they
  // put into an unfinished hand, which is cancelled. Resolves once the bank has it all.
  async shutdown() {
    for (const entry of [...this.tables.values()]) {
      const { table } = entry;
      this.destroyTable(entry);
      for (const p of table.players) {
        if (p.isBot) continue;
        const stake = p.chips + (table.inProgress ? p.totalBet : 0);
        this.deposit(p.userId, stake, `Cash-out from ${table.name} (server stopped)`);
      }
    }
    await Promise.allSettled([...this.pending]);
  }
}

module.exports = { Lobby, cleanName };
