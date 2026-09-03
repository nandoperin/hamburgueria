function normalizarFala(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarBusca(texto) {
  return normalizarFala(texto)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function termosDoCatalogo(produtos = []) {
  const termos = new Set();
  const adicionar = (valor) => {
    if (typeof valor === 'string') {
      const termo = normalizarBusca(valor);
      if (termo) termos.add(termo);
      return;
    }
    if (Array.isArray(valor)) {
      valor.forEach(adicionar);
      return;
    }
    if (valor && typeof valor === 'object') Object.values(valor).forEach(adicionar);
  };

  for (const produto of produtos) {
    if (typeof produto === 'string') {
      adicionar(produto);
      continue;
    }
    adicionar(produto?.id);
    adicionar(produto?.name);
    adicionar(produto?.alias);
    adicionar(produto?.aliases);
  }
  return [...termos];
}

function mencionaProduto(segmento, termosProdutos) {
  const texto = ` ${normalizarBusca(segmento)} `;
  return termosProdutos.some((termo) => texto.includes(` ${termo} `));
}

const CATEGORIA_UPSELL =
  '(?:ingredientes?|recheios?|molhos?|adicion(?:al|ais)|extras?|bebidas?|' +
  'refrigerantes?|sucos?|aguas?|sobremesas?|doces?|acompanhamentos?|' +
  'porc(?:ao|oes)|batatas?|fritas?|combos?|ofertas?|promoc(?:ao|oes))';
const ALIMENTO_DO_DOMINIO =
  '(?:alfaces?|tomates?|cebolas?|picles|maioneses?|ketchups?|mostardas?|' +
  'queijos?|cheddar|catupiry|bacon|ovos?|presuntos?|calabresas?|jalapenos?|' +
  'frangos?|manjericao|alho|parmesao|carnes?|hamburgueres?)';
const CONTEUDO_COMERCIAL = `(?:${CATEGORIA_UPSELL}|${ALIMENTO_DO_DOMINIO})`;

function segmentoOfereceAlgo(segmentoOriginal, termosProdutos) {
  const segmento = normalizarFala(segmentoOriginal);
  if (!segmento) return false;

  const pergunta = /\?/.test(segmentoOriginal);
  const intencao =
    /\b(?:quer|queria|deseja|gostaria|prefere|aceita|posso|podemos|vamos|aproveita|aproveite|incluo|adiciono|acrescento|completo|complemento|recomendo|sugiro)\b|\bque tal\b|\bvai querer\b|\btem interesse\b/.test(
      segmento
    );
  const expansaoGenerica =
    /\b(?:algo mais|mais algo|mais alguma coisa|mais algum item|completar o pedido|complementar o pedido)\b/.test(
      segmento
    );
  const acaoComercial =
    /\b(?:personalizar|alterar|trocar|substituir|retirar|tirar|remover|acrescentar|adicionar|incluir)\b/.test(
      segmento
    );
  const conteudoComercial =
    new RegExp(`\\b${CONTEUDO_COMERCIAL}\\b`).test(segmento) ||
    mencionaProduto(segmento, termosProdutos);
  const confirmacaoConcluida =
    /\b(?:foi|foram|ficou|ficaram)\s+(?:personalizad[oa]s?|alterad[oa]s?|trocad[oa]s?|substituid[oa]s?|retirad[oa]s?|removid[oa]s?|adicionad[oa]s?|acrescentad[oa]s?|incluid[oa]s?)\b/.test(
      segmento
    ) ||
    /\b(?:foi|foram)\s+preparad[oa]s?\b/.test(segmento) ||
    /\b(?:ficou|ficaram)\s+(?:sem|com)\b/.test(segmento) ||
    /\b(?:esta|estao)\s+(?:corret[oa]s?|cert[oa]s?)\b/.test(segmento) ||
    /\b(?:personalizei|alterei|troquei|substitui|retirei|removi|tirei|adicionei|acrescentei|inclui)\b/.test(
      segmento
    );
  const assuntoOperacional =
    /\b(?:entrega|retirada|balcao|cidade|endereco|rua|numero|nome|email|confirmar|confirmacao|dados|pagamento|pagar|zelle|cartao|dinheiro)\b/.test(
      segmento
    );
  const ajudaSemVenda = /\b(?:repetir|explicar|esclarecer)\b/.test(segmento);

  if (confirmacaoConcluida && !intencao && !acaoComercial) return false;
  if (assuntoOperacional && !conteudoComercial) return false;
  if (conteudoComercial && (pergunta || intencao)) return true;
  if (expansaoGenerica && (pergunta || intencao)) return true;
  if (acaoComercial && (pergunta || intencao)) return true;
  if (ajudaSemVenda) return false;
  return intencao;
}

function ofertaNaoSolicitada(texto, catalogo = []) {
  const segmentos = String(texto || '').match(/[^.!?;,\r\n]+[.!?;,]*/g) || [];
  const termosProdutos = termosDoCatalogo(catalogo);
  return segmentos.some((segmento) => segmentoOfereceAlgo(segmento, termosProdutos));
}

module.exports = { ofertaNaoSolicitada };
