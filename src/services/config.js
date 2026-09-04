const path = require('path');

const log = require('../log');
const db = require('../db/queries');

/**
 * Configuração editável — a que o dono muda sem você.
 *
 * ## Por que não pode ser arquivo
 *
 * Os `config/*.json` são lidos com `require()`, que cacheia: mesmo escrevendo no
 * arquivo em tempo de execução, o processo não veria a mudança até reiniciar. E
 * o disco do Railway é efêmero — o que fosse escrito ali sumiria no próximo
 * deploy. Então config que o dono edita **tem que morar no banco**. Isso não é
 * preferência de arquitetura; é a condição de existir.
 *
 * ## Arquivo é semente, banco é verdade
 *
 * O `config/*.json` continua no repositório e continua valendo como **padrão**:
 * no primeiro boot, cada documento ausente é semeado a partir dele. Depois disso
 * quem manda é o banco.
 *
 * Isso dá três coisas de graça:
 *   - deploy novo sobe funcionando, sem ninguém preencher nada
 *   - o histórico do git continua sendo a referência do que era o padrão
 *   - os testes rodam sem banco: sem carga, `get()` cai no arquivo
 *
 * ## Cópia em memória, como o `availability.js`
 *
 * `cardapio.disponivel()` é chamado a cada mensagem e é **síncrono** — consultar
 * o banco ali obrigaria a tornar assíncrona metade dos handlers. Então a leitura
 * é de memória, atualizada na escrita e recarregada de tempos em tempos (para o
 * caso de haver mais de uma instância no ar).
 *
 * ## O que NÃO está aqui, de propósito
 *
 * `config/pagamento.json` não aparece nesta lista, e a ausência é a defesa.
 * Quem edita o destinatário do Zelle redireciona o faturamento inteiro — o bot
 * entregaria o dado novo, educadamente, para cada cliente. Esse arquivo fica
 * fora do alcance do painel por **não existir aqui**, não por uma checagem de
 * permissão que alguém pode afrouxar depois. Ver `zelle.js`, que segue lendo o
 * arquivo direto.
 *
 * Pela mesma razão ficam de fora `ADMIN_PHONE`, `CLOUDPRNT_TOKEN`,
 * `PAINEL_SECRET` e `PAGAMENTO_PROVIDER` — credenciais e rota do dinheiro moram
 * em variável de ambiente, nunca em banco que uma tela web escreve.
 */

/** Os documentos editáveis. A lista é fechada — acrescentar é decisão consciente. */
const DOCS = ['menu', 'promotions', 'ingredientes', 'delivery', 'schedule', 'faq'];

const ARQUIVO = {
  menu: '../../config/menu.json',
  promotions: '../../config/promotions.json',
  ingredientes: '../../config/ingredientes.json',
  delivery: '../../config/delivery.json',
  schedule: '../../config/schedule.json',
  faq: '../../config/faq.json',
};

const RECARGA_MS = 60 * 1000;

/** O que veio do banco. Vazio antes do boot, e nos testes. */
const memoria = new Map();

/** O padrão do repositório. Lido uma vez, nunca muda em execução. */
function doArquivo(key) {
  // `require` cacheia, então isto lê do disco uma vez por processo.
  return require(ARQUIVO[key]);
}

/**
 * O documento vigente.
 *
 * Banco quando há; arquivo quando não. A ordem importa no boot e nos testes: o
 * bot precisa responder mesmo antes de a primeira carga terminar, e um Supabase
 * lento não pode ser o motivo de o cardápio sumir.
 */
function get(key) {
  if (!DOCS.includes(key)) {
    throw new Error(`Documento de config desconhecido: "${key}". Conhecidos: ${DOCS.join(', ')}`);
  }
  return memoria.get(key) ?? doArquivo(key);
}

/** Veio do banco, ou ainda é o padrão do repositório? */
function veioDoBanco(key) {
  return memoria.has(key);
}

// --------------------------------------------------------------- validação

const numero = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const texto = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * O documento tem forma de gente?
 *
 * Existe porque o painel grava JSONB direto na config que o bot lê a cada
 * mensagem. Sem esta porta, um campo de preço deixado vazio não vira "o dono
 * errou" — vira **o bot fora do ar**, no meio do serviço, com o cardápio
 * inteiro sumido.
 *
 * Confere estrutura e tipo, não gosto: se o preço do hambúrguer vai ser $2 ou
 * $200 é decisão do dono. Que ele seja um número é decisão nossa.
 *
 * @returns {string[]} lista de problemas; vazia quando está bom
 */
function validar(key, doc) {
  const erros = [];
  if (!doc || typeof doc !== 'object') return [`"${key}" precisa ser um objeto`];

  if (key === 'menu') {
    if (!Array.isArray(doc.categories) || !doc.categories.length) {
      return ['o cardápio precisa de pelo menos uma categoria'];
    }
    const ids = new Set();
    for (const [i, cat] of doc.categories.entries()) {
      if (!texto(cat?.id)) erros.push(`categoria ${i + 1}: falta o id`);
      if (!texto(cat?.name?.pt)) erros.push(`categoria "${cat?.id}": falta o nome em português`);
      if (!Array.isArray(cat?.items)) {
        erros.push(`categoria "${cat?.id}": itens precisam ser uma lista`);
        continue;
      }
      for (const item of cat.items) {
        if (!texto(item?.id)) { erros.push(`categoria "${cat.id}": item sem id`); continue; }
        if (ids.has(item.id)) erros.push(`item "${item.id}" aparece duas vezes`);
        ids.add(item.id);
        if (!texto(item?.name?.pt)) erros.push(`item "${item.id}": falta o nome em português`);
        if (!numero(item?.price)) erros.push(`item "${item.id}": preço precisa ser um número`);
      }
    }
    // Um cardápio sem nenhum item disponível deixa o bot sem nada para vender —
    // é erro de edição, não escolha de negócio (para fechar existe `!fechar`).
    if (!ids.size) erros.push('o cardápio ficaria sem nenhum item');
  }

  if (key === 'ingredientes') {
    const dic = doc.ingredientes;
    if (!dic || typeof dic !== 'object') return ['falta o bloco "ingredientes"'];
    for (const [id, ing] of Object.entries(dic)) {
      if (!texto(ing?.name?.pt)) erros.push(`ingrediente "${id}": falta o nome em português`);
      if (!numero(ing?.price)) erros.push(`ingrediente "${id}": preço precisa ser um número`);
    }
  }

  if (key === 'promotions') {
    if (typeof doc.automatic !== 'boolean') erros.push('ativação automática precisa estar ligada ou desligada');
    if (typeof doc.manual_active !== 'boolean') erros.push('ativação manual precisa estar ligada ou desligada');
    if (!Number.isInteger(doc.weekday) || doc.weekday < 0 || doc.weekday > 6) {
      erros.push('dia da promoção precisa ser um número de 0 a 6');
    }
    if (!texto(doc.timezone)) erros.push('falta o fuso horário da promoção');
    else {
      try { new Intl.DateTimeFormat('en-US', { timeZone: doc.timezone }).format(); }
      catch (_) { erros.push('fuso horário da promoção é inválido'); }
    }
    const categoria = doc.category;
    if (!texto(categoria?.id) || !texto(categoria?.name?.pt)) {
      erros.push('falta a categoria da promoção');
    }
    if (!Array.isArray(categoria?.items) || !categoria.items.length) {
      erros.push('a promoção precisa ter pelo menos um produto');
    } else {
      const ids = new Set();
      const bases = new Set((get('menu').categories || [])
        .flatMap((c) => c.items || []).map((item) => item.id));
      for (const item of categoria.items) {
        if (!texto(item?.id)) { erros.push('produto da promoção sem id'); continue; }
        if (ids.has(item.id)) erros.push(`produto da promoção "${item.id}" aparece duas vezes`);
        ids.add(item.id);
        if (!texto(item?.name?.pt)) erros.push(`produto da promoção "${item.id}": falta o nome`);
        if (!numero(item?.price)) erros.push(`produto da promoção "${item.id}": preço precisa ser um número`);
        if (!bases.has(item?.base_item_id)) {
          erros.push(`produto da promoção "${item.id}": produto-base não existe`);
        }
        if (!Number.isInteger(item?.bundle_quantity) || item.bundle_quantity < 1) {
          erros.push(`produto da promoção "${item.id}": quantidade precisa ser um inteiro positivo`);
        }
      }
    }
  }

  if (key === 'delivery') {
    if (!Array.isArray(doc.cities)) return ['falta a lista de cidades'];
    for (const c of doc.cities) {
      if (!texto(c?.id)) { erros.push('cidade sem id'); continue; }
      if (!texto(c?.label)) erros.push(`cidade "${c.id}": falta o nome`);
      if (!numero(c?.delivery_fee)) erros.push(`cidade "${c.id}": taxa precisa ser um número`);
    }
    // Sem cidade ativa E sem retirada, não sobra jeito de receber o pedido.
    const temEntrega = doc.cities.some((c) => c.active !== false);
    if (!temEntrega && doc.pickup?.enabled !== true) {
      erros.push('sem nenhuma cidade ativa e sem retirada, o cliente não teria como receber');
    }
  }

  if (key === 'schedule') {
    if (doc.always_open !== true) {
      if (!Number.isInteger(doc.open_hour) || doc.open_hour < 0 || doc.open_hour > 24) {
        erros.push('hora de abertura precisa ser um número de 0 a 24');
      }
      if (!Number.isInteger(doc.close_hour) || doc.close_hour < 0 || doc.close_hour > 24) {
        erros.push('hora de fechamento precisa ser um número de 0 a 24');
      }
    }
    if (doc.closed_days && !Array.isArray(doc.closed_days)) {
      erros.push('dias fechados precisam ser uma lista');
    }
  }

  if (key === 'faq') {
    if (!Array.isArray(doc)) return ['o FAQ precisa ser uma lista'];
    for (const f of doc) {
      if (!texto(f?.id)) { erros.push('pergunta sem id'); continue; }
      if (!texto(f?.answer?.pt)) erros.push(`pergunta "${f.id}": falta a resposta em português`);
    }
  }

  return erros;
}

/**
 * Grava um documento.
 *
 * Valida antes de tudo: o painel é a única porta por onde entra config, e o que
 * entra torto aqui sai como bot mudo lá.
 *
 * Atualiza a memória **depois** do banco — se a gravação falhar, o que está no
 * ar continua sendo o que estava, e não uma versão que só existe nesta
 * instância.
 */
async function set(key, doc, quem = null) {
  if (!DOCS.includes(key)) {
    throw new Error(`Documento de config desconhecido: "${key}"`);
  }

  const erros = validar(key, doc);
  if (erros.length) {
    const err = new Error(`Configuração inválida: ${erros.join('; ')}`);
    err.erros = erros;
    err.validacao = true;
    throw err;
  }

  // O anterior vai para o histórico antes de ser substituído — é o que permite
  // desfazer, e o que responde "quem mudou isso?" depois de um prejuízo.
  const anterior = memoria.get(key) ?? null;

  await db.setConfigDoc(key, doc, quem);
  memoria.set(key, doc);

  db.registrarHistoricoConfig(key, anterior, quem).catch((err) => {
    // Histórico é registro, não caminho crítico: falhar aqui não pode desfazer
    // uma gravação que já aconteceu.
    log.error({ evt: 'config', doc: key, err }, 'falha ao gravar historico de config');
  });

  log.info({ evt: 'config', doc: key, por: quem }, `config "${key}" atualizada`);
  return doc;
}

/** Recarrega tudo do banco. Falha aqui não derruba o atendimento. */
async function recarregar() {
  try {
    const docs = await db.getConfigDocs();
    for (const { key, doc } of docs) {
      if (DOCS.includes(key)) memoria.set(key, doc);
    }
    return true;
  } catch (err) {
    log.error({ evt: 'config', err }, 'falha ao carregar config do banco');
    return false;
  }
}

/**
 * Semeia o banco com o padrão do repositório, para os documentos que faltam.
 *
 * Só insere o ausente — nunca sobrescreve. Um deploy não pode desfazer o que o
 * dono editou, e é exatamente isso que aconteceria se a semeadura fosse um
 * `upsert` cego.
 */
async function semear() {
  const faltando = DOCS.filter((key) => !memoria.has(key));
  if (!faltando.length) return [];

  for (const key of faltando) {
    try {
      await db.setConfigDoc(key, doArquivo(key), 'semente');
      memoria.set(key, doArquivo(key));
    } catch (err) {
      // Sem semente o `get()` cai no arquivo, então o bot segue funcionando —
      // só não persiste edição até o banco voltar.
      log.error({ evt: 'config', doc: key, err }, `falha ao semear config "${key}"`);
    }
  }

  log.info({ evt: 'config', docs: faltando }, `config semeada: ${faltando.join(', ')}`);
  return faltando;
}

async function start() {
  const ok = await recarregar();
  if (ok) await semear();

  setInterval(recarregar, RECARGA_MS).unref();

  log.info(
    {
      evt: 'boot',
      config: DOCS.map((k) => `${k}:${veioDoBanco(k) ? 'banco' : 'arquivo'}`).join(' '),
    },
    'configuracao carregada'
  );
}

/** Só para os testes: volta tudo ao padrão do repositório. */
function zerar() {
  memoria.clear();
}

module.exports = { DOCS, start, get, set, validar, veioDoBanco, recarregar, semear, zerar };
