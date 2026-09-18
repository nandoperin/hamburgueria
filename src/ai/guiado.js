const tools = require('./tools');
const leitor = require('./leitor');
const cardapio = require('../services/cardapio');
const modifiers = require('../services/modifiers');
const delivery = require('../services/delivery');
const schedule = require('../services/schedule');
const session = require('../bot/session');
const notify = require('../bot/notify');
const { t, prazoPedido } = require('../i18n');
const log = require('../log');

/**
 * Fluxo guiado — Fase 2 do plano "Fluxo guiado da IA" (doc de 17/09).
 *
 *   mensagem → IA leitora (JSON) → validador (regras do dono) → carrinho
 *            → próxima pergunta do sistema → resposta com texto fixo
 *
 * O modelo não escreve nada que o cliente leia e não mexe no carrinho: ele
 * preenche um formulário (`ai/leitor.js`), e este módulo decide. As regras
 * (R1…R13 do doc) moram aqui, uma vez cada, em vez de espalhadas em travas
 * contra ferramentas.
 *
 * Liga com FLUXO_GUIADO=on. Desligado, nada muda: o agente de sempre conduz.
 * Qualquer falha da leitura (provedor fora, teto de gasto, JSON quebrado)
 * devolve false, e quem chamou cai no agente antigo — a rede continua armada.
 */

function ligado() {
  return String(process.env.FLUXO_GUIADO || 'off').toLowerCase() === 'on';
}

const LANCHES = ['sanduiches', 'hotdogs', 'massas'];

// Palavra da família sem o nome do produto: "2 hot dog" não diz qual dos seis.
const FAMILIAS = [
  { categoria: 'hotdogs', palavras: /\b(?:hot ?dogs?|hots?|cachorros? quentes?|dogao)\b/ },
  { categoria: 'bebidas', palavras: /\b(?:refri|refris|refrigerantes?|latas?|bebidas?|sodas?)\b/ },
  { categoria: 'sanduiches', palavras: /\b(?:lanches?|hamburguers?|hamburger|sanduiches?|burgers?)\b/ },
];

const norm = (texto) => tools.normalizarComparacao(texto);

// O que faz de um ingrediente solto um acréscimo: "com ovo", "bacon extra",
// "coloca banana", "mais calabresa".
const PEDE_ACRESCIMO = /\b(?:com|c|acrescent\w*|adicion\w*|coloc\w*|poe|bota|extra|mais)\b/;

function estado(sess) {
  if (!sess.guiado) sess.guiado = { ultimaPergunta: null, pendente: null, ultimaFala: null };
  return sess.guiado;
}

function produtoDaLinha(line) {
  return line.productId || String(line.id || '').split(':')[0];
}

function ehLanche(item) {
  return LANCHES.includes(item?.category?.id);
}

function nome(item, lang) {
  return cardapio.nome(item, lang);
}

/**
 * O produto está na fala? (R4)
 *
 * Na mensagem, não necessariamente no trecho: em "3 x tudo, 2 sem tomate e 1
 * com banana" o trecho de cada variação é "2 sem tomate" — o nome veio antes.
 * O que não pode é o produto não aparecer em lugar nenhum do que ele escreveu.
 */
function citado(item, trecho, texto) {
  const nomes = tools.nomesDoItem(item);
  return tools.nomeCitado(nomes, trecho || '') || tools.nomeCitado(nomes, texto);
}

function familiaDe(trecho) {
  const n = norm(trecho);
  return FAMILIAS.find((f) => f.palavras.test(n)) || null;
}

function opcoesDaFamilia(categoria) {
  const cat = cardapio.categoriaById(categoria);
  return cardapio.itensDisponiveis(cat).map((i) => i.id);
}

// ------------------------------------------------------------- validação

/**
 * Transforma a leitura em um plano: o que entra, o que muda, o que perguntar.
 * Nada aqui toca no carrinho — só decide.
 */
function validar(sess, leitura, texto) {
  const lang = sess.lang || 'pt';
  const plano = { itens: [], correcoes: [], avisos: [], ambiguos: [], alvos: [] };
  const pendente = estado(sess).pendente;

  for (const a of leitura.ambiguos) {
    const opcoes = a.opcoes.filter((id) => cardapio.disponivel(cardapio.itemById(id)));
    if (opcoes.length > 1) plano.ambiguos.push({ trecho: a.trecho, qtd: a.qtd, opcoes });
    else if (opcoes.length === 1) leitura.itens.push({ produto: opcoes[0], qtd: a.qtd, sem: [], com: [], trecho: a.trecho });
  }

  for (const bruto of leitura.itens) {
    const item = cardapio.itemById(bruto.produto);
    const trecho = bruto.trecho || bruto.produto;

    if (!item || !citado(item, bruto.trecho, texto)) {
      // R4: produto que não está na fala não entra. Se a fala tem a família
      // ("hot dog"), pergunta qual; senão, avisa que não entendeu aquele trecho.
      const familia = familiaDe(trecho);
      if (familia) {
        plano.ambiguos.push({ trecho, qtd: bruto.qtd, opcoes: opcoesDaFamilia(familia.categoria) });
      } else if (item) {
        log.warn({ evt: 'guiado', motivo: 'produto_nao_citado', produto: bruto.produto, trecho }, 'item descartado: não está na fala');
      } else {
        plano.avisos.push(t(lang, 'guiado_nao_temos', { trecho }));
      }
      continue;
    }
    if (!cardapio.disponivel(item)) {
      plano.avisos.push(cardapio.mensagemIndisponivel(item, lang));
      continue;
    }

    // A resposta a "Qual hot dog?" vem sem número: vale a quantidade perguntada.
    let qtd = bruto.qtd || 1;
    if (!bruto.qtd && pendente?.tipo === 'qual' && pendente.opcoes.includes(item.id) && pendente.qtd) qtd = pendente.qtd;

    // R1: ingrediente não é produto — vira acréscimo no lanche. Mas só quando a
    // fala pede acréscimo: "3x bacon" com três X-Bacon no carrinho é o nome do
    // lanche repetido (Kiki, #154), e virou bacon extra nos três.
    if (item.category?.id === 'adicionais' && !cardapio.avulsoPermitido(item)) {
      if (PEDE_ACRESCIMO.test(norm(trecho))) plano.alvos.push({ ingrediente: item.id, qtd: bruto.qtd, trecho });
      else log.warn({ evt: 'guiado', motivo: 'ingrediente_sem_pedido_de_acrescimo', produto: item.id, trecho }, 'ingrediente solto ignorado');
      continue;
    }

    const removiveis = new Set(modifiers.removiveis(item, lang).map((i) => i.id));
    const acrescentaveis = new Set(modifiers.adicionais(item, lang).map((i) => i.id));
    const sem = [];
    for (const id of bruto.sem) {
      if (removiveis.has(id)) sem.push(id);
      else if (!(id === 'maionese' && bruto.maionese_a_parte)) {
        // R5: só sai o que o lanche tem.
        plano.avisos.push(t(lang, 'guiado_nao_leva', { produto: nome(item, lang), ingrediente: modifiers.nomeDe(id, lang) }));
      }
    }
    // R13: maionese à parte sai de dentro (se o lanche leva) e vai separada, de graça.
    if (bruto.maionese_a_parte && removiveis.has('maionese') && !sem.includes('maionese')) sem.push('maionese');
    const com = [];
    for (const id of bruto.com) {
      if (acrescentaveis.has(id)) com.push(id);
      else plano.avisos.push(t(lang, 'guiado_nao_acrescenta', { ingrediente: modifiers.nomeDe(id, lang) }));
    }

    plano.itens.push({
      item_id: item.id,
      quantidade: qtd,
      remover: sem,
      acrescentar: com,
      ...(bruto.salsicha ? { preparo_salsicha: bruto.salsicha } : {}),
      ...(bruto.ponto_bife ? { ponto_bife: bruto.ponto_bife } : {}),
      ...(bruto.maionese_a_parte && ehLanche(item) ? { maionese_a_parte: true } : {}),
    });
  }

  for (const c of leitura.correcoes) {
    const linha = (sess.cart || []).find((l) => l.id === c.linha) ||
      unicaLinhaDoProduto(sess, c.linha);
    if (!linha) continue;
    plano.correcoes.push({ ...c, linha });
  }

  // R1/R8: acréscimo sem lanche indicado vai no único lanche possível; com
  // mais de um, pergunta em qual.
  for (const alvo of plano.alvos) {
    const novosLanches = plano.itens.filter((i) => ehLanche(cardapio.itemById(i.item_id)));
    const noCarrinho = (sess.cart || []).filter((l) => ehLanche(cardapio.itemById(produtoDaLinha(l))));
    if (novosLanches.length + noCarrinho.length === 1) {
      if (novosLanches.length) novosLanches[0].acrescentar = [...new Set([...novosLanches[0].acrescentar, alvo.ingrediente])];
      else plano.correcoes.push({ acao: 'alterar', linha: noCarrinho[0], sem: [], com: [alvo.ingrediente], trecho: alvo.trecho });
      alvo.resolvido = true;
    }
  }
  plano.alvos = plano.alvos.filter((a) => !a.resolvido);
  return plano;
}

function unicaLinhaDoProduto(sess, produtoId) {
  const linhas = (sess.cart || []).filter((l) => produtoDaLinha(l) === produtoId);
  return linhas.length === 1 ? linhas[0] : null;
}

// ---------------------------------------------------------------- aplicar

/** A leitura trouxe algo além do troco? */
function mudouAlgo(l) {
  return Boolean(l.itens.length || l.ambiguos.length || l.correcoes.length || l.refazer_lista ||
    l.concluiu_itens || l.entrega || l.cidade || l.endereco || l.nome || l.pagamento ||
    l.confirma_resumo || l.pergunta || l.cancelar);
}

function carrinhoComoTexto(sess) {
  return JSON.stringify((sess.cart || []).map((l) => [l.id, l.qty]));
}

/**
 * Mudança de item depois do resumo invalida o resumo — mesmo tratamento que o
 * agente dá (`executarFerramenta`): o carrinho reabre e um resumo novo sai.
 */
function reabrirParaEdicao(sess) {
  if (['CONFIRM', 'PAYMENT_METHOD', 'CASH_CHANGE'].includes(sess.state)) {
    sess.state = 'ORDER';
    sess.editingCart = true;
    sess.escolhaItensConcluida = true;
    sess.aguardandoMaisItens = false;
  }
}

async function aplicar(sess, plano, leitura, texto, send) {
  const lang = sess.lang || 'pt';
  const contexto = { textoCliente: texto };
  const antes = carrinhoComoTexto(sess);
  const resultado = { avisos: [...plano.avisos], respostas: [], sistemaRespondeu: false };

  if (leitura.refazer_lista && plano.itens.length) {
    // #155: a lista mandada de novo substitui o carrinho — somar foi o que
    // levou três lanches a $252.
    reabrirParaEdicao(sess);
    sess.cart = [];
  }

  for (const c of plano.correcoes) {
    reabrirParaEdicao(sess);
    if (c.acao === 'tirar') {
      tools.carrinho.definirQuantidade(sess, { item_id: c.linha.id, quantidade: 0 });
    } else if (c.acao === 'quantidade' && c.qtd != null) {
      tools.carrinho.definirQuantidade(sess, { item_id: c.linha.id, quantidade: c.qtd });
    } else if (c.acao === 'alterar') {
      const item = cardapio.itemById(produtoDaLinha(c.linha));
      const removiveis = new Set(modifiers.removiveis(item, lang).map((i) => i.id));
      const acrescentaveis = new Set(modifiers.adicionais(item, lang).map((i) => i.id));
      const r = tools.carrinho.personalizar(sess, {
        item_id: c.linha.id,
        quantidade: c.linha.qty,
        remover: (c.sem || []).filter((id) => removiveis.has(id)),
        acrescentar: (c.com || []).filter((id) => acrescentaveis.has(id)),
        ...(c.ponto_bife ? { ponto_bife: c.ponto_bife } : {}),
      });
      if (r?.bloqueiaFluxo) log.warn({ evt: 'guiado', motivo: 'alteracao_recusada', resultado: r.resultado }, 'alteração não aplicada');
    }
  }

  for (const i of plano.itens) {
    reabrirParaEdicao(sess);
    tools.carrinho.adicionar(sess, i);
  }
  if (plano.itens.length || plano.ambiguos.length === 0) estado(sess).pendente = null;

  const mudou = carrinhoComoTexto(sess) !== antes;
  resultado.carrinhoMudou = mudou;

  if (leitura.concluiu_itens && sess.cart.length) {
    sess.escolhaItensConcluida = true;
    sess.aguardandoMaisItens = false;
    sess.editingCart = false;
  }

  // Logística, na ordem das perguntas. As ferramentas de sempre, com a fala
  // do cliente como contexto: elas já conferem nome, cidade e pagamento.
  if (leitura.entrega && sess.cart.length) {
    await tools.executar('definir_entrega', { tipo: leitura.entrega === 'entrega' ? 'delivery' : 'pickup' }, sess, send, contexto);
    sess.escolhaItensConcluida = true;
    sess.aguardandoMaisItens = false;
  }
  if (leitura.cidade && sess.orderType === 'delivery') {
    await tools.executar('definir_cidade', { cidade: leitura.cidade }, sess, send, contexto);
  }
  if (leitura.endereco && sess.orderType === 'delivery') {
    await tools.executar('definir_endereco', { endereco: leitura.endereco }, sess, send, contexto);
  }
  // R10: nome só se está escrito na mensagem — "Ok" virou "Ana" (Vanessa, 13/09).
  if (leitura.nome && norm(texto).includes(norm(leitura.nome))) {
    await tools.executar('definir_cadastro', { nome: leitura.nome }, sess, send, contexto);
  }

  if (leitura.pagamento === 'cartao') {
    resultado.respostas.push(t(lang, 'guiado_cartao'));
  } else if (leitura.pagamento && sess.cart.length) {
    // R11: trocar a forma de pagamento vale até o pedido ser confirmado.
    if (sess.paymentMethod && sess.paymentMethod !== leitura.pagamento && !sess.orderId) {
      sess.paymentMethod = null;
      sess.changeFor = null;
    }
    if (!sess.paymentMethod) {
      const r = await tools.executar('definir_pagamento', { metodo: leitura.pagamento }, sess, send, contexto);
      if (r?.entregouAoFluxo) resultado.sistemaRespondeu = true;
    }
  }

  // Troco não é tratado (decisão do dono, 18/09): quem fala de troco ouve só
  // "Ok" — nada é registrado nem conferido.
  resultado.soTroco = Boolean(leitura.troco) && !mudouAlgo(leitura);

  if (sess.state === 'CONFIRM' && !mudou && leitura.confirma_resumo) {
    if (leitura.confirma_resumo === 'sim') await tools.executar('confirmar_resumo', {}, sess, send, contexto);
    else await require('../bot/handlers/order').handleConfirm(sess, 'não', send);
    resultado.sistemaRespondeu = true;
  }

  return resultado;
}

// ------------------------------------------------------------ perguntas

function tabelaDeCidades(lang) {
  return delivery.getCities().map((c) => `• ${c.label} — $${Number(c.delivery_fee).toFixed(2)}`).join('\n');
}

async function repassarParaEquipe(sess, texto) {
  const quem = sess.name ? `${sess.name} (+${sess.phone})` : `+${sess.phone}`;
  const mensagem = require('../texto').paraAdmin(`❓ *${quem}* perguntou:\n"${String(texto).slice(0, 400)}"`);
  const envios = await Promise.all(notify.admins().map((admin) => notify.send(admin, mensagem).catch(() => false)));
  return envios.some(Boolean);
}

/** Resposta fixa para a pergunta, ou repasse para a equipe. Nunca improviso. */
async function responderPergunta(sess, pergunta, texto) {
  const lang = sess.lang || 'pt';
  switch (pergunta) {
    case 'cartao':
      return t(lang, 'guiado_cartao');
    case 'taxa_entrega':
      if (sess.city) return t(lang, 'delivery_fee_city', { city: sess.city.label, fee: Number(sess.city.delivery_fee).toFixed(2) });
      return `${t(lang, 'guiado_taxas')}\n${tabelaDeCidades(lang)}`;
    case 'cidades':
      return `${t(lang, 'guiado_taxas')}\n${tabelaDeCidades(lang)}`;
    case 'horario':
      return schedule.horarioTexto(lang);
    case 'cardapio': {
      const link = notify.catalogLink();
      return link ? `${t(lang, 'guiado_menu')}\n${link}` : t(lang, 'guiado_menu_escreva');
    }
    case 'tempo':
      if (sess.orderType) return prazoPedido(lang, sess.orderType);
      return `${t(lang, 'guiado_tempo_retirada')} ${prazoPedido(lang, 'pickup')}\n` +
        `${t(lang, 'guiado_tempo_entrega')} ${prazoPedido(lang, 'delivery')}`;
    default: {
      // status do pedido, fiado, promoção e o que não está na lista: a equipe.
      const foi = await repassarParaEquipe(sess, texto);
      log.info({ evt: 'guiado', pergunta, repassada: foi }, 'pergunta fora da lista enviada à equipe');
      return t(lang, foi ? 'guiado_equipe' : 'atendimento_indisponivel');
    }
  }
}

// --------------------------------------------------------------- resposta

function perguntaDeAmbiguidade(sess, a) {
  const lang = sess.lang || 'pt';
  const nomes = a.opcoes.map((id) => nome(cardapio.itemById(id), lang)).join(', ');
  estado(sess).pendente = { tipo: 'qual', trecho: a.trecho, qtd: a.qtd, opcoes: a.opcoes };
  return t(lang, 'guiado_qual', { trecho: a.trecho, opcoes: nomes });
}

function perguntaDeAlvo(sess, alvo) {
  const lang = sess.lang || 'pt';
  const lanches = (sess.cart || []).filter((l) => ehLanche(cardapio.itemById(produtoDaLinha(l))));
  estado(sess).pendente = { tipo: 'alvo', ingrediente: alvo.ingrediente };
  return t(lang, 'guiado_qual_lanche', {
    ingrediente: modifiers.nomeDe(alvo.ingrediente, lang),
    opcoes: lanches.map((l) => l.name).join(' ou '),
  });
}

async function responder(sess, resultado, plano, leitura, texto, send) {
  const lang = sess.lang || 'pt';
  if (resultado.soTroco) {
    await send(t(lang, 'guiado_ok'));
    return;
  }
  const partes = [...resultado.avisos];
  const respondeuCartao = resultado.respostas.includes(t(lang, 'guiado_cartao'));

  if (resultado.carrinhoMudou && sess.cart.length) {
    partes.push(`${t(lang, 'guiado_anotei')}\n${require('../bot/handlers/order').summaryLines(sess.cart, lang)}`);
  }
  for (const r of resultado.respostas) partes.push(r);
  if (leitura.pergunta && !(leitura.pergunta === 'cartao' && leitura.pagamento === 'cartao')) {
    partes.push(await responderPergunta(sess, leitura.pergunta, texto));
  }

  // A próxima pergunta: primeiro o que ficou em aberto nesta mensagem, depois
  // a etapa seguinte do pedido — sempre do sistema, nunca inventada.
  let proxima = null;
  if (plano.ambiguos.length) proxima = perguntaDeAmbiguidade(sess, plano.ambiguos[0]);
  else if (plano.alvos.length) proxima = perguntaDeAlvo(sess, plano.alvos[0]);
  else if (!resultado.sistemaRespondeu) proxima = tools.mensagemColeta(sess);
  // "Não aceitamos cartão. Pode ser cash ou Zelle?" já é a pergunta.
  if (respondeuCartao && proxima === t(lang, 'payment_method_ask')) proxima = null;

  if (resultado.sistemaRespondeu) {
    if (partes.length) await send(partes.join('\n\n'));
    estado(sess).ultimaPergunta = null;
    return;
  }

  // No resumo, mensagem que não muda o pedido ("sem troco", "ok") ouve só a
  // pergunta de confirmação — o resumo inteiro de novo é ruído.
  if (!proxima && resultado.estavaNoResumo && sess.state === 'CONFIRM' && !resultado.carrinhoMudou) {
    partes.push(t(lang, 'guiado_confirmar'));
    await send(partes.join('\n\n'));
    estado(sess).ultimaPergunta = 'resumo do pedido (sim para confirmar)';
    return;
  }

  if (!proxima && sess.cart.length && !plano.ambiguos.length && !respondeuCartao) {
    if (partes.length) await send(partes.join('\n\n'));
    // Tudo respondido: o resumo oficial, escrito pelo sistema.
    await require('../bot/handlers/order').mostrarResumo(sess, send);
    estado(sess).ultimaPergunta = 'resumo do pedido (sim para confirmar)';
    return;
  }

  if (proxima) partes.push(proxima);
  if (!partes.length) partes.push(t(lang, 'guiado_nao_entendi'));
  await send(partes.join('\n\n'));
  estado(sess).ultimaPergunta = proxima || null;
}

// ------------------------------------------------------------------ entrada

/**
 * Atende uma mensagem pelo fluxo guiado. Devolve false quando não conseguiu
 * ler — aí o agente de sempre assume.
 */
async function atender(sess, texto, send, { citada } = {}) {
  const g = estado(sess);
  const lang = sess.lang || 'pt';

  // R9: a mesma mensagem de novo não é pedido novo (Kiki, #154: "3x bacon"
  // repetido virou bacon extra nos três lanches).
  const fala = norm(texto);
  if (fala && fala === g.ultimaFala && sess.cart.length) {
    const proxima = tools.mensagemColeta(sess);
    await send(`${t(lang, 'guiado_ja_anotado')}\n${require('../bot/handlers/order').summaryLines(sess.cart, lang)}` +
      (proxima ? `\n\n${proxima}` : ''));
    return true;
  }

  const lido = await leitor.ler(sess, texto, { citada });
  if (!lido.ok) return false;
  g.ultimaFala = fala;
  const leitura = lido.dados;

  if (leitura.cancelar && !leitura.itens.length) {
    session.clear(sess.phone);
    await send(t(lang, 'flow_cancelled'));
    return true;
  }

  const plano = validar(sess, leitura, texto);
  const estavaNoResumo = sess.state === 'CONFIRM';
  const resultado = await aplicar(sess, plano, leitura, texto, send);
  resultado.estavaNoResumo = estavaNoResumo;
  log.info({
    evt: 'guiado',
    itens: plano.itens.map((i) => `${i.quantidade}x ${i.item_id}`),
    ambiguos: plano.ambiguos.length,
    avisos: plano.avisos.length,
    estado: sess.state,
  }, 'mensagem atendida pelo fluxo guiado');
  await responder(sess, resultado, plano, leitura, texto, send);
  return true;
}

module.exports = { ligado, atender, validar };
