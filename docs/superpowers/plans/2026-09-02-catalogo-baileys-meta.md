# Catálogo Baileys e migração Meta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receber o carrinho do catálogo nativo do WhatsApp pelo Baileys, continuar o pedido pela IA sem perguntas de personalização, permitir alterações solicitadas pelo cliente e reutilizar o mesmo domínio quando o número migrar para a Meta.

**Architecture:** Baileys e Meta convertem seus payloads em um contrato interno único antes de alcançar o carrinho. O domínio valida o lote inteiro, ignora preços externos e aplica somente produtos e valores do cardápio dinâmico; depois, a IA recebe um evento interno curto e faz no máximo a pergunta obrigatória seguinte. Personalização atua sobre uma linha já existente no carrinho, separada da ferramenta que adiciona produtos novos.

**Tech Stack:** Node.js 22, CommonJS, Baileys 7.0.0-rc13, Express 4, Supabase, Mistral tool calling e o executor de testes próprio em `test/run.js`.

**Spec:** `docs/superpowers/specs/2026-09-02-catalogo-baileys-meta-design.md`

## Global Constraints

- Produtos, fotos e preços são cadastrados manualmente no WhatsApp Business nesta fase.
- O bot não cria, edita nem apaga produtos pelo Baileys.
- O cardápio vigente de `src/services/cardapio.js` decide existência, disponibilidade, preço e ingredientes.
- Preços, totais e moeda recebidos do WhatsApp nunca entram no cálculo.
- O nome em português no catálogo precisa resolver para exatamente um produto interno após normalização.
- Cada linha aceita de 1 a 99 unidades; o lote inteiro aceita no máximo 200 unidades.
- Quantidade inválida rejeita o lote inteiro, sem redução silenciosa e sem mutação parcial.
- A IA não oferece personalização, adicionais ou upsell depois do carrinho do catálogo.
- Retirada de ingrediente é gratuita; adicional usa o preço vigente carregado do painel.
- O token de `orderMessage` nunca aparece em logs, erros ou respostas.
- Nenhuma migração de banco é necessária; idempotência desta fase vive na sessão do cliente.
- Não editar `.env`, não registrar segredos e não tocar no projeto Supabase do Espetinho.

---

## Estrutura de arquivos

- `src/services/catalog.js`: leitura dinâmica do cardápio, normalização de nomes e funções já usadas por feeds da Meta.
- `src/bot/catalog/adapters.js`: conversão pura dos formatos Baileys e Meta para `CatalogOrder`.
- `src/bot/handlers/catalogorder.js`: validação atômica e aplicação do contrato comum ao carrinho.
- `src/bot/session.js`: IDs externos já consumidos durante a sessão.
- `src/bot/router.js`: política de horário, pedido novo após pagamento e chamada do handler comum.
- `src/bot/index.js`: detecção de `orderMessage` e busca protegida com `sock.getOrderDetails`.
- `src/api/webhooks/meta.js`: adaptação do `message.order` para o mesmo contrato.
- `src/ai/tools.js`: ferramenta `personalizar_item` e metadados estáveis das linhas do carrinho.
- `src/ai/agente.js`: evento interno de carrinho e instrução de conversa sem oferta de alterações.
- `test/catalogservicetest.js`: resolução dinâmica e nomes normalizados.
- `test/catalogadapterstest.js`: contratos Baileys/Meta e sigilo do token.
- `test/catalogordertest.js`: lote atômico, preço interno, repetição e mesclagem.
- `test/catalogroutingtest.js`: ligação dos dois provedores ao contrato comum.
- `test/personalizartest.js`: alteração, divisão e ambiguidade de linhas.
- `test/catalogiaflowtest.js`: uma chamada da IA, próxima pergunta obrigatória e fallback.
- `scripts/prova-catalogo.js`: repetição opcional contra a Mistral real.
- `docs/MIGRACAO-BAILEYS-META.md`: operação da troca futura.

---

### Task 1: Tornar o serviço de catálogo dinâmico e resolver nomes

**Files:**
- Modify: `src/services/catalog.js`
- Create: `test/catalogservicetest.js`

**Interfaces:**
- Consumes: `cardapio.allItems()`, `cardapio.itemsOfCategory(id)` e objetos com `name.pt`.
- Produces: `normalizarNome(nome): string` e `resolverNomePt(nome): { ok: true, item } | { ok: false, erro: 'vazio' | 'desconhecido' | 'ambiguo', candidatos: string[] }`.
- Preserves: `allItems`, `itemByRetailerId`, feeds CSV e demais exports já usados pelo projeto.

- [ ] **Step 1: Escrever a suíte que prova atualização em tempo de execução e resolução única**

```js
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

let itens = [
  { id: 'x_bacon', name: { pt: 'X-Bacon' }, price: 14, available: true },
  { id: 'x_tudo', name: { pt: 'X Tudo' }, price: 17, available: true },
];

const cardapioPath = require.resolve(`${PROJECT}/src/services/cardapio`);
require.cache[cardapioPath] = {
  id: cardapioPath,
  filename: cardapioPath,
  loaded: true,
  exports: {
    allItems: () => itens,
    itemsOfCategory: () => [],
  },
};

delete require.cache[require.resolve(`${PROJECT}/src/services/catalog`)];
const catalog = require(`${PROJECT}/src/services/catalog`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

checar(catalog.resolverNomePt('x bacon').item.id === 'x_bacon', 'ignora hífen');
checar(catalog.resolverNomePt('  X–BÁCON! ').item.id === 'x_bacon', 'ignora acento e pontuação');

itens = [{ id: 'novo', name: { pt: 'Novo Lanche' }, price: 9, available: true }];
checar(catalog.allItems()[0].id === 'novo', 'não congela o menu no require');

itens = [
  { id: 'a', name: { pt: 'X Bacon' }, price: 1, available: true },
  { id: 'b', name: { pt: 'X-Bacon' }, price: 2, available: true },
];
const ambiguo = catalog.resolverNomePt('x bacon');
checar(!ambiguo.ok && ambiguo.erro === 'ambiguo', 'não escolhe entre nomes duplicados');
```

- [ ] **Step 2: Rodar a suíte e confirmar a falha inicial**

Run: `node test/catalogservicetest.js`

Expected: FAIL porque `resolverNomePt` ainda não existe e `catalog.js` ainda captura `config/menu.json` no carregamento.

- [ ] **Step 3: Trocar o JSON congelado pelo serviço dinâmico e implementar a normalização**

```js
const cardapio = require('./cardapio');

function normalizarNome(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function allItems() {
  return cardapio.allItems();
}

function resolverNomePt(nome) {
  const chave = normalizarNome(nome);
  if (!chave) return { ok: false, erro: 'vazio', candidatos: [] };

  const encontrados = allItems().filter(
    (item) => normalizarNome(item.name?.pt) === chave
  );
  if (encontrados.length === 1) return { ok: true, item: encontrados[0] };
  return {
    ok: false,
    erro: encontrados.length ? 'ambiguo' : 'desconhecido',
    candidatos: encontrados.map((item) => item.id),
  };
}

function itemsOfCategory(categoryId) {
  return cardapio.itemsOfCategory(categoryId);
}
```

Adicionar `normalizarNome` e `resolverNomePt` aos exports e manter todas as funções de feed utilizando `allItems()`.

- [ ] **Step 4: Rodar as provas local e completa**

Run: `node test/catalogservicetest.js`

Expected: PASS.

Run: `npm test`

Expected: todas as suítes existentes e `catalogservicetest` passam.

- [ ] **Step 5: Versionar a fonte dinâmica do catálogo**

```powershell
git add -- src/services/catalog.js test/catalogservicetest.js
git commit -m "refactor: le catalogo da configuracao vigente"
```

---

### Task 2: Criar os adaptadores Baileys e Meta

**Files:**
- Create: `src/bot/catalog/adapters.js`
- Create: `test/catalogadapterstest.js`

**Interfaces:**
- Consumes Baileys: `fromBaileys(sock, orderMessage)` e `sock.getOrderDetails(orderId, tokenBase64)`.
- Consumes Meta: `fromMeta(message)` com `message.id` e `message.order.product_items`.
- Produces: `CatalogOrder = { source, externalOrderId, items: [{ productId, quantity, externalProductId }] }`.
- Produces: `CatalogInputError` com apenas `code` e `products`; nunca inclui token ou payload integral.
- Produces: `publicErrorKey(code): string`, que reduz todo erro interno a uma chave pública conhecida.

- [ ] **Step 1: Escrever a suíte dos dois contratos e do sigilo do token**

```js
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const { fromBaileys, fromMeta, CatalogInputError } = require(`${PROJECT}/src/bot/catalog/adapters`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

(async () => {
  let chamada;
  let nomeDoProduto = 'X-Bacon';
  const sock = {
    getOrderDetails: async (orderId, token) => {
      chamada = { orderId, token };
      return {
        products: [
          { id: 'wa-17', name: nomeDoProduto, quantity: 2, price: 1 },
        ],
        price: 1,
      };
    },
  };

  const segredo = Buffer.from('token-que-nao-pode-vazar');
  const baileys = await fromBaileys(sock, { orderId: 'ord-1', token: segredo });
  checar(chamada.orderId === 'ord-1', 'busca o pedido certo');
  checar(chamada.token === segredo.toString('base64'), 'converte token para base64');
  checar(baileys.items[0].productId === 'x_bacon', 'resolve pelo nome em português');
  checar(!JSON.stringify(baileys).includes('price'), 'descarta preço externo');

  const meta = fromMeta({
    id: 'wamid.1',
    order: { product_items: [{ product_retailer_id: 'x_bacon', quantity: 2, item_price: 1 }] },
  });
  checar(meta.source === 'meta' && meta.items[0].productId === 'x_bacon', 'normaliza Meta');

  nomeDoProduto = 'Produto sem cadastro';
  try {
    await fromBaileys(sock, { orderId: 'ord-2', token: Buffer.from('secreto') });
    throw new Error('nome desconhecido deveria ser recusado');
  } catch (err) {
    checar(err instanceof CatalogInputError, 'usa erro sanitizado');
    checar(!JSON.stringify(err).includes('secreto'), 'erro não carrega token');
    checar(err.products[0] === 'Produto sem cadastro', 'identifica o produto ao cliente');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar a suíte e confirmar que o módulo ainda não existe**

Run: `node test/catalogadapterstest.js`

Expected: FAIL com `MODULE_NOT_FOUND` para `src/bot/catalog/adapters.js`.

- [ ] **Step 3: Implementar o erro sanitizado, o token e o adaptador Meta**

```js
const catalog = require('../../services/catalog');
const entrada = require('../../entrada');

class CatalogInputError extends Error {
  constructor(code, products = []) {
    super(code);
    this.name = 'CatalogInputError';
    this.code = code;
    this.products = products.map((value) => entrada.limpar(value, 120));
  }

  toJSON() {
    return { name: this.name, code: this.code, products: this.products };
  }
}

const PUBLIC_ERROR_KEYS = Object.freeze({
  pedido_invalido: 'catalog_error_pedido_invalido',
  leitura_falhou: 'catalog_error_leitura_falhou',
  produto_desconhecido: 'catalog_error_produto_desconhecido',
  produto_ambiguo: 'catalog_error_produto_ambiguo',
  quantidade_invalida: 'catalog_error_quantidade_invalida',
  quantidade_total: 'catalog_error_quantidade_invalida',
  produto_esgotado: 'catalog_error_produto_esgotado',
  origem_invalida: 'catalog_error_pedido_invalido',
  pedido_vazio: 'catalog_error_pedido_invalido',
});

function publicErrorKey(code) {
  return PUBLIC_ERROR_KEYS[code] || 'catalog_error_pedido_invalido';
}

function tokenBase64(token) {
  if (typeof token === 'string' && token.trim()) return token;
  if (Buffer.isBuffer(token) || token instanceof Uint8Array) {
    return Buffer.from(token).toString('base64');
  }
  throw new CatalogInputError('pedido_invalido');
}

function fromMeta(message) {
  const externalOrderId = String(message?.id || '').trim();
  if (!externalOrderId) throw new CatalogInputError('pedido_invalido');
  const entries = message?.order?.product_items;
  if (!Array.isArray(entries)) throw new CatalogInputError('pedido_invalido');
  return {
    source: 'meta',
    externalOrderId,
    items: entries.map((entry) => ({
      productId: String(entry.product_retailer_id || ''),
      quantity: entry.quantity,
      externalProductId: String(entry.product_retailer_id || ''),
    })),
  };
}
```

- [ ] **Step 4: Implementar a busca Baileys sem conservar preço nem token**

```js
async function fromBaileys(sock, orderMessage) {
  const externalOrderId = String(orderMessage?.orderId || '').trim();
  if (!externalOrderId || !sock?.getOrderDetails) {
    throw new CatalogInputError('pedido_invalido');
  }

  let details;
  try {
    details = await sock.getOrderDetails(externalOrderId, tokenBase64(orderMessage.token));
  } catch (_err) {
    throw new CatalogInputError('leitura_falhou');
  }

  const products = Array.isArray(details?.products) ? details.products : [];
  const items = products.map((product) => {
    const resolvido = catalog.resolverNomePt(product?.name);
    if (!resolvido.ok) {
      const code = resolvido.erro === 'ambiguo'
        ? 'produto_ambiguo'
        : 'produto_desconhecido';
      throw new CatalogInputError(code, [product?.name]);
    }
    return {
      productId: resolvido.item.id,
      quantity: product.quantity,
      externalProductId: String(product.id || ''),
    };
  });

  return { source: 'baileys', externalOrderId, items };
}

module.exports = { CatalogInputError, publicErrorKey, fromBaileys, fromMeta };
```

- [ ] **Step 5: Rodar a suíte dos adaptadores e a suíte completa**

Run: `node test/catalogadapterstest.js`

Expected: PASS para Baileys, Meta, preço descartado, nome desconhecido e token ausente do erro.

Run: `npm test`

Expected: todas as suítes passam.

- [ ] **Step 6: Versionar os adaptadores**

```powershell
git add -- src/bot/catalog/adapters.js test/catalogadapterstest.js
git commit -m "feat: normaliza carrinhos Baileys e Meta"
```

---

### Task 3: Aplicar o carrinho de forma atômica e idempotente

**Files:**
- Modify: `src/bot/handlers/catalogorder.js`
- Modify: `src/bot/session.js`
- Modify: `src/i18n/pt.json`
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/es.json`
- Create: `test/catalogordertest.js`
- Modify: `test/carrinhotest.js`
- Modify: `test/enxutotest.js`
- Modify: `test/faqtest.js`
- Modify: `test/idiomatest.js`

**Interfaces:**
- Consumes: `handleCartOrder(session, catalogOrder, send)` com o contrato da Task 2.
- Produces: `{ status: 'applied' | 'duplicate' | 'rejected', session }`.
- Session field: `catalogOrderIds: string[]`, preservado em `session.reset(phone)` e limitado aos 20 IDs mais recentes.
- Cart line base: `{ id, productId, name, nomeCozinha, choicesCozinha, removed, added, qty, price }`.
- Product alerts: no máximo um aviso ao administrador por `erro + produto` durante a vida do processo.
- Produces: `avisarDono(erro, produtos): Promise<void>` para os adaptadores recusados antes do roteador.

- [ ] **Step 1: Escrever a suíte de preço interno, lote inválido, repetição e mesclagem**

```js
process.env.AI_ENABLED = 'off';
process.env.ADMIN_PHONE = '16175550000';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const session = require(`${PROJECT}/src/bot/session`);
const notify = require(`${PROJECT}/src/bot/notify`);
const handler = require(`${PROJECT}/src/bot/handlers/catalogorder`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

const send = async () => {};
const alertas = [];
notify.register(async (_phone, text) => alertas.push(text));

(async () => {
  const s = session.get('15550000001');
  s.lang = 'pt';
  const pedido = {
    source: 'baileys',
    externalOrderId: 'ord-1',
    items: [{ productId: 'x_bacon', quantity: 2, externalProductId: 'wa-1' }],
  };

  await handler.handleCartOrder(s, pedido, send);
  checar(s.cart[0].qty === 2, 'aplica quantidade');
  checar(s.cart[0].price === 14, 'usa preço interno do X-Bacon');
  checar(s.cart[0].productId === 'x_bacon', 'guarda identidade base');

  await handler.handleCartOrder(s, pedido, send);
  checar(s.cart[0].qty === 2, 'retransmissão não duplica');

  const antes = JSON.stringify(s.cart);
  const adulterado = {
    source: 'meta',
    externalOrderId: 'ord-2',
    items: [
      { productId: 'x_bacon', quantity: 1, externalProductId: 'ok' },
      { productId: 'guarana', quantity: 100, externalProductId: 'ruim' },
    ],
  };
  const rejeitado = await handler.handleCartOrder(s, adulterado, send);
  checar(rejeitado.status === 'rejected', 'rejeita quantidade acima de 99');
  checar(JSON.stringify(s.cart) === antes, 'não aplica metade do lote');

  const desconhecido = {
    source: 'meta',
    externalOrderId: 'ord-fantasma-1',
    items: [{ productId: 'produto_fantasma', quantity: 1, externalProductId: 'produto_fantasma' }],
  };
  await handler.handleCartOrder(s, desconhecido, send);
  await handler.handleCartOrder(s, { ...desconhecido, externalOrderId: 'ord-fantasma-2' }, send);
  checar(alertas.length === 1, 'avisa o dono uma vez por produto divergente');

  await handler.handleCartOrder(s, {
    source: 'baileys',
    externalOrderId: 'ord-3',
    items: [{ productId: 'guarana', quantity: 1, externalProductId: 'wa-2' }],
  }, send);
  checar(s.cart.some((line) => line.productId === 'guarana'), 'mescla carrinho novo');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Adicionar ao mesmo bloco assíncrono os casos inválidos completos:

```js
  const invalidos = [
    ['quantidade ausente', [{ productId: 'x_bacon', externalProductId: 'a' }]],
    ['quantidade zero', [{ productId: 'x_bacon', quantity: 0, externalProductId: 'b' }]],
    ['quantidade fracionária', [{ productId: 'x_bacon', quantity: 1.5, externalProductId: 'c' }]],
    ['total 201', [
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd1' },
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd2' },
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd3' },
    ]],
    ['produto inexistente', [
      { productId: 'nao_existe', quantity: 1, externalProductId: 'e' },
    ]],
  ];

  for (const [nome, items] of invalidos) {
    const fotografia = JSON.stringify(s.cart);
    const resultado = await handler.handleCartOrder(s, {
      source: 'meta', externalOrderId: `invalido-${nome}`, items,
    }, send);
    checar(resultado.status === 'rejected', `${nome}: lote recusado`);
    checar(JSON.stringify(s.cart) === fotografia, `${nome}: carrinho intacto`);
  }

  const cardapio = require(`${PROJECT}/src/services/cardapio`);
  const disponibilidadeOriginal = cardapio.disponivel;
  cardapio.disponivel = (item) => item.id !== 'agua';
  const fotografia = JSON.stringify(s.cart);
  const esgotado = await handler.handleCartOrder(s, {
    source: 'meta',
    externalOrderId: 'invalido-esgotado',
    items: [{ productId: 'agua', quantity: 1, externalProductId: 'agua' }],
  }, send);
  cardapio.disponivel = disponibilidadeOriginal;
  checar(esgotado.status === 'rejected', 'produto esgotado: lote recusado');
  checar(JSON.stringify(s.cart) === fotografia, 'produto esgotado: carrinho intacto');
```

- [ ] **Step 2: Rodar a suíte e confirmar que o handler ainda espera snake_case**

Run: `node test/catalogordertest.js`

Expected: FAIL porque `handleCartOrder` ainda recebe `product_retailer_id` e limita quantidade em vez de rejeitar o lote.

- [ ] **Step 3: Adicionar os IDs externos à sessão e preservá-los no reset**

```js
// em createSession
catalogOrderIds: [],

// dentro do Object.assign de reset
catalogOrderIds: [...(previous.catalogOrderIds || [])].slice(-20),
```

- [ ] **Step 4: Substituir a mutação progressiva por validar primeiro e aplicar depois**

```js
const QTD_MAX = 99;
const QTD_TOTAL_MAX = 200;

function validarPedido(order) {
  if (!['baileys', 'meta'].includes(order?.source)) {
    return { ok: false, erro: 'origem_invalida', produtos: [] };
  }
  if (!String(order.externalOrderId || '').trim() || !Array.isArray(order.items) || !order.items.length) {
    return { ok: false, erro: 'pedido_vazio', produtos: [] };
  }

  let total = 0;
  const linhas = [];
  for (const entry of order.items) {
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > QTD_MAX) {
      return { ok: false, erro: 'quantidade_invalida', produtos: [entry.externalProductId] };
    }
    total += quantity;
    if (total > QTD_TOTAL_MAX) {
      return { ok: false, erro: 'quantidade_total', produtos: [] };
    }

    const item = cardapio.itemById(entry.productId);
    if (!item) return { ok: false, erro: 'produto_desconhecido', produtos: [entry.productId] };
    if (!cardapio.disponivel(item)) {
      return { ok: false, erro: 'produto_esgotado', produtos: [cardapio.nome(item, 'pt')] };
    }
    linhas.push({ item, quantity });
  }
  return { ok: true, linhas };
}
```

Somente depois de `validarPedido(order).ok` iterar pelas linhas, somar por ID base e registrar `externalOrderId`:

```js
function aplicarLinhas(sess, linhas, lang) {
  for (const { item, quantity } of linhas) {
    const existing = sess.cart.find((line) => line.id === item.id);
    if (existing) {
      existing.qty += quantity;
      continue;
    }
    sess.cart.push({
      id: item.id,
      productId: item.id,
      name: cardapio.nome(item, lang),
      nomeCozinha: cardapio.nomeCozinha(item),
      choicesCozinha: [],
      removed: [],
      added: [],
      qty: quantity,
      price: item.price,
    });
  }
}
```

- [ ] **Step 5: Responder recusas por chaves públicas conhecidas**

Importar `publicErrorKey` da Task 2 e responder antes de sair, sem mostrar IDs internos quando `order.source === 'meta'`:

```js
const { publicErrorKey } = require('../catalog/adapters');

async function responderRecusa(sess, order, validacao, send) {
  const mostrarProdutos = order.source === 'baileys';
  await send(t(
    sess.lang || DEFAULT_LANG,
    publicErrorKey(validacao.erro),
    { items: mostrarProdutos ? validacao.produtos.join(', ') : 'um item do carrinho' }
  ));
}
```

Adicionar aos três JSONs, com tradução equivalente:

```json
{
  "catalog_error_pedido_invalido": "Não consegui ler esse carrinho. Abra o catálogo e envie novamente.",
  "catalog_error_leitura_falhou": "Não consegui abrir o carrinho agora. Tente enviar novamente ou me diga o pedido por mensagem.",
  "catalog_error_produto_desconhecido": "Não reconheci no catálogo: {items}. O carrinho não foi adicionado; tente novamente ou me diga o pedido por mensagem.",
  "catalog_error_produto_ambiguo": "O nome {items} corresponde a mais de um produto e não vou adivinhar qual é. O carrinho não foi adicionado.",
  "catalog_error_quantidade_invalida": "A quantidade do carrinho não é válida. Nada foi adicionado; abra o catálogo e envie novamente.",
  "catalog_error_produto_esgotado": "Um produto desse carrinho está esgotado agora. Nada foi adicionado; escolha outro item no catálogo.",
  "catalog_duplicate": "Esse carrinho já está comigo. Seu pedido não foi duplicado."
}
```

Em `en.json`, usar:

```json
{
  "catalog_error_pedido_invalido": "I couldn't read this cart. Open the catalog and send it again.",
  "catalog_error_leitura_falhou": "I couldn't open the cart right now. Send it again or tell me your order in a message.",
  "catalog_error_produto_desconhecido": "I couldn't match this catalog product: {items}. Nothing was added; send it again or tell me your order.",
  "catalog_error_produto_ambiguo": "The name {items} matches more than one product, so I won't guess. The cart was not added.",
  "catalog_error_quantidade_invalida": "The cart quantity is invalid. Nothing was added; open the catalog and send it again.",
  "catalog_error_produto_esgotado": "A product in this cart is sold out right now. Nothing was added; choose another item.",
  "catalog_duplicate": "I already have this cart. Your order was not duplicated."
}
```

Em `es.json`, usar:

```json
{
  "catalog_error_pedido_invalido": "No pude leer este carrito. Abre el catálogo y envíalo otra vez.",
  "catalog_error_leitura_falhou": "No pude abrir el carrito ahora. Envíalo otra vez o dime tu pedido por mensaje.",
  "catalog_error_produto_desconhecido": "No pude reconocer este producto del catálogo: {items}. No agregué nada; envíalo otra vez o dime tu pedido.",
  "catalog_error_produto_ambiguo": "El nombre {items} coincide con más de un producto y no voy a adivinar. No agregué el carrito.",
  "catalog_error_quantidade_invalida": "La cantidad del carrito no es válida. No agregué nada; abre el catálogo y envíalo otra vez.",
  "catalog_error_produto_esgotado": "Un producto de este carrito está agotado ahora. No agregué nada; elige otro producto.",
  "catalog_duplicate": "Ya tengo este carrito. Tu pedido no fue duplicado."
}
```

- [ ] **Step 6: Implementar idempotência antes de qualquer mensagem ou mutação**

```js
function jaRecebido(sess, externalOrderId) {
  return (sess.catalogOrderIds || []).includes(externalOrderId);
}

function marcarRecebido(sess, externalOrderId) {
  sess.catalogOrderIds = [...(sess.catalogOrderIds || []), externalOrderId].slice(-20);
}
```

Ao detectar repetição, responder com uma confirmação curta já traduzida e devolver `{ status: 'duplicate', session: sess }`. Registrar o ID somente após `aplicarLinhas` terminar.

- [ ] **Step 7: Preservar o alerta ao administrador sem tempestade de mensagens**

Generalizar o `fantasmasAvisados` existente para uma chave estável e sanitizada:

```js
const produtosAvisados = new Set();

async function avisarDono(erro, produtos) {
  const novos = produtos.filter((produto) => {
    const chave = `${erro}:${String(produto || '').slice(0, 120)}`;
    if (produtosAvisados.has(chave)) return false;
    produtosAvisados.add(chave);
    return true;
  });
  if (!novos.length) return;

  const admin = notify.dono();
  if (!admin) return;
  await notify.send(admin, require('../../texto').paraAdmin(
    `CATALOGO DIVERGENTE\n\nMotivo: ${erro}\n` +
    novos.map((produto) => `- ${produto}`).join('\n')
  ));
}
```

Chamar somente para `produto_desconhecido`, `produto_ambiguo` e `produto_esgotado`. O texto não inclui token, payload, nome do cliente nem telefone.

Exportar `avisarDono` junto de `handleCartOrder`, para o caminho Baileys também avisar quando a recusa acontecer no adaptador de nomes.

- [ ] **Step 8: Atualizar as suítes antigas para o contrato comum**

Substituir entradas como:

```js
[{ product_retailer_id: 'x_burger', quantity: 2 }]
```

por:

```js
{
  source: 'meta',
  externalOrderId: 'teste-x-burger-2',
  items: [{ productId: 'x_burger', quantity: 2, externalProductId: 'x_burger' }],
}
```

Usar um `externalOrderId` diferente em cada carrinho dentro da mesma suíte.

- [ ] **Step 9: Rodar as provas do domínio e toda a regressão**

Run: `node test/catalogordertest.js`

Expected: PASS para preço interno, atomicidade, limites, repetição e mesclagem.

Run: `npm test`

Expected: todas as suítes passam com o novo contrato.

- [ ] **Step 10: Versionar a ingestão atômica**

```powershell
git add -- src/bot/handlers/catalogorder.js src/bot/session.js src/i18n/pt.json src/i18n/en.json src/i18n/es.json test/catalogordertest.js test/carrinhotest.js test/enxutotest.js test/faqtest.js test/idiomatest.js
git commit -m "feat: aplica carrinho de catalogo com validacao atomica"
```

---

### Task 4: Ligar Baileys e Meta ao mesmo roteamento

**Files:**
- Modify: `src/bot/index.js`
- Modify: `src/bot/router.js`
- Modify: `src/api/webhooks/meta.js`
- Create: `test/catalogroutingtest.js`

**Interfaces:**
- `routeOrder(phone, catalogOrder, send)` substitui a assinatura baseada em `productItems`.
- Baileys chama `fromBaileys(sock, orderMessage)`.
- Meta chama `fromMeta(message)`.
- Erros externos são convertidos em mensagens por código, nunca por `err.message` bruto.

- [ ] **Step 1: Escrever uma suíte que entrega contratos equivalentes ao roteador**

```js
const path = require('path');
const fs = require('fs');
const PROJECT = path.resolve(__dirname, '..');
const { fromBaileys, fromMeta } = require(`${PROJECT}/src/bot/catalog/adapters`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

(async () => {
  const sock = {
    getOrderDetails: async () => ({
      products: [{ id: 'wa-1', name: 'X-Bacon', quantity: 1, price: 0.01 }],
      price: 0.01,
    }),
  };
  const b = await fromBaileys(sock, { orderId: 'b-1', token: Buffer.from('token') });
  const m = fromMeta({
    id: 'm-1',
    order: { product_items: [{ product_retailer_id: 'x_bacon', quantity: 1 }] },
  });
  checar(JSON.stringify(b.items) === JSON.stringify(m.items.map((i) => ({
    ...i,
    externalProductId: 'wa-1',
  }))), 'provedores produzem o mesmo produto e quantidade');

  const baileysSource = fs.readFileSync(`${PROJECT}/src/bot/index.js`, 'utf8');
  checar(
    baileysSource.indexOf('msg.message?.orderMessage') >= 0 &&
      baileysSource.indexOf('msg.message?.orderMessage') < baileysSource.indexOf('msg.message?.imageMessage'),
    'pedido do catálogo é tratado antes de imagem e texto'
  );

  const metaSource = fs.readFileSync(`${PROJECT}/src/api/webhooks/meta.js`, 'utf8');
  checar(
    /routeOrder\(phone,\s*fromMeta\(message\),\s*send\)/.test(metaSource),
    'webhook Meta usa o mesmo contrato antes do roteador'
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar a suíte e confirmar a ausência da ligação Baileys**

Run: `node test/catalogroutingtest.js`

Expected: FAIL na verificação de `orderMessage`, pois `src/bot/index.js` ainda ignora esse tipo.

- [ ] **Step 3: Alterar o roteador para receber o contrato normalizado**

```js
async function routeOrder(phone, catalogOrder, send) {
  return log.contexto({ phone }, () => rotearCarrinho(phone, catalogOrder, send));
}
```

Antes de reiniciar uma sessão em `PAYMENT_PENDING`, conferir se o ID externo já consta em `sess.catalogOrderIds`. Carrinho repetido mantém a sessão; ID novo chama `session.reset(phone)` e preserva os IDs recentes.

- [ ] **Step 4: Detectar o pedido Baileys antes de imagem e texto**

```js
const { fromBaileys, CatalogInputError, publicErrorKey } = require('./catalog/adapters');
const catalogorder = require('./handlers/catalogorder');

const orderMessage = msg.message?.orderMessage;
if (orderMessage) {
  try {
    const order = await fromBaileys(sock, orderMessage);
    await routeOrder(phone, order, send);
  } catch (err) {
    const code = err instanceof CatalogInputError ? err.code : 'leitura_falhou';
    log.warn(
      { evt: 'carrinho', phone, code, products: err.products || [] },
      'carrinho Baileys recusado'
    );
    if (['produto_desconhecido', 'produto_ambiguo'].includes(code)) {
      await catalogorder.avisarDono(code, err.products || []);
    }
    await send(t(
      session.get(phone).lang || 'pt',
      publicErrorKey(code),
      { items: (err.products || []).join(', ') }
    ));
  }
  continue;
}
```

Importar `routeOrder`, `t` e `session` no topo. Não passar `orderMessage`, `token` nem `err` inteiro ao logger.

- [ ] **Step 5: Converter a mensagem Meta antes do roteador**

```js
const { fromMeta, CatalogInputError, publicErrorKey } = require('../../bot/catalog/adapters');

if (message.type === 'order') {
  meta.markAsRead(message.id);
  try {
    await routeOrder(phone, fromMeta(message), send);
  } catch (err) {
    const code = err instanceof CatalogInputError ? err.code : 'leitura_falhou';
    log.warn({ evt: 'carrinho', phone, code, products: err.products || [] }, 'carrinho Meta recusado');
    await send(t(
      'pt',
      publicErrorKey(code),
      { items: (err.products || []).join(', ') }
    ));
  }
  return;
}
```

- [ ] **Step 6: Rodar as provas de roteamento, sigilo e regressão**

Run: `node test/catalogroutingtest.js`

Expected: PASS.

Run: `node test/segurancatest.js`

Expected: PASS.

Run: `npm test`

Expected: todas as suítes passam.

- [ ] **Step 7: Versionar a ligação dos provedores**

```powershell
git add -- src/bot/index.js src/bot/router.js src/api/webhooks/meta.js test/catalogroutingtest.js
git commit -m "feat: recebe catalogo nativo pelo Baileys"
```

---

### Task 5: Personalizar uma linha já existente no carrinho

**Files:**
- Modify: `src/ai/tools.js`
- Modify: `src/ai/agente.js`
- Modify: `src/bot/handlers/menu.js`
- Create: `test/personalizartest.js`
- Modify: `test/checkouttest.js`
- Modify: `test/memoriatest.js`

**Interfaces:**
- Produces tool: `personalizar_item({ item_id, quantidade?, remover?, acrescentar?, restaurar?, retirar_adicionais? })`.
- Cart metadata: `productId`, `removed`, `added` on every simple line produced by catalog or IA.
- On ambiguity: `{ resultado, bloqueiaFluxo: true }` without changing the cart.

- [ ] **Step 1: Escrever a suíte de alteração direta, divisão e ambiguidade**

```js
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

const send = async () => {};

(async () => {
  const s = session.get('15550000002');
  s.lang = 'pt';
  await tools.executar('adicionar_item', { item_id: 'x_bacon', quantidade: 2 }, s, send);

  const ambiguo = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', remover: ['cebola'] },
    s,
    send
  );
  checar(ambiguo.bloqueiaFluxo, 'pergunta quantas unidades quando há duas');
  checar(s.cart.length === 1 && s.cart[0].qty === 2, 'ambiguidade não altera nada');

  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, remover: ['cebola'], acrescentar: ['bacon'] },
    s,
    send
  );
  checar(s.cart.length === 2, 'divide uma unidade da linha base');
  const alterada = s.cart.find((line) => line.removed?.includes('cebola'));
  checar(alterada.qty === 1 && alterada.added.includes('bacon'), 'aplica os dois modificadores');
  checar(alterada.price > s.cart.find((line) => line.id === 'x_bacon').price, 'adicional aumenta preço');

  await tools.executar(
    'personalizar_item',
    { item_id: alterada.id, restaurar: ['cebola'], retirar_adicionais: ['bacon'] },
    s,
    send
  );
  checar(s.cart.length === 1 && s.cart[0].qty === 2, 'desfazer reúne linhas idênticas');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Adicionar ao mesmo teste:

```js
  const antesDoProibido = JSON.stringify(s.cart);
  const proibido = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, acrescentar: ['abacaxi'] },
    s,
    send
  );
  checar(/nao_acrescentavel|não consegui/i.test(proibido.resultado), 'recusa ingrediente proibido');
  checar(JSON.stringify(s.cart) === antesDoProibido, 'ingrediente proibido não altera o carrinho');

  const excesso = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 3, remover: ['cebola'] },
    s,
    send
  );
  checar(/quantidade/i.test(excesso.resultado), 'recusa mais unidades do que existem');

  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, remover: ['cebola'] },
    s,
    send
  );
  const semCebola = s.cart.find((line) => line.removed?.includes('cebola'));
  await tools.executar(
    'personalizar_item',
    { item_id: semCebola.id, acrescentar: ['bacon'] },
    s,
    send
  );
  const preservada = s.cart.find((line) =>
    line.removed?.includes('cebola') && line.added?.includes('bacon')
  );
  checar(Boolean(preservada), 'novo adicional preserva a retirada anterior');
```

- [ ] **Step 2: Rodar a suíte e confirmar que a ferramenta ainda não existe**

Run: `node test/personalizartest.js`

Expected: FAIL com `ferramenta desconhecida: personalizar_item`.

- [ ] **Step 3: Gravar metadados de produto e modificadores nas linhas novas**

Em `tools.adicionar`, criar a linha personalizada com os valores já devolvidos por `modifiers.validar`:

```js
{
  id: cartId,
  productId: item.id,
  name: rotulo,
  nomeCozinha: cardapio.nomeCozinha(item),
  choicesCozinha: modifiers.linhasCozinha({ removed: val.removed, added: val.added }),
  removed: [...val.removed],
  added: [...val.added],
  qty,
  price: precoUnit,
}
```

Em `menu.addSimpleItem`, a linha é sempre base e não usa `val`, `rotulo` ou `cartId`:

```js
session.cart.push({
  id: item.id,
  productId: item.id,
  name,
  nomeCozinha: nomeCozinha(item),
  choicesCozinha: [],
  removed: [],
  added: [],
  qty: 1,
  price: item.price,
});
```

Quando `addSimpleItem` encontrar uma linha antiga pelo ID base, preencher os metadados ausentes antes de aumentar `qty`, para que uma sessão aberta durante o deploy continue personalizável:

```js
existing.productId = existing.productId || item.id;
existing.choicesCozinha = existing.choicesCozinha || [];
existing.removed = existing.removed || [];
existing.added = existing.added || [];
existing.qty += 1;
```

Para linhas antigas sem `productId`, usar `String(line.id).split(':')[0]` apenas como compatibilidade durante a sessão.

- [ ] **Step 4: Declarar a ferramenta sem qualquer parâmetro de preço**

```js
{
  name: 'personalizar_item',
  description:
    'Altera um produto que JÁ está no carrinho. Não adiciona uma nova unidade. ' +
    'Se houver mais de uma unidade e o cliente não disser quantas, omita quantidade.',
  input_schema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'Id base ou id exato da linha no carrinho' },
      quantidade: { type: 'integer', minimum: 1, maximum: 20 },
      remover: { type: 'array', items: { type: 'string' } },
      acrescentar: { type: 'array', items: { type: 'string' } },
      restaurar: { type: 'array', items: { type: 'string' } },
      retirar_adicionais: { type: 'array', items: { type: 'string' } },
    },
    required: ['item_id'],
  },
}
```

- [ ] **Step 5: Implementar divisão e recomposição de linhas**

```js
function produtoDaLinha(line) {
  return line.productId || String(line.id || '').split(':')[0];
}

function unicos(lista) {
  return [...new Set((lista || []).map(String).filter(Boolean))];
}

function sem(lista, retirados) {
  const remover = new Set(unicos(retirados));
  return unicos(lista).filter((id) => !remover.has(id));
}

function juntarLinha(sess, nova) {
  const existente = sess.cart.find((line) => line.id === nova.id);
  if (existente) existente.qty += nova.qty;
  else sess.cart.push(nova);
}
```

`personalizar` deve selecionar primeiro uma linha por ID exato; se não houver, selecionar pelo `productId`. Se a soma das unidades compatíveis for maior que 1 e `quantidade` estiver ausente, devolver bloqueio. Calcular o estado desejado assim:

```js
const removed = unicos([
  ...sem(target.removed, args.restaurar),
  ...(args.remover || []),
]);
const added = unicos([
  ...sem(target.added, args.retirar_adicionais),
  ...(args.acrescentar || []),
]);
const val = modifiers.validar(item, { remover: removed, acrescentar: added });
```

Validar antes de diminuir a linha original. Depois, retirar `quantidade` da origem, criar a linha com `modifiers.cartId`, preço `item.price + val.extra` e chamar `juntarLinha`.

- [ ] **Step 6: Ligar a ferramenta ao executor e à ordem de chamadas**

```js
case 'personalizar_item':
  return personalizar(sess, args);
```

Em `src/ai/agente.js`, adicionar `personalizar_item: 0` à tabela de prioridade e listar a ferramenta no prompt como alteração de item existente. Manter `adicionar_item` somente para produto novo.

- [ ] **Step 7: Rodar as provas de personalização, memória e preço**

Run: `node test/personalizartest.js`

Expected: PASS.

Run: `node test/checkouttest.js`

Expected: PASS e nenhuma ferramenta aceita preço, taxa ou desconto.

Run: `node test/memoriatest.js`

Expected: PASS com quantidade e personalização preservadas no último pedido.

Run: `npm test`

Expected: todas as suítes passam.

- [ ] **Step 8: Versionar a personalização de linha**

```powershell
git add -- src/ai/tools.js src/ai/agente.js src/bot/handlers/menu.js test/personalizartest.js test/checkouttest.js test/memoriatest.js
git commit -m "feat: personaliza item existente do carrinho"
```

---

### Task 6: Continuar o carrinho pela IA com uma única chamada

**Files:**
- Modify: `src/ai/agente.js`
- Modify: `src/bot/handlers/catalogorder.js`
- Create: `test/catalogiaflowtest.js`

**Interfaces:**
- Produces: `agente.receberCarrinho(sess, send): Promise<boolean>`.
- `true`: IA enviou a próxima fala; `false`: handler chama `continueAfterCart` determinístico.
- Evento interno contém apenas itens já calculados e `tools.orientacao(sess)`; não contém preço externo.

- [ ] **Step 1: Escrever a suíte de uma chamada, ausência de upsell e fallback**

```js
process.env.AI_ENABLED = 'on';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

let chamadas = 0;
let entrada;
const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
require(providerPath);
require.cache[providerPath].exports = {
  habilitada: () => true,
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async (args) => {
      chamadas += 1;
      entrada = args;
      return { texto: 'Recebi seu X-Bacon. Vai ser entrega ou retirada?', chamadas: [], uso: {} };
    },
  }),
};

const session = require(`${PROJECT}/src/bot/session`);
delete require.cache[require.resolve(`${PROJECT}/src/ai/agente`)];
const agente = require(`${PROJECT}/src/ai/agente`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

(async () => {
  const s = session.get('15550000003');
  s.lang = 'pt';
  s.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  const saidas = [];
  const tratou = await agente.receberCarrinho(s, async (text) => saidas.push(text));
  checar(tratou && chamadas === 1, 'faz uma chamada quando basta perguntar o próximo dado');
  const conteudo = JSON.stringify(entrada.mensagens);
  checar(conteudo.includes('EVENTO_INTERNO_CARRINHO'), 'marca a origem interna');
  checar(!/quer retirar|quer acrescentar|bebida|upsell/i.test(saidas.join(' ')), 'não oferece alteração nem bebida');

  entrada = null;
  const conhecido = session.get('15550000004');
  Object.assign(conhecido, {
    lang: 'pt',
    name: 'Fernando',
    lastAddress: '6 Main St',
    lastCityId: 'everett',
    cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
  });
  const falasConhecido = [];
  await agente.receberCarrinho(conhecido, async (text) => falasConhecido.push(text));
  const contextoConhecido = JSON.stringify(entrada.mensagens);
  checar(contextoConhecido.includes('Fernando'), 'evento leva o nome já conhecido');
  checar(contextoConhecido.includes('6 Main St'), 'evento leva o endereço já conhecido');
  checar(!/qual.*nome|seu nome/i.test(falasConhecido.join(' ')), 'não pede o nome novamente');

  require.cache[providerPath].exports.get = () => ({
    conversar: async () => { throw new Error('indisponível'); },
  });
  const caiu = await agente.receberCarrinho(s, async () => {});
  checar(caiu === false, 'falha devolve controle ao checkout determinístico');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar a suíte e confirmar que a entrada interna ainda não existe**

Run: `node test/catalogiaflowtest.js`

Expected: FAIL porque `agente.receberCarrinho` ainda não foi exportado.

- [ ] **Step 3: Criar uma entrada interna sem executar atalhos de texto do cliente**

Alterar somente a assinatura e as três condições de atalho; o laço de custo e ferramentas abaixo delas permanece idêntico:

```diff
-async function conversar(sess, texto, send) {
+async function conversar(sess, texto, send, opcoes = {}) {
+  const interno = opcoes.interno === true;

-  tools.observarMensagem(sess, texto);
+  if (!interno) tools.observarMensagem(sess, texto);

-  if (await tools.confirmarEnderecoPendente(sess, texto, send)) return true;
+  if (!interno && await tools.confirmarEnderecoPendente(sess, texto, send)) return true;

-  if (escolheuEntregaConhecida(sess, texto)) {
+  if (!interno && escolheuEntregaConhecida(sess, texto)) {
```

Não executar `escolheuEntregaConhecida` para eventos internos.

- [ ] **Step 4: Gerar o evento somente com dados internos já validados**

```js
async function receberCarrinho(sess, send) {
  const itens = sess.cart
    .map((line) => `${line.qty}x ${line.name} ($${(line.qty * line.price).toFixed(2)})`)
    .join('; ');
  const evento =
    '[EVENTO_INTERNO_CARRINHO]\n' +
    `Carrinho validado pelo sistema: ${itens}.\n` +
    'Confirme em uma frase natural e siga apenas com o próximo dado obrigatório. ' +
    'Não pergunte se quer retirar ou acrescentar ingredientes. Não faça upsell.' +
    tools.orientacao(sess);
  return conversar(sess, evento, send, { interno: true });
}
```

Exportar `receberCarrinho`.

- [ ] **Step 5: Fazer o handler escolher IA ou checkout determinístico**

```js
const ia = require('../../ai/provider');
const agente = require('../../ai/agente');

async function continueAfterCart(sess, send) {
  if (ia.habilitada()) {
    const tratou = await agente.receberCarrinho(sess, send);
    if (tratou) return;
  }
  const carrinho = orderHandler.oQueFalta(sess)
    ? menuHandler.buildCartSummary(sess)
    : null;
  await orderHandler.startCheckout(sess, send, carrinho);
}
```

Chamar `continueAfterCart` somente depois de o lote inteiro ser aplicado e marcado como recebido.

- [ ] **Step 6: Reforçar no prompt cacheável o comportamento após catálogo**

Adicionar ao `systemPrompt`:

```text
- EVENTO_INTERNO_CARRINHO significa que produto e quantidade já estão no carrinho.
- Confirme naturalmente e peça somente o próximo dado obrigatório indicado pelo sistema.
- Não ofereça personalização, adicionais ou bebida. Se o cliente pedir uma alteração depois, use personalizar_item.
```

- [ ] **Step 7: Rodar a prova de fluxo, custo e regressão**

Run: `node test/catalogiaflowtest.js`

Expected: PASS com uma chamada e fallback.

Run: `node test/cachingtest.js`

Expected: PASS; o contexto do cliente continua nas mensagens e o system prompt continua cacheável.

Run: `npm test`

Expected: todas as suítes passam.

- [ ] **Step 8: Versionar a continuidade pela IA**

```powershell
git add -- src/ai/agente.js src/bot/handlers/catalogorder.js test/catalogiaflowtest.js
git commit -m "feat: continua carrinho do catalogo pela IA"
```

---

### Task 7: Medir o comportamento contra a Mistral real

**Files:**
- Create: `scripts/prova-catalogo.js`
- Modify: `package.json`

**Interfaces:**
- Command: `npm run prova-catalogo -- --repeticoes=10`.
- Exit code 0: todas as conversas aplicaram a personalização e não ofereceram ingredientes antes do pedido do cliente.
- Erro de API: execução marcada como inconclusiva, sem ser contado como erro lógico.

- [ ] **Step 1: Escrever o executor com sessão isolada por repetição**

```js
process.env.AI_ENABLED = 'on';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const session = require(`${PROJECT}/src/bot/session`);
const agente = require(`${PROJECT}/src/ai/agente`);

const arg = process.argv.find((value) => value.startsWith('--repeticoes='));
const repeticoes = Math.max(1, Number(arg?.split('=')[1] || 10));

async function umaRodada(indice) {
  const phone = `prova-catalogo-${Date.now()}-${indice}`;
  const sess = session.get(phone);
  sess.lang = 'pt';
  sess.cart = [{
    id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', nomeCozinha: 'X-Bacon',
    choicesCozinha: [], removed: [], added: [], qty: 1, price: 14,
  }];
  const falas = [];
  const send = async (text) => falas.push(text);

  await agente.receberCarrinho(sess, send);
  const primeira = falas.join(' ');
  if (/quer retirar|quer acrescentar|adicional|bebida/i.test(primeira)) {
    throw new Error('oferta não solicitada após catálogo');
  }

  await agente.conversar(sess, 'No X-Bacon, tire a cebola e acrescente bacon', send);
  const alterado = sess.cart.find((line) =>
    line.removed?.includes('cebola') && line.added?.includes('bacon')
  );
  if (!alterado) throw new Error('personalização não aplicada');
}

function erroExterno(err) {
  return /rate.?limit|timeout|timed out|indispon.vel|network|fetch failed|429|503/i
    .test(String(err?.message || err));
}

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let passou = 0;
  let falhou = 0;
  let inconclusivo = 0;

  for (let i = 1; i <= repeticoes; i += 1) {
    try {
      await umaRodada(i);
      passou += 1;
      console.log(`PASSOU ${i}/${repeticoes}`);
    } catch (err) {
      if (erroExterno(err)) {
        inconclusivo += 1;
        console.log(`INCONCLUSIVO ${i}/${repeticoes}: ${err.message}`);
      } else {
        falhou += 1;
        console.error(`FALHOU ${i}/${repeticoes}: ${err.message}`);
      }
    }
    if (i < repeticoes) await pausa(1100);
  }

  console.log({ passou, falhou, inconclusivo });
  if (falhou) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

O script não importa `db/queries`, não chama `finalizar_pedido` e usa apenas telefones sintéticos, portanto não grava pedido, cliente ou pagamento.

- [ ] **Step 2: Adicionar o comando explícito, fora do `npm test`**

```json
"prova-catalogo": "node scripts/prova-catalogo.js"
```

- [ ] **Step 3: Rodar primeiro uma repetição para validar o executor**

Run: `npm run prova-catalogo -- --repeticoes=1`

Expected: uma execução PASS ou INCONCLUSIVA por erro externo; nunca grava pedido, cliente ou pagamento no Supabase.

- [ ] **Step 4: Rodar dez repetições com prompt caching ativo**

Run: `npm run prova-catalogo -- --repeticoes=10`

Expected: 10 PASS lógicos; chamadas externas indisponíveis aparecem separadas como inconclusivas. Qualquer falha lógica deve imprimir a fala e o estado do carrinho sem telefone real ou segredo.

- [ ] **Step 5: Rodar novamente a suíte determinística**

Run: `npm test`

Expected: todas as suítes passam sem chamar a Mistral, pois `test/run.js` mantém `AI_ENABLED=off`.

- [ ] **Step 6: Versionar a prova real reproduzível**

```powershell
git add -- scripts/prova-catalogo.js package.json
git commit -m "test: mede fluxo real do catalogo na Mistral"
```

---

### Task 8: Documentar operação e migração para a Meta

**Files:**
- Create: `docs/MIGRACAO-BAILEYS-META.md`
- Modify: `docs/OPERACAO.md`
- Modify: `docs/CARDAPIO-CONVERSA.md`

**Interfaces:**
- Manual operacional sem segredos reais.
- Convenção atual: nome português único no WhatsApp Business.
- Convenção Meta futura: `product_retailer_id` igual ao `item.id` interno.

- [ ] **Step 1: Escrever o manual de cadastro atual no WhatsApp Business**

Incluir esta sequência exata em `docs/OPERACAO.md`:

```markdown
## Produtos no catálogo enquanto o bot usa Baileys

1. Abra WhatsApp Business → Ferramentas comerciais → Catálogo.
2. Cadastre foto, nome, descrição e preço do produto.
3. Copie no nome exatamente o nome em português mostrado no painel da Point Burger.
4. Envie um carrinho de teste para o próprio número.
5. Confira o resumo do bot: o valor cobrado pelo sistema é o do painel, mesmo que o catálogo esteja desatualizado.

Se aparecer “produto ainda não está ligado ao cardápio”, compare o nome do catálogo com o painel. Não altere IDs, banco ou variáveis do Railway para corrigir um nome.
```

- [ ] **Step 2: Escrever `MIGRACAO-BAILEYS-META.md` com preparação, virada e retorno**

O documento deve conter as seções completas:

```markdown
# Migração do Baileys para a API oficial da Meta

## Pré-requisitos
## Coexistência com o WhatsApp Business
## Catálogo no Commerce Manager
## Convenção de product_retailer_id
## Variáveis do Railway
## Webhook e assinatura
## Teste em número de homologação
## Virada de WHATSAPP_PROVIDER
## Validação de texto, carrinho e comprovante
## Desativação segura do volume Baileys
## Retorno imediato para Baileys
```

Na seção de variáveis, listar somente nomes: `WHATSAPP_PROVIDER`, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_CATALOG_ID`. Explicar onde cada valor é obtido sem escrever valores reais.

- [ ] **Step 3: Atualizar a descrição antiga do cardápio conversacional**

Em `docs/CARDAPIO-CONVERSA.md`, marcar o fluxo de página/lista interna como histórico e apontar para o catálogo nativo. Registrar claramente:

```markdown
O cliente escolhe produto e quantidade no catálogo nativo. O bot não pergunta se deseja alterar ingredientes. Se o cliente escrever uma alteração, a IA usa `personalizar_item`; retirada não muda o preço e adicional é calculado pelo painel.
```

- [ ] **Step 4: Conferir documentação e suíte completa**

Run: `rg -n "PREENCHER|FAZER DEPOIS|token-que-nao-pode-vazar" docs/MIGRACAO-BAILEYS-META.md docs/OPERACAO.md docs/CARDAPIO-CONVERSA.md`

Expected: nenhuma ocorrência.

Run: `npm test`

Expected: todas as suítes passam.

Run: `git diff --check`

Expected: nenhuma linha com erro de espaço ou fim de linha.

- [ ] **Step 5: Versionar os manuais**

```powershell
git add -- docs/MIGRACAO-BAILEYS-META.md docs/OPERACAO.md docs/CARDAPIO-CONVERSA.md
git commit -m "docs: orienta catalogo atual e migracao para Meta"
```

---

## Verificação final e entrega

- [ ] Rodar `npm test` e registrar a quantidade total de suítes aprovadas.
- [ ] Rodar `npm run prova-catalogo -- --repeticoes=10` e separar falhas lógicas de indisponibilidade externa.
- [ ] Rodar `git diff --check`.
- [ ] Conferir `git status --short` e garantir que `.claude/`, `.codex/`, `projeto.zip` e `savo.29-08-zip` não entraram em nenhum commit.
- [ ] Revisar os commits com `git log --oneline -8`.
- [ ] Fazer push somente depois de todas as provas determinísticas passarem.
- [ ] No Railway, acompanhar o primeiro boot sem exibir token do carrinho e confirmar `WhatsApp conectado`.
- [ ] Enviar um carrinho real pelo catálogo, recusar ou solicitar uma personalização e chegar ao resumo sem pergunta automática de ingredientes.
- [ ] Não configurar a impressora nem substituir os dados de Zelle de teste nesta entrega; esses dados reais continuam pendentes por decisão do proprietário.
