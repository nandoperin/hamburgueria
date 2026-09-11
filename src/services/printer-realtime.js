const crypto = require('crypto');
const { Client } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');

const db = require('../db/queries');
const log = require('../log');
const printwatch = require('./printwatch');

const PATH = '/printer-agent/events';
const CHANNEL = 'printer_orders';
const clients = new Map();

let wss = null;
let heartbeat = null;
let listener = null;
let reconnectTimer = null;
let reconnectDelay = 1_000;
let stopping = false;
let pararAvisoAvulso = null;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bearer(req) {
  const match = String(req.headers.authorization || '')
    .match(/^Bearer ([A-Za-z0-9_-]{40,100})$/);
  return match?.[1] || null;
}

function reject(socket, status = 401, message = 'Unauthorized') {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

function signal() {
  const message = JSON.stringify({ type: 'print' });
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

function disconnectAll() {
  for (const ws of clients.values()) {
    try { ws.close(4001, 'revoked'); } catch { ws.terminate(); }
  }
  clients.clear();
}

function scheduleDatabaseReconnect(client) {
  if (stopping) return;
  if (listener === client) listener = null;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDatabase().catch(() => {});
  }, reconnectDelay);
  reconnectTimer.unref();
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

async function connectDatabase() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'point-burger-printer-listener',
    keepAlive: true,
  });
  client.on('notification', (event) => {
    if (event.channel !== CHANNEL) return;
    log.info({ evt: 'impressao', pedido: Number(event.payload) || undefined },
      'aviso de nova comanda enviado ao Android');
    signal();
  });
  client.on('error', (err) => {
    log.warn({ evt: 'impressao', err }, 'conexao de avisos do PostgreSQL caiu');
    scheduleDatabaseReconnect(client);
  });
  client.on('end', () => scheduleDatabaseReconnect(client));

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
    reconnectDelay = 1_000;
    log.info({ evt: 'boot' }, 'avisos instantaneos de impressao ativos');
  } catch (err) {
    log.warn({ evt: 'impressao', err }, 'nao foi possivel ouvir novos pedidos; tentando novamente');
    try { await client.end(); } catch { /* conexão incompleta */ }
    scheduleDatabaseReconnect(client);
  }
}

function start(server, { listenDatabase = true } = {}) {
  if (wss) return wss;
  stopping = false;

  wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });

  server.on('upgrade', async (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'https://localhost').pathname; } catch { return reject(socket, 400, 'Bad Request'); }
    if (pathname !== PATH) return reject(socket, 404, 'Not Found');

    const token = bearer(req);
    if (!token) return reject(socket);

    try {
      const device = await db.authenticatePrinterDevice(hash(token));
      if (!device) return reject(socket);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, device);
      });
    } catch (err) {
      log.error({ evt: 'impressao', err }, 'falha ao autenticar WebSocket da impressora');
      return reject(socket, 500, 'Internal Server Error');
    }
  });

  wss.on('connection', (ws, req, device) => {
    const previous = clients.get(device.id);
    if (previous && previous !== ws) previous.close(4000, 'replaced');
    clients.set(device.id, ws);
    ws.isAlive = true;
    printwatch.registrarPolling();
    ws.send(JSON.stringify({ type: 'ready' }));
    log.info({ evt: 'impressao', aparelho: device.id }, 'Android conectado em tempo real');

    ws.on('pong', () => {
      ws.isAlive = true;
      printwatch.registrarPolling();
    });
    ws.on('close', () => {
      if (clients.get(device.id) === ws) clients.delete(device.id);
      log.info({ evt: 'impressao', aparelho: device.id }, 'Android desconectado do tempo real');
    });
    ws.on('error', () => {});
  });

  heartbeat = setInterval(() => {
    for (const ws of clients.values()) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25_000);
  heartbeat.unref();

  // Papel avulso (2ª via, relatório, aviso) não passa pelo banco: a fila em
  // memória avisa direto, e o Android busca na hora.
  pararAvisoAvulso = require('./printqueue').aoEnfileirar(signal);

  if (listenDatabase) connectDatabase().catch(() => {});
  return wss;
}

async function stop() {
  stopping = true;
  if (pararAvisoAvulso) pararAvisoAvulso();
  pararAvisoAvulso = null;
  disconnectAll();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (listener) {
    const current = listener;
    listener = null;
    try { await current.end(); } catch { /* encerramento */ }
  }
  if (wss) wss.close();
  wss = null;
}

module.exports = { start, stop, signal, disconnectAll, hash, PATH };
