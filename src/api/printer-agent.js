const express = require('express');
const crypto = require('crypto');

const db = require('../db/queries');
const log = require('../log');
const printwatch = require('../services/printwatch');
const { buildEscPosTicketWithCopies } = require('../services/printer');

const router = express.Router();
const json = express.json({ limit: '8kb', strict: true });
const pairingAttempts = new Map();

function hash(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(input).digest('hex');
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100);
}

function pairingAllowed(req) {
  const key = clientKey(req);
  const now = Date.now();

  // Mantém o limitador com tamanho finito mesmo se alguém variar o endereço
  // de origem para tentar consumir memória do processo.
  if (pairingAttempts.size >= 1_000) {
    for (const [storedKey, attempts] of pairingAttempts) {
      if (!attempts.some((t) => now - t < 15 * 60_000)) pairingAttempts.delete(storedKey);
    }
    if (pairingAttempts.size >= 1_000 && !pairingAttempts.has(key)) return false;
  }

  const recent = (pairingAttempts.get(key) || []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 5) return false;
  recent.push(now);
  pairingAttempts.set(key, recent);
  return true;
}

async function authenticate(req, res, next) {
  noStore(res);
  const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{40,100})$/);
  if (!match) return res.status(401).json({ error: 'unauthorized' });
  try {
    const device = await db.authenticatePrinterDevice(hash(match[1]));
    if (!device) return res.status(401).json({ error: 'unauthorized' });
    req.printerDevice = device;
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/printer-agent/pair', json, async (req, res) => {
  noStore(res);
  if (!pairingAllowed(req)) return res.status(429).json({ error: 'try_later' });

  const code = String(req.body?.code || '').replace(/\D/g, '');
  const name = String(req.body?.deviceName || 'Android')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 60);
  if (!/^\d{8}$/.test(code) || !name) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: `android_${crypto.randomBytes(8).toString('hex')}`,
    name,
    tokenHash: hash(token),
  };

  try {
    const created = await db.consumePrinterPairingCode(hash(code), device);
    if (!created) return res.status(401).json({ error: 'invalid_or_expired_code' });
    require('../services/printer-realtime').disconnectAll();
    log.info({ evt: 'impressao', aparelho: created.id, nome: created.name }, 'aparelho de impressao vinculado');
    return res.status(201).json({ token, deviceId: created.id });
  } catch (err) {
    log.error({ evt: 'impressao', err }, 'falha ao vincular aparelho de impressao');
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/printer-agent/next', authenticate, async (req, res) => {
  try {
    printwatch.registrarPolling();
    const leaseToken = crypto.randomBytes(24).toString('base64url');
    const order = await db.claimNextPrintableOrder(req.printerDevice.id, hash(leaseToken));
    if (!order) return res.json({ jobReady: false, pollAfterMs: 5000 });

    const payment = await db.getPaymentByOrderId(order.id);
    const bytes = Buffer.from(buildEscPosTicketWithCopies(order, payment), 'binary');
    log.info({ evt: 'impressao', pedido: order.id, aparelho: req.printerDevice.id }, 'comanda reservada pelo Android');
    return res.json({
      jobReady: true,
      jobId: String(order.id),
      leaseToken,
      contentBase64: bytes.toString('base64'),
      contentSha256: hash(bytes),
      leaseSeconds: 45,
    });
  } catch (err) {
    log.error({ evt: 'impressao', err }, 'falha ao entregar comanda ao Android');
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/printer-agent/complete', json, authenticate, async (req, res) => {
  const jobId = String(req.body?.jobId || '');
  const leaseToken = String(req.body?.leaseToken || '');
  if (!/^\d+$/.test(jobId) || !/^[A-Za-z0-9_-]{30,80}$/.test(leaseToken)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  try {
    const completed = await db.completeClaimedPrint(
      Number(jobId), req.printerDevice.id, hash(leaseToken)
    );
    if (!completed) return res.status(409).json({ error: 'invalid_or_expired_lease' });
    log.info({ evt: 'impressao', pedido: Number(jobId), aparelho: req.printerDevice.id }, 'pedido impresso pelo Android');
    return res.json({ ok: true });
  } catch (err) {
    log.error({ evt: 'impressao', err }, 'falha ao confirmar impressao Android');
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/printer-agent/fail', json, authenticate, async (req, res) => {
  const jobId = String(req.body?.jobId || '');
  const leaseToken = String(req.body?.leaseToken || '');
  if (!/^\d+$/.test(jobId) || !/^[A-Za-z0-9_-]{30,80}$/.test(leaseToken)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  try {
    await db.releaseClaimedPrint(Number(jobId), req.printerDevice.id, hash(leaseToken));
    log.warn({ evt: 'impressao', pedido: Number(jobId), aparelho: req.printerDevice.id }, 'Android devolveu comanda para a fila');
    return res.json({ ok: true });
  } catch (err) {
    log.error({ evt: 'impressao', err }, 'falha ao devolver comanda para fila');
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  noStore(res);
  log.error({ evt: 'impressao', err }, 'erro interno no agente Android');
  return res.status(500).json({ error: 'internal_error' });
});

module.exports = router;
module.exports.hash = hash;
