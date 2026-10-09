const cardapio = require('./cardapio');
const modifiers = require('./modifiers');
const promotions = require('./promotions');
const delivery = require('./delivery');
const schedule = require('./schedule');
const salsicha = require('./preparo-salsicha');
const zelle = require('./zelle');
const entrada = require('../entrada');

/**
 * O pedido que chega do site (pointburgerjg.com), conferido item por item.
 *
 * Mesmo desenho do food truck (`projeto atendimento/src/services/pedidoweb.js`):
 * a página mora no site, que é HTML estático, e só manda **o que** o cliente
 * quer — ids, quantidades, ingredientes. **Quanto custa** sai daqui.
 *
 * ## A linha sai pela mesma porta do bot
 *
 * Cada linha é montada por `tools.carrinho.adicionar`, a mesma função que o
 * fluxo guiado usa: valida o ingrediente contra o item, cobra o adicional,
 * aplica a promoção do dia, monta o id composto e o texto da comanda. A
 * cozinha, o painel e o relatório não distinguem pedido do site de pedido do
 * WhatsApp — e não existe uma segunda regra de preço para divergir.
 *
 * Nada aqui grava no banco: `montarPedido` devolve o pedido pronto, e
 * `api/pedir.js` grava.
 */

/** Tetos do carrinho, como no food truck: ninguém pede 21 lanches pelo celular. */
const TETO = { linhas: 20, qtd: 10 };

/** A nota mais alta que faz sentido para troco — acima disso é engano. */
const TROCO_MAX = 500;

/** Categorias em que o cliente monta lanche; adicional solto só os avulsos. */
const CATEGORIA_ADICIONAIS = 'adicionais';

class PedidoInvalido extends Error {
  constructor(codigo, detalhe = null) {
    super(codigo);
    this.codigo = codigo;
    this.detalhe = detalhe;
  }
}

function recusar(codigo, detalhe) {
  throw new PedidoInvalido(codigo, detalhe);
}

function centavos(valor) {
  return Math.round(valor * 100) / 100;
}

const vazio = (v) => v === undefined || v === null || v === '';

// ---------------------------------------------------------------- cardápio

/** O que a página mostra no popup "Customizar ingredientes". */
function opcoesDoItem(item) {
  if (!modifiers.tem(item)) return null;
  const sanduiche = ['sanduiches', 'hotdogs', 'massas'].includes(item.category?.id);
  return {
    remover: modifiers.removiveis(item, 'pt').map(({ id }) => ({ id, nome: String(modifiers.nomeDe(id, 'pt')).replace(/^sach[eê]s? de /i, '') })),
    acrescentar: modifiers.adicionais(item, 'pt').map(({ id, nome, preco }) => ({ id, nome, preco })),
    pedePontoBife: item.category?.id === 'sanduiches' || (item.modifiers?.removable || []).includes('bife'),
    pedePontoBacon: (item.modifiers?.removable || []).includes('bacon') ||
      /\bbacon\b/i.test(cardapio.nome(item, 'pt')),
    maioneseAParte: sanduiche,
  };
}

function itemPublico(item) {
  const opcoes = opcoesDoItem(item);
  return {
    id: item.id,
    nome: cardapio.nome(item, 'pt'),
    descricao: cardapio.descricao(item, 'pt'),
    preco: Number(item.price),
    ...(item.regularPrice != null ? { precoNormal: Number(item.regularPrice) } : {}),
    disponivel: cardapio.disponivel(item),
    ...(promotions.itemDaPromocao(item) ? { promocao: true } : {}),
    ...(opcoes ? { opcoes } : {}),
  };
}

/**
 * O cardápio que a página desenha, já com estoque, promoção do dia, horário,
 * cidades e taxa. Preço vai junto para **mostrar**; quem cobra é `montarPedido`.
 */
function cardapioPublico(quando = new Date()) {
  const categorias = cardapio.categorias()
    .map((c) => ({
      id: c.id,
      nome: c.name?.pt || c.name?.en || c.id,
      itens: (c.items || [])
        .map((item) => ({ ...item, category: c }))
        .filter((item) => item.available !== false)
        .filter((item) => c.id !== CATEGORIA_ADICIONAIS || cardapio.avulsoPermitido(item))
        .filter((item) => promotions.itemLiberado(item, quando))
        .map(itemPublico),
    }))
    .filter((c) => c.itens.length);

  const pickup = delivery.getPickup();
  const z = zelle.destinatario();
  return {
    aberto: schedule.isOpen(),
    horario: schedule.horarioTexto('pt'),
    categorias,
    retirada: delivery.isPickupEnabled()
      ? { endereco: delivery.enderecoRetirada(), minutos: Number(pickup.ready_in_minutes) || 25 }
      : null,
    cidades: delivery.getCities().map((c) => ({ id: c.id, nome: c.label, taxa: Number(c.delivery_fee) })),
    pedidoMinimo: delivery.getMinOrder(),
    entregaGratisAcima: Number(require('./config').get('delivery')?.free_delivery_above) || 0,
    pagamentos: ['zelle', 'cash'],
    zelle: zelle.configurado() ? { nome: z.nome, email: z.email, telefone: z.telefone } : null,
  };
}

// ---------------------------------------------------------------- pedido

const PONTOS_BIFE = Object.keys(modifiers.PONTOS_BIFE || {
  mal_passado: 1, ao_ponto: 1, bem_passado: 1,
});
const PONTOS_BACON = Object.keys(modifiers.PONTOS_BACON || { mal_passado: 1, bem_passado: 1 });

function listaDeIds(lista) {
  if (vazio(lista)) return [];
  if (!Array.isArray(lista)) recusar('ingredientes');
  return lista.map((id) => String(id ?? '').trim()).filter(Boolean).slice(0, 20);
}

/**
 * Uma linha do site → uma linha do carrinho, pela porta do bot.
 *
 * `adicionar` devolve texto (é ferramenta da IA); sucesso é a linha ter
 * entrado no carrinho. Qualquer outra coisa é recusa, com o texto de motivo
 * guardado só para o log.
 */
function adicionarLinha(sess, pedido) {
  const tools = require('../ai/tools');
  const qtd = pedido?.qtd;
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > TETO.qtd) recusar('quantidade', pedido?.id || null);

  const item = cardapio.itemById(String(pedido?.id || ''));
  if (!item || item.available === false) recusar('item_invalido', pedido?.id || null);
  if (item.category?.id === CATEGORIA_ADICIONAIS && !cardapio.avulsoPermitido(item)) {
    recusar('item_invalido', item.id);
  }
  if (!cardapio.disponivel(item)) recusar('esgotado', item.id);

  const remover = listaDeIds(pedido.remover);
  const acrescentar = listaDeIds(pedido.acrescentar);
  const pontoBife = vazio(pedido.pontoBife) ? undefined : String(pedido.pontoBife);
  const pontoBacon = vazio(pedido.pontoBacon) ? undefined : String(pedido.pontoBacon);
  if (pontoBife && !PONTOS_BIFE.includes(pontoBife)) recusar('ponto_bife', item.id);
  if (pontoBacon && !PONTOS_BACON.includes(pontoBacon)) recusar('ponto_bacon', item.id);

  // A validação de ingrediente é a do bot; aqui só se confere antes para
  // devolver um código claro à página, sem depender do texto da ferramenta.
  if (remover.length || acrescentar.length) {
    const val = modifiers.validar(item, { remover, acrescentar });
    if (!val.ok) recusar('ingrediente', val.detalhe?.[0] || val.erro);
  }

  const antes = JSON.stringify(sess.cart.map((l) => [l.id, l.qty]));
  const motivo = tools.carrinho.adicionar(sess, {
    item_id: item.id,
    quantidade: qtd,
    remover,
    acrescentar,
    // No site, o adicional escolhido no popup vai DENTRO do lanche; a
    // salsicha avulsa (produto) vai à parte. Sem pergunta de preparo.
    ...(acrescentar.includes('salsicha') ? { preparo_salsicha: 'junto' } : {}),
    ...(item.id === 'salsicha' ? { preparo_salsicha: 'a_parte' } : {}),
    ...(pontoBife ? { ponto_bife: pontoBife } : {}),
    ...(pontoBacon ? { ponto_bacon: pontoBacon } : {}),
    ...(pedido.maioneseAParte === true ? { maionese_a_parte: true } : {}),
  });
  const depois = JSON.stringify(sess.cart.map((l) => [l.id, l.qty]));
  if (antes === depois) recusar('item_recusado', { item: item.id, motivo: String(motivo || '').slice(0, 200) });
}

/** Retirada ou entrega, conferida contra a config de entrega do painel. */
function montarDestino(entrega, subtotal) {
  const tipo = entrega?.tipo;
  if (tipo === 'pickup') {
    if (!delivery.isPickupEnabled()) recusar('retirada_desligada');
    const pickup = delivery.getPickup();
    return {
      orderType: 'pickup',
      city: pickup.label,
      address: delivery.enderecoRetirada() || pickup.label,
      deliveryFee: 0,
    };
  }
  if (tipo === 'delivery') {
    const destino = delivery.getCityById(String(entrega.cidade || ''));
    if (!destino) recusar('cidade_invalida', entrega.cidade || null);
    const rua = entrada.limpar(entrega.endereco, entrada.LIMITES.endereco).replace(/\s+/g, ' ').trim();
    // Endereço livre, como no bot — só precisa parecer um endereço: número e rua.
    if (rua.length < 5 || !/\d/.test(rua) || !/\p{L}{2,}/u.test(rua)) recusar('endereco');
    if (subtotal < delivery.getMinOrder()) recusar('pedido_minimo', delivery.getMinOrder());
    return {
      orderType: 'delivery',
      city: destino.label,
      address: rua,
      deliveryFee: Number(delivery.getDeliveryFee(destino, subtotal)) || 0,
    };
  }
  return recusar('tipo_invalido');
}

/**
 * Telefone americano, só dígitos, com o `1` na frente — o formato em que o
 * WhatsApp entrega o número, para o comprovante e o "cancelar" mandados do
 * WhatsApp acharem este pedido.
 */
function normalizarTelefone(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  if (digitos.length === 10) return `1${digitos}`;
  if (digitos.length === 11 && digitos.startsWith('1')) return digitos;
  return null;
}

/** Zelle ou dinheiro. Troco só no dinheiro, e nunca recusa o pedido. */
function montarPagamento(corpo, total) {
  const forma = corpo.pagamento;
  if (forma !== 'zelle' && forma !== 'cash') recusar('pagamento_invalido');
  if (forma === 'zelle') {
    if (!zelle.conferir().ok) recusar('zelle_indisponivel');
    return { pagamento: 'zelle', trocoPara: null };
  }
  const bruto = corpo.trocoPara;
  const valor = vazio(bruto) ? NaN : Number(String(bruto).replace(',', '.'));
  const vale = Number.isFinite(valor) && valor > total && valor <= TROCO_MAX;
  return { pagamento: 'cash', trocoPara: vale ? centavos(valor) : null };
}

/**
 * O pedido inteiro, pronto para gravar.
 *
 * @throws {PedidoInvalido}
 */
function montarPedido(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) recusar('corpo');

  const phone = normalizarTelefone(corpo.telefone);
  if (!phone) recusar('telefone');
  const nome = entrada.limpar(corpo.nome, entrada.LIMITES.nome).replace(/\s+/g, ' ').trim();
  if (!/\p{L}.*\p{L}/u.test(nome)) recusar('nome');

  const itens = corpo.itens;
  if (!Array.isArray(itens) || !itens.length) recusar('carrinho_vazio');
  if (itens.length > TETO.linhas) recusar('carrinho_grande');

  const sess = { phone, lang: 'pt', cart: [], state: 'ORDER' };
  for (const pedido of itens) adicionarLinha(sess, pedido);

  // Salsicha que ficou sem saber onde vai não pode chegar à cozinha.
  if (salsicha.pendente(sess)) recusar('salsicha_sem_preparo');
  if (sess.cart.some((l) => l.qty > TETO.qtd)) recusar('quantidade');

  promotions.reprecificarCarrinho(sess.cart, 'pt');
  const subtotal = centavos(sess.cart.reduce((s, l) => s + l.price * l.qty, 0));
  const destino = montarDestino(corpo.entrega, subtotal);
  const total = centavos(subtotal + destino.deliveryFee);
  const { pagamento, trocoPara } = montarPagamento(corpo, total);

  return { phone, nome, lang: 'pt', cart: sess.cart, subtotal, ...destino, total, pagamento, trocoPara };
}

/**
 * O total que a página mostra enquanto o cliente monta o carrinho: as mesmas
 * contas de `montarPedido`, sem telefone, nome nem pagamento, e sem gravar.
 * Assim "3 X Tudo = $50" e a taxa da cidade aparecem como serão cobrados.
 */
function orcar(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) recusar('corpo');
  const itens = corpo.itens;
  if (!Array.isArray(itens) || !itens.length) recusar('carrinho_vazio');
  if (itens.length > TETO.linhas) recusar('carrinho_grande');

  const sess = { phone: 'site', lang: 'pt', cart: [], state: 'ORDER' };
  for (const pedido of itens) adicionarLinha(sess, pedido);
  promotions.reprecificarCarrinho(sess.cart, 'pt');
  const subtotal = centavos(sess.cart.reduce((s, l) => s + l.price * l.qty, 0));
  const cidade = corpo.entrega?.tipo === 'delivery' ? delivery.getCityById(String(corpo.entrega.cidade || '')) : null;
  const taxa = cidade ? Number(delivery.getDeliveryFee(cidade, subtotal)) || 0 : 0;
  return {
    itens: sess.cart.map((l) => ({ nome: l.name, qtd: l.qty, preco: l.price, promocao: Boolean(l.promotionApplied) })),
    subtotal,
    taxa,
    total: centavos(subtotal + taxa),
    pedidoMinimo: delivery.getMinOrder(),
  };
}

module.exports = {
  cardapioPublico,
  montarPedido,
  orcar,
  normalizarTelefone,
  PedidoInvalido,
  TETO,
};
