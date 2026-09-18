const provider = require('./provider');
const custo = require('./custo');
const cardapio = require('../services/cardapio');
const modifiers = require('../services/modifiers');
const log = require('../log');

/**
 * A IA leitora do fluxo guiado (Fase 2 do plano "Fluxo guiado da IA").
 *
 * Ela não conversa. Lê a mensagem do cliente e devolve um formulário JSON num
 * esquema fechado — o que ele pediu, tirou, corrigiu, respondeu ou perguntou.
 * Quem decide o que entra no carrinho é `ai/guiado.js`, pelas regras do dono;
 * quem escreve a resposta é o sistema, com texto fixo.
 *
 * ## Por que um formulário, e não ferramentas
 *
 * Com 14 ferramentas e texto livre, cada erro virou uma trava nova e o modelo
 * achava outro jeito de errar: "com dois ovos" virou porção avulsa E acréscimo,
 * "vai ser cartão" virou Zelle, a lista reenviada somou em vez de substituir
 * (pedido #155, $252 por três lanches). Aqui não há campo de porção, de preço
 * nem de resposta: o que não cabe no formulário simplesmente não acontece.
 *
 * `trecho` é o pedaço exato da fala que gerou cada item. O código confere que
 * o produto está nele — a IA não consegue registrar um item sem apontar de
 * onde tirou.
 */

const PONTOS = ['mal_passado', 'ao_ponto', 'bem_passado'];
const PERGUNTAS = [
  'cartao', 'taxa_entrega', 'cidades', 'horario', 'cardapio', 'tempo',
  'promocao', 'status_pedido', 'fiado', 'outra',
];

const nulo = (tipo) => ({ type: [tipo, 'null'] });
const lista = { type: 'array', items: { type: 'string' } };

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['produto', 'qtd', 'sem', 'com', 'salsicha', 'ponto_bife', 'maionese_a_parte', 'trecho'],
  properties: {
    produto: { type: 'string' },
    qtd: nulo('integer'),
    sem: lista,
    com: lista,
    salsicha: { type: ['string', 'null'], enum: ['junto', 'a_parte', null] },
    ponto_bife: { type: ['string', 'null'], enum: [...PONTOS, null] },
    maionese_a_parte: { type: 'boolean' },
    trecho: { type: 'string' },
  },
};

const CORRECAO = {
  type: 'object',
  additionalProperties: false,
  required: ['acao', 'linha', 'qtd', 'sem', 'com', 'ponto_bife', 'trecho'],
  properties: {
    acao: { type: 'string', enum: ['tirar', 'quantidade', 'alterar'] },
    linha: { type: 'string' },
    qtd: nulo('integer'),
    sem: lista,
    com: lista,
    ponto_bife: { type: ['string', 'null'], enum: [...PONTOS, null] },
    trecho: { type: 'string' },
  },
};

const AMBIGUO = {
  type: 'object',
  additionalProperties: false,
  required: ['trecho', 'qtd', 'opcoes'],
  properties: { trecho: { type: 'string' }, qtd: nulo('integer'), opcoes: lista },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'itens', 'ambiguos', 'correcoes', 'refazer_lista', 'concluiu_itens', 'entrega', 'cidade',
    'endereco', 'nome', 'pagamento', 'troco', 'confirma_resumo', 'pergunta', 'cancelar',
  ],
  properties: {
    itens: { type: 'array', items: ITEM },
    ambiguos: { type: 'array', items: AMBIGUO },
    correcoes: { type: 'array', items: CORRECAO },
    refazer_lista: { type: 'boolean' },
    concluiu_itens: { type: 'boolean' },
    entrega: { type: ['string', 'null'], enum: ['entrega', 'retirada', null] },
    cidade: nulo('string'),
    endereco: nulo('string'),
    nome: nulo('string'),
    pagamento: { type: ['string', 'null'], enum: ['cash', 'zelle', 'cartao', null] },
    troco: nulo('number'),
    confirma_resumo: { type: ['string', 'null'], enum: ['sim', 'nao', null] },
    pergunta: { type: ['string', 'null'], enum: [...PERGUNTAS, null] },
    cancelar: { type: 'boolean' },
  },
};

// ------------------------------------------------------------------ prompt

function cardapioParaLeitura(lang) {
  const linhas = [];
  for (const categoria of cardapio.categoriasDisponiveis()) {
    const itens = cardapio.itensDisponiveis(categoria);
    if (!itens.length) continue;
    linhas.push(`\n## ${categoria.name?.pt || categoria.id} (${categoria.id})`);
    for (const item of itens) {
      const apelidos = (item.aliases || []).length ? ` | apelidos: ${item.aliases.join(', ')}` : '';
      const tira = modifiers.removiveis(item, lang).map((i) => i.id);
      linhas.push(`- ${item.id} | ${cardapio.nome(item, 'pt')}${apelidos}` +
        (tira.length ? ` | vem com: ${tira.join(', ')}` : ''));
    }
  }
  const extras = modifiers.adicionais({ modifiers: { addable: ['bacon'] } }, lang).map((i) => i.id);
  return (
    `Ingredientes que podem ser ACRESCENTADOS (campo "com") em qualquer lanche, hot dog ou macarrão: ${extras.join(', ')}.\n` +
    linhas.join('\n')
  );
}

function carrinhoParaLeitura(sess) {
  const cart = sess.cart || [];
  if (!cart.length) return '(vazio)';
  return cart.map((l) => {
    const detalhes = [];
    if (l.removed?.length) detalhes.push(`sem ${l.removed.join(',')}`);
    if (l.added?.length) detalhes.push(`com ${l.added.join(',')}`);
    if (l.pontoBife) detalhes.push(l.pontoBife);
    return `- linha "${l.id}": ${l.qty}x ${l.productId || l.id}${detalhes.length ? ` (${detalhes.join('; ')})` : ''}`;
  }).join('\n');
}

const REGRAS = `Você LÊ mensagens de clientes de uma hamburgueria e preenche um formulário JSON.
Você não responde ao cliente, não conversa e não inventa nada: só registra o que a mensagem ATUAL diz.

Regras:
1. itens: só produtos que o cliente pediu nesta mensagem, com o id exato do cardápio. "trecho" é o pedaço
   EXATO da fala que pede aquele item. Se o nome do produto não está na fala, não registre.
2. Ingredientes (bacon, ovo, banana, calabresa, mussarela, bife, milho...) NUNCA são itens: vão em "com" do
   lanche ("x tudo com ovo" → com ["ovo"]). Não existem porções. Exceções que podem ser item: salsicha e
   sache_maionese (sachê de maionese).
3. "sem X" → sem [X] (id do ingrediente). "com X" → com [X].
4. Quantidade: "2 x tudo" → qtd 2. Sem número → qtd null. Se o cliente pede unidades diferentes do mesmo
   produto, separe em itens: "3 x tudo, 2 sem maionese e 1 com banana" → {x_tudo, qtd 2, sem [maionese]} e
   {x_tudo, qtd 1, com [banana]}. A soma tem de dar o total que ele disse.
5. Palavra genérica que serve para vários produtos ("hot dog", "cachorro quente", "refri", "lanche",
   "hamburguer") sem dizer qual → NÃO escolha: vá em "ambiguos" com os ids possíveis em "opcoes".
6. "bem passado", "mal passado", "ao ponto" → ponto_bife no lanche. Não é bife a mais.
7. "maionese à parte" / "maionese separada" → maionese_a_parte true no lanche (e sem maionese dentro).
   Só use "com": ["maionese"] se ele pedir maionese EXTRA dentro.
8. correcoes: mudanças em linhas que JÁ estão no carrinho, pelo id da linha. "tira a coca" → tirar.
   "na verdade são 3" → quantidade com qtd 3. "o x tudo sem tomate" (já no carrinho) → alterar.
9. refazer_lista: true quando o cliente MANDA A LISTA DO PEDIDO DE NOVO (inteira ou corrigida) e já existe
   carrinho — a lista nova substitui o carrinho. Os itens da lista vão em "itens".
10. Repetir o nome de um produto que já está no carrinho, sem "mais", "outro" ou número novo, não é pedido novo.
11. entrega: "entrega"/"delivery"/endereço → entrega; "retirada"/"vou buscar"/"retiro" → retirada.
    cidade e endereco só se ele escreveu. nome só se ele disse o próprio nome (nunca "ok", cidade ou rua).
12. pagamento: "cash"/"dinheiro" → cash; "zelle" → zelle; "cartão"/"crédito"/"débito"/"card" → cartao.
    troco: "troco para 50" → 50.
13. concluiu_itens: true quando ele diz que terminou de escolher ("só isso", "é isso", "não", "somente").
14. confirma_resumo: só quando a pergunta pendente é o resumo do pedido. "sim"/"pode mandar" → sim.
15. pergunta: se a mensagem pergunta algo — cartao (aceita cartão?), taxa_entrega, cidades (entrega em X?),
    horario, cardapio, tempo (quanto demora), promocao, status_pedido (meu pedido saiu/chegou/previsão),
    fiado (pagar depois/amanhã), outra.
16. cancelar: true só se ele desiste do pedido inteiro.
17. Se a mensagem RESPONDE à pergunta que o atendimento fez por último, preencha só o que ela responde:
    "Qual hot dog?" → "completo" = itens [{hot_completo}]; "Em qual lanche vai o bacon?" → "no x tudo" =
    correcoes alterar na linha do x tudo com ["bacon"] (nunca um lanche novo).
18. Campos sem informação: listas vazias, false ou null. Nunca adivinhe.`;

const EXEMPLOS = `Exemplos:

Mensagem: "boa noite\\n1 xtudo\\n2 hot dog\\n1 coca\\npara entrega"
→ itens: [{produto:"x_tudo", qtd:1, trecho:"1 xtudo"}, {produto:"coca_cola", qtd:1, trecho:"1 coca"}],
  ambiguos: [{trecho:"2 hot dog", qtd:2, opcoes:[ids de todos os hot dogs]}], entrega:"entrega"

Mensagem: "3 xegg bacon, os 2 sem maionese dentro, as maionese a parte, 1 com banana"
→ itens: [{produto:"egg_bacon", qtd:2, sem:["maionese"], maionese_a_parte:true, trecho:"os 2 sem maionese dentro, as maionese a parte"},
          {produto:"egg_bacon", qtd:1, com:["banana"], trecho:"1 com banana"}]

Carrinho: 3x x_bacon. Mensagem: "3x bacon"
→ nada novo: itens [], correcoes [] (ele repetiu o pedido que já está no carrinho).

Mensagem: "Ok"  → tudo vazio/null/false (não é nome).
Mensagem: "vai ser cartão" → pagamento:"cartao".`;

function montarSystem(sess) {
  const lang = sess.lang || 'pt';
  return `${REGRAS}\n\n# Cardápio\n${cardapioParaLeitura(lang)}\n\n${EXEMPLOS}`;
}

function montarMensagem(sess, texto, citada) {
  const partes = [
    `Carrinho atual:\n${carrinhoParaLeitura(sess)}`,
    `Pergunta que o atendimento fez por último: ${sess.guiado?.ultimaPergunta ? JSON.stringify(sess.guiado.ultimaPergunta) : '(nenhuma)'}`,
  ];
  if (citada) partes.push(`O cliente respondeu citando esta mensagem anterior: ${JSON.stringify(citada)}`);
  partes.push(`Mensagem do cliente:\n${texto}`);
  return partes.join('\n\n');
}

// -------------------------------------------------------------- conferência

const txt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 20) : []);
const qtd = (v) => (Number.isInteger(v) && v >= 1 && v <= 50 ? v : null);
const um = (v, opcoes) => (opcoes.includes(v) ? v : null);

/**
 * A saída do modelo é entrada não confiável, como o texto do cliente. Esta
 * função só aceita o que o esquema promete — o resto vira vazio.
 */
function normalizar(bruto) {
  const o = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : {};
  const itens = (Array.isArray(o.itens) ? o.itens : []).slice(0, 20).map((i) => ({
    produto: txt(i?.produto, 60) || '',
    qtd: qtd(i?.qtd),
    sem: ids(i?.sem),
    com: ids(i?.com),
    salsicha: um(i?.salsicha, ['junto', 'a_parte']),
    ponto_bife: um(i?.ponto_bife, PONTOS),
    maionese_a_parte: i?.maionese_a_parte === true,
    trecho: txt(i?.trecho, 300) || '',
  })).filter((i) => i.produto);
  const ambiguos = (Array.isArray(o.ambiguos) ? o.ambiguos : []).slice(0, 10).map((a) => ({
    trecho: txt(a?.trecho, 200) || '', qtd: qtd(a?.qtd), opcoes: ids(a?.opcoes),
  })).filter((a) => a.opcoes.length);
  const correcoes = (Array.isArray(o.correcoes) ? o.correcoes : []).slice(0, 20).map((c) => ({
    acao: um(c?.acao, ['tirar', 'quantidade', 'alterar']),
    linha: txt(c?.linha, 200) || '',
    qtd: Number.isInteger(c?.qtd) && c.qtd >= 0 && c.qtd <= 50 ? c.qtd : null,
    sem: ids(c?.sem), com: ids(c?.com), ponto_bife: um(c?.ponto_bife, PONTOS),
    trecho: txt(c?.trecho, 300) || '',
  })).filter((c) => c.acao && c.linha);
  const troco = Number(o.troco);
  return {
    itens, ambiguos, correcoes,
    refazer_lista: o.refazer_lista === true,
    concluiu_itens: o.concluiu_itens === true,
    entrega: um(o.entrega, ['entrega', 'retirada']),
    cidade: txt(o.cidade, 60),
    endereco: txt(o.endereco, 200),
    nome: txt(o.nome, 60),
    pagamento: um(o.pagamento, ['cash', 'zelle', 'cartao']),
    troco: Number.isFinite(troco) && troco > 0 && troco < 10000 ? troco : null,
    confirma_resumo: um(o.confirma_resumo, ['sim', 'nao']),
    pergunta: um(o.pergunta, PERGUNTAS),
    cancelar: o.cancelar === true,
  };
}

// ------------------------------------------------------------------ leitura

/**
 * Lê uma mensagem. Nunca lança: falha de provedor, teto de gasto ou JSON
 * quebrado devolvem `{ ok: false }` e quem chamou cai no caminho antigo.
 */
async function ler(sess, texto, { citada } = {}) {
  const pode = custo.podeChamar(sess);
  if (!pode.ok) return { ok: false, motivo: 'teto' };

  const ia = provider.get();
  if (typeof ia.extrair !== 'function') return { ok: false, motivo: 'provedor_sem_extracao' };

  try {
    const resposta = await ia.extrair({
      system: montarSystem(sess),
      mensagens: [{ role: 'user', content: montarMensagem(sess, texto, citada) }],
      schema: SCHEMA,
      nome: 'leitura_pedido',
    });
    custo.registrar(sess, resposta.uso, resposta.modelo || provider.getModelo());
    if (resposta.concluida === false) return { ok: false, motivo: 'truncada' };
    const dados = normalizar(JSON.parse(resposta.texto));
    log.info({ evt: 'leitor', leitura: dados }, 'mensagem lida pela IA leitora');
    return { ok: true, dados };
  } catch (err) {
    log.warn({ evt: 'leitor', motivo: 'falhou', status: err?.statusCode || err?.status }, 'IA leitora indisponível');
    return { ok: false, motivo: 'falhou' };
  }
}

module.exports = { ler, normalizar, montarSystem, montarMensagem, SCHEMA };
