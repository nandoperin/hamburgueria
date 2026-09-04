process.env.LOG_LEVEL = 'silent';
const assert = require('node:assert/strict');
const imp = require('../src/services/catalogo-importacao');
const itens = require('../config/menu.json').categories.flatMap(category =>
  category.items.map(item => ({ ...item, category: { id: category.id } })));
const imagem = { original: 'https://mmg.whatsapp.net/test.jpg' };
const registro = (item, id) => ({
  id: String(id), retailerId: item.id, name: item.name.pt, price: item.price * 1000,
  currency: 'USD', description: item.description.pt, isHidden: false,
  imageUrls: imagem, reviewStatus: { whatsapp: 'approved' },
});
function fake() {
  const estado = { produtos: [registro(itens[0], 1), registro(itens[2], 2), {
    ...registro(itens[0], 3), retailerId: '', name: 'Antigo de teste',
  }], eventos: [], serial: 10, avisos: [] };
  const api = {
    getCatalog: async ({cursor}) => {
      const inicio = Number(cursor || 0);
      const products = structuredClone(estado.produtos.slice(inicio, inicio + 8));
      return { products, nextPageCursor: inicio + 8 < estado.produtos.length ? String(inicio + 8) : undefined };
    },
    productCreate: async dados => {
      estado.eventos.push('create');
      const p = { ...dados, id: String(++estado.serial), imageUrls: imagem, reviewStatus: { whatsapp: 'approved' } };
      estado.produtos.push(p);
      return structuredClone(p);
    },
    productUpdate: async (id, dados) => {
      estado.eventos.push('update');
      const p = estado.produtos.find(p => p.id === id);
      Object.assign(p, dados);
      return structuredClone(p);
    },
    productDelete: async ids => {
      estado.eventos.push('delete');
      estado.produtos = estado.produtos.filter(p => !ids.includes(p.id));
      return { deleted: ids.length };
    },
  };
  const args = { api, itens, salvar: async dados => {
    assert.equal(dados.produtos.length, estado.produtos.length);
    estado.eventos.push('backup');
  }, avisar: async texto => estado.avisos.push(texto), pausa: async () => {} };
  return { estado, api, args };
}

(async () => {
  const f = fake();
  const resultado = await imp.executar(f.args);
  assert.match(resultado, /28 produtos/);
  assert.equal(f.estado.produtos.length, 28);
  assert.equal(f.estado.eventos[0], 'backup');
  assert.equal(f.estado.eventos.at(-1), 'delete');
  for (const item of itens) {
    const p = f.estado.produtos.find(p => p.retailerId === item.id);
    assert.equal(p.price, Math.round(item.price * 1000));
    assert.ok(p.description.startsWith(item.description.pt));
    assert.ok(p.imageUrls.original);
  }
  assert.equal(f.estado.produtos.find(p => p.id === '1').imageUrls.original, imagem.original);
  assert.match(f.estado.produtos.find(p => p.retailerId === itens[1].id).description, /ilustrativa/);
  f.estado.eventos = [];
  await imp.executar(f.args);
  assert.deepEqual(f.estado.eventos, ['backup'], 'repeticao nao recria, reedita ou apaga');

  const semBackup = fake();
  semBackup.args.salvar = async () => { throw new Error('disco indisponivel'); };
  await assert.rejects(imp.executar(semBackup.args), /disco/);
  assert.equal(semBackup.estado.eventos.length, 0);

  const preco = fake();
  preco.estado.produtos[1].price = 999;
  await assert.rejects(imp.executar(preco.args), /catalogo conferir/);
  assert.equal(preco.estado.eventos.length, 0);
  assert.equal(imp.foto({ imageUrls: { original: 'https://mmg.whatsapp.net.evil.test/x' } }), null);
  assert.equal(imp.foto({ imageUrls: { original: 'http://mmg.whatsapp.net/x' } }), null);
  assert.equal(imp.foto({ imageUrls: { original: 'https://user:pass@mmg.whatsapp.net/x' } }), null);
  const fotos = fake();
  fotos.estado.produtos.forEach(p => { p.imageUrls = {}; });
  await assert.rejects(imp.executar(fotos.args), /foto reutilizavel/);
  assert.equal(fotos.estado.eventos.length, 0);

  const falha = fake();
  const criar = falha.api.productCreate;
  falha.api.productCreate = async dados => {
    await criar(dados);
    throw new Error('timeout apos criar');
  };
  await assert.rejects(imp.executar(falha.args), /timeout/);
  assert.ok(!falha.estado.eventos.includes('delete'));
  assert.equal(falha.estado.eventos.filter(e => e === 'create').length, 1);
  falha.api.productCreate = criar;
  await imp.executar(falha.args);
  assert.equal(falha.estado.produtos.length, 28, 'retomada sem duplicacao');

  const divergente = fake();
  divergente.api.productCreate = async dados => ({ ...await fake().api.productCreate(dados), price: 1 });
  await assert.rejects(imp.executar(divergente.args), /nao confirmou/);
  assert.ok(!divergente.estado.eventos.includes('delete'));

  const editado = fake();
  editado.args.avisar = async texto => {
    if (texto.startsWith('28/28')) editado.estado.produtos.find(p => p.id === '3').price++;
  };
  await assert.rejects(imp.executar(editado.args), /editado durante/);
  assert.ok(!editado.estado.eventos.includes('delete'));

  await assert.rejects(imp.listar({ getCatalog: async () => ({ products: [], nextPageCursor: 'mesmo' }) }), /Paginacao repetida/);
  process.env.ADMIN_PHONE = '15555555555';
  imp.registrar({ online: () => true, phone: () => '15555555556' });
  await assert.rejects(imp.importar('5555555555', '15555555556', async () => {}), /ADMIN_PHONE completo/);
  await assert.rejects(imp.importar('15555555555', '15555555557', async () => {}), /Numero informado/);
  imp.registrar({ online: () => false });
  await assert.rejects(imp.importar('15555555555', '15555555556', async () => {}), /desconectado/);

  // Catálogo de teste não precisa compartilhar nomes/preços com o cardápio novo.
  for (const escala of [1, 100, 1000]) {
    const antigo = fake();
    antigo.estado.produtos = [{ ...registro(itens[0], 1),
      name: 'Produto de teste antigo', retailerId: '', price: 13.5 * escala }];
    antigo.args.referencia = { id: '1', name: 'Produto de teste antigo', price: 13.5 * escala, valor: '13,50' };
    await imp.executar(antigo.args);
    assert.equal(antigo.estado.produtos.length, 28);
    assert.equal(antigo.estado.produtos.find(p => p.retailerId === itens[0].id).price, itens[0].price * escala);
  }
  const referencia = { id: '1', name: itens[0].name.pt, price: 12000, valor: '12.00' };
  assert.equal(imp.escalaConfirmada([registro(itens[0], 1)], referencia), 1000);
  assert.throws(() => imp.escalaConfirmada([registro(itens[0], 1)], { ...referencia, valor: '0.00' }), /invalido/);
  assert.throws(() => imp.escalaConfirmada([registro(itens[0], 1)], { ...referencia, valor: '17.00' }), /nao corresponde/);
  assert.throws(() => imp.escalaConfirmada([{ ...registro(itens[0], 1), price: 13000 }], referencia), /mudou/);
  assert.throws(() => imp.escalaConfirmada([{ ...registro(itens[0], 1), currency: 'BRL' }], referencia), /mudou/);

  const leitura = fake();
  leitura.api.online = () => true;
  leitura.api.phone = () => '15555555556';
  imp.registrar(leitura.api);
  await assert.rejects(imp.conferir('5555555555'), /ADMIN_PHONE completo/);
  const aviso = await imp.conferir('15555555555');
  assert.match(aviso, /referencia 1 preco VALOR/);
  assert.match(aviso, /preco ATUAL/);
  assert.ok(!aviso.includes('whatsapp.net'), 'conferencia nao expoe URL de foto');
  assert.equal(leitura.estado.eventos.length, 0, 'conferencia somente leitura');
  await assert.rejects(imp.importar('15555555555', '15555555556', async () => {}, { id: '999', valor: '12.00' }), /Escolha/);
  // Reinício/troca de conexão exige nova conferência, não usa fotografia antiga.
  imp.registrar({ ...leitura.api });
  await assert.rejects(imp.importar('15555555555', '15555555556', async () => {}, { id: '1', valor: '12.00' }), /conferir antes/);

  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
  const admin = require('../src/bot/handlers/admin');
  let argumentos;
  imp.conferir = async phone => { argumentos = [phone]; return 'Somente leitura'; };
  imp.importar = async (phone, bot, _send, ref) => { argumentos = [phone, bot, ref]; return 'Importado'; };
  const enviar = async () => {};
  await admin.handle('15555555555', '!catalogo conferir', enviar);
  assert.deepEqual(argumentos, ['15555555555']);
  await admin.handle('15555555555', '!importar catalogo 15555555556 referencia 1 preco 13,50', enviar);
  assert.deepEqual(argumentos, ['15555555555', '15555555556', { id: '1', valor: '13,50' }]);
  await admin.handle('15555555555', '!importar catalogo 15555555556', enviar);
  assert.deepEqual(argumentos, ['15555555555', '15555555556', undefined]);
  argumentos = null;
  assert.equal(await admin.handle('15555555557', '!catalogo conferir', enviar), false);
  assert.equal(argumentos, null);
  console.log('Importacao: ingredientes, precos, fotos, paginacao, retomada, copia e guardas conferidos.');
})().catch(err => { console.error(err); process.exitCode = 1; });
