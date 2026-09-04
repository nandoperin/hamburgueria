process.env.LOG_LEVEL = 'silent';
const assert = require('node:assert/strict');
const { criarLeitura, interpretar, estrutura } = require('../src/bot/catalog/leitura-business');
const imp = require('../src/services/catalogo-importacao');
const node = (tag, content = [], attrs = {}) => ({ tag, attrs, content });
const campo = (tag, valor) => node(tag, Buffer.from(String(valor)));
const produto = id => node('product', [campo('id', id), campo('name', 'Produto'),
  campo('description', 'pao, bife'), campo('price', 12000), campo('currency', 'USD'),
  campo('retailer_id', 'x_burger'), node('media', [node('image', [
    campo('original_image_url', 'https://mmg.whatsapp.net/foto?token=NAO_LOGAR'),
  ])]), node('status_info', [campo('status', 'APPROVED')])]);
const resposta = (produtos, cursor) => node('iq', [node('product_catalog', [
  ...produtos, ...(cursor ? [node('paging', [campo('after', cursor)])] : []),
])], { type: 'result' });

(async () => {
  assert.equal(interpretar(node('iq', [])).code, 'catalogo_estrutura_inesperada');
  assert.equal(interpretar(node('iq', [node('error')])).code, 'catalogo_estrutura_inesperada');
  assert.equal(interpretar(node('iq', [node('product_catalog', [node('products', [produto('1')])])])).code,
    'catalogo_estrutura_inesperada', 'envelope desconhecido nao vira lista vazia');
  assert.equal(interpretar(resposta([produto('1')])).resultado.products[0].price, 12000);
  assert.equal(interpretar(resposta([produto('1')])).resultado.products[0].description, 'pao, bife');
  assert.equal(interpretar(resposta([])).resultado.products.length, 0);
  assert.equal(interpretar(resposta([produto('1')]).content[0]).resultado.products.length, 1);

  let requisicoes = [];
  const diagnosticos = [];
  const socket = { query: async (q, timeout) => {
    requisicoes.push(q);
    assert.equal(timeout, 15000);
    assert.equal(q.attrs.type, 'get');
    assert.equal(q.content[0].attrs.jid, '15555555555@s.whatsapp.net');
    return requisicoes.length === 1 ? resposta([]) : resposta([produto('1')]);
  } };
  const ler = criarLeitura({ socket, phone: () => '15555555555', registrar: d => diagnosticos.push(d) });
  assert.equal((await ler({ limit: 100, jid: 'outro@lid' })).products.length, 1);
  assert.deepEqual(requisicoes.map(q => q.content[0].content[0].content.toString()), ['50', '10']);
  assert.ok(!JSON.stringify(diagnosticos).includes('NAO_LOGAR'));
  assert.ok(!JSON.stringify(diagnosticos).includes('15555555555'));
  assert.ok(!estrutura(resposta([produto('1')])).includes('whatsapp.net'));

  requisicoes = [];
  socket.query = async q => {
    requisicoes.push(q);
    const cursor = q.content[0].content.find(n => n.tag === 'after');
    return cursor ? resposta([produto('2')]) : resposta([produto('1')], 'proxima');
  };
  assert.deepEqual((await imp.listar({ getCatalog: ler })).map(p => p.id), ['1', '2']);
  assert.equal(requisicoes.length, 2);

  socket.query = async () => node('iq', [node('query', [campo('token', 'SECRETO')])]);
  socket.getCollections = async (jid, limit) => {
    assert.equal(jid, '15555555555@s.whatsapp.net');
    assert.equal(limit, 50);
    return { collections: [{ products: [{ id: '1' }, { id: '2' }] }, { products: [{ id: '1' }] }] };
  };
  await assert.rejects(ler(), /estrutura_inesperada.*colecoes retornaram 2 produtos/);
  assert.ok(!JSON.stringify(diagnosticos).includes('SECRETO'));
  let gravou = false;
  await assert.rejects(imp.executar({ api: { getCatalog: ler }, itens: [],
    salvar: async () => { gravou = true; }, avisar: async () => {},
  }), /estrutura_inesperada/);
  assert.equal(gravou, false, 'falha de leitura impede qualquer escrita');
  await assert.rejects(imp.executar({ api: { getCatalog: async () => ({ products: [] }) }, itens: [],
    salvar: async () => { gravou = true; }, avisar: async () => {},
  }), /Nao e um erro de preco/);
  assert.equal(gravou, false);

  socket.query = async () => { throw Object.assign(new Error('URL?token=SECRETO'), { output: { statusCode: 403 } }); };
  await assert.rejects(ler(), err => /catalogo_consulta_falhou/.test(err.message) && !err.message.includes('SECRETO'));
  assert.equal(diagnosticos.at(-1).status, 403);
  await assert.rejects(criarLeitura({ socket, phone: () => '123@lid' })(), /Numero da sessao/);
  await assert.rejects(ler({ cursor: {} }), /Cursor/);
  console.log('Leitura nativa, JID explicito, lotes, paginacao, diagnostico sem segredos e bloqueio antes de escrita conferidos.');
})().catch(err => { console.error(err); process.exitCode = 1; });
