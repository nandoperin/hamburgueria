const crypto = require('crypto');

const log = require('../log');

/**
 * Acesso ao painel: link mágico pelo WhatsApp, sem senha.
 *
 * ## Por que não tem login
 *
 * Introduzir senha significaria armazenamento, sessão, recuperação e uma tela
 * de login numa URL pública — uma superfície nova inteira, para autenticar
 * alguém que o sistema **já sabe autenticar**. O `ADMIN_PHONE` é o âncora de
 * confiança desde o começo: é ele que autoriza `!liberar`, que solta comida
 * sem pagamento. Um painel que muda preço não merece uma âncora mais forte que
 * essa; merece a mesma.
 *
 * ## Os dois tokens, e por que são dois
 *
 * O link que vai para o WhatsApp é **de uso único**: ele abre a página uma vez
 * e queima. O que a página usa depois, para salvar, é um segundo token que vive
 * só na memória do navegador — nunca em cookie, nunca no histórico.
 *
 * A diferença importa: mensagem de WhatsApp fica no aparelho, pode ser
 * encaminhada, e a URL entra no histórico do navegador. Se esse link valesse
 * para sempre, cada `!painel` deixaria uma chave permanente espalhada por aí.
 * Queimando na primeira abertura, o que vazar depois já não serve.
 *
 * Um cookie de sessão daria o mesmo conforto e um risco a mais — sobreviveria
 * ao fechamento da aba, no celular que fica em cima do balcão.
 *
 * ## Segredo que falta fecha a porta
 *
 * Sem `PAINEL_SECRET`, `criarLink` recusa e as rotas respondem 503. É a mesma
 * inversão de `ambiente.js` e do `CLOUDPRNT_TOKEN`: o caso não previsto — host
 * novo, variável apagada — cai do lado fechado, não do lado aberto.
 */

/** O link do WhatsApp vale pouco: é para abrir agora, não para guardar. */
const LINK_TTL_MS = 15 * 60 * 1000;

/** A sessão da página dura o suficiente para uma edição sem pressa. */
const SESSAO_TTL_MS = 30 * 60 * 1000;

/**
 * Links já usados (ou expirados) — para o uso único valer.
 *
 * Em memória, e não no banco, de propósito: a janela é de 15 minutos, e um
 * reinício dentro dela é raro. O custo de errar é pequeno (um link volta a
 * valer, e ainda exige tê-lo em mãos); o custo de uma tabela seria uma consulta
 * a cada abertura, para sempre.
 */
const queimados = new Map();

function limparQueimados() {
  const agora = Date.now();
  for (const [id, expira] of queimados) {
    if (expira < agora) queimados.delete(id);
  }
}

function segredo() {
  return process.env.PAINEL_SECRET || '';
}

/** O painel está habilitado? Sem segredo, não. */
function habilitado() {
  return segredo().length >= 16;
}

function assinar(carga) {
  return crypto.createHmac('sha256', segredo()).update(carga).digest('base64url');
}

/** Comparação em tempo constante — o mesmo cuidado do `cloudprnt.js`. */
function iguais(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Monta um token assinado.
 *
 * Formato: `tipo.phone.expira.id.assinatura` — tudo em claro menos a
 * assinatura, que é o que impede forjar. Não há segredo dentro do token; ele
 * não precisa ser secreto, precisa ser **inforjável e curto de vida**.
 */
function criarToken(tipo, phone, ttl) {
  const expira = Date.now() + ttl;
  const id = crypto.randomBytes(16).toString('base64url');
  const carga = `${tipo}.${phone}.${expira}.${id}`;
  return `${carga}.${assinar(carga)}`;
}

/**
 * @returns {{ok: true, tipo: string, phone: string, id: string}
 *          |{ok: false, motivo: string}}
 */
function lerToken(token, tipoEsperado) {
  if (!habilitado()) return { ok: false, motivo: 'painel_desabilitado' };

  const partes = String(token || '').split('.');
  if (partes.length !== 5) return { ok: false, motivo: 'malformado' };

  const [tipo, phone, expira, id, assinatura] = partes;

  // Assinatura antes de qualquer outra coisa: enquanto ela não confere, os
  // outros campos são texto de estranho e não merecem interpretação.
  if (!iguais(assinatura, assinar(`${tipo}.${phone}.${expira}.${id}`))) {
    return { ok: false, motivo: 'assinatura_invalida' };
  }

  if (tipo !== tipoEsperado) return { ok: false, motivo: 'tipo_errado' };
  if (Number(expira) < Date.now()) return { ok: false, motivo: 'expirado' };

  return { ok: true, tipo, phone, id };
}

// ------------------------------------------------------------------- link

/**
 * O link que o `!painel` manda. Só para quem já é admin — quem chama confere.
 *
 * @returns {{ok: true, url: string, minutos: number} | {ok: false, motivo: string}}
 */
function criarLink(phone) {
  if (!habilitado()) {
    log.error(
      { evt: 'painel' },
      'PAINEL_SECRET ausente ou curto demais — painel recusado'
    );
    return { ok: false, motivo: 'painel_desabilitado' };
  }

  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false, motivo: 'sem_base_url' };

  const token = criarToken('link', phone, LINK_TTL_MS);
  return {
    ok: true,
    url: `${base}/painel?t=${token}`,
    minutos: Math.round(LINK_TTL_MS / 60000),
  };
}

/**
 * Abre o painel: valida o link, **queima** e devolve a sessão da página.
 *
 * Queimar aqui, e não na primeira gravação, é o que faz o link do WhatsApp
 * valer uma vez só.
 */
function abrir(token) {
  limparQueimados();

  const lido = lerToken(token, 'link');
  if (!lido.ok) return lido;

  if (queimados.has(lido.id)) return { ok: false, motivo: 'ja_usado' };
  queimados.set(lido.id, Date.now() + LINK_TTL_MS);

  log.info({ evt: 'painel', phone: lido.phone }, 'painel aberto');

  return {
    ok: true,
    phone: lido.phone,
    sessao: criarToken('sessao', lido.phone, SESSAO_TTL_MS),
    minutos: Math.round(SESSAO_TTL_MS / 60000),
  };
}

/** Valida o token que a página manda em cada gravação. */
function conferirSessao(token) {
  return lerToken(token, 'sessao');
}

/** Só para os testes. */
function zerar() {
  queimados.clear();
}

module.exports = {
  habilitado,
  criarLink,
  abrir,
  conferirSessao,
  zerar,
  LINK_TTL_MS,
  SESSAO_TTL_MS,
};
