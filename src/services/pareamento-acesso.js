const crypto = require('crypto');

// O link dura pouco: é credencial forte num endereço público, e quem o perde
// pede outro (o bot registra um novo assim que o anterior expira). Cinco
// minutos, e não um: o log do Railway chega com até um minuto de atraso, e com
// 1 min o link já nascia vencido para quem o lê ali (dono, 19/09). A sessão
// que ele abre dura mais, para dar tempo de escanear.
const LINK_TTL_MS = 5 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
// O link vale algumas aberturas, não uma só: a pré-visualização do WhatsApp e
// o pré-carregamento do navegador abrem sozinhos e queimavam o acesso antes do
// dono (19/09 — o bot ficou fora do ar sem ninguém conseguir escanear).
const MAX_ABERTURAS = 5;
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
    expira: Date.now() + LINK_TTL_MS,
    aberturas: 0,
    url: `${base}/pareamento?t=${token}`,
  };
  return { ok: true, url: link.url, novo: true, minutos: LINK_TTL_MS / 60000 };
}

/** Consome o link e cria a credencial que ficará somente em cookie HttpOnly. */
function abrir(token) {
  if (!configurado() || !valido(token) || !link || link.expira <= Date.now() ||
      link.aberturas >= MAX_ABERTURAS) {
    return { ok: false };
  }
  if (!iguais(hash(token), link.hash)) return { ok: false };
  link.aberturas += 1;
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

module.exports = { configurado, preparar, abrir, conferir, encerrar, TTL_MS, LINK_TTL_MS, MAX_ABERTURAS };
