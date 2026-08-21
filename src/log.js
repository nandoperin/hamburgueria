const pino = require('pino');
const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Log estruturado do bot.
 *
 * O problema que isto resolve: quando um testador diz "não funcionou", o log
 * antigo tinha uma linha solta — "Erro ao criar pedido" — sem dizer de quem,
 * em que ponto da conversa, nem com qual pedido. Achar o resto era ler tudo em
 * volta pelo horário e torcer para ninguém mais estar conversando ao mesmo
 * tempo.
 *
 * Agora **toda** linha nascida durante o atendimento carrega o telefone, e a
 * partir do fechamento carrega também o número do pedido — sem que nenhuma
 * função precise receber isso por parâmetro. Quem faz esse transporte é o
 * `AsyncLocalStorage`: o ponto de entrada abre um escopo com `contexto()`, e
 * tudo que rodar dentro dele, por mais fundo que esteja na pilha de handlers,
 * enxerga os mesmos campos.
 *
 * Na Railway a saída é JSON (uma linha por evento, filtrável por `phone` ou
 * `pedido` na busca); no terminal, texto colorido.
 */

const escopo = new AsyncLocalStorage();

const nivel = process.env.LOG_LEVEL || 'info';

// Sem TTY é servidor: JSON, que a Railway indexa e deixa filtrar por campo.
// Com TTY é gente lendo: pino-pretty. `LOG_FORMAT` força qualquer um dos dois.
const formato =
  process.env.LOG_FORMAT || (process.stdout.isTTY ? 'pretty' : 'json');

const base = pino({
  level: nivel,
  // pid e hostname não dizem nada aqui: é um processo só, num container só.
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'token',
      'authToken',
      'access_token',
      'signature',
      'email',
      '*.token',
      '*.access_token',
      '*.email',
    ],
    censor: '[oculto]',
  },
  ...(formato === 'pretty' && nivel !== 'silent'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/**
 * Emite juntando o escopo corrente aos campos da chamada.
 *
 * Aceita as duas formas do pino: `log.info('texto')` e
 * `log.info({ campo }, 'texto')`.
 */
function emitir(metodo, primeiro, segundo) {
  const ctx = escopo.getStore();

  if (typeof primeiro === 'string') {
    if (!ctx) return base[metodo](primeiro);
    return base[metodo]({ ...ctx }, primeiro);
  }

  return base[metodo]({ ...ctx, ...primeiro }, segundo);
}

const log = {
  debug: (a, b) => emitir('debug', a, b),
  info: (a, b) => emitir('info', a, b),
  warn: (a, b) => emitir('warn', a, b),
  error: (a, b) => emitir('error', a, b),
};

/**
 * Abre um escopo. Tudo que `fn` logar — inclusive de dentro de `await` — sai
 * com estes campos. Devolve o que `fn` devolver, então dá para envolver um
 * handler assíncrono sem mudar quem o chama.
 */
function contexto(campos, fn) {
  return escopo.run({ ...campos }, fn);
}

/**
 * Acrescenta campos ao escopo já aberto, valendo das próximas linhas em diante.
 *
 * Serve para o que só se descobre no meio do caminho: o número do pedido só
 * existe depois de gravado no banco, e a partir dali toda linha deve levá-lo.
 * Fora de um escopo, não faz nada — chamar de um script avulso é inofensivo.
 */
function marcar(campos) {
  const ctx = escopo.getStore();
  if (ctx) Object.assign(ctx, campos);
}

// O texto do cliente é o que mais ajuda a reconstruir um relato ("mandei 2 e
// ele repetiu o menu"), e é o mesmo conteúdo que o dono já lê no WhatsApp.
// Ainda assim carrega endereço: `LOG_TEXTO=off` desliga sem mexer no código.
const TEXTO_MAX = 160;
const LOGAR_TEXTO = process.env.LOG_TEXTO !== 'off';

function texto(body) {
  if (!LOGAR_TEXTO) return undefined;
  const valor = String(body ?? '');
  return valor.length <= TEXTO_MAX ? valor : `${valor.slice(0, TEXTO_MAX)}…`;
}

module.exports = { ...log, contexto, marcar, texto, base };
