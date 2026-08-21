/**
 * Higiene do que o cliente digita.
 *
 * Espelho de `texto.js`: aquele trata a **saída** (o papel e o canal do admin),
 * este trata a **entrada**. Ficam separados porque a pergunta é outra — lá é
 * "como isto fica legível", aqui é "o que disto pode ser um comando".
 *
 * ## Por que `ascii()` não bastava
 *
 * A comanda já passava por `ascii()`, que apaga o que está **fora** da tabela
 * ASCII. Os caracteres de controle estão dentro dela: `ESC` é 0x1B, e sobrevivia
 * inteiro até o fluxo da impressora — onde, segundo a mesma especificação que
 * `printer.js` usa para ampliar a fonte, `ESC d 2` corta o papel e `ESC i` muda
 * o tamanho do texto. Nome e endereço do cliente entram na comanda; um `ESC`
 * dentro deles seria comando, e não conteúdo.
 *
 * O mesmo byte no log é ruim de outro jeito: o `pino-pretty` escreve num
 * terminal, e uma sequência ANSI vinda de fora pinta, apaga ou reposiciona o que
 * o dono está lendo — inclusive as linhas anteriores.
 *
 * ## "Ninguém digita isso no celular"
 *
 * Verdade, e não é o ponto. O teclado do WhatsApp não produz `ESC`, mas a Cloud
 * API entrega o corpo da mensagem como veio, e quem manda pela API manda o byte
 * que quiser. A defesa não custa nada e não depende de o atacante ser desatento.
 *
 * ## Por que ponto de código, e não expressão regular
 *
 * A classe de caracteres teria que trazer os próprios caracteres — e são todos
 * invisíveis por definição. Ninguém releria essa linha depois, e um erro nela
 * não teria como aparecer. Comparar número tem revisão possível.
 */

// Os dois controles que ficam: tabulação e quebra de linha. Endereço de duas
// linhas é comum, e o parse do cadastro separa nome e email por `\n`.
const CONTROLE_PERMITIDO = new Set([0x09, 0x0a]);

/** C0 (até 0x1F) e C1 (0x7F–0x9F) — onde moram `ESC`, `NUL` e companhia. */
function ehControle(cp) {
  if (CONTROLE_PERMITIDO.has(cp)) return false;
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Invisíveis com uso conhecido em texto enganoso.
 *
 * Não aparecem em lugar nenhum — servem para esconder conteúdo dentro de algo
 * que parece normal, ou para inverter no visor a ordem do que está gravado. Um
 * nome e um endereço não precisam de nenhum deles.
 */
const INVISIVEIS = [
  [0x200b, 0x200f], // largura zero e marcas de direção
  [0x202a, 0x202e], // sobrescrita de direção (bidi override)
  [0x2060, 0x2064], // juntores invisíveis
  [0x2066, 0x2069], // isolamento de direção
  [0xfeff, 0xfeff], // BOM aparecendo no meio do texto
];

function ehInvisivel(cp) {
  return INVISIVEIS.some(([de, ate]) => cp >= de && cp <= ate);
}

/**
 * Tetos de tamanho.
 *
 * `mensagem` é o teto do próprio WhatsApp — repeti-lo aqui é só não depender de
 * a Meta continuar aplicando o dela. Os outros dois existem porque nome e
 * endereço são gravados e impressos na comanda: um nome de quatro mil
 * caracteres consome o rolo de papel inteiro numa comanda só.
 *
 * Os valores são folgados de propósito. Nome completo mais longo que 60 e
 * endereço mais longo que 120 não existem na área de entrega.
 */
const LIMITES = {
  mensagem: 4096,
  nome: 60,
  endereco: 120,
  email: 254, // teto do próprio formato (RFC 5321)
};

/**
 * Tira de uma mensagem recebida tudo que não é texto do cliente.
 *
 * Aplicado num ponto só, na entrada do router, para valer também para o handler
 * escrito daqui a um ano — pela mesma razão que `paraAdmin` fica na saída do
 * `admin.handle`, e não em cada resposta.
 *
 * O corte é feito sobre a lista de caracteres, e não com `slice` na string: o
 * emoji ocupa duas posições, e cortar no meio dele deixaria meio par solto.
 */
function limpar(texto, limite = LIMITES.mensagem) {
  return Array.from(String(texto ?? ''))
    .filter((c) => {
      const cp = c.codePointAt(0);
      return !ehControle(cp) && !ehInvisivel(cp);
    })
    .slice(0, limite)
    .join('')
    .trim();
}

/**
 * Corta no limite, sem reclamar.
 *
 * Recusar obrigaria a mais uma pergunta e mais uma mensagem cobrada, para um
 * caso que nenhum cliente real produz. Quem digitar um nome dentro do razoável
 * nunca encosta nisto.
 */
function curto(texto, limite) {
  return Array.from(String(texto ?? '')).slice(0, limite).join('').trim();
}

module.exports = { limpar, curto, LIMITES };
