const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const normalizar = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Apenas a conexão viva do bot registra esta capacidade. Não existe endpoint público.
let conexao = null;
let ocupado = false;
function registrar(api) { conexao = api; }

async function listar(api) {
  const produtos = new Map();
  const cursores = new Set();
  let cursor;
  for (let pagina = 0; pagina < 30; pagina++) {
    const resposta = await api.getCatalog({ limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(resposta?.products)) throw new Error('Catalogo retornou uma resposta incompleta.');
    for (const p of resposta.products) {
      if (!/^\d+$/.test(p.id)) throw new Error('Produto sem identificador valido.');
      produtos.set(p.id, p);
    }
    cursor = resposta.nextPageCursor;
    if (!cursor) return [...produtos.values()];
    if (cursores.has(cursor)) throw new Error('Paginacao repetida; nenhum item sera apagado.');
    cursores.add(cursor);
  }
  throw new Error('Catalogo excedeu o limite de leitura.');
}

function foto(produto) {
  for (const valor of [produto?.imageUrls?.original, produto?.imageUrls?.requested]) {
    try {
      const url = new URL(valor);
      // Só mídia devolvida pelo catálogo do WhatsApp. Nunca buscar URLs do menu/cliente.
      if (url.protocol === 'https:' && url.hostname.endsWith('.whatsapp.net') &&
          !url.username && !url.password && !url.port) return url.href;
    } catch { /* tentar a outra imagem */ }
  }
  return null;
}

function preparar(itens, existentes) {
  if (itens.length !== 28 || new Set(itens.map(i => i.id)).size !== 28) {
    throw new Error('Esta importacao de teste exige os 28 produtos do cardapio aprovado.');
  }
  const usados = new Set();
  const linhas = itens.map(item => {
    if (!item.id || !item.name?.pt || !item.description?.pt ||
        !Number.isFinite(item.price) || item.price <= 0 ||
        !Number.isSafeInteger(Math.round(item.price * 1000))) {
      throw new Error('Produto com nome, ingredientes ou preco invalido.');
    }
    const candidatos = existentes.filter(p => !usados.has(p.id) &&
      (p.retailerId === item.id || normalizar(p.name) === normalizar(item.name.pt)));
    candidatos.sort((a, b) => Number(b.retailerId === item.id) - Number(a.retailerId === item.id) ||
      Number(Boolean(foto(b))) - Number(Boolean(foto(a))) || a.id.localeCompare(b.id));
    const atual = candidatos[0];
    if (atual) usados.add(atual.id);
    return { item, atual };
  });

  // O SDK serializa price sem converter. Calibrar com pelo menos dois produtos
  // conhecidos de preços distintos, sem assumir unidade monetária do protocolo.
  const referencias = linhas.filter(l => l.atual?.currency === 'USD');
  const escalas = [1, 100, 1000].filter(escala => referencias.length >= 2 &&
    new Set(referencias.map(l => l.item.price)).size >= 2 &&
    referencias.every(l => Number(l.atual.price) === Math.round(l.item.price * escala)));
  if (escalas.length !== 1) {
    throw new Error('Nao foi possivel conferir a unidade dos precos com o catalogo atual. Nenhuma alteracao realizada. Envie esta mensagem ao responsavel tecnico.');
  }
  const escala = escalas[0];
  for (const linha of linhas) {
    const { item, atual } = linha;
    const mesmaCategoria = linhas.find(l => l.item.category?.id === item.category?.id && foto(l.atual));
    const imagem = foto(atual) || foto(mesmaCategoria?.atual) || existentes.map(foto).find(Boolean);
    if (!imagem) throw new Error(`Nao ha foto reutilizavel para ${item.name.pt}. Nenhuma alteracao realizada.`);
    linha.imagem = imagem;
    linha.ilustrativa = !foto(atual) || Boolean(atual?.description?.includes('Imagem ilustrativa do catalogo de teste.'));
    linha.dados = {
      name: item.name.pt,
      description: item.description.pt + (linha.ilustrativa ? '\nImagem ilustrativa do catalogo de teste.' : ''),
      retailerId: item.id,
      price: Math.round(item.price * escala),
      currency: 'USD',
      isHidden: item.available === false,
    };
  }
  return { linhas, remover: existentes.filter(p => !usados.has(p.id)) };
}

function confere(produto, dados) {
  return produto && ['name', 'description', 'retailerId', 'price', 'currency', 'isHidden']
    .every(k => produto[k] === dados[k]) && !/reject/i.test(produto.reviewStatus?.whatsapp || '');
}

async function executar({ api, itens, salvar, avisar, pausa = () => new Promise(r => setTimeout(r, 800)) }) {
  const antigos = await listar(api);
  const plano = preparar(itens, antigos);
  // Se a cópia falhar, nenhuma escrita remota é iniciada.
  await salvar({ criadoEm: new Date().toISOString(), produtos: antigos, menu: itens });
  await avisar(`Importando ${plano.linhas.length} produtos com ingredientes. Copia anterior salva. Aguarde a mensagem final.`);
  const ids = new Set();
  for (const [indice, linha] of plano.linhas.entries()) {
    let produto = linha.atual;
    if (!confere(produto, linha.dados)) {
      if (produto) {
        produto = await api.productUpdate(produto.id, {
          ...linha.dados, images: foto(produto) ? [] : [{ url: linha.imagem }],
        });
      } else {
        produto = await api.productCreate({
          ...linha.dados, originCountryCode: undefined, images: [{ url: linha.imagem }],
        });
      }
      // Sem repetição automática de criação: timeout pode ter criado o produto.
      await pausa();
    }
    if (!/^\d+$/.test(produto?.id) || ids.has(produto.id) || !confere(produto, linha.dados)) {
      throw new Error(`WhatsApp nao confirmou ${linha.item.name.pt}. Importacao interrompida; itens antigos nao foram apagados.`);
    }
    linha.idFinal = produto.id;
    ids.add(produto.id);
    if ((indice + 1) % 7 === 0) await avisar(`${indice + 1}/28 produtos conferidos.`);
  }

  const atualizados = await listar(api);
  if (!plano.linhas.every(l => confere(atualizados.find(p => p.id === l.idFinal), l.dados))) {
    throw new Error('Conferencia final pendente no WhatsApp. Nenhum item antigo foi apagado.');
  }
  // Não apagar produtos novos nem itens editados por outra pessoa durante o processo.
  for (const antigo of plano.remover) {
    const atual = atualizados.find(p => p.id === antigo.id);
    if (atual && !['name', 'description', 'price', 'currency', 'retailerId', 'isHidden']
      .every(k => atual[k] === antigo[k])) throw new Error('Catalogo foi editado durante a importacao. Limpeza cancelada.');
  }
  const remover = plano.remover.filter(p => atualizados.some(a => a.id === p.id));
  if (remover.length) {
    const resultado = await api.productDelete(remover.map(p => p.id));
    if (resultado?.deleted !== remover.length) throw new Error('Produtos importados, mas a limpeza foi parcial. Confira o catalogo.');
  }
  const final = await listar(api);
  if (final.length !== 28 || !plano.linhas.every(l => confere(final.find(p => p.id === l.idFinal), l.dados))) {
    throw new Error('Importacao executada, mas a leitura final ainda nao confirmou exatamente os 28 produtos. Confira o catalogo.');
  }
  const fotosTeste = plano.linhas.filter(l => l.ilustrativa).length;
  return `Catalogo atualizado: 28 produtos, precos em USD e ingredientes nas descricoes. ${remover.length} itens antigos removidos. ${fotosTeste} fotos ilustrativas reaproveitadas. O WhatsApp ainda pode revisar os produtos. A copia dos dados anteriores permite recadastro manual, nao restauracao automatica das fotos.`;
}

async function importar(phone, numeroBot, avisar) {
  const admins = (process.env.ADMIN_PHONE || '').split(',')
    .map(p => p.replace(/\D/g, '')).filter(p => /^\d{10,15}$/.test(p));
  if (!admins.includes(String(phone))) throw new Error('Importacao exige ADMIN_PHONE completo, com codigo do pais.');
  const api = conexao;
  if (!api?.online() || api.phone() !== numeroBot) throw new Error('Numero informado diferente do WhatsApp conectado ou bot desconectado.');
  if (ocupado) throw new Error('Uma importacao ja esta em andamento.');
  ocupado = true;
  try {
    const itens = require('./cardapio').allItems();
    const salvar = async dados => {
      await fs.mkdir(api.backupDir, { recursive: true });
      await fs.writeFile(path.join(api.backupDir, `catalogo-${randomUUID()}.json`),
        JSON.stringify({ numeroBot, ...dados }, null, 2), { flag: 'wx', mode: 0o600 });
    };
    return await executar({ api, itens, salvar, avisar });
  } finally { ocupado = false; }
}

module.exports = { registrar, importar, listar, preparar, executar, foto };
