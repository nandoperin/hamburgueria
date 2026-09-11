/**
 * O caixa: quanto entrou em cash, quanto de Zelle foi conferido no banco e
 * quanto ainda falta conferir.
 *
 * Existe porque, com a comanda saindo no comprovante, "vendido" deixou de
 * querer dizer "recebido": um Zelle a conferir é promessa até alguém olhar o
 * banco. O `!relatorio` e o resumo do fechamento separam os dois, para o dono
 * não fechar o dia achando que recebeu um valor que não caiu.
 */

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function grupo() {
  return { qtd: 0, total: 0, pedidos: [] };
}

/**
 * Separa os pedidos do período pelo pagamento (linhas de
 * `db.getPagamentosDoPeriodo`).
 *
 * Zelle que não está conferido nem recusado conta como a conferir — inclusive
 * um estado inesperado: na dúvida, o dinheiro não aparece como recebido.
 */
function classificar(linhas = []) {
  const caixa = { cash: grupo(), conferido: grupo(), aConferir: grupo(), recusado: grupo() };

  for (const l of linhas) {
    const chave =
      l.order_status === 'rejected' || l.payment_status === 'rejected' ? 'recusado'
        : l.method === 'cash' ? 'cash'
          : l.payment_status === 'paid' ? 'conferido'
            : 'aConferir';
    caixa[chave].qtd += 1;
    caixa[chave].total += Number(l.total || 0);
    caixa[chave].pedidos.push(l);
  }
  return caixa;
}

function linhaPedido(p) {
  return `   *#${p.id}* — ${p.customer_name || 'sem nome'} — ${money(p.total)}`;
}

/** A seção de pagamentos do `!relatorio`. `listar` mostra quem falta conferir. */
function linhasRelatorio(caixa, { listar = false } = {}) {
  const linhas = [
    `💵 Cash: ${caixa.cash.qtd} — ${money(caixa.cash.total)}`,
    `✅ Zelle conferido: ${caixa.conferido.qtd} — ${money(caixa.conferido.total)}`,
    `🔎 Zelle a conferir: ${caixa.aConferir.qtd} — ${money(caixa.aConferir.total)}`,
    ...(listar ? caixa.aConferir.pedidos.map(linhaPedido) : []),
  ];
  if (caixa.recusado.qtd) {
    linhas.push(`❌ Recusado: ${caixa.recusado.qtd} — ${money(caixa.recusado.total)}`);
  }
  return linhas.join('\n');
}

/** Teve Zelle no período? Sem nenhum, o fechamento não manda nada. */
function temZelle(caixa) {
  return caixa.conferido.qtd + caixa.aConferir.qtd + caixa.recusado.qtd > 0;
}

/**
 * O resumo que o dono recebe quando o dia fecha.
 *
 * Os pendentes vão listados com o comando pronto: o fim do dia é a hora de
 * abrir o app do banco e conferir tudo de uma vez.
 */
function mensagemFechamento(caixa) {
  const { conferido, aConferir, recusado } = caixa;
  const linhas = [
    '💵 *CAIXA ZELLE DO DIA*',
    '',
    `✅ Conferido: ${conferido.qtd} — ${money(conferido.total)}`,
    `🔎 A conferir: ${aConferir.qtd} — ${money(aConferir.total)}`,
    ...aConferir.pedidos.map(linhaPedido),
  ];
  if (recusado.qtd) linhas.push(`❌ Recusado: ${recusado.qtd} — ${money(recusado.total)}`);
  linhas.push('');
  linhas.push(aConferir.qtd
    ? 'Tudo caiu no banco? *!liberar todos*\nAlgum não caiu? Antes, *!recusar ID motivo*.'
    : '_Todos os Zelle do dia foram conferidos._');
  return linhas.join('\n');
}

module.exports = { classificar, linhasRelatorio, mensagemFechamento, temZelle };
