'use strict';

// A scripted human-like player used by the multiplayer e2e flow. It connects
// over the same public WebSocket endpoint as the browser, opens a table and
// starts the game once someone joins and always checks or calls, so the Maestro-driven browser player has a real
// second client to play against. It signs in through the accounts API like
// the browser does (creating its account on first use).
//
// Usage: node remote-player.js [ws://localhost:8090/ws] [Table name]

const url = process.argv[2] || process.env.WS_URL || 'ws://localhost:8090/ws';
const tableName = process.argv[3] || 'Remote Table';
const playerName = 'Remote Rita';
const password = 'remote-secret';
const accountsUrl = `${url.replace(/^ws/, 'http').replace(/\/ws$/, '')}/api/accounts`;

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${accountsUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Registers on first use, logs in afterwards, and tops up the bank for the buy-in.
async function signIn() {
  let res = await post('/register', { username: playerName, password });
  if (res.status === 409) res = await post('/login', { username: playerName, password });
  if (!res.body.token) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  await post('/buy', { amount: 1000 }, res.body.token);
  return res.body.token;
}

async function start() {
  let token;
  try {
    token = await signIn();
  } catch (err) {
    console.log(`[remote-player] ${err.message}, retrying in 1s`);
    setTimeout(start, 1000);
    return;
  }
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', token }));
    ws.send(JSON.stringify({ type: 'createTable', name: tableName }));
    console.log(`[remote-player] connected to ${url}, opened "${tableName}"`);
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') {
      // it hosts its table: start the game as soon as someone sits down with it
      if (msg.table.you && msg.table.you.canStart) ws.send(JSON.stringify({ type: 'startGame' }));
      const legal = msg.table.you && msg.table.you.legal;
      if (legal) {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'action', action: legal.canCheck ? 'check' : 'call' }));
        }, 200);
      }
    } else if (msg.type === 'error') {
      console.log(`[remote-player] server says: ${msg.message}`);
    }
  });
  ws.addEventListener('close', () => {
    console.log('[remote-player] disconnected, retrying in 1s');
    setTimeout(start, 1000);
  });
  ws.addEventListener('error', () => {});
}

start();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
