/**
 * O que o bot lembra do cliente, e onde essa lembrança é colocada.
 *
 * O bot sempre teve memória: `welcome.js#loadKnownCustomer` lê `customers` e
 * `orders` e preenche a sessão com nome, email e endereço anterior. O que
 * faltava era a IA **saber disso** — `systemPrompt()` não citava o cliente em
 * lugar nenhum, então o modelo perguntava nome e endereço a quem já tinha
 * comprado dez vezes.
 *
 * ## Os dois riscos que esta suíte cobre
 *
 * **1. O contexto no lugar errado destrói o prompt caching.** Se os dados do
 * cliente forem parar no system prompt, o prefixo deixa de ser idêntico entre
 * chamadas: o cache fragmenta em um por pessoa e a economia de ~90% medida em
 * `scripts/prova-conversa.js` evapora. O cenário 1 trava isso.
 *
 * **2. Reoferecer endereço não pode virar assumir endereço.** Quem se mudou
 * receberia comida no endereço velho, e a taxa de entrega muda com a cidade
 * (ver `delivery.js`). O contexto tem que OFERECER; quem decide é o cliente.
 *
 * Nada aqui chama a API: o provedor é um espião que guarda o payload.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';

const PROJECT = require('path').resolve(__dirname, '..');

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
};

require('./comentrega').ligar();

// ------------------------------------------------------ o provedor espião

let payloads = [];

const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true,
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async (payload) => {
      // Cópia, não referência. `payload.mensagens` É o array de histórico vivo
      // do agente: guardá-lo cru faz o payload "capturado" mudar sozinho
      // quando a resposta do modelo é empurrada depois da chamada — e o teste
      // passa a medir o histórico final, não o que foi enviado naquela hora.
      payloads.push({ ...payload, mensagens: payload.mensagens.map((m) => ({ ...m })) });
      return { texto: 'ok', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
    },
  }),
};

const agente = require(`${PROJECT}/src/ai/agente`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

// Dados deliberadamente improvaveis: a primeira versao desta suite usou
// "Maria Souza" e "250 Broadway", e o cenario 1 falhou — nao por vazamento,
// mas porque "250 Broadway" e o endereco de EXEMPLO em `tools.js` (descricao
// de definir_endereco) e no proprio prompt. Um teste que procura vazamento de
// dado pessoal precisa de dado que nao exista como exemplo em lugar nenhum.
let contador = 0;
/** Sessão nova a cada cenário — telefone diferente zera o histórico do agente. */
function sessao(dados = {}) {
  const tel = `1555000${String(++contador).padStart(4, '0')}`;
  session.clear(tel);
  const s = session.get(tel);
  s.lang = 'pt';
  s.state = 'MENU';
  Object.assign(s, dados);
  payloads = [];
  return s;
}

/** O texto de todas as mensagens de um payload, junto. */
const textoDasMensagens = (p) => p.mensagens.map((m) => m.content || '').join('\n');

(async () => {
  // ------------------------------- 1. o caching não pode ser sabotado
  console.log('\n\x1b[36m### 1. O CONTEXTO NAO ENTRA NO SYSTEM PROMPT ###\x1b[0m');

  const novo = sessao();
  await agente.conversar(novo, 'oi', async () => {});
  const systemDoNovo = payloads[0].system;

  const conhecido = sessao({
    name: 'Zoraide Petrovna',
    email: 'zoraide.petrovna@exemplo-unico.test',
    lastAddress: '9871 Travessa Zimbabue',
    lastCityId: 'everett',
    lastItems: [{ id: 'x_bacon', name: 'X-Bacon', qty: 1, removed: ['cebola'] }],
  });
  await agente.conversar(conhecido, 'oi', async () => {});
  const systemDoConhecido = payloads[0].system;

  checar(
    systemDoNovo === systemDoConhecido,
    'o system prompt é IDENTICO para cliente novo e conhecido — o prefixo cacheado sobrevive'
  );
  checar(
    !systemDoConhecido.includes('Zoraide Petrovna') && !systemDoConhecido.includes('9871 Travessa Zimbabue'),
    'nenhum dado pessoal vazou para dentro do system prompt'
  );
  checar(
    textoDasMensagens(payloads[0]).includes('Zoraide Petrovna'),
    'os dados do cliente vão nas MENSAGENS, depois do prefixo cacheado'
  );

  // ------------------------------------ 2. cliente novo não ganha contexto
  console.log('\n\x1b[36m### 2. CLIENTE NOVO NAO GANHA BLOCO DE CONTEXTO ###\x1b[0m');
  const s2 = sessao();
  await agente.conversar(s2, 'quero um x-burger', async () => {});
  checar(
    !textoDasMensagens(payloads[0]).includes('CONTEXTO DO SISTEMA'),
    'sem histórico no banco, nenhum bloco de contexto é enviado — nada de tokens à toa'
  );
  checar(
    payloads[0].mensagens.length === 1,
    'só a mensagem do cliente vai no payload'
  );

  // -------------------------------------- 3. o que o contexto carrega
  console.log('\n\x1b[36m### 3. O CONTEXTO CARREGA NOME, ENDERECO E PEDIDO ###\x1b[0m');
  const s3 = sessao({
    name: 'Zoraide Petrovna',
    email: 'zoraide.petrovna@exemplo-unico.test',
    lastAddress: '9871 Travessa Zimbabue',
    lastCityId: 'everett',
    lastItems: [
      {
        id: 'x_bacon:-cebola+ovo',
        productId: 'x_bacon',
        name: 'X-Bacon',
        qty: 2,
        removed: ['cebola'],
        added: ['ovo'],
      },
      { id: 'coca_cola', name: 'Coca-Cola', qty: 1 },
    ],
  });
  await agente.conversar(s3, 'oi', async () => {});
  const ctx = textoDasMensagens(payloads[0]);

  checar(ctx.includes('Zoraide Petrovna'), 'o nome vai no contexto');
  checar(ctx.includes('zoraide.petrovna@exemplo-unico.test'), 'o email vai no contexto');
  checar(ctx.includes('9871 Travessa Zimbabue'), 'o endereço anterior vai no contexto');
  checar(ctx.includes('Everett'), 'com a cidade resolvida do id, não o id cru');
  checar(
    ctx.includes('2x X-Bacon (sem cebola, com ovo)'),
    'o item anterior vem com quantidade E personalização — é o que o cliente reconhece'
  );
  checar(
    ctx.includes(
      'adicionar_item(item_id="x_bacon", quantidade=2, remover=["cebola"], acrescentar=["ovo"])'
    ),
    'repetir último pedido usa productId base e preserva quantidade e personalização'
  );
  checar(ctx.includes('Coca-Cola'), 'e todos os itens, não só o primeiro');

  // ------------------------------ 4. endereço é oferta, não fato consumado
  console.log('\n\x1b[36m### 4. O ENDERECO: QUEM FALOU PRIMEIRO DECIDE ###\x1b[0m');

  // A primeira versão desta suíte travava o texto "OFEREÇA este endereço e
  // ESPERE ele confirmar" — regra rígida que, num teste real, fez o bot
  // repetir o endereço e pedir "é nesse mesmo?" para um cliente que ACABARA de
  // escrever "entrega no mesmo endereço". A asserção estava certa sobre o
  // texto e errada sobre o comportamento: travou a redundância no lugar da
  // proteção.
  //
  // O que precisa ser garantido são as duas metades da regra, não a frase.
  checar(
    /já é a confirmação|ja e a confirmacao/i.test(ctx),
    'o cliente que menciona o endereço primeiro NAO é reperguntado'
  );
  checar(
    /Se VOCÊ trouxer o endereço primeiro, aí espere o "sim"/.test(ctx),
    'mas se o bot trouxer primeiro, aí sim espera confirmação — a trava original'
  );
  checar(
    /gente se muda|a taxa muda\s*\n?\s*com a cidade/i.test(ctx),
    'e o porquê continua dito: gente se muda, e a taxa muda com a cidade'
  );
  checar(
    !s3.address,
    'a sessão NAO teve o endereço preenchido por trás — lastAddress não vira address sozinho'
  );

  // ------------------------- 5. o bloco não é confundido com fala do cliente
  console.log('\n\x1b[36m### 5. O BLOCO SE IDENTIFICA COMO SISTEMA ###\x1b[0m');
  checar(
    ctx.includes('não é fala do cliente'),
    'o bloco avisa explicitamente que não é o cliente falando'
  );
  const papeis = payloads[0].mensagens.map((m) => m.role);
  checar(
    papeis[1] === 'assistant',
    'e é fechado por um turno assistant — a fala real do cliente não se funde a ele'
  );
  checar(
    payloads[0].mensagens[papeis.length - 1].content === 'oi',
    'a mensagem real do cliente é a última, intacta'
  );

  // --------------------------------- 6. o contexto é enviado UMA vez
  console.log('\n\x1b[36m### 6. O CONTEXTO NAO SE REPETE A CADA MENSAGEM ###\x1b[0m');
  payloads = [];
  await agente.conversar(s3, 'quero dois x-bacon', async () => {});
  await agente.conversar(s3, 'e uma coca', async () => {});

  const ocorrencias = textoDasMensagens(payloads[payloads.length - 1])
    .split('CONTEXTO DO SISTEMA').length - 1;
  checar(
    ocorrencias === 1,
    `o bloco aparece uma vez só no histórico, não a cada mensagem (achou ${ocorrencias})`
  );

  // ------------------------- 7. dados parciais não geram bloco quebrado
  console.log('\n\x1b[36m### 7. DADOS PARCIAIS NAO QUEBRAM O BLOCO ###\x1b[0m');
  const s7 = sessao({ name: 'João' }); // sem email, sem endereço, sem itens
  await agente.conversar(s7, 'oi', async () => {});
  const ctx7 = textoDasMensagens(payloads[0]);

  checar(ctx7.includes('João'), 'o nome sozinho já gera contexto');
  checar(!ctx7.includes('Último endereço'), 'sem endereço, a linha do endereço não aparece');
  checar(!ctx7.includes('Último pedido'), 'sem itens, a linha do pedido não aparece');
  checar(!ctx7.includes('undefined'), 'e nada de "undefined" vazando no texto');

  console.log('\n\x1b[32mmemoriatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
