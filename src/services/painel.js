const crypto = require('crypto');

const log = require('../log');
const db = require('../db/queries');
const notify = require('../bot/notify');

/** O link enviado pelo WhatsApp vale somente para a abertura imediata. */
const LINK_TTL_MS = 15 * 60 * 1000;

/** A sessão HttpOnly dura o suficiente para uma edição sem pressa. */
const SESSAO_TTL_MS = 30 * 60 * 1000;

function segredo() {
  return process.env.PAINEL_SECRET || '';
}

function habilitado() {
  return segredo().length >= 16;
}

/** Token de 256 bits, sem telefone, tipo, data ou outro dado identificável. */
function novoToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenValido(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** O banco recebe somente uma impressão irreversível vinculada ao segredo. */
function hash(token) {
  return crypto.createHmac('sha256', segredo()).update(token).digest('base64url');
}

function adminsAtuais() {
  return notify.admins();
}

function adminAtual(phone) {
  return adminsAtuais().includes(String(phone || ''));
}

/** Cria a estrutura idempotente sem tornar o atendimento dependente do painel. */
async function start() {
  if (!habilitado()) return false;
  try {
    await db.garantirTabelaPainelAcesso();
    await db.limparAcessosPainelExpirados();
    return true;
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao preparar credenciais do painel');
    return false;
  }
}

async function criarLink(phone) {
  if (!habilitado()) {
    log.error({ evt: 'painel' }, 'PAINEL_SECRET ausente ou curto demais — painel recusado');
    return { ok: false, motivo: 'painel_desabilitado' };
  }

  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, motivo: 'sem_base_url' };
  if (!adminAtual(phone)) return { ok: false, motivo: 'nao_autorizado' };

  const token = novoToken();
  try {
    await db.salvarLinkPainel(hash(token), String(phone), new Date(Date.now() + LINK_TTL_MS));
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao criar link do painel');
    return { ok: false, motivo: 'painel_indisponivel' };
  }

  return {
    ok: true,
    url: `${base}/painel?t=${token}`,
    minutos: Math.round(LINK_TTL_MS / 60000),
  };
}

/** Queima o link no banco e cria uma sessão opaca somente para admin atual. */
async function abrir(token) {
  if (!habilitado()) return { ok: false, motivo: 'painel_desabilitado' };
  if (!tokenValido(token)) return { ok: false, motivo: 'malformado' };

  const sessao = novoToken();
  let registro;
  try {
    registro = await db.consumirLinkPainel(
      hash(token),
      hash(sessao),
      new Date(Date.now() + SESSAO_TTL_MS),
      adminsAtuais()
    );
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao abrir painel');
    return { ok: false, motivo: 'painel_indisponivel' };
  }
  if (!registro) return { ok: false, motivo: 'invalido_usado_expirado_ou_revogado' };

  log.info({ evt: 'painel', phone: registro.phone }, 'painel aberto');
  return {
    ok: true,
    phone: registro.phone,
    sessao,
    minutos: Math.round(SESSAO_TTL_MS / 60000),
  };
}

/** Valida no banco e revoga imediatamente se o telefone deixou de ser admin. */
async function conferirSessao(token) {
  if (!habilitado()) return { ok: false, motivo: 'painel_desabilitado' };
  if (!tokenValido(token)) return { ok: false, motivo: 'malformado' };

  const tokenHash = hash(token);
  let registro;
  try {
    registro = await db.getSessaoPainel(tokenHash);
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao conferir sessao do painel');
    return { ok: false, motivo: 'painel_indisponivel' };
  }
  if (!registro) return { ok: false, motivo: 'invalido_expirado_ou_revogado' };
  if (!adminAtual(registro.phone)) {
    await db.revogarAcessoPainel(tokenHash).catch(() => {});
    return { ok: false, motivo: 'nao_autorizado' };
  }
  return { ok: true, phone: registro.phone };
}

/** Compatibilidade para testes; produção não mantém mais estado em memória. */
async function zerar() {
  return true;
}

module.exports = {
  habilitado,
  start,
  criarLink,
  abrir,
  conferirSessao,
  zerar,
  LINK_TTL_MS,
  SESSAO_TTL_MS,
};
