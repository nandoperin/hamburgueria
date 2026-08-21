const log = require('../log');

/**
 * Fila de impressões que não são comanda de pedido.
 *
 * Relatório, aviso de cancelamento e segunda via não têm de onde ser buscados:
 * a comanda o CloudPRNT acha sozinho no banco (`status = paid`), mas um
 * relatório existe só no instante em que alguém pediu. Então o conteúdo é
 * gerado na hora e fica aqui até a impressora vir buscar.
 *
 * **Em memória, de propósito.** Um deploy perde o que estiver na fila — e isso
 * é aceitável para papel que se refaz com um comando, enquanto pedido nenhum
 * pode se perder (por isso pedido continua no banco). Trocar por tabela seria
 * arrastar um problema resolvido para um lugar novo.
 */

// Teto para o caso de a impressora ficar fora por horas: sem ele, cada
// `!imprimir` empilha uma página que sairia toda de uma vez quando ela voltar.
const LIMITE = 20;

const PREFIXO = 'avulso:';

const trabalhos = [];
let sequencia = 0;

/** O jobToken é de um trabalho avulso? (comanda usa id numérico) */
function ehAvulso(token) {
  return String(token || '').startsWith(PREFIXO);
}

/**
 * Põe na fila e devolve o token, ou `null` se a fila estiver cheia.
 *
 * O `null` não é detalhe: quem chamou precisa dizer ao dono que não vai sair,
 * em vez de confirmar uma impressão que nunca aconteceria.
 */
function enfileirar({ conteudo, descricao }) {
  if (trabalhos.length >= LIMITE) {
    log.warn(
      { evt: 'impressao', fila: trabalhos.length, descricao },
      'fila de impressão cheia — trabalho recusado'
    );
    return null;
  }

  sequencia += 1;
  const token = `${PREFIXO}${sequencia}`;
  trabalhos.push({ token, conteudo, descricao, criadoEm: Date.now() });

  log.info(
    { evt: 'impressao', token, descricao, fila: trabalhos.length },
    `"${descricao}" na fila de impressão`
  );

  return token;
}

/** Próximo da fila, sem tirar — quem tira é o DELETE, depois de imprimir. */
function proximo() {
  return trabalhos[0] || null;
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

function tamanho() {
  return trabalhos.length;
}

/** Só para os testes. */
function limpar() {
  trabalhos.length = 0;
}

module.exports = { ehAvulso, enfileirar, proximo, porToken, confirmar, tamanho, limpar, LIMITE };
