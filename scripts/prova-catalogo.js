#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const FALA_EXPLICITA = 'No X-Bacon, tire a cebola e acrescente bacon';
const PAUSA_PADRAO_MS = 1100;

class FalhaLogica extends Error {
  constructor(message, detalhes = {}) {
    super(message);
    this.name = 'FalhaLogica';
    this.detalhes = detalhes;
  }
}

function opcao(nome, padrao) {
  const prefixo = `--${nome}=`;
  const arg = process.argv.find((value) => value.startsWith(prefixo));
  return arg ? arg.slice(prefixo.length) : padrao;
}

function inteiroPositivo(valor, padrao) {
  const numero = Number.parseInt(valor, 10);
  return Number.isInteger(numero) && numero > 0 ? numero : padrao;
}

function normalizarFala(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const CATEGORIA_UPSELL =
  '(?:ingredientes?|recheios?|molhos?|adicion(?:al|ais)|extras?|bebidas?|' +
  'refrigerantes?|sucos?|aguas?|sobremesas?|doces?|acompanhamentos?|' +
  'porc(?:ao|oes)|batatas?|fritas?|combos?|ofertas?|promoc(?:ao|oes))';

function segmentoOfereceAlgo(segmentoOriginal) {
  const segmento = normalizarFala(segmentoOriginal);
  if (!segmento) return false;

  const pergunta = /\?/.test(segmentoOriginal);
  const intencao =
    /\b(?:quer|queria|deseja|gostaria|prefere|aceita|posso|podemos|vamos|aproveita|aproveite|incluo|adiciono|acrescento|completo|complemento|recomendo|sugiro)\b|\bque tal\b|\bvai querer\b|\btem interesse\b/.test(
      segmento
    );
  const expansaoGenerica =
    /\b(?:algo mais|mais algo|mais alguma coisa|mais algum item|completar o pedido|complementar o pedido)\b/.test(
      segmento
    );
  const acaoComercial =
    /\b(?:personalizar|alterar|trocar|substituir|retirar|tirar|remover|acrescentar|adicionar|incluir)\b(?!\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)?(?:entrega|retirada|cidade|endereco|nome|email|dados|pagamento)\b)/.test(
      segmento
    );
  const categoriaDeUpsell = new RegExp(`\\b${CATEGORIA_UPSELL}\\b`).test(segmento);
  const confirmacaoConcluida =
    /\b(?:foi|foram|ficou|ficaram)\s+(?:personalizad[oa]s?|alterad[oa]s?|trocad[oa]s?|substituid[oa]s?|retirad[oa]s?|removid[oa]s?|adicionad[oa]s?|acrescentad[oa]s?|incluid[oa]s?)\b/.test(
      segmento
    ) ||
    /\b(?:personalizei|alterei|troquei|substitui|retirei|removi|tirei|adicionei|acrescentei|inclui)\b/.test(
      segmento
    );
  const restoDaPerguntaDeCategoria = segmento
    .replace(new RegExp(`\\b${CATEGORIA_UPSELL}\\b`, 'g'), ' ')
    .replace(/\b(?:ou|e|um|uma|uns|umas|algum|alguma|alguns|algumas|para|acompanhar|tambem)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const perguntaSoDeCategorias = pergunta && categoriaDeUpsell && !restoDaPerguntaDeCategoria;
  const assuntoOperacional =
    /\b(?:entrega|retirada|balcao|cidade|endereco|rua|numero|nome|email|confirmar|confirmacao|dados|pagamento|pagar|zelle|cartao|dinheiro)\b/.test(
      segmento
    );
  const ajudaSemVenda = /\b(?:repetir|explicar|esclarecer)\b/.test(segmento);

  if (confirmacaoConcluida && !intencao) return false;
  if (expansaoGenerica && (pergunta || intencao)) return true;
  if (categoriaDeUpsell && (intencao || perguntaSoDeCategorias)) return true;
  if (acaoComercial && (pergunta || intencao)) return true;
  if (assuntoOperacional || ajudaSemVenda) return false;

  // Uma pergunta/convite de inclusão sem categoria conhecida ("quer bacon?")
  // também é oferta. Só escapam os próximos dados obrigatórios do checkout e
  // perguntas de ajuda que não ampliam o pedido.
  return intencao;
}

function ofertaNaoSolicitada(texto) {
  const segmentos = String(texto || '').match(/[^.!?;,\r\n]+[.!?;,]*/g) || [];
  return segmentos.some((segmento) => segmentoOfereceAlgo(segmento));
}

function dadosDoErro(err) {
  const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? '';
  return [status, err?.code, err?.cause?.code, err?.name, err?.message, err]
    .filter(Boolean)
    .join(' ');
}

function erroExterno(err) {
  return /429|502|503|504|rate.?limit|too many|timeout|timed out|network|fetch failed|socket hang up|econn(?:reset|refused)|enotfound|etimedout|eai_again|service unavailable|temporarily unavailable|indispon.vel/i.test(
    dadosDoErro(err)
  );
}

function categoriaExterna(err) {
  const texto = dadosDoErro(err);
  if (/429|rate.?limit|too many/i.test(texto)) return 'rate-limit/429';
  if (/502|503|504|service unavailable|temporarily unavailable|indispon.vel/i.test(texto)) {
    return 'serviço indisponível';
  }
  if (/timeout|timed out|etimedout/i.test(texto)) return 'timeout';
  return 'rede';
}

function sanitizarTexto(valor, limite = 300) {
  return String(valor ?? '')
    .replace(/bearer\s+[a-z0-9._~-]+/gi, 'Bearer [SEGREDO OMITIDO]')
    .replace(/((?:api[_ -]?key|token|authorization)\s*[:=]\s*)\S+/gi, '$1[SEGREDO OMITIDO]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[TELEFONE OMITIDO]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limite);
}

function carrinhoSanitizado(cart) {
  return (cart || []).map((line) => ({
    produto: sanitizarTexto(line.productId || line.id || '', 80),
    quantidade: Number(line.qty || 0),
    removidos: (line.removed || []).map((item) => sanitizarTexto(item, 60)),
    acrescentados: (line.added || []).map((item) => sanitizarTexto(item, 60)),
  }));
}

function detalhesSanitizados(detalhes) {
  return {
    primeiraResposta: sanitizarTexto(detalhes.primeiraResposta || ''),
    respostaFinal: sanitizarTexto(detalhes.respostaFinal || ''),
    ferramentas: (detalhes.ferramentas || []).map(({ nome, fase }) => ({
      nome: sanitizarTexto(nome, 80),
      fase: sanitizarTexto(fase, 40),
    })),
    carrinho: carrinhoSanitizado(detalhes.carrinho),
  };
}

function estadoEsperado(cart) {
  if (!Array.isArray(cart) || cart.length !== 1) return false;
  const line = cart[0];
  const produto = line.productId || String(line.id || '').split(':')[0];
  const removidos = [...(line.removed || [])].map(String).sort();
  const acrescentados = [...(line.added || [])].map(String).sort();
  return (
    produto === 'x_bacon' &&
    Number(line.qty) === 1 &&
    JSON.stringify(removidos) === JSON.stringify(['cebola']) &&
    JSON.stringify(acrescentados) === JSON.stringify(['bacon'])
  );
}

function falhar(message, contexto) {
  throw new FalhaLogica(message, {
    primeiraResposta: contexto.falasCatalogo.join(' '),
    respostaFinal: contexto.falasCliente.join(' '),
    ferramentas: contexto.chamadas,
    carrinho: contexto.sess.cart,
  });
}

function erroCapturado(deps) {
  const err = deps.obterErroExterno?.();
  if (err) throw err;
}

async function umaRodada(indice, deps, idExecucao) {
  const phone = `prova-catalogo-${idExecucao}-${indice}`;
  const sess = deps.session.get(phone);
  Object.assign(sess, {
    lang: 'pt',
    cart: [
      {
        id: 'x_bacon',
        productId: 'x_bacon',
        name: 'X-Bacon',
        nomeCozinha: 'X-Bacon',
        choicesCozinha: [],
        removed: [],
        added: [],
        qty: 1,
        price: 14,
      },
    ],
  });

  const contexto = {
    sess,
    fase: 'evento-catalogo',
    falasCatalogo: [],
    falasCliente: [],
    chamadas: [],
  };
  const executarReal = deps.tools.executar;

  deps.tools.executar = async function (nome, argumentos, ...restante) {
    contexto.chamadas.push({ nome, fase: contexto.fase });
    if (nome === 'finalizar_pedido') {
      return { resultado: 'Fechamento bloqueado por esta prova.' };
    }
    return executarReal.call(this, nome, argumentos, ...restante);
  };

  try {
    deps.limparErroExterno?.();
    const recebeu = await deps.agente.receberCarrinho(
      sess,
      async (text) => contexto.falasCatalogo.push(String(text))
    );
    erroCapturado(deps);

    if (!recebeu) falhar('agente devolveu o catálogo ao fluxo determinístico', contexto);
    if (!contexto.falasCatalogo.length) falhar('não houve primeira resposta após o catálogo', contexto);
    if (contexto.chamadas.some((chamada) => chamada.nome === 'personalizar_item')) {
      falhar('personalizar_item foi chamada antes do pedido explícito do cliente', contexto);
    }
    if (ofertaNaoSolicitada(contexto.falasCatalogo.join(' '))) {
      falhar('oferta não solicitada após o catálogo', contexto);
    }

    contexto.fase = 'fala-explicita-cliente';
    deps.limparErroExterno?.();
    const conversou = await deps.agente.conversar(
      sess,
      FALA_EXPLICITA,
      async (text) => contexto.falasCliente.push(String(text))
    );
    erroCapturado(deps);

    if (!conversou) falhar('agente devolveu a personalização ao fluxo determinístico', contexto);
    if (contexto.falasCliente.some((fala) => ofertaNaoSolicitada(fala))) {
      falhar('oferta não solicitada após a personalização', contexto);
    }
    const personalizacoes = contexto.chamadas.filter(
      (chamada) => chamada.nome === 'personalizar_item'
    );
    if (!personalizacoes.length) falhar('personalizar_item não foi chamada', contexto);
    if (personalizacoes.some((chamada) => chamada.fase !== 'fala-explicita-cliente')) {
      falhar('personalizar_item foi chamada fora da fala explícita do cliente', contexto);
    }
    if (contexto.chamadas.some((chamada) => chamada.nome === 'finalizar_pedido')) {
      falhar('o modelo tentou finalizar o pedido durante a prova', contexto);
    }
    if (!estadoEsperado(sess.cart)) {
      falhar('personalização final diferente de sem cebola com bacon', contexto);
    }
  } finally {
    deps.tools.executar = executarReal;
    deps.agente.limpar?.(phone);
    deps.session.clear?.(phone);
  }
}

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executarProva({
  repeticoes,
  pausaMs = PAUSA_PADRAO_MS,
  deps,
  escrever = console.log,
}) {
  const resumo = { passou: 0, falhou: 0, inconclusivo: 0 };
  const idExecucao = `${Date.now()}-${process.pid}`;

  for (let indice = 1; indice <= repeticoes; indice += 1) {
    try {
      await umaRodada(indice, deps, idExecucao);
      resumo.passou += 1;
      escrever(`PASSOU ${indice}/${repeticoes}`);
    } catch (err) {
      if (erroExterno(err)) {
        resumo.inconclusivo += 1;
        escrever(`INCONCLUSIVO ${indice}/${repeticoes}: ${categoriaExterna(err)}`);
      } else {
        resumo.falhou += 1;
        const mensagem =
          err instanceof FalhaLogica ? sanitizarTexto(err.message) : 'falha interna ou de configuração';
        escrever(`FALHOU ${indice}/${repeticoes}: ${mensagem}`);
        const detalhes = detalhesSanitizados(err?.detalhes || {});
        escrever(`  evidência=${JSON.stringify(detalhes)}`);
      }
    }
    if (indice < repeticoes && pausaMs > 0) await pausa(pausaMs);
  }

  escrever(`RESUMO ${JSON.stringify(resumo)}`);
  return resumo;
}

function caminhoEnv() {
  const local = path.join(PROJECT, '.env');
  if (fs.existsSync(local)) return local;

  const checkoutCompartilhado = path.resolve(PROJECT, '..', '..', '.env');
  if (path.basename(path.dirname(PROJECT)) === '.worktrees' && fs.existsSync(checkoutCompartilhado)) {
    return checkoutCompartilhado;
  }
  return null;
}

function carregarDependencias() {
  const envPath = caminhoEnv();
  require('dotenv').config(envPath ? { path: envPath } : undefined);
  process.env.AI_ENABLED = 'on';
  process.env.AI_PROVIDER = 'mistral';
  process.env.LOG_LEVEL = 'silent';
  process.env.AI_MAX_USD_DIA = '0';
  process.env.AI_MAX_TOKENS_CONVERSA = '0';

  const provider = require(path.join(PROJECT, 'src/ai/provider'));
  const getReal = provider.get;
  let ultimoErroExterno = null;
  provider.get = () => {
    const real = getReal();
    return {
      ...real,
      conversar: async (payload) => {
        try {
          return await real.conversar(payload);
        } catch (err) {
          ultimoErroExterno = err;
          throw err;
        }
      },
    };
  };

  return {
    session: require(path.join(PROJECT, 'src/bot/session')),
    tools: require(path.join(PROJECT, 'src/ai/tools')),
    agente: require(path.join(PROJECT, 'src/ai/agente')),
    limparErroExterno: () => {
      ultimoErroExterno = null;
    },
    obterErroExterno: () => ultimoErroExterno,
  };
}

async function main() {
  const repeticoes = inteiroPositivo(opcao('repeticoes', '10'), 10);
  const pausaMs = inteiroPositivo(opcao('pausa', String(PAUSA_PADRAO_MS)), PAUSA_PADRAO_MS);
  const resumo = await executarProva({ repeticoes, pausaMs, deps: carregarDependencias() });
  if (resumo.falhou > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    if (erroExterno(err)) {
      console.log(`INCONCLUSIVO: ${categoriaExterna(err)}`);
      process.exitCode = 0;
      return;
    }
    console.error('FALHOU: erro interno ou de configuração');
    process.exitCode = 1;
  });
}

module.exports = {
  executarProva,
  erroExterno,
  ofertaNaoSolicitada,
  umaRodada,
};
