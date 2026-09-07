const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const PROJECT = path.resolve(__dirname, '..');
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);

const allowedHash = require('crypto').createHash('sha256')
  .update('a'.repeat(43)).digest('hex');

require.cache[dbPath].exports = {
  authenticatePrinterDevice: async (tokenHash) =>
    tokenHash === allowedHash ? { id: 'android_test', name: 'Teste' } : null,
};

const realtime = require(`${PROJECT}/src/services/printer-realtime`);

function check(value, message) {
  if (!value) throw new Error(message);
}

(async () => {
  const app = express();
  const server = http.createServer(app);
  realtime.start(server, { listenDatabase: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}${realtime.PATH}`;

  try {
    const deniedStatus = await new Promise((resolve, reject) => {
      const denied = new WebSocket(url);
      denied.on('unexpected-response', (request, response) => {
        const status = response.statusCode;
        response.resume();
        resolve(status);
      });
      denied.on('open', () => reject(new Error('WebSocket sem token foi aceito')));
      denied.on('error', () => {});
    });
    check(deniedStatus === 401, 'WebSocket sem token foi recusado');

    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${'a'.repeat(43)}` },
    });
    const ready = await new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(String(data)));
      socket.once('error', reject);
    });
    check(ready === '{"type":"ready"}', 'aparelho autenticado recebeu somente ready');

    const notice = new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(String(data)));
      socket.once('error', reject);
    });
    realtime.signal();
    const message = await notice;
    check(message === '{"type":"print"}', 'aviso não contém dados do pedido');

    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    realtime.disconnectAll();
    check(await closed === 4001, 'revogação encerrou a conexão ativa');

    const schema = fs.readFileSync(`${PROJECT}/src/db/schema.sql`, 'utf8');
    check(/pg_notify\('printer_orders'/.test(schema), 'banco avisa quando pedido vira pago');
  } finally {
    await realtime.stop();
    await new Promise((resolve) => server.close(resolve));
  }
})().then(() => process.exit(0)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
