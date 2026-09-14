const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
let link = null;
const sessoes = new Map();

function segredo() {
  return process.env.PAIRING_SECRET || '';
}

function configurado() {
  const s = segredo();
  return s.trim().length >= 32 && s !== process.env.PAINEL_SECRET;
}

function hash(token) {
  return crypto.createHmac('sha256', segredo()).update(token).digest('base64url');
}

function novoToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function iguais(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function valido(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Um link por tentativa de conexão, não um novo link a cada QR de 20s. */
function preparar() {
  if (!configurado()) return { ok: false, motivo: 'desabilitado' };
  const base = String(process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, motivo: 'sem_base_url' };
  // Depois de aberto, o mesmo registro continua vivo até a sessão expirar.
  // Não emitir e registrar outro link a cada atualização do QR (~20s).
  if (link && link.expira > Date.now()) {
    return { ok: true, url: link.url, novo: false };
  }

  const token = novoToken();
  link = {
    hash: hash(token),
    expira: Date.now() + TTL_MS,
    usado: false,
    url: `${base}/pareamento?t=${token}`,
  };
  return { ok: true, url: link.url, novo: true, minutos: TTL_MS / 60000 };
}

/** Consome o link e cria a credencial que ficará somente em cookie HttpOnly. */
function abrir(token) {
  if (!configurado() || !valido(token) || !link || link.usado || link.expira <= Date.now()) {
    return { ok: false };
  }
  if (!iguais(hash(token), link.hash)) return { ok: false };
  link.usado = true;
  const sessao = novoToken();
  sessoes.set(hash(sessao), Date.now() + TTL_MS);
  return { ok: true, sessao, segundos: Math.floor(TTL_MS / 1000) };
}

function conferir(token) {
  if (!configurado() || !valido(token)) return false;
  const expira = sessoes.get(hash(token));
  if (!expira || expira <= Date.now()) {
    if (expira) sessoes.delete(hash(token));
    return false;
  }
  return true;
}

/** Conectou ou reiniciou: links e sessões da tentativa anterior morrem. */
function encerrar() {
  link = null;
  sessoes.clear();
}

module.exports = { configurado, preparar, abrir, conferir, encerrar, TTL_MS };
