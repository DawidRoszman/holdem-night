'use strict';

const http = require('http');
const { rankPlayers } = require('./evaluator');

const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { status: 'ok', service: 'evaluator' });
    }
    if (req.method === 'POST' && req.url === '/rank') {
      try {
        const { board, players } = await readJson(req);
        if (!Array.isArray(board) || !Array.isArray(players) || players.length === 0) {
          return send(res, 400, { error: 'Expected { board: string[], players: [{id, hole}] }' });
        }
        return send(res, 200, rankPlayers(board, players));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    return send(res, 404, { error: 'Not found' });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4001;
  createServer().listen(port, () => console.log(`evaluator listening on :${port}`));
}

module.exports = { createServer };
