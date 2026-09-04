process.env.LOG_LEVEL = 'silent';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.ADMIN_PHONE = '15555555555';
const assert = require('node:assert/strict');
const { criarLeituraColecoes } = require('../src/bot/catalog/leitura-colecoes');
const imp = require('../src/services/catalogo-importacao');
const node = (tag, content = [], attrs = {}) => ({ tag, attrs, content });
const campo = (tag, value) => node(tag, Buffer.from(String(value)));
const produto = id => node('product', [campo('id', id), campo('name', 'X Burger'),
  campo('price', '12000'), campo('currency', 'USD')]);
const colecao = id => node('collection', [campo('id', id), campo('name', 'Lanches'), produto('1')]);
const dados = node('iq', [node('collections', [colecao('10'), colecao('11')])], { type: 'result' });

(async () => {
  let chamadas = 0;
  const logs = [];
  const socket = { query: async (q, timeout) => {
    chamadas++;
    assert.equal(timeout, 60000);
    assert.equal(q.attrs.type, 'get');
    assert.equal(q.attrs.smax_id, '35');
    assert.equal(q.content[0].tag, 'collections');
    assert.equal(q.content[0].attrs.biz_jid, '15555555556@s.whatsapp.net');
    return dados;
  } };
  const lerColecoes = criarLeituraColecoes({ socket, phone: () => '15555555556', registrar: d => logs.push(d) });
  const r = await lerColecoes();
  assert.equal(r.code, 'colecoes_lidas');
  assert.equal(r.colecoes.length, 2);
  assert.equal(r.produtos.length, 1, 'produto repetido em duas colecoes conta uma vez');
  assert.equal(r.parcial, true);
  assert.equal(chamadas, 1);
  assert.ok(!JSON.stringify(logs).includes('15555555556'));
  assert.ok(!JSON.stringify(logs).includes('X Burger'));

  imp.registrar({ online: () => true, phone: () => '15555555556', lerColecoes,
    getCatalog: () => { throw new Error('Nao deve consultar catalogo geral'); },
    productCreate: () => { throw new Error('Nao deve escrever'); },
    productUpdate: () => { throw new Error('Nao deve escrever'); },
    productDelete: () => { throw new Error('Nao deve escrever'); },
  });
  const admin = require('../src/bot/handlers/admin');
  const saidas = [];
  await admin.handle('15555555555', '!catalogo colecoes', async msg => saidas.push(msg));
  assert.equal(saidas.length, 2);
  assert.match(saidas[0], /1 minuto/);
  assert.match(saidas[1], /Colecoes: 2/);
  assert.match(saidas[1], /Produtos distintos encontrados: 1/);
  assert.match(saidas[1], /nada foi importado ou apagado/);
  chamadas = 0;
  assert.equal(await admin.handle('15555555557', '!catalogo colecoes', async () => {}), false);
  await assert.rejects(imp.conferirColecoes('5555555555', async () => {}), /ADMIN_PHONE completo/);
  assert.equal(chamadas, 0);

  socket.query = async () => { throw Object.assign(new Error('url?token=SECRETO'), { output: { statusCode: 408 } }); };
  assert.match(await imp.conferirColecoes('15555555555', async () => {}), /colecoes_timeout; status: 408/);
  assert.ok(!JSON.stringify(logs).includes('SECRETO'));
  socket.query = async () => undefined;
  assert.equal((await lerColecoes()).code, 'colecoes_sem_resposta');
  socket.query = async () => node('iq', []);
  assert.equal((await lerColecoes()).code, 'colecoes_estrutura_inesperada');
  socket.query = async () => node('iq', [node('collections', [node('novo_formato')])]);
  assert.equal((await lerColecoes()).code, 'colecoes_estrutura_inesperada');
  socket.query = async () => node('iq', [node('collections')]);
  assert.equal((await lerColecoes()).produtos.length, 0);

  let liberar;
  socket.query = async () => new Promise(resolve => { liberar = resolve; });
  const pendente = imp.conferirColecoes('15555555555', async () => {});
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(imp.conferirColecoes('15555555555', async () => {}), /andamento/);
  liberar(dados);
  await pendente;
  console.log('Colecoes: consulta independente, timeout, vazio, parsing, deduplicacao, autorizacao e nenhuma escrita.');
})().catch(err => { console.error(err); process.exitCode = 1; });
