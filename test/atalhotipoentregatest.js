/**
 * "E" e "R" como atalho de entrega e retirada.
 *
 * Atalho silencioso: a pergunta na tela continua igual, e quem escreve a
 * palavra inteira não muda de caminho. Ele existe porque no WhatsApp o
 * cliente abrevia sozinho, e uma letra sem resposta é o mesmo que o bot não
 * ter entendido.
 *
 * O que este teste protege de verdade é o outro lado: uma letra só é ambígua,
 * e fora do momento da pergunta ela NÃO pode virar tipo de entrega — senão um
 * "R" no meio da montagem do carrinho fecharia a escolha sozinho.
 */
process.env.AI_ENABLED = 'off';

const ordertype = require('../src/bot/handlers/ordertype');
const session = require('../src/bot/session');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

// ------------------------------------------- 1. a tela de botões (IA off)
console.log('\n\x1b[36m### 1. NA TELA DE ESCOLHA, A LETRA VALE ###\x1b[0m');
for (const [texto, esperado] of [
  ['E', 'delivery'], ['e', 'delivery'], ['R', 'pickup'], ['r', 'pickup'],
  ['e.', 'delivery'], [' r ', 'pickup'],
]) {
  checar(ordertype.interpretar(texto) === esperado,
    `"${texto}" é ${esperado}`);
}
checar(ordertype.interpretar('entrega') === 'delivery', '"entrega" continua valendo');
checar(ordertype.interpretar('2') === 'pickup', 'o número do fallback continua valendo');
checar(ordertype.interpretar('x') === null, 'outra letra qualquer não vira escolha');

// -------------------------------- 2. na conversa com IA, só na hora certa
console.log('\n\x1b[36m### 2. COM A IA, SÓ QUANDO A PERGUNTA É ESSA ###\x1b[0m');

function sessaoCom(campos) {
  session.clear('15550000700');
  return Object.assign(session.get('15550000700'), { lang: 'pt', state: 'ORDER' }, campos);
}

const comCarrinho = sessaoCom({ cart: [{ id: 'x_tudo', productId: 'x_tudo', qty: 1, price: 20 }] });
checar(ordertype.atalhoDeTipo(comCarrinho, 'R') === 'pickup',
  'carrinho cheio e sem tipo escolhido: "R" é retirada');
checar(ordertype.atalhoDeTipo(comCarrinho, 'E') === 'delivery', 'e "E" é entrega');

const vazio = sessaoCom({ cart: [] });
checar(ordertype.atalhoDeTipo(vazio, 'R') === null,
  'carrinho vazio: a pergunta ainda não foi feita, "R" não vira nada');

const jaEscolhido = sessaoCom({
  cart: [{ id: 'x_tudo', productId: 'x_tudo', qty: 1, price: 20 }],
  orderType: 'delivery',
});
checar(ordertype.atalhoDeTipo(jaEscolhido, 'R') === null,
  'tipo já escolhido: "R" não troca a escolha por acidente');

const comSalsicha = sessaoCom({
  cart: [{ id: 'salsicha', productId: 'salsicha', qty: 1, price: 1, added: [] }],
});
checar(ordertype.atalhoDeTipo(comSalsicha, 'R') === null,
  'com a pergunta da salsicha na frente, a letra não fura a fila');

checar(ordertype.atalhoDeTipo(comCarrinho, 'x') === null, 'outra letra não vira escolha');
checar(ordertype.atalhoDeTipo(comCarrinho, 'retirada') === null,
  'a palavra inteira não passa por aqui — segue o caminho normal da IA');

session.clear('15550000700');
console.log('\n\x1b[32matalhotipoentregatest: tudo passou.\x1b[0m');
