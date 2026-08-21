const log = require('../log');

/**
 * O que o `/health` responde — e por que ele não pode ser só `{ok:true}`.
 *
 * Um monitor externo bate aqui a cada poucos minutos e avisa quando cai. Só
 * que "o processo está de pé" é a menor das falhas possíveis: se a chave do
 * Supabase for rotacionada, ou o token da Meta expirar, o Express continua
 * respondendo 200 alegremente enquanto nenhum pedido consegue ser gravado e
 * nenhuma mensagem consegue sair. O monitor ficaria verde a noite inteira.
 *
 * Então o endpoint verifica as duas coisas de que o atendimento depende e que
 * quebram em silêncio — banco e WhatsApp — e responde **503** quando alguma
 * falha, que é o que faz o monitor tocar.
 *
 * A impressora fica de fora do veredito de propósito: ela pode estar desligada
 * porque a loja fechou, e quem cobra atraso de comanda é o `printwatch`, que
 * sabe distinguir "sem trabalho" de "sumiu". Aqui ela entra só como informação.
 */

const GRAPH = 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v22.0';

// O monitor bate a cada 5 minutos; o cache existe para o endpoint aguentar
// também curl na mão, teste de rota e uma eventual rajada, sem multiplicar
// consulta ao banco e chamada à Graph API.
const CACHE_MS = 30 * 1000;

// A Graph API responde rápido, mas "rápido" não é garantia: sem teto, um
// timeout dela seguraria a resposta do health até o monitor desistir — e
// desistir é indistinguível de bot morto.
const TIMEOUT_MS = 5000;

let cache = null;

async function checarBanco() {
  await require('../db/queries').ping();
}

/**
 * O token da Meta ainda vale?
 *
 * Consulta mais barata possível: só o id do próprio número. Não é mensagem,
 * não conta na cota e não custa nada. No Baileys não há equivalente — a
 * conexão é contínua e quem reclama dela é o próprio provider —, então o
 * check é pulado.
 */
async function checarWhatsApp() {
  const provider = (process.env.WHATSAPP_PROVIDER || 'baileys').toLowerCase();
  if (provider !== 'meta') return;

  const res = await fetch(
    `${GRAPH}/${API_VERSION}/${process.env.META_PHONE_NUMBER_ID}?fields=id`,
    {
      headers: { authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `Graph API ${res.status}`);
  }
}

/**
 * O envio está de fato saindo?
 *
 * Diferente do `whatsapp` acima, que só prova que o token vale. Token válido com
 * conta bloqueada — cota estourada, ou sem forma de pagamento quando a cobrança
 * começar em 01/10/2026 — responde 200 na consulta e recusa toda mensagem. Sem
 * esta checagem o monitor ficaria verde a noite inteira com o bot mudo.
 *
 * E o aviso precisa sair por aqui, não pelo WhatsApp: é o WhatsApp que caiu.
 */
async function checarEnvio() {
  const { comprometido, falhasSeguidas } = require('../bot/notify').estadoDoEnvio();
  if (comprometido) {
    throw new Error(`${falhasSeguidas} mensagens seguidas falharam ao sair`);
  }
}

/**
 * Os segredos que autenticam quem bate na porta ainda estão no lugar?
 *
 * Existe por causa da decisão tomada em `webhooks/meta.js` e `cloudprnt.js`: sem
 * o segredo configurado, em produção eles **recusam** em vez de liberar. É a
 * escolha certa, e ela tem um efeito colateral que precisa de saída — uma
 * variável apagada por engano faria o bot parar de receber mensagem e de
 * imprimir, respondendo 401 em silêncio para o mundo inteiro.
 *
 * Sem esta checagem, o sintoma chegaria pelo cliente reclamando. Com ela, o
 * monitor toca em cinco minutos dizendo o nome da variável que sumiu.
 *
 * Só vale onde o fechamento acontece — em desenvolvimento declarado a ausência
 * é normal e não bloqueia nada. Ver `src/ambiente.js`.
 */
function checarSegredos() {
  if (!require('../ambiente').exigeSegredos()) return;

  const exigidos = ['CLOUDPRNT_TOKEN'];
  if ((process.env.WHATSAPP_PROVIDER || '').toLowerCase() === 'meta') {
    exigidos.push('META_APP_SECRET');
  }

  const faltando = exigidos.filter((chave) => !process.env[chave]);
  if (faltando.length) {
    throw new Error(`sem ${faltando.join(', ')} — porta fechada por seguranca`);
  }
}

const CHECAGENS = {
  banco: checarBanco,
  whatsapp: checarWhatsApp,
  envio: checarEnvio,
  segredos: checarSegredos,
};

async function avaliar() {
  const falhas = [];

  for (const [nome, checar] of Object.entries(CHECAGENS)) {
    try {
      await checar();
    } catch (err) {
      falhas.push(nome);
      log.error({ evt: 'saude', checagem: nome, err }, `checagem "${nome}" falhou`);
    }
  }

  const impressora = require('./printwatch').status();

  return {
    ok: falhas.length === 0,
    falhas,
    uptime: Math.round(process.uptime()),
    impressora: {
      viva: impressora.viva,
      // null enquanto ela nunca tiver consultado desde a subida.
      segundos: impressora.segundos,
    },
  };
}

/** Resultado das checagens, reaproveitado por até `CACHE_MS`. */
async function verificar() {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.resultado;

  const resultado = await avaliar();
  cache = { em: Date.now(), resultado };
  return resultado;
}

/** Só para os testes: descarta o cache entre cenários. */
function limparCache() {
  cache = null;
}

module.exports = { verificar, limparCache, CACHE_MS };
