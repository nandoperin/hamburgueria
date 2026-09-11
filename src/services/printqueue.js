const log = require('../log');

/**
 * Fila de impressões que não são comanda de pedido.
 *
 * Relatório, aviso de cancelamento e segunda via não têm de onde ser buscados:
 * a comanda a impressora acha sozinha no banco (`status = paid`), mas um
 * relatório existe só no instante em que alguém pediu. Então o conteúdo é
 * gerado na hora e fica aqui até a impressora vir buscar.
 *
 * **Duas impressoras possíveis, dois formatos.** O CloudPRNT busca `conteudo`,
 * no formato do `PRINTER_FORMAT`; o agente Android busca `escpos`. Quem
 * enfileira passa `gerar`, e a mesma página sai nos dois formatos. Antes disto
 * só o CloudPRNT lia a fila: com o Android, `!imprimir 42` entrava aqui e nunca
 * saía no papel.
 *
 * **Em memória, de propósito.** Um deploy perde o que estiver na fila — e isso
 * é aceitável para papel que se refaz com um comando, enquanto pedido nenhum
 * pode se perder (por isso pedido continua no banco). Trocar por tabela seria
 * arrastar um problema resolvido para um lugar novo.
 */

// Teto para o caso de a impressora ficar fora por horas: sem ele, cada
// `!imprimir` empilha uma página que sairia toda de uma vez quando ela voltar.
const LIMITE = 20;

// Mesmo prazo da reserva de comanda no banco: se o celular cair no meio da
// impressão, o trabalho volta sozinho para a fila.
const RESERVA_MS = 45 * 1000;

const PREFIXO = 'avulso:';

const trabalhos = [];
const ouvintes = new Set();
let sequencia = 0;

/** O jobToken é de um trabalho avulso? (comanda usa id numérico) */
function ehAvulso(token) {
  return String(token || '').startsWith(PREFIXO);
}

/**
 * Quem precisa saber que chegou papel novo — o tempo real do Android. Sem o
 * aviso, o celular só buscaria na próxima comanda ou na conferência de 15 min.
 */
function aoEnfileirar(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

/**
 * Põe na fila e devolve o token, ou `null` se a fila estiver cheia.
 *
 * O `null` não é detalhe: quem chamou precisa dizer ao dono que não vai sair,
 * em vez de confirmar uma impressão que nunca aconteceria.
 *
 * `gerar` monta a página; ela é gerada agora, nos dois formatos, para a hora
 * impressa ser a do pedido e não a da impressão. `conteudo` pronto também é
 * aceito — o Android recebe esse texto fechado em ESC/POS.
 */
function enfileirar({ conteudo, gerar, descricao }) {
  if (trabalhos.length >= LIMITE) {
    log.warn(
      { evt: 'impressao', fila: trabalhos.length, descricao },
      'fila de impressão cheia — trabalho recusado'
    );
    return null;
  }

  const printer = require('./printer');
  sequencia += 1;
  const token = `${PREFIXO}${sequencia}`;
  trabalhos.push({
    token,
    descricao,
    criadoEm: Date.now(),
    conteudo: gerar ? gerar() : conteudo,
    escpos: gerar ? printer.emEscPos(gerar) : printer.textoEmEscPos(conteudo),
    reserva: null,
  });

  log.info(
    { evt: 'impressao', token, descricao, fila: trabalhos.length },
    `"${descricao}" na fila de impressão`
  );

  for (const fn of ouvintes) {
    try {
      fn();
    } catch (err) {
      log.warn({ evt: 'impressao', err }, 'aviso de papel novo falhou');
    }
  }

  return token;
}

/** Sem reserva, ou com a reserva vencida (o celular caiu no meio). */
function livre(trabalho, agora = Date.now()) {
  return !trabalho.reserva || trabalho.reserva.ate <= agora;
}

/**
 * Próximo da fila, sem tirar — quem tira é o DELETE, depois de imprimir.
 * Pula o que o Android reservou, para a mesma página não sair duas vezes.
 */
function proximo() {
  return trabalhos.find((t) => livre(t)) || null;
}

function porToken(token) {
  return trabalhos.find((t) => t.token === token) || null;
}

/** Chamado quando a impressora confirma. */
function confirmar(token) {
  const i = trabalhos.findIndex((t) => t.token === token);
  if (i === -1) return null;

  const [trabalho] = trabalhos.splice(i, 1);
  return trabalho;
}

/**
 * O Android reserva antes de imprimir — mesmo protocolo da comanda: só quem
 * tem a reserva confirma, e ela vence sozinha se o celular sumir.
 */
function reservar(dispositivo, hash) {
  const agora = Date.now();
  const trabalho = trabalhos.find((t) => livre(t, agora));
  if (!trabalho) return null;

  trabalho.reserva = { dispositivo, hash, ate: agora + RESERVA_MS };
  return trabalho;
}

function daReserva(token, dispositivo, hash) {
  return trabalhos.findIndex((t) =>
    t.token === token &&
    t.reserva?.dispositivo === dispositivo &&
    t.reserva?.hash === hash);
}

/** Impresso pelo Android: sai da fila. Reserva de outro → null. */
function concluirReserva(token, dispositivo, hash) {
  const i = daReserva(token, dispositivo, hash);
  if (i === -1) return null;

  const [trabalho] = trabalhos.splice(i, 1);
  return trabalho;
}

/** O Android não conseguiu imprimir: o trabalho volta para a fila na hora. */
function liberarReserva(token, dispositivo, hash) {
  const i = daReserva(token, dispositivo, hash);
  if (i === -1) return false;

  trabalhos[i].reserva = null;
  return true;
}

function tamanho() {
  return trabalhos.length;
}

/** Só para os testes. */
function limpar() {
  trabalhos.length = 0;
}

module.exports = {
  ehAvulso,
  aoEnfileirar,
  enfileirar,
  proximo,
  porToken,
  confirmar,
  reservar,
  concluirReserva,
  liberarReserva,
  tamanho,
  limpar,
  LIMITE,
};
