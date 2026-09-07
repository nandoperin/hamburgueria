const path = require('path');
const express = require('express');
const crypto = require('crypto');

const PROJECT = path.resolve(__dirname, '..');
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);

const sha = (v) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(v) ? v : Buffer.from(String(v))).digest('hex');
const pairingCode = '12345678';
let activeTokenHash = null;
let activeDevice = null;
let claim = null;
let printed = false;

require.cache[dbPath].exports = {
  consumePrinterPairingCode: async (codeHash, device) => {
    if (codeHash !== sha(pairingCode)) return null;
    activeTokenHash = device.tokenHash;
    activeDevice = { id: device.id, name: device.name };
    return activeDevice;
  },
  authenticatePrinterDevice: async (tokenHash) =>
    tokenHash === activeTokenHash ? activeDevice : null,
  claimNextPrintableOrder: async (deviceId, claimHash) => {
    if (printed || claim) return null;
    claim = { deviceId, claimHash };
    return {
      id: 42, status: 'paid', order_type: 'pickup', customer_name: 'Cliente Teste',
      phone: '16175550000', city: 'Everett', address: 'Retirada', subtotal: 12,
      delivery_fee: 0, total: 12, created_at: new Date().toISOString(),
      items_json: [{ name: 'X Burger', qty: 1, price: 12 }],
    };
  },
  getPaymentByOrderId: async () => ({ status: 'paid', approved_by: 'admin' }),
  completeClaimedPrint: async (id, deviceId, claimHash) => {
    if (id !== 42 || printed || !claim || claim.deviceId !== deviceId || claim.claimHash !== claimHash) return null;
    printed = true;
    claim = null;
    return { id, status: 'printed' };
  },
  releaseClaimedPrint: async () => null,
};

const router = require(`${PROJECT}/src/api/printer-agent`);
const app = express();
app.use(router);

function check(value, message) {
  if (!value) throw new Error(message);
}

(async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/printer-agent`;
  try {
    let response = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '00000000', deviceName: 'Atacante' }),
    });
    check(response.status === 401, 'código inventado foi recusado');

    response = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, deviceName: 'Celular da loja' }),
    });
    check(response.status === 201, 'código temporário vinculou o aparelho');
    const paired = await response.json();
    check(!JSON.stringify(paired).includes(pairingCode), 'código não voltou na resposta');
    check(paired.token && paired.deviceId, 'token individual foi entregue uma vez');

    response = await fetch(`${base}/next`, { method: 'POST', headers: { authorization: 'Bearer chute' } });
    check(response.status === 401, 'token inválido não lê a fila');

    response = await fetch(`${base}/next`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}` } });
    check(response.status === 200, 'aparelho autorizado consultou a fila');
    const job = await response.json();
    check(job.jobReady && job.jobId === '42', 'pedido foi reservado');
    check(!('phone' in job) && !('address' in job), 'dados do cliente não são campos consultáveis');
    const bytes = Buffer.from(job.contentBase64, 'base64');
    check(sha(bytes) === job.contentSha256, 'conteúdo tem verificação de integridade');

    response = await fetch(`${base}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: '42', leaseToken: 'x'.repeat(32) }),
    });
    check(response.status === 409, 'reserva falsa não marcou pedido como impresso');

    response = await fetch(`${base}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.jobId, leaseToken: job.leaseToken }),
    });
    check(response.status === 200 && printed, 'reserva correta confirmou a impressão');

    response = await fetch(`${base}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.jobId, leaseToken: job.leaseToken }),
    });
    check(response.status === 409, 'confirmação repetida não alterou novamente');
  } finally {
    server.close();
  }
})().then(() => process.exit(0)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
