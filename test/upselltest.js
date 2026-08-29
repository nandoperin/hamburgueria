/**
 * O upsell NÃO acontece. Esta suíte guarda a ausência dele.
 *
 * Ela já foi o contrário: provava que a sugestão de bebida saía no fechamento,
 * uma vez por pedido, sem recitar o cardápio. Passava — e passava em 10/10 na
 * prova contra o modelo real também.
 *
 * O dono removeu assim mesmo, depois de usar:
 *
 *   "retire o upsell. sempre ele, o fluxo não casa, repete sempre"
 *
 * ## Por que a prova não via
 *
 * Os roteiros da prova são lineares: item, entrega, endereço, nome, fecha. Um
 * pedido real vai e volta — o cliente acrescenta item depois de dar o endereço,
 * muda de ideia, confirma e desconfirma. Cada volta passa por `oQueFalta` de
 * novo, e a oferta reaparecia em pontos onde nada a justificava.
 *
 * A trava era `upsellFeito`, uma por **sessão**. E a sessão reinicia mais do
 * que eu supunha: a cada novo pedido (`session.reset`) e a cada 30 minutos de
 * silêncio. Todo reinício zerava a trava e a pergunta voltava.
 *
 * ## Por que a suíte continua existindo
 *
 * Porque a decisão é frágil: o código para reintroduzir é pequeno, o pedido
 * "vamos tentar upsell de novo" é natural, e o defeito só aparece no uso real —
 * nunca num roteiro linear. Se alguém religar a sugestão dentro de `oQueFalta`,
 * isto quebra e traz o motivo junto.
 *
 * O que faltou não foi a regra nem o texto: foi **um gatilho que não seja
 * `oQueFalta`**, que roda em toda passagem pelo fechamento — e o fechamento
 * não acontece uma vez, acontece toda vez que o cliente mexe no pedido.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';

const PROJECT = require('path').resolve(__dirname, '..');
require('./comentrega').ligar();

const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Qualquer menção a oferecer bebida no resultado de uma ferramenta. */
const ofereceu = (texto) =>
  /bebida|refrigerante|acompanhar|coca|guaran/i.test(String(texto));

let n = 0;
/** Fecha um pedido com o carrinho dado e devolve o resultado do último setter. */
async function fechar(cart, extra = {}) {
  const tel = `1555${++n}`;
  session.clear(tel);
  const s = session.get(tel);
  Object.assign(s, { lang: 'pt', cart, orderType: 'pickup' }, extra);
  const r = await tools.executar('definir_cadastro', { nome: 'Fernando' }, s, async () => {});
  return { texto: r.resultado, sess: s };
}

const X_BACON = { id: 'x_bacon', qty: 1, price: 14 };
const BATATA = { id: 'batata_frita', qty: 1, price: 6 };
const COCA = { id: 'coca_cola', qty: 1, price: 3 };

(async () => {
  // ------------------------------------ 1. nenhum carrinho puxa a oferta
  console.log('\n\x1b[36m### 1. O FECHAMENTO NAO OFERECE NADA ###\x1b[0m');

  // Os três casos que a versão anterior tratava de formas diferentes. Agora
  // todos têm o mesmo resultado: silêncio.
  const casos = [
    ['sanduíche sozinho', [X_BACON]],
    ['acompanhamento sozinho', [BATATA]],
    ['sanduíche com batata', [X_BACON, BATATA]],
    ['já tem bebida', [X_BACON, COCA]],
  ];

  for (const [nome, cart] of casos) {
    const { texto } = await fechar(cart);
    checar(!ofereceu(texto), `${nome}: a ferramenta não sugere bebida`);
  }

  // ------------------------------- 2. e o fechamento segue direto ao ponto
  console.log('\n\x1b[36m### 2. VAI DIRETO AO RESUMO ###\x1b[0m');

  const { texto } = await fechar([X_BACON]);
  checar(
    /CHAME finalizar_pedido AGORA/i.test(texto),
    'com tudo preenchido, manda finalizar na mesma resposta'
  );
  checar(
    !/antes disso|só uma vez/i.test(texto),
    'sem nenhum passo intermediário antes do resumo'
  );

  // ------------------------ 3. a sessão não carrega mais o estado do upsell
  console.log('\n\x1b[36m### 3. SEM ESTADO ORFAO NA SESSAO ###\x1b[0m');

  const { sess } = await fechar([X_BACON]);
  checar(
    !('upsellFeito' in sess),
    'a sessão não guarda mais `upsellFeito` — era a trava que não segurava'
  );

  console.log('\n\x1b[32m✓ upselltest passou (o upsell segue removido)\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
