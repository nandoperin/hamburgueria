const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const normalizar = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Apenas a conexão viva do bot registra esta capacidade. Não existe endpoint público.
let conexao = null;
let ocupado = false;
let conferindoColecoes = false;
const conferencias = new Map();
const VALIDADE_CONFERENCIA_MS = 10 * 60 * 1000;
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

function escalaConfirmada(existentes, referencia) {
  const p = existentes.find(p => p.id === referencia.id);
  if (!p || p.currency !== 'USD' || p.price !== referencia.price || p.name !== referencia.name) {
    throw new Error('O produto de referencia mudou. Envie !catalogo conferir novamente.');
  }
  if (!/^\d{1,6}[.,]\d{2}$/.test(referencia.valor || '')) {
    throw new Error('Informe o preco visivel no aplicativo com duas casas, por exemplo 12.00.');
  }
  const centavos = Number(referencia.valor.replace(',', '.')) * 100;
  if (!Number.isFinite(centavos) || centavos <= 0) throw new Error('Preco de referencia invalido.');
  const escalas = [1, 100, 1000].filter(e =>
    Math.abs(Number(p.price) - Math.round(centavos) * e / 100) < 0.000001);
  if (escalas.length !== 1) {
    throw new Error('O preco informado nao corresponde ao formato recebido. Confira o valor do produto no aplicativo; nenhuma alteracao realizada.');
  }
  return escalas[0];
}

function preparar(itens, existentes, referencia) {
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
  if (!referencia && escalas.length !== 1) {
    throw new Error(`O catalogo antigo nao tem referencias suficientes com os mesmos precos do bot (${existentes.length} produtos encontrados; ${referencias.length} correspondencias em USD). Nenhuma alteracao realizada. Envie !catalogo conferir para usar o preco visivel de um produto como referencia.`);
  }
  const escala = referencia ? escalaConfirmada(existentes, referencia) : escalas[0];
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

async function executar({ api, itens, salvar, avisar, referencia, pausa = () => new Promise(r => setTimeout(r, 800)) }) {
  const antigos = await listar(api);
  if (!antigos.length) throw new Error('A leitura do catalogo nao retornou produtos. Nao e um erro de preco; a importacao foi bloqueada antes de alterar qualquer item.');
  const plano = preparar(itens, antigos, referencia);
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

function autorizar(phone, numeroBot) {
  const admins = (process.env.ADMIN_PHONE || '').split(',')
    .map(p => p.replace(/\D/g, '')).filter(p => /^\d{10,15}$/.test(p));
  if (!admins.includes(String(phone))) throw new Error('Importacao exige ADMIN_PHONE completo, com codigo do pais.');
  const api = conexao;
  if (!api?.online() || !/^\d{10,15}$/.test(api.phone()) || (numeroBot && api.phone() !== numeroBot)) {
    throw new Error('Numero informado diferente do WhatsApp conectado ou bot desconectado.');
  }
  return api;
}

async function conferirColecoes(phone, avisar) {
  const api = autorizar(phone);
  if (typeof api.lerColecoes !== 'function') throw new Error('Consulta de colecoes indisponivel nesta conexao.');
  if (conferindoColecoes || ocupado) throw new Error('Ja existe uma consulta ou importacao em andamento. Aguarde.');
  conferindoColecoes = true;
  try {
    await avisar('Consultando somente as colecoes do WhatsApp. Pode levar ate 1 minuto. Nenhum produto sera alterado.');
    const r = await api.lerColecoes();
    const rodape = '\nSomente consulta: nada foi importado ou apagado.';
    if (r.code !== 'colecoes_lidas') {
      const motivo = ['colecoes_timeout', 'colecoes_sem_resposta'].includes(r.code)
        ? 'O WhatsApp nao respondeu a consulta das colecoes dentro do prazo.'
        : 'Nao foi possivel interpretar ou concluir a consulta das colecoes.';
      return `${motivo}\nCodigo: ${r.code}${r.status ? `; status: ${r.status}` : ''}.\nEnvie esta resposta ao responsavel tecnico.${rodape}`;
    }
    const nome = valor => String(valor || '(sem nome)').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80);
    return `Colecoes: ${r.colecoes.length}. Produtos distintos encontrados: ${r.produtos.length}.\n` +
      r.colecoes.slice(0, 10).map(c => `- ${nome(c.name)}: ${c.quantidade} produtos`).join('\n') +
      (r.produtos.length ? '\nExemplos: ' + r.produtos.slice(0, 5).map(p => nome(p.name)).join(', ') + '.' : '') +
      '\nEsta leitura pode ser parcial e nao substitui o catalogo completo. Zero colecoes nao significa catalogo vazio.' + rodape;
  } finally { conferindoColecoes = false; }
}

async function conferir(phone) {
  const api = autorizar(phone);
  for (const [key, valor] of conferencias) {
    if (Date.now() - valor.em > VALIDADE_CONFERENCIA_MS) conferencias.delete(key);
  }
  conferencias.delete(phone);
  const produtos = await listar(api);
  if (!produtos.length) {
    return `A leitura do catalogo conectado (${api.phone()}) nao retornou produtos. Isso nao confirma que esteja vazio no aplicativo. Nao altere moeda nem precos. A importacao permanece bloqueada; nenhum item foi alterado.`;
  }
  const referencias = produtos.filter(p => p.currency === 'USD' && Number.isFinite(p.price) && p.price > 0).slice(0, 5);
  if (!referencias.length) {
    return `Catalogo conectado: ${api.phone()}. ${produtos.length} produtos encontrados, mas nenhum com preco numerico em USD. Confira a moeda e o preco de um produto no aplicativo. Nada foi alterado.`;
  }
  conferencias.set(phone, { api, numeroBot: api.phone(), em: Date.now(), referencias });
  const primeiro = referencias[0];
  const nome = p => String(p.name || '(sem nome)').replace(/[\r\n]/g, ' ').slice(0, 90);
  return `Conferencia sem alterar o catalogo: ${produtos.length} produtos encontrados.\n\n` +
    referencias.map(p => `${nome(p)} — ID ${p.id}`).join('\n') +
    `\n\nAbra o catalogo no WhatsApp Business e veja o preco atual de "${nome(primeiro)}".\n` +
    `Depois envie, substituindo VALOR pelo preco que aparece (exemplo de formato: 12.00):\n` +
    `!importar catalogo ${api.phone()} referencia ${primeiro.id} preco VALOR\n\n` +
    `Use o preco ATUAL desse produto no aplicativo, nao o preco novo do bot. Isso confirma a conversao e inicia a importacao dos 28 produtos. Valido por 10 minutos. Nenhum item foi alterado ate aqui.`;
}

async function importar(phone, numeroBot, avisar, confirmacao) {
  const api = autorizar(phone, numeroBot);
  let referencia;
  if (confirmacao) {
    const leitura = conferencias.get(phone);
    if (!leitura || leitura.api !== api || leitura.numeroBot !== numeroBot ||
        Date.now() - leitura.em > VALIDADE_CONFERENCIA_MS) {
      throw new Error('Envie !catalogo conferir antes de informar o preco de referencia.');
    }
    const p = leitura.referencias.find(p => p.id === confirmacao.id);
    if (!p) throw new Error('Escolha um dos produtos mostrados em !catalogo conferir.');
    referencia = { id: p.id, name: p.name, price: p.price, valor: confirmacao.valor };
  }
  if (ocupado) throw new Error('Uma importacao ja esta em andamento.');
  ocupado = true;
  try {
    // Promoções por dia vivem no chat/painel e não no catálogo permanente do
    // WhatsApp. Assim a importação continua com os 28 produtos regulares.
    const itens = require('./cardapio').allItems()
      .filter(item => item.catalogVisible !== false);
    const salvar = async dados => {
      await fs.mkdir(api.backupDir, { recursive: true });
      await fs.writeFile(path.join(api.backupDir, `catalogo-${randomUUID()}.json`),
        JSON.stringify({ numeroBot, ...dados }, null, 2), { flag: 'wx', mode: 0o600 });
    };
    return await executar({ api, itens, salvar, avisar, referencia });
  } finally { ocupado = false; }
}

module.exports = { registrar, importar, conferir, conferirColecoes, listar, preparar, executar, foto, escalaConfirmada };
