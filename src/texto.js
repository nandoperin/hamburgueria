/**
 * Normalização de texto compartilhada entre a impressora e o canal do admin.
 *
 * Os dois querem a mesma coisa por motivos diferentes: o papel sai em ASCII
 * porque a impressora interpreta byte a byte na code page dela, e o admin
 * porque acento e emoji só atrapalham quem lê comando e relatório correndo.
 *
 * O cliente é o oposto — mensagem em português sem acento parece bot quebrado,
 * e as bandeiras da escolha de idioma dispensam traduzir a pergunta. Por isso
 * isto **nunca** é aplicado ao que vai para o cliente.
 */

/**
 * Tira acento, cedilha e tudo que não for ASCII — inclusive emoji.
 *
 * Os sinais tipográficos viram equivalentes de máquina de escrever em vez de
 * sumir: travessão vira hífen, aspas curvas viram retas. Some só o que não tem
 * equivalente nenhum.
 */
function ascii(texto) {
  return dobrarAcentos(texto).replace(/[^\x00-\x7F]/g, ''); // o que sobrar não tem equivalente
}

/** Só a dobra de acento e a troca dos sinais tipográficos, sem apagar nada. */
function dobrarAcentos(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[·•]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/**
 * Versão para o WhatsApp do admin.
 *
 * O emoji sai junto com o espaço que vinha depois dele. Apagar só o emoji
 * deixava a marca de onde ele estava: "📊 RELATÓRIO" começava com um espaço
 * solto, e "Impressora: ✅ ativa" ficava com dois no meio. Levando o espaço
 * junto, a linha fica como se o emoji nunca tivesse existido — e a indentação
 * de propósito, que não vem depois de emoji nenhum, continua intacta.
 *
 * O `*negrito*` fica: não é acento nem emoji, e é o que dá hierarquia à
 * resposta na tela.
 */
function paraAdmin(texto) {
  return dobrarAcentos(texto)
    .replace(/[^\x00-\x7F]+ ?/g, '')
    .split('\n')
    .map((linha) => linha.trimEnd())
    .join('\n');
}

/**
 * Forma canônica de um comando digitado.
 *
 * O corretor do celular acentua sozinho: quem digita `!relatorio` recebe
 * `!relatório` de volta, e o comando deixava de ser reconhecido — o bot
 * respondia como se fosse cliente perguntando alguma coisa. Comparar sem acento
 * resolve os de hoje e os de amanhã, sem precisar cadastrar as duas grafias.
 */
function comoComando(texto) {
  return ascii(texto).trim().toLowerCase();
}

module.exports = { ascii, paraAdmin, comoComando };
