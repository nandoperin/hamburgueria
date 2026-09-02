/**
 * Ponte para quem está fora do fluxo de mensagem (avisos, watchers) conseguir
 * enviar pelo bot sem criar dependência circular com o módulo de conexão.
 *
 * Também isola os recursos que só a Cloud API tem (listas tocáveis, catálogo).
 * O Baileys não os registra, então tudo cai automaticamente no equivalente em
 * texto — os handlers não precisam saber qual provider está ativo.
 */

const log = require('../log');

let sender = null;
let rich = null;

/** Registrado pelo bot assim que a conexão com o WhatsApp é aberta. */
function register(fn) {
  sender = fn;
}

/** Registrado só pelos providers que suportam mensagens interativas. */
function registerRich(api) {
  rich = api;
}

function supportsRich() {
  return Boolean(rich);
}

// Tentativas e espera entre elas. Curtas de propósito: o cliente está
// esperando a resposta, e uma mensagem que chega tarde demais já não serve.
const TENTATIVAS = 3;
const ESPERAS_MS = [400, 1200];

/**
 * Vale repetir esta falha?
 *
 * Só erro de rede e resposta do servidor. Um 4xx é recusa da própria
 * requisição — botão com texto longo demais, número inválido, janela de 24h
 * fechada — e repetir dá o mesmo erro três vezes, atrasando a resposta.
 * A exceção é 429, que é excesso de chamadas e passa com uma pausa.
 */
function valeRepetir(err) {
  if (!err.status) return true; // sem status = falha de rede
  return err.status === 429 || err.status >= 500;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- o envio ainda funciona?
//
// Token válido com conta bloqueada (cota estourada, ou sem forma de pagamento
// quando a cobrança começar em 01/10/2026) pode recusar toda mensagem. O
// `/health` simples continua verde porque mede somente o processo HTTP; este
// contador preserva o diagnóstico operacional no log e tenta avisar o dono.
//
// Uma falha isolada não diz nada: número que não existe, janela de 24h fechada.
// Três seguidas, em clientes diferentes, é sistêmico.

const FALHAS_PARA_ALARME = 3;

// Passado esse tempo sem nenhuma tentativa, o contador para de valer. Sem isto,
// três falhas às 23h50 deixariam o monitor vermelho até a loja reabrir — e o
// alerta chegaria às 3 da manhã, para ninguém.
const JANELA_MS = 30 * 60 * 1000;

let falhasSeguidas = 0;
let ultimaFalhaEm = null;

let jaAvisou = false;
let avisando = false;

function registrarEnvio(ok) {
  if (ok) {
    falhasSeguidas = 0;
    jaAvisou = false; // voltou a funcionar: a próxima queda avisa de novo
    return;
  }
  falhasSeguidas += 1;
  ultimaFalhaEm = Date.now();
  avisarDono();
}

/**
 * Para qual número vai um aviso do sistema.
 *
 * `ADMIN_PHONE` é uma **lista** separada por vírgula — todos podem dar
 * comandos (`admin.isAdminPhone` confere a lista inteira), mas aviso
 * automático vai para o primeiro, que é o dono. Notificar todo mundo a cada
 * comprovante transformaria a equipe num grupo de avisos.
 *
 * Isto existe como função porque a mesma linha estava copiada em seis lugares,
 * e dois deles a copiaram **errado** — sem o `split`. Com um único admin
 * ninguém notava; no dia em que o segundo número entrou, `ADMIN_PHONE` virou
 * "1617...,1555..." e aqueles dois passaram a montar um telefone de 22 dígitos
 * juntando os dois. O aviso de cancelamento de pedido e o de teto de gasto
 * simplesmente deixavam de chegar, sem erro nenhum no log.
 *
 * @returns {string} só dígitos, ou '' se não houver admin configurado
 */
function dono() {
  return (process.env.ADMIN_PHONE || '').split(',')[0].replace(/\D/g, '');
}

/**
 * Tenta avisar o dono pelo WhatsApp — melhor esforço, e só isso.
 *
 * Num bloqueio total esta mensagem **não vai chegar**: o canal que ela usaria é
 * exatamente o que está fora. Aqui cobre-se a falha parcial: janela de 24h
 * fechada para alguns, número de cliente inválido, instabilidade de uma região.
 *
 * Vai direto no `sender`, sem passar pelo `send`: assim não repete, não conta
 * como falha e não tem como chamar a si mesma.
 */
function avisarDono() {
  if (jaAvisou || avisando || !envioComprometido() || !sender) return;

  const admin = dono();
  if (!admin) return;

  jaAvisou = true;
  avisando = true;

  const texto = require('../texto').paraAdmin(
    `🔇 *O bot não está conseguindo responder*\n\n` +
      `${falhasSeguidas} mensagens seguidas falharam ao sair.\n\n` +
      `Costuma ser a conta da Meta: cota do dia, token vencido, ou forma de ` +
      `pagamento (a cobrança por mensagem começa em 01/10/2026).\n\n` +
      `_Se você está lendo isto, o bloqueio é parcial — num bloqueio total esta ` +
      `mensagem também não sairia. Confira os logs do Railway._`
  );

  Promise.resolve(sender(admin, texto))
    .catch(() => {
      // Esperado num bloqueio total; o erro permanece registrado no log.
    })
    .finally(() => {
      avisando = false;
    });
}

/** O bot está incapaz de falar com os clientes agora? */
function envioComprometido() {
  if (falhasSeguidas < FALHAS_PARA_ALARME) return false;
  return Date.now() - ultimaFalhaEm < JANELA_MS;
}

function estadoDoEnvio() {
  return { falhasSeguidas, ultimaFalhaEm, comprometido: envioComprometido() };
}

/** Só para os testes. */
function zerarEnvio() {
  falhasSeguidas = 0;
  ultimaFalhaEm = null;
  jaAvisou = false;
  avisando = false;
}

/**
 * Envia com nova tentativa em falha transitória.
 *
 * Sem isso, uma instabilidade momentânea da Graph API deixava o cliente sem
 * resposta no meio do pedido — ele não sabe se deu errado, e desiste.
 */
async function send(phone, text) {
  if (!sender) {
    log.warn({ evt: 'envio', phone, motivo: 'desconectado' }, 'mensagem não enviada');
    registrarEnvio(false);
    return false;
  }

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    try {
      await sender(phone, text);
      if (tentativa > 1) {
        log.info({ evt: 'envio', phone, tentativa }, 'mensagem entregue após repetir');
      }
      registrarEnvio(true);
      return true;
    } catch (err) {
      const ultima = tentativa === TENTATIVAS;

      if (!valeRepetir(err) || ultima) {
        registrarEnvio(false);
        log.error(
          {
            evt: 'envio',
            phone,
            tentativas: tentativa,
            status: err.status,
            falhasSeguidas,
            err,
          },
          'falha ao enviar mensagem'
        );
        return false;
      }

      await espera(ESPERAS_MS[tentativa - 1]);
    }
  }

  return false;
}

/**
 * Recurso interativo que não foi.
 *
 * É sempre aviso, nunca erro: todos degradam para texto e o cliente segue
 * atendido. A linha existe para o caso de a degradação virar regra — cardápio
 * saindo em lista numerada todo dia é sintoma de catálogo ou token com problema.
 */
function falhouRich(recurso, phone, err) {
  log.warn(
    { evt: 'envio', recurso, phone, status: err.status, err },
    `${recurso} falhou — caindo para texto`
  );
}

/**
 * Lista tocável, com degradação para texto numerado.
 *
 * `rows[].id` é o que volta no webhook quando a lista é nativa. No fallback em
 * texto o cliente responde o número, e quem chamou resolve pela ordem — por
 * isso o array de linhas é devolvido, na mesma ordem em que foi exibido.
 */
async function sendList(phone, { body, button, sections, header, footer }) {
  const rows = sections.flatMap((section) => section.rows);

  if (rich?.sendList) {
    try {
      await rich.sendList(phone, { body, button, sections, header, footer });
      return rows;
    } catch (err) {
      falhouRich('lista', phone, err);
    }
  }

  const lines = [];
  if (header) lines.push(`*${header}*`, '');
  lines.push(body, '');

  let index = 0;
  for (const section of sections) {
    if (sections.length > 1) lines.push(`*${section.title}*`);
    for (const row of section.rows) {
      index += 1;
      lines.push(`${index}. ${row.title}${row.description ? ` — ${row.description}` : ''}`);
    }
    lines.push('');
  }
  if (footer) lines.push(`_${footer}_`);

  await send(phone, lines.join('\n').trim());
  return rows;
}

async function sendCatalog(phone, options) {
  if (!rich?.sendCatalog) return false;
  try {
    await rich.sendCatalog(phone, options);
    return true;
  } catch (err) {
    falhouRich('catálogo', phone, err);
    return false;
  }
}

async function sendProductList(phone, options) {
  if (!rich?.sendProductList) return false;
  try {
    await rich.sendProductList(phone, options);
    return true;
  } catch (err) {
    falhouRich('lista de produtos', phone, err);
    return false;
  }
}

/** Botões de resposta rápida, sem fallback automático — quem chama decide o texto. */
async function sendButtons(phone, options) {
  if (!rich?.sendButtons) return false;
  try {
    await rich.sendButtons(phone, options);
    return true;
  } catch (err) {
    falhouRich('botões', phone, err);
    return false;
  }
}

/** Imagem avulsa, melhor esforço — decorativo, nunca deve travar o atendimento. */
async function sendImage(phone, options) {
  if (!rich?.sendImage) return false;
  try {
    await rich.sendImage(phone, options);
    return true;
  } catch (err) {
    falhouRich('imagem', phone, err);
    return false;
  }
}

module.exports = {
  dono,
  register,
  registerRich,
  supportsRich,
  envioComprometido,
  estadoDoEnvio,
  zerarEnvio,
  send,
  sendList,
  sendCatalog,
  sendProductList,
  sendButtons,
  sendImage,
};
