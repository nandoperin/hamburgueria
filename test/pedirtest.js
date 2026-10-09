/**
 * Pedido pelo site (docs/PEDIDO-WEB.md): a página manda ids, quantidades e
 * ingredientes; o servidor monta a linha pela mesma porta do bot, cobra pelo
 * cardápio, e grava como o bot grava — pedido + pagamento, que solta a comanda.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
let promo = false;
// Promoção pelo interruptor manual do painel, para não depender do dia da semana.
config.get = (chave) => {
  if (chave === 'menu') return menuProducao;
  if (chave === 'promotions') return { ...getReal(chave), automatic: false, manual_active: promo, disabled_date: null };
  return getReal(chave);
};
const schedule = require(`${PROJECT}/src/services/schedule`);
let aberto = true;
schedule.isOpen = () => aberto;

// Banco de mentira que só anota o que foi gravado.
const gravado = [];
const pedidos = new Map();
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  // Maria já tem cadastro e endereço antigo vindos do WhatsApp — que o site
  // nunca pode revelar a quem só digita o número dela.
  getCustomerByPhone: async (p) => (p === '18575551111' ? { id: 3, name: 'Maria Lima' } : null),
  getLastDeliveryOrder: async (p) => (p === '18575551111' ? { city: 'Malden', address: '9 Segredo Rd', created_at: new Date() } : null),
  upsertCustomer: async (c) => { gravado.push(['cliente', c]); return { id: 7, ...c }; },
  createOrder: async (o) => {
    gravado.push(['pedido', o]);
    const id = 501 + pedidos.size;
    pedidos.set(id, { id, phone: o.phone, customer_name: o.customerName, order_type: o.orderType, city: o.city,
      address: o.address, created_at: new Date() });
    return { id, ...o };
  },
  getOrder: async (id) => pedidos.get(Number(id)) || null,
  createCashPayment: async (p) => { gravado.push(['cash', p]); },
  createZellePayment: async (p) => { gravado.push(['zelle', p]); },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const pedidoweb = require(`${PROJECT}/src/services/pedidoweb`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
function recusa(corpo) {
  try { pedidoweb.montarPedido(corpo); return null; } catch (e) {
    if (!(e instanceof pedidoweb.PedidoInvalido)) throw e;
    return e.codigo;
  }
}
const base = (extra = {}) => ({
  telefone: '(857) 555-0101', nome: 'Ana Souza', pagamento: 'cash',
  entrega: { tipo: 'pickup' }, itens: [{ id: 'x_burger', qtd: 1 }], ...extra,
});

(async () => {
  // ---------------------------------------------------------- cardápio
  const c = pedidoweb.cardapioPublico();
  const todos = c.categorias.flatMap((cat) => cat.itens);
  const xb = todos.find((i) => i.id === 'x_burger');
  checar(xb && xb.preco === 12 && xb.opcoes?.remover?.length && xb.opcoes?.acrescentar?.length,
    'cardápio: X Burger com preço, ingredientes para tirar e para acrescentar');
  checar(xb.opcoes.pedePontoBife && xb.opcoes.maioneseAParte, 'cardápio: lanche pede ponto do bife e maionese à parte');
  checar(xb.opcoes.remover.some((r) => r.id === 'maionese' && r.nome === 'maionese'), 'cardápio: "maionese" para tirar, sem "Sachê de"');
  checar(!todos.some((i) => i.id === 'bacon'), 'cardápio: bacon não aparece como produto solto');
  checar(todos.some((i) => i.id === 'sache_maionese'), 'cardápio: sachê de maionese aparece (avulso)');
  checar(!todos.some((i) => i.promocao), 'cardápio: sem promoção fora de terça/quarta');
  checar(c.cidades.length && c.cidades.every((x) => x.taxa > 0), 'cardápio: cidades com taxa');
  checar(c.retirada?.endereco, 'cardápio: endereço da retirada');
  promo = true;
  checar(pedidoweb.cardapioPublico().categorias.flatMap((cat) => cat.itens).some((i) => i.promocao),
    'cardápio: terça/quarta mostra a promoção');
  const cp = pedidoweb.cardapioPublico().categorias;
  const xtSand = cp.find((x) => x.id === 'sanduiches').itens.find((i) => i.id === 'x_tudo');
  checar(xtSand.preco === 18 && xtSand.precoNormal === 20, 'cardápio: no dia da promoção, X Tudo da aba Sanduíches mostra $20 riscado e $18');
  const pacote = cp.flatMap((x) => x.itens).find((i) => i.id === 'promo_terca_quarta_3_x_tudo');
  checar(pacote.preco === 50 && pacote.precoNormal === 60, 'cardápio: pacote 3 X Tudo mostra $60 riscado e $50');
  promo = false;
  const xtNormal = pedidoweb.cardapioPublico().categorias.find((x) => x.id === 'sanduiches').itens.find((i) => i.id === 'x_tudo');
  checar(xtNormal.preco === 20 && xtNormal.precoNormal === undefined, 'cardápio: fora do dia, X Tudo $20 sem riscado');

  // ---------------------------------------------------------- montagem
  let p = pedidoweb.montarPedido(base());
  checar(p.phone === '18575550101' && p.nome === 'Ana Souza', 'telefone vira 1+10 dígitos; nome limpo');
  checar(p.cart.length === 1 && p.cart[0].id === 'x_burger' && p.total === 12 && p.deliveryFee === 0,
    'retirada: X Burger $12, sem taxa');

  p = pedidoweb.montarPedido(base({
    itens: [{ id: 'x_burger', qtd: 2, remover: ['tomate'], acrescentar: ['bacon'], pontoBife: 'bem_passado', maioneseAParte: true }],
  }));
  const l = p.cart[0];
  checar(l.removed.includes('tomate') && l.added.includes('bacon') && l.pontoBife === 'bem_passado' && l.maioneseAParte,
    'linha personalizada: sem tomate, + bacon, bife bem passado, maionese à parte');
  checar(l.id === 'x_burger:-tomate+bacon~bife=bem_passado~maionese=a_parte', 'id composto igual ao do bot');
  const bacon = require(`${PROJECT}/src/services/modifiers`).precoDe('bacon');
  checar(bacon > 0 && l.price === 12 + bacon && p.total === 2 * (12 + bacon), `adicional cobrado pelo cardápio: 2 × ($12 + bacon ${bacon}) = ${p.total}`);
  checar(l.choicesCozinha.length >= 3, 'comanda recebe as observações da linha');

  p = pedidoweb.montarPedido(base({ itens: [{ id: 'hot_completo', qtd: 1, acrescentar: ['salsicha'] }] }));
  checar(p.cart[0].preparoSalsicha?.modo === 'junto', 'salsicha acrescentada no popup vai junto, sem pergunta');

  p = pedidoweb.montarPedido(base({
    entrega: { tipo: 'delivery', cidade: 'chelsea', endereco: '45 Broadway Apt 2' },
    itens: [{ id: 'x_tudo', qtd: 1, preco: 0.01 }, { id: 'coca_cola', qtd: 2 }],
  }));
  checar(p.orderType === 'delivery' && p.city === 'Chelsea' && p.deliveryFee === 7, 'entrega em Chelsea: taxa $7 do cardápio de cidades');
  checar(p.total === 20 + 2 * Number(todos.find((i) => i.id === 'coca_cola').preco) + 7, 'preço mandado pela página é ignorado');

  promo = true;
  p = pedidoweb.montarPedido(base({ itens: [{ id: 'x_tudo', qtd: 3 }] }));
  checar(p.subtotal === 50, 'terça/quarta: 3 X Tudo = $50, a mesma promoção do bot');
  promo = false;

  p = pedidoweb.montarPedido(base({ trocoPara: '100' }));
  checar(p.pagamento === 'cash' && p.trocoPara === 100, 'dinheiro com troco para $100');
  checar(pedidoweb.montarPedido(base({ trocoPara: '5' })).trocoPara === null, 'troco menor que o total vira "sem troco", não recusa');
  checar(pedidoweb.montarPedido(base({ pagamento: 'zelle' })).pagamento === 'zelle', 'Zelle aceito');

  // ---------------------------------------------------------- recusas
  checar(recusa(base({ telefone: '123' })) === 'telefone', 'telefone inválido recusa');
  checar(recusa(base({ nome: ' ' })) === 'nome', 'sem nome recusa');
  checar(recusa(base({ itens: [] })) === 'carrinho_vazio', 'carrinho vazio recusa');
  checar(recusa(base({ itens: [{ id: 'nao_existe', qtd: 1 }] })) === 'item_invalido', 'item inventado recusa');
  checar(recusa(base({ itens: [{ id: 'bacon', qtd: 1 }] })) === 'item_invalido', 'bacon solto recusa');
  checar(recusa(base({ itens: [{ id: 'x_burger', qtd: 11 }] })) === 'quantidade', 'quantidade acima do teto recusa');
  checar(recusa(base({ itens: [{ id: 'x_burger', qtd: 1, acrescentar: ['ouro'] }] })) === 'ingrediente', 'ingrediente inventado recusa');
  checar(recusa(base({ itens: [{ id: 'x_burger', qtd: 1, pontoBife: 'cru' }] })) === 'ponto_bife', 'ponto inventado recusa');
  checar(recusa(base({ itens: [{ id: 'x_tudo_3', qtd: 1 }] })) === 'item_invalido' ||
    recusa(base({ itens: [{ id: 'x_tudo_3', qtd: 1 }] })) === 'esgotado', 'pacote da promoção fora do dia recusa');
  checar(recusa(base({ entrega: { tipo: 'delivery', cidade: 'boston', endereco: '1 Main St' } })) === 'cidade_invalida', 'cidade fora da área recusa');
  checar(recusa(base({ entrega: { tipo: 'delivery', cidade: 'everett', endereco: 'perto do mercado' } })) === 'endereco', 'endereço sem número recusa');
  checar(recusa(base({ pagamento: 'cartao' })) === 'pagamento_invalido', 'cartão recusa');

  // ---------------------------------------------------------- API
  process.env.PEDIR_ATIVO = 'on';
  process.env.PEDIR_SEGREDO = 'segredo-de-teste-com-mais-de-16';
  const { app } = require(`${PROJECT}/src/api`);
  const servidor = app.listen(0);
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const post = (corpo, origem = 'https://pointburgerjg.com') => fetch(`${url}/pedir/pedido`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origem }, body: JSON.stringify(corpo),
  });

  let r = await fetch(`${url}/pedir/cardapio`, { headers: { Origin: 'https://pointburgerjg.com' } });
  checar(r.status === 200 && r.headers.get('access-control-allow-origin') === 'https://pointburgerjg.com',
    'GET /pedir/cardapio responde com CORS para o site');
  r = await fetch(`${url}/pedir/cardapio`, { headers: { Origin: 'https://outro.com' } });
  checar(!r.headers.get('access-control-allow-origin'), 'outra origem não recebe CORS');

  promo = true;
  r = await fetch(`${url}/pedir/orcamento`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itens: [{ id: 'x_tudo', qtd: 3 }], entrega: { tipo: 'delivery', cidade: 'everett' } }) });
  const orc = await r.json();
  checar(r.status === 200 && orc.subtotal === 50 && orc.taxa === 5 && orc.total === 55 && gravado.length === 0,
    'orçamento: 3 X Tudo na promoção + Everett = $55, sem gravar nada');
  promo = false;

  r = await post(base({ itens: [{ id: 'x_burger', qtd: 1, remover: ['tomate'] }], trocoPara: 20 }));
  const corpo = await r.json();
  checar(r.status === 201 && corpo.pedido === 501 && corpo.total === 12, 'POST cria o pedido #501, total do servidor');
  checar(typeof corpo.chave === 'string' && /^501.[0-9a-f]{40}$/.test(corpo.chave), 'pedido devolve a chave do aparelho para o próximo pedido');
  const pedidoGravado = gravado.find(([k]) => k === 'pedido')[1];
  checar(pedidoGravado.phone === '18575550101' && pedidoGravado.customerName === 'Ana Souza' &&
    pedidoGravado.items[0].id === 'x_burger:-tomate', 'pedido gravado no formato do bot');
  checar(gravado.some(([k, v]) => k === 'cash' && v.orderId === 501 && v.changeFor === 20),
    'pagamento em dinheiro gravado (solta a comanda), com troco');

  gravado.length = 0;
  r = await post(base({ telefone: '8575550202', pagamento: 'zelle' }), 'https://www.pointburgerjg.com');
  checar(r.status === 201 && gravado.some(([k]) => k === 'zelle'), 'Zelle gravado como no bot');

  r = await post(base({ telefone: '8575550303', itens: [{ id: 'x_burger', qtd: 0 }] }));
  checar(r.status === 400 && (await r.json()).erro === 'quantidade', 'pedido inválido volta 400 com o código');

  aberto = false;
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  r = await post(base({ telefone: '8575550404' }));
  checar(r.status === 409, 'loja fechada: 409, nada gravado');
  aberto = true;

  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  const tel = { telefone: '8575550505' };
  for (let i = 0; i < 3; i += 1) await post(base(tel));
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  for (let i = 0; i < 3; i += 1) {
    r = await fetch(`${url}/pedir/pedido`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base({ telefone: `85755506${i}0` })) });
  }
  r = await post(base({ telefone: '8575550999' }));
  checar(r.status === 429, 'mais de 3 pedidos por minuto do mesmo IP: 429');

  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  const cli = (telefone, chave) => fetch(`${url}/pedir/cliente`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefone, chave }) });
  // A chave sai do pedido feito pelo site, e abre só o que aquele pedido gravou.
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  const chaveMaria = (await (await post(base({ telefone: '(857) 555-1111', nome: 'Maria Lima',
    entrega: { tipo: 'delivery', cidade: 'chelsea', endereco: '45 Broadway Apt 2' } }))).json()).chave;
  const chaveAna = corpo.chave;
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  let dados = await (await cli('(857) 555-1111', chaveMaria)).json();
  checar(dados.nome === 'Maria Lima' && dados.cidade === 'chelsea' && dados.endereco === '45 Broadway Apt 2',
    'cliente: com a chave do aparelho, devolve nome, cidade (id do menu) e endereço do pedido dela');

  // Quem pede pelo site com o número da Maria ganha a chave do pedido DELE.
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  const chaveIntruso = (await (await post(base({ telefone: '(857) 555-1111', nome: 'Intruso' }))).json()).chave;
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  dados = await (await cli('(857) 555-1111', chaveIntruso)).json();
  checar(dados.nome === 'Intruso' && !dados.endereco && !JSON.stringify(dados).includes('Segredo') && !JSON.stringify(dados).includes('Broadway'),
    'cliente: pedido falso com o número dela só devolve o que o intruso digitou — nada da Maria');
  dados = await (await cli('(857) 555-1111')).json();
  checar(JSON.stringify(dados) === '{}', 'cliente: só o telefone, sem chave (outro aparelho), não mostra nada');
  dados = await (await cli('(857) 555-1111', chaveAna)).json();
  checar(JSON.stringify(dados) === '{}', 'cliente: chave de outro número não abre os dados da Maria');
  dados = await (await cli('(857) 555-1111', 'x'.repeat(40))).json();
  checar(JSON.stringify(dados) === '{}', 'cliente: chave inventada não abre nada');
  checar((await cli('123', chaveMaria)).status === 400, 'cliente: número incompleto recusa');
  for (let i = 0; i < 1; i += 1) await cli('8575559999');
  checar((await cli('8575559999')).status === 429, 'cliente: mais de 5 consultas em 10 min: 429');

  delete process.env.PEDIR_SEGREDO;
  require(`${PROJECT}/src/api/pedir`).zerarVazao();
  dados = await (await cli('(857) 555-1111', chaveMaria)).json();
  checar(JSON.stringify(dados) === '{}', 'cliente: sem PEDIR_SEGREDO, preenchimento desligado');
  r = await post(base({ telefone: '8575553333' }));
  checar(r.status === 201 && !(await r.json()).chave, 'sem PEDIR_SEGREDO, pedido funciona e não entrega chave');

  process.env.PEDIR_ATIVO = '';
  r = await fetch(`${url}/pedir/cardapio`);
  checar(r.status === 404, 'sem PEDIR_ATIVO: 404, como se não existisse');

  servidor.close();
  console.log('\n\x1b[32mpedirtest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
