const log = require('../log');
const entrada = require('../entrada');

/**
 * Perguntas e respostas cadastradas pelo dono no painel (docs/PERGUNTAS.md,
 * 13/11/2026).
 *
 * Quando a leitora classifica a mensagem como pergunta `outra` — a que hoje vai
 * para a equipe —, uma chamada curta à IA escolhe qual pergunta cadastrada o
 * cliente fez, ou nenhuma. O código envia **a resposta do dono, palavra por
 * palavra**: a IA só escolhe o número, nunca escreve a resposta.
 *
 * Cadastro vazio = nenhuma chamada a mais, comportamento idêntico ao de antes.
 * As perguntas que ficam sem resposta são anotadas (texto e data, sem telefone)
 * para o dono responder pelo painel.
 */
const CHAVE_BANCO = 'perguntas';
const CHAVE_PENDENTES = 'perguntas_pendentes';
const MAX_PERGUNTAS = 50;
const MAX_PERGUNTA = 120;
const MAX_RESPOSTA = 600;
const MAX_PENDENTES = 200;
const DIAS_PENDENTES = 30;

let cadastro = [];

const limpo = (v, max) => entrada.limpar(String(v ?? ''), max).replace(/[ \t]+/g, ' ').trim();
// A resposta pode ter mais de uma linha: limpa linha a linha e junta de novo.
const limpoComLinhas = (v, max) => String(v ?? '').split(/\r?\n/)
  .map((l) => limpo(l, max)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/** Confere um item: pergunta e resposta preenchidas, dentro do tamanho. */
function montarItem(bruto, anterior = null) {
  const pergunta = limpo(bruto?.pergunta, MAX_PERGUNTA);
  const resposta = limpoComLinhas(bruto?.resposta, MAX_RESPOSTA);
  const erros = [];
  if (pergunta.length < 3) erros.push('escreva a pergunta');
  if (resposta.length < 2) erros.push('escreva a resposta');
  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    item: {
      id: anterior?.id || 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      pergunta,
      resposta,
      ativa: bruto?.ativa !== false,
      atualizada: new Date().toISOString().slice(0, 10),
    },
  };
}

function usar(lista) {
  cadastro = (Array.isArray(lista) ? lista : [])
    .filter((p) => p && typeof p.pergunta === 'string' && typeof p.resposta === 'string' && p.pergunta && p.resposta)
    .slice(0, MAX_PERGUNTAS);
}

function lista() {
  return cadastro.map((p) => ({ ...p }));
}

function ativas() {
  return cadastro.filter((p) => p.ativa !== false);
}

/** Lê do banco no boot. Falha aqui não derruba nada: sem cadastro, como antes. */
async function recarregar() {
  try {
    const docs = await require('../db/queries').getConfigDocs();
    usar(docs.find((d) => d.key === CHAVE_BANCO)?.doc || []);
  } catch (err) {
    log.warn({ evt: 'perguntas', err: err.message }, 'perguntas do painel não carregaram');
  }
  return cadastro.length;
}

/** Grava a lista inteira no banco e só depois passa a usar. */
async function salvar(novaLista, quem = null) {
  const limpa = (Array.isArray(novaLista) ? novaLista : []).slice(0, MAX_PERGUNTAS);
  await require('../db/queries').setConfigDoc(CHAVE_BANCO, limpa, quem);
  usar(limpa);
  return lista();
}

// ------------------------------------------------------------- a escolha

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['numero'],
  properties: { numero: { type: ['integer', 'null'] } },
};

const SYSTEM = 'Você recebe a mensagem de um cliente de uma hamburgueria e uma lista numerada de ' +
  'perguntas que a loja já sabe responder. Responda só com o número da pergunta da lista que o ' +
  'cliente está fazendo — a MESMA pergunta, mesmo escrita com outras palavras, gírias ou erros de ' +
  'digitação. Se a mensagem não faz nenhuma delas, ou se houver dúvida, numero: null. Nunca ' +
  'escolha uma pergunta só porque fala do mesmo produto: "o macarrão tem pimenta?" não é ' +
  '"qual o preço do macarrão?".';

/**
 * Qual pergunta cadastrada o cliente fez: o item ou null. Nunca lança — falha
 * de provedor, teto de gasto ou número inválido devolvem null (vai para a
 * equipe, como antes).
 */
async function escolher(sess, texto) {
  const opcoes = ativas();
  if (!opcoes.length || !String(texto || '').trim()) return null;
  const custo = require('../ai/custo');
  const provider = require('../ai/provider');
  if (!custo.podeChamar(sess).ok) return null;
  const ia = (typeof provider.leitora === 'function' && provider.leitora()) || provider.get();
  if (!ia || typeof ia.extrair !== 'function') return null;

  const listaTexto = opcoes.map((p, i) => `${i + 1}. ${p.pergunta}`).join('\n');
  try {
    const resposta = await ia.extrair({
      system: SYSTEM,
      mensagens: [{ role: 'user', content: `Perguntas da loja:\n${listaTexto}\n\nMensagem do cliente:\n${String(texto).slice(0, 600)}` }],
      schema: SCHEMA,
      nome: 'pergunta_cadastrada',
    });
    custo.registrar(sess, resposta.uso, resposta.modelo || provider.getModelo());
    if (resposta.concluida === false) return null;
    const numero = JSON.parse(resposta.texto)?.numero;
    // O número é saída da IA: só vale se aponta para um item da lista enviada.
    const item = Number.isInteger(numero) && numero >= 1 && numero <= opcoes.length ? opcoes[numero - 1] : null;
    log.info({ evt: 'perguntas', escolhida: item?.id || null, total: opcoes.length }, 'pergunta cadastrada procurada');
    return item;
  } catch (err) {
    log.warn({ evt: 'perguntas', err: err.message }, 'falha ao procurar pergunta cadastrada');
    return null;
  }
}

// ------------------------------------------------------------- pendentes

let fila = Promise.resolve();

function lerPendentes(bruto) {
  try {
    const l = JSON.parse(bruto || '[]');
    return Array.isArray(l) ? l : [];
  } catch (_) {
    return [];
  }
}

/** Anota a pergunta que foi para a equipe (texto e data, sem telefone). */
function anotarPendente(texto) {
  const pergunta = limpo(texto, 400);
  if (!pergunta) return Promise.resolve();
  const tarefa = fila.then(async () => {
    const db = require('../db/queries');
    const corte = Date.now() - DIAS_PENDENTES * 864e5;
    const l = lerPendentes(await db.getSetting(CHAVE_PENDENTES))
      .filter((p) => new Date(p.em).getTime() >= corte);
    l.push({ id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pergunta, em: new Date().toISOString() });
    await db.setSetting(CHAVE_PENDENTES, JSON.stringify(l.slice(-MAX_PENDENTES)));
  }).catch((err) => log.warn({ evt: 'perguntas', err: err.message }, 'não consegui anotar a pergunta sem resposta'));
  fila = tarefa;
  return tarefa;
}

/** Tira da lista a pergunta respondida ou ignorada no painel (pelo código; as antigas, pela data). */
function removerPendente(chave) {
  const tarefa = fila.then(async () => {
    const db = require('../db/queries');
    const l = lerPendentes(await db.getSetting(CHAVE_PENDENTES));
    const resto = l.filter((p) => (p.id || p.em) !== chave);
    if (resto.length !== l.length) await db.setSetting(CHAVE_PENDENTES, JSON.stringify(resto));
    return l.length - resto.length;
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

async function pendentes() {
  const corte = Date.now() - DIAS_PENDENTES * 864e5;
  return lerPendentes(await require('../db/queries').getSetting(CHAVE_PENDENTES))
    .filter((p) => new Date(p.em).getTime() >= corte)
    .reverse();
}

module.exports = {
  montarItem, usar, lista, ativas, recarregar, salvar, escolher, anotarPendente, pendentes, removerPendente,
  MAX_PERGUNTAS, CHAVE_BANCO,
};
