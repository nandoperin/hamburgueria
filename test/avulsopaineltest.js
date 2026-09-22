/**
 * "Pode ir à parte", a caixinha do painel (pedido do dono, 19/09).
 *
 * Marcado, o adicional pode ser vendido sozinho; desmarcado, ele só entra
 * dentro de um lanche. Sem marcação nenhuma vale a regra antiga: salsicha e
 * sachê de maionese à parte, o resto dentro do lanche.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menu = JSON.parse(JSON.stringify(require('./fixtures/menu-producao.json')));
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menu : getReal(chave));

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });

const cardapio = require(`${PROJECT}/src/services/cardapio`);
const guiado = require(`${PROJECT}/src/ai/guiado`);
const session = require(`${PROJECT}/src/bot/session`);
const tools = require(`${PROJECT}/src/ai/tools`);

const item = (id) => menu.categories.flatMap((c) => c.items).find((i) => i.id === id);
const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const lido = (produto, trecho) => ({ ...VAZIA, itens: [{ produto, qtd: 1, sem: [], com: [],
  salsicha: null, ponto_bife: null, ponto_bacon: null, maionese_a_parte: false, trecho }] });

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

let seq = 0;
function carrinhoDe(produto, trecho) {
  const s = session.get(`1555778${String(++seq).padStart(4, '0')}`);
  s.lang = 'pt';
  tools.carrinho.adicionar(s, { item_id: 'x_tudo', quantidade: 1 });
  const plano = guiado.validar(s, JSON.parse(JSON.stringify(lido(produto, trecho))), trecho);
  return plano;
}

// 1. Sem marcação, a regra de sempre.
checar(cardapio.avulsoPermitido('salsicha') && cardapio.avulsoPermitido('sache_maionese'),
  'sem marcação: salsicha e sachê vão à parte');
checar(!cardapio.avulsoPermitido('bife') && !cardapio.avulsoPermitido('bacon'),
  'sem marcação: bife e bacon só dentro do lanche');

// 2. A caixinha manda.
item('bife').avulso = true;
checar(cardapio.avulsoPermitido('bife'), 'marcado no painel: o bife passa a poder ir à parte');
const comBife = carrinhoDe('bife', 'um bife a parte');
checar(comBife.itens.some((i) => i.item_id === 'bife'), '   e "um bife a parte" entra como item');

item('salsicha').avulso = false;
checar(!cardapio.avulsoPermitido('salsicha'), 'desmarcado no painel: a salsicha deixa de ir à parte');

// 3. Desmarcado, continua sendo acréscimo do lanche.
item('bife').avulso = false;
const semBife = carrinhoDe('bife', 'um bife a mais');
// Com um lanche só no carrinho, o acréscimo vai direto nele (sem perguntar).
checar(!semBife.itens.some((i) => i.item_id === 'bife') &&
  semBife.correcoes.some((c) => (c.com || []).includes('bife')),
  'desmarcado: "um bife a mais" vira acréscimo no lanche, não item solto');

// 4. Marcado, com lanche no carrinho: o bot PERGUNTA junto ou à parte (regra
//    do dono, 20/09) — era o que faltava para o bife virar a salsicha.
item('bife').avulso = true;
const pergunta = carrinhoDe('bife', 'Adciona bife');
checar(!pergunta.itens.length && pergunta.preparos.some((x) => x.ingrediente === 'bife'),
  'marcado: "Adciona bife" com lanche no carrinho vira pergunta, não item');

const jaDisse = carrinhoDe('bife', 'um bife a parte');
checar(jaDisse.itens.some((i) => i.item_id === 'bife') && !jaDisse.preparos.length,
  'quem já diz "à parte" não é perguntado de novo');

const junto = carrinhoDe('bife', 'bife junto no lanche');
// Com um lanche só, vai direto nele; com vários, vira a pergunta "em qual".
checar(!junto.itens.length && (junto.correcoes.some((c) => (c.com || []).includes('bife')) ||
  junto.alvos.some((a) => a.ingrediente === 'bife')),
  'quem diz "junto" vira acréscimo no lanche');

// 5. A resposta à pergunta.
function respostaDe(tel, fala) {
  const s = session.get(tel);
  s.lang = 'pt';
  tools.carrinho.adicionar(s, { item_id: 'x_tudo', quantidade: 1 });
  s.guiado = { ultimaPergunta: null, pendente: { tipo: 'preparo', ingrediente: 'bife', qtd: null } };
  return guiado.validar(s, JSON.parse(JSON.stringify(VAZIA)), fala);
}
checar(respostaDe('15557780900', 'A parte').itens.some((i) => i.item_id === 'bife'),
  'responder "a parte" põe o bife como item');
const respJunto = respostaDe('15557780901', 'Junto');
checar(respJunto.alvos.some((a) => a.ingrediente === 'bife') ||
  respJunto.correcoes.some((c) => (c.com || []).includes('bife')),
  'responder "junto" manda o bife para o lanche');

// 6. Adicional que não pode ir à parte não some calado.
item('bacon').avulso = false;
checar(carrinhoDe('bacon', 'bacon').avisos.some((a) => /Bacon/.test(a)),
  'adicional sem pedido de acréscimo avisa o cliente');

console.log('\n\x1b[32mavulsopaineltest: tudo passou.\x1b[0m');
