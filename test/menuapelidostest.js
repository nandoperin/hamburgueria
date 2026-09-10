/**
 * Apelidos do cardápio em produção.
 *
 * O bug que isto trava: o cardápio vigente vem do banco, semeado antes de
 * `aliases` existir no arquivo, e o painel reescreve o documento inteiro sem
 * conhecer o campo. Em produção nenhum item tinha apelido, "coca" sozinho
 * batia na trava anti-invenção de `adicionar_item` e o bot dizia "não
 * entendi" — enquanto o mesmo teste passava localmente lendo o arquivo.
 *
 * Duas defesas, testadas separadas:
 *   1. a migração leva os apelidos do arquivo para o documento do banco
 *      (sem sobrescrever o que o dono editou pelo painel);
 *   2. mesmo SEM apelido nenhum, a trava aceita um prefixo curto do nome
 *      ("coca" → "coca cola"), para um item novo cadastrado pelo painel não
 *      voltar ao "não entendi".
 */
const assert = require('assert/strict');

process.env.AI_ENABLED = 'off';

// O banco devolve o cardápio do arquivo COM os apelidos apagados — o estado
// real de produção — e um item cujo apelido o dono editou pelo painel.
const doArquivo = JSON.parse(JSON.stringify(require('../config/menu.json')));
for (const cat of doArquivo.categories) {
  for (const item of cat.items) {
    delete item.aliases;
    if (item.id === 'coca_cola') item.aliases = ['refri'];
  }
}

const dbPath = require.resolve('../src/db/queries');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    getConfigDocs: async () => [{ key: 'menu', doc: doArquivo }],
    setConfigDoc: async () => {},
    registrarHistoricoConfig: async () => {},
  },
};

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const config = require('../src/services/config');
  assert.equal(await config.recarregar(), true);
  checar(config.veioDoBanco('menu'), 'o cardápio em uso é o do banco, não o arquivo');

  const menu = config.get('menu');
  const item = (id) => menu.categories.flatMap((c) => c.items).find((i) => i.id === id);

  assert.deepEqual(item('macarrao_chapa').aliases, ['macarrao']);
  checar(true, 'apelido do arquivo entra no item do banco que não tinha nenhum (macarrao)');
  assert.deepEqual(item('guarana').aliases, ['guarana']);
  checar(true, 'idem para guarana');
  assert.deepEqual(item('coca_cola').aliases, ['refri']);
  checar(true, 'apelido editado pelo painel prevalece sobre o do arquivo');

  // ---------------------------------------------- 2. a trava sem apelido
  const tools = require('../src/ai/tools');
  const cardapio = require('../src/services/cardapio');
  const session = require('../src/bot/session');

  const original = cardapio.itemById;
  cardapio.itemById = (id) => {
    const real = original(id);
    if (!real) return real;
    const { aliases, ...semApelido } = real;
    return semApelido;
  };
  try {
    const sess = session.get('15550000777');
    sess.lang = 'pt';
    sess.state = 'MENU';
    const r = await tools.executar(
      'adicionar_item', { item_id: 'coca_cola', quantidade: 1 }, sess, async () => {}, { textoCliente: 'coca' }
    );
    checar(!r.bloqueiaFluxo && /Adicionado/.test(r.resultado),
      '"coca" passa na trava anti-invenção mesmo com o item sem apelido (prefixo de "coca cola")');
    checar(sess.cart.some((l) => l.productId === 'coca_cola'), 'e a Coca entra no carrinho');

    const s2 = session.get('15550000778');
    s2.lang = 'pt';
    s2.state = 'MENU';
    const r2 = await tools.executar(
      'adicionar_item', { item_id: 'coca_cola', quantidade: 1 }, s2, async () => {}, { textoCliente: 'sim' }
    );
    checar(r2.bloqueiaFluxo === true, '"sim" sozinho continua bloqueado — a trava não ficou frouxa');
  } finally {
    cardapio.itemById = original;
    session.clear('15550000777');
    session.clear('15550000778');
  }

  const erros = config.validar('menu', {
    categories: [{ id: 'x', name: { pt: 'X' }, items: [{ id: 'a', name: { pt: 'A' }, price: 1, aliases: 'coca' }] }],
  });
  checar(erros.some((e) => /apelidos/.test(e)), 'painel não consegue gravar apelido fora do formato de lista');

  console.log('\n\x1b[32mmenuapelidostest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
