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
  { categoria: 'massas', palavras: /\b(?:macarrao|macarroes|massas?|espaguete|noodles?|pasta)\b/ },
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

// ------------------------------------------------ nome exato do produto

/** Janelas de 1 a 5 palavras da fala, sem espaço: "x egg bacon" → "xeggbacon". */
function janelas(texto) {
  const palavras = norm(texto).replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  const todas = new Set();
  for (let i = 0; i < palavras.length; i++) {
    for (let n = 1; n <= 5 && i + n <= palavras.length; n++) todas.add(palavras.slice(i, i + n).join(''));
  }
  return todas;
}

function nomesCompactos(item) {
  return tools.nomesDoItem(item).filter(Boolean).map((n) => norm(n).replace(/[-_\s]+/g, ''))
    .filter((n) => n.length >= 3);
}

function distancia(a, b) {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return linha[b.length];
}

/**
 * Das opções de uma ambiguidade, as que o cliente escreveu (com erro de
 * digitação). "Hamburguer" é Hamburger (1 letra) e não Hamburgão (3): no teste
 * de 18/09 o bot perguntou "Hamburger ou Hamburgão?" três vezes seguidas.
 * Devolve só a opção clara, ou as que empatam de perto, ou todas.
 */
function opcoesPeloNome(trecho, opcoes) {
  const palavras = norm(trecho || '').replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  const pedacos = [];
  for (let i = 0; i < palavras.length; i++) {
    for (let n = 1; n <= 4 && i + n <= palavras.length; n++) pedacos.push(palavras.slice(i, i + n).join(''));
  }
  if (!pedacos.length) return opcoes;
  const notas = opcoes.map((id) => {
    const item = cardapio.itemById(id);
    const nomes = item ? nomesCompactos(item) : [];
    let melhor = Infinity;
    for (const nomeC of nomes) for (const p of pedacos) melhor = Math.min(melhor, distancia(nomeC, p));
    return { id, d: melhor };
  }).sort((a, b) => a.d - b.d);
  const [primeira, segunda] = notas;
  if (!primeira || primeira.d > 2) return opcoes;
  if (!segunda || segunda.d >= primeira.d + 2) return [primeira.id];
  return notas.filter((n) => n.d <= primeira.d + 1).map((n) => n.id);
}

/**
 * O produto cujo nome INTEIRO está no texto, preferindo o nome mais longo.
 *
 * O cardápio tem pares quase iguais — Egg Bacon ($16) e X Egg Bacon ($18),
 * Egg Burger e X Egg Burger, X bacon e Bacon Burger. No teste de 18/09 a
 * leitora trocou "x egg bacon" por Egg Bacon e depois por X Egg Burger; o
 * casamento solto de nomes aceitou os dois. Aqui "x egg bacon" casa por
 * inteiro com X Egg Bacon (9 letras) e só em parte com Egg Bacon (8): ganha o
 * mais longo. Promoção repete o nome do lanche e fica de fora.
 */
function produtosExatos(texto) {
  const js = janelas(texto);
  let melhores = [];
  let tamanho = 0;
  for (const item of cardapio.allItems()) {
    // Ingrediente não disputa com produto: "1 com banana" não é o adicional Banana.
    if (item.baseItemId || !cardapio.disponivel(item) || item.category?.id === 'adicionais') continue;
    const len = Math.max(0, ...nomesCompactos(item).filter((n) => js.has(n)).map((n) => n.length));
    if (!len) continue;
    if (len > tamanho) { melhores = [item]; tamanho = len; } else if (len === tamanho) melhores.push(item);
  }
  return melhores;
}

/** Linhas do carrinho que a fala aponta: "egg bacon" aponta a linha do X Egg Bacon também. */
function linhasApontadas(sess, texto) {
  const citados = produtosExatos(texto).flatMap((i) => nomesCompactos(i));
  if (!citados.length) return [];
  return (sess.cart || []).filter((l) => {
    const item = cardapio.itemById(produtoDaLinha(l));
    return item && nomesCompactos(item).some((n) => citados.some((c) => n === c || n.includes(c)));
  });
}

/**
 * O id que a leitora mandou, ou o produto real que ele quis dizer. Ela às
 * vezes inventa um id no padrão dos vizinhos — "x_egg_bacon" quando o real é
 * "xeggbacon" (teste de 18/09). Sem sublinhado e sem espaço, os dois batem.
 */
function produtoPeloId(id) {
  const direto = cardapio.itemById(id);
  if (direto) return direto;
  const compacto = norm(id).replace(/[-_\s]+/g, '');
  const achados = cardapio.allItems().filter((i) => !i.baseItemId && nomesCompactos(i).includes(compacto));
  return achados.length === 1 ? achados[0] : null;
}

/** "3 x tudo", "3 xtudo": o número escrito logo antes do nome do produto. */
function totalEscrito(texto, item) {
  if (!item) return null;
  const palavras = norm(texto).replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  const nomes = new Set(nomesCompactos(item));
  for (let i = 1; i < palavras.length; i++) {
    for (let n = 1; n <= 5 && i + n <= palavras.length; n++) {
      if (!nomes.has(palavras.slice(i, i + n).join(''))) continue;
      const antes = palavras[i - 1] === 'x' && i >= 2 ? palavras[i - 2] : palavras[i - 1];
      const numero = Number(antes);
      if (Number.isInteger(numero) && numero > 0 && numero <= 50) return numero;
    }
  }
  return null;
}

/** "2 xegg burguer 1 sem maionese" → 1: o número logo antes do "sem"/"com". */
const EXTENSO = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 };
function quantosComObservacao(trecho) {
  const m = norm(trecho || '').match(/\b(\d+|um|uma|dois|duas|tres|quatro|cinco)\s+(?:(?:deles|delas|dele|dela)\s+)?(?:sem|com)\b/);
  if (!m) return null;
  const n = EXTENSO[m[1]] || Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const NUMERO = /\b(?:\d+|um|uma|dois|duas|tres|quatro|cinco|seis)\b/;

// "São 2 xegg bacon", "na verdade é 1": corrige a quantidade do que já está no
// carrinho, não pede mais (teste de 18/09).
const QUANTIDADE_FINAL = /^(?:nao |ja )?(?:sao|e|eh|seria|seriam|na verdade(?: sao| e)?|quero so|so)\b/;

function familiaDe(trecho) {
  const n = norm(trecho);
  return FAMILIAS.find((f) => f.palavras.test(n)) || null;
}

/**
 * Rede de segurança: linha do texto que cita produto (pelo nome ou pela
 * família) e não virou nada na leitura. Teste de 18/09: "Ola / Quero um
 * macarrao / Xtudao sem tomate e sem maionese" — a leitora leu só o X Tudão e
 * o macarrão sumiu em silêncio. Família de uma opção só entra direto; de
 * várias, vira pergunta.
 */
const NAO_E_PEDIDO = /\?|\b(?:tira|tirar|remove|cancela|nao quero|sem\s+o|tem\b|voces tem|quanto)\b/;
function esquecidosPelaLeitora(leitura, texto, sess) {
  // Trecho de item cobre a linha quando é a linha inteira (ou mais), ou quando
  // é parte dela e o item é o produto que a linha cita. "egg bacon" (item Egg
  // Bacon) dentro de "quero xegg bacon" não cobre o X Egg Bacon.
  const lidos = [
    ...leitura.itens.map((i) => ({ trecho: norm(i.trecho || ''), ids: [produtoPeloId(i.produto)?.id].filter(Boolean) })),
    ...leitura.ambiguos.map((a) => ({ trecho: norm(a.trecho || ''), ids: a.opcoes })),
  ].filter((l) => l.trecho);
  // Correção cobre a linha só quando mexe no produto que a linha cita: em
  // "Nao e egg bacon / Quero xegg bacon" a correção tira o Egg Bacon, e o X
  // Egg Bacon da segunda linha ainda precisa entrar (prova de 18/09).
  const correcoes = leitura.correcoes.map((c) => ({
    trecho: norm(c.trecho || ''), produto: String(c.linha || '').split(':')[0],
  }));
  const produtosLidos = new Set([
    ...leitura.itens.map((i) => produtoPeloId(i.produto)?.id),
    ...leitura.ambiguos.flatMap((a) => a.opcoes),
  ].filter(Boolean));
  const achados = { itens: [], ambiguos: [] };
  for (const bruta of String(texto || '').split(/\n+/)) {
    const linha = norm(bruta).trim();
    if (!linha || NAO_E_PEDIDO.test(linha)) continue;
    const exatos = produtosExatos(linha);
    const familia = familiaDe(linha);
    const opcoes = exatos.length ? exatos.map((i) => i.id) : familia ? opcoesDaFamilia(familia.categoria) : [];
    if (lidos.some((l) => l.trecho.includes(linha) ||
      (linha.includes(l.trecho) && (!opcoes.length || l.ids.some((id) => opcoes.includes(id)))))) continue;
    if (!opcoes.length || opcoes.some((id) => produtosLidos.has(id))) continue;
    // ...e só se o produto está no carrinho: "quantidade X Egg Bacon" sem X
    // Egg Bacon no carrinho não mexe em nada, e o pedido da linha se perderia.
    const noCarrinho = new Set((sess?.cart || []).map(produtoDaLinha));
    if (correcoes.some((c) => c.trecho && (c.trecho.includes(linha) || linha.includes(c.trecho)) &&
      (!cardapio.itemById(c.produto) || (opcoes.includes(c.produto) && noCarrinho.has(c.produto))))) continue;

    const numero = linha.match(/\b(\d+|um|uma|dois|duas|tres)\b/);
    const qtd = numero ? (EXTENSO[numero[1]] || Number(numero[1])) : null;
    log.warn({ evt: 'guiado', motivo: 'esquecido_pela_leitora', linha, opcoes }, 'linha com produto que a leitora não leu');
    if (opcoes.length === 1) {
      achados.itens.push({ produto: opcoes[0], qtd, sem: [], com: [], salsicha: null, ponto_bife: null, ponto_bacon: null,
        maionese_a_parte: false, trecho: bruta.trim() });
    } else {
      achados.ambiguos.push({ trecho: bruta.trim(), qtd, opcoes });
    }
  }
  return achados;
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

  // "Nao e egg bacon / Quero xegg bacon": numa prova a leitora tirou o Egg
  // Bacon e, na mesma leitura, pôs "2 Egg Bacon sem ovo, bacon". Item do mesmo
  // produto que a mensagem manda tirar, sem citá-lo pelo nome, é contradição.
  const tirarLido = leitura.correcoes.filter((c) => c.acao === 'tirar');
  const tirando = new Set(tirarLido.map((c) => produtoDaLinha({ id: c.linha })));
  const trechosTirar = tirarLido.map((c) => norm(c.trecho || '')).filter(Boolean);
  const linhasTexto = String(texto || '').split(/\n+/).map((l) => norm(l).trim()).filter(Boolean);
  leitura.itens = leitura.itens.filter((bruto) => {
    const id = produtoPeloId(bruto.produto)?.id;
    // O trecho é a própria linha do "não é"/"tira": ali nada é pedido. A
    // leitora pôs o X Egg Bacon (e "sem bacon") no trecho "Nao e egg bacon".
    const trechoItem = norm(bruto.trecho || '');
    if (trechoItem && trechosTirar.includes(trechoItem)) {
      log.warn({ evt: 'guiado', motivo: 'item_na_linha_do_tira', produto: bruto.produto, trecho: bruto.trecho },
        'item lido na linha de tirar descartado');
      return false;
    }
    if (!id || !tirando.has(id)) return true;
    // Fica se alguma linha que não é a do "tira" pede esse produto pelo nome.
    const trechoN = norm(bruto.trecho || '');
    const pede = linhasTexto.some((l) => (!trechoN || l.includes(trechoN) || trechoN.includes(l)) &&
      !trechosTirar.some((t) => t.includes(l) || l.includes(t)) &&
      produtosExatos(l).some((i) => i.id === id));
    if (pede) return true;
    log.warn({ evt: 'guiado', motivo: 'tira_e_poe_o_mesmo', produto: id, trecho: bruto.trecho }, 'item contraditório descartado');
    return false;
  });

  if (!leitura.refazer_lista && !leitura.cancelar) {
    const esquecidos = esquecidosPelaLeitora(leitura, texto, sess);
    leitura.itens.push(...esquecidos.itens);
    leitura.ambiguos.push(...esquecidos.ambiguos);
  }

  for (const a of leitura.ambiguos) {
    const opcoes = opcoesPeloNome(a.trecho || texto,
      a.opcoes.filter((id) => cardapio.disponivel(cardapio.itemById(id))));
    if (opcoes.length > 1) plano.ambiguos.push({ trecho: a.trecho, qtd: a.qtd, opcoes });
    else if (opcoes.length === 1) leitura.itens.push({ produto: opcoes[0], qtd: a.qtd, sem: [], com: [], trecho: a.trecho });
  }

  // "Salsicha a parte" sem citar lanche é a salsicha avulsa ($1), não
  // salsicha dentro do lanche que está no carrinho (teste de 18/09: a leitora
  // quis pôr no X Egg Burger).
  leitura.correcoes = leitura.correcoes.filter((c) => {
    const trechoC = norm(c.trecho || texto);
    if (!(c.com || []).includes('salsicha') || !/\ba\s*parte\b|\bseparad/.test(trechoC)) return true;
    if (produtosExatos(c.trecho || texto).length) return true;
    leitura.itens.push({ produto: 'salsicha', qtd: c.qtd || null, sem: [], com: [], trecho: c.trecho || texto });
    return false;
  });

  for (const bruto of leitura.itens) {
    let item = produtoPeloId(bruto.produto);
    const trecho = bruto.trecho || bruto.produto;

    // Nome inteiro vence: se o trecho cita outro produto por inteiro, é ele.
    const exatos = produtosExatos(trecho);
    if (exatos.length === 1 && exatos[0].id !== item?.id) {
      log.warn({ evt: 'guiado', motivo: 'produto_pelo_nome_exato', leu: bruto.produto, virou: exatos[0].id, trecho },
        'produto corrigido pelo nome exato da fala');
      item = exatos[0];
    } else if (exatos.length > 1 && !exatos.some((e) => e.id === item?.id)) {
      plano.ambiguos.push({ trecho, qtd: bruto.qtd, opcoes: exatos.map((e) => e.id) });
      continue;
    }

    // "Maionese à parte" nunca é sachê pago: sachê é quando ele pede sachê,
    // maionese extra ou adicional (teste de 18/09: "um maionese à parte" virou $1).
    if (item?.id === 'sache_maionese' && !/\b(?:sache|saches|extra|adicional|mais)\b/.test(norm(trecho))) {
      plano.alvos.push({ ingrediente: 'maionese_a_parte', qtd: null, trecho });
      continue;
    }

    if (!item || (!exatos.length && !citado(item, bruto.trecho, texto))) {
      // R4: produto que não está na fala não entra. Se a fala tem a família
      // ("hot dog"), pergunta qual; senão, avisa que não entendeu aquele trecho.
      const familia = familiaDe(trecho);
      if (familia) {
        plano.ambiguos.push({ trecho, qtd: bruto.qtd, opcoes: opcoesDaFamilia(familia.categoria) });
      } else {
        // Nada some em silêncio: o cliente fica sabendo o que não foi entendido.
        log.warn({ evt: 'guiado', motivo: 'produto_nao_citado', produto: bruto.produto, trecho }, 'item não entendido');
        plano.avisos.push(t(lang, item ? 'guiado_nao_entendi_trecho' : 'guiado_nao_temos', { trecho }));
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
    // "Hamburguer com bife bem passado" fala do bife que já vem: não cobra bife
    // extra. E "com maionese à parte" não é maionese a mais dentro do lanche.
    const pedidosCom = tools.semBaconDoPonto(tools.semBifeDoPonto(bruto.com, texto), texto, item)
      .filter((id) => !(bruto.maionese_a_parte && ['maionese', 'sache_maionese'].includes(id)));
    for (const id of pedidosCom) {
      if (acrescentaveis.has(id)) com.push(id);
      else plano.avisos.push(t(lang, 'guiado_nao_acrescenta', { ingrediente: modifiers.nomeDe(id, lang) }));
    }

    const linhasDoProduto = (sess.cart || []).filter((l) => produtoDaLinha(l) === item.id);
    // "São 2 xegg bacon" com os 2 já em duas linhas (um com maionese à
    // parte): a quantidade final já bate, nada muda.
    const jaTem = linhasDoProduto.reduce((t, l) => t + Number(l.qty || 0), 0);
    if (bruto.qtd && linhasDoProduto.length > 1 && QUANTIDADE_FINAL.test(norm(trecho))) {
      if (jaTem !== bruto.qtd) {
        plano.avisos.push(t(lang, 'guiado_qual_item', { opcoes: linhasDoProduto.map((l) => l.name).join(' ou ') }));
      }
      continue;
    }
    if (bruto.qtd && linhasDoProduto.length === 1 && QUANTIDADE_FINAL.test(norm(trecho))) {
      plano.correcoes.push({ acao: 'quantidade', linha: linhasDoProduto[0], qtd: bruto.qtd, sem: [], com: [], trecho });
      continue;
    }

    // Ponto do bacon (pedido do dono, 18/09): a fala decide de quem é o ponto.
    // "bacon bem passado" que a leitora pôs no bife volta para o bacon.
    const pontoBaconFala = tools.pontoBaconDoTexto(trecho);
    if (pontoBaconFala && !bruto.ponto_bacon) bruto.ponto_bacon = pontoBaconFala;
    if (bruto.ponto_bife && pontoBaconFala && !tools.pontoBifeDoTexto(trecho)) bruto.ponto_bife = null;

    plano.itens.push({
      trecho,
      citaProduto: produtosExatos(trecho).length > 0 || tools.nomeCitado(tools.nomesDoItem(item), bruto.trecho || ''),
      qtdDita: NUMERO.test(norm(trecho)),
      item_id: item.id,
      quantidade: qtd,
      remover: sem,
      acrescentar: com,
      ...(bruto.salsicha ? { preparo_salsicha: bruto.salsicha } : {}),
      ...(bruto.ponto_bife ? { ponto_bife: bruto.ponto_bife } : {}),
      ...(bruto.ponto_bacon ? { ponto_bacon: bruto.ponto_bacon } : {}),
      ...(bruto.maionese_a_parte && ehLanche(item) ? { maionese_a_parte: true } : {}),
    });
  }

  const produtosNoCarrinho = new Set((sess.cart || []).map(produtoDaLinha));
  const produtosNovos = new Set(plano.itens.map((i) => i.item_id));
  for (const bruto of leitura.correcoes) {
    const c = { ...bruto };
    // Correção de produto que não está no carrinho mas entrou agora como item:
    // é o próprio pedido novo, lido duas vezes. Nada a corrigir.
    const alvo = produtoDaLinha({ id: c.linha });
    if (!produtosNoCarrinho.has(alvo) && produtosNovos.has(alvo)) continue;
    // "Tira tomate egg bacon" é tirar o TOMATE. No teste de 18/09 a leitora
    // mandou tirar a linha inteira — e a linha errada, o X-Tudo.
    if (c.acao === 'tirar' && (c.sem.length || c.com.length)) c.acao = 'alterar';

    let linha = (sess.cart || []).find((l) => l.id === c.linha) || unicaLinhaDoProduto(sess, c.linha);
    const apontadas = linhasApontadas(sess, c.trecho || texto);
    // "Tira tomate egg bacon" com o X Egg Bacon em duas linhas (uma com a
    // maionese à parte): a fala cita o produto, vale para todas as linhas dele.
    if (c.acao === 'alterar' && apontadas.length > 1 &&
        new Set(apontadas.map(produtoDaLinha)).size === 1) {
      for (const l of apontadas) plano.correcoes.push({ ...c, linha: l });
      continue;
    }
    if (apontadas.length === 1) linha = apontadas[0];
    else if (apontadas.length > 1 && !apontadas.includes(linha)) linha = null;

    const lanches = (sess.cart || []).filter((l) => ehLanche(cardapio.itemById(produtoDaLinha(l))));
    const falaCita = apontadas.includes(linha);
    // Tirar ou mudar a quantidade exige que a fala cite o item. Alterar sem
    // citar só vale quando há um lanche só.
    if (!linha || (!falaCita && (c.acao !== 'alterar' || lanches.length > 1))) {
      plano.avisos.push(t(lang, 'guiado_qual_item', { opcoes: (sess.cart || []).map((l) => l.name).join(' ou ') }));
      continue;
    }
    plano.correcoes.push({ ...c, linha });
  }

  // A observação fica na linha cujo trecho a menciona. "2 x egg burger, 1 sem
  // maionese": a leitora pôs o "sem maionese" no total ("2 x egg burger") e
  // deixou o "1 sem maionese" sem nada — ou pôs nos dois (prova de 18/09).
  const mencionaIngrediente = (trecho, id) => {
    const n = norm(trecho || '');
    return [id, modifiers.nomeDe(id, lang)].some((nomeI) => nomeI && n.includes(norm(nomeI)));
  };
  const grupos = new Map();
  for (const i of plano.itens) grupos.set(i.item_id, [...(grupos.get(i.item_id) || []), i]);
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    for (const campo of ['remover', 'acrescentar']) {
      const ids = new Set(grupo.flatMap((i) => i[campo]));
      for (const id of ids) {
        const donos = grupo.filter((i) => mencionaIngrediente(i.trecho, id));
        if (!donos.length || donos.length === grupo.length) continue;
        for (const i of grupo) {
          const tem = i[campo].includes(id);
          if (donos.includes(i) && !tem) i[campo] = [...i[campo], id];
          if (!donos.includes(i) && tem) i[campo] = i[campo].filter((x) => x !== id);
        }
        log.info({ evt: 'guiado', motivo: 'observacao_na_linha_certa', produto: grupo[0].item_id, ingrediente: id },
          'observação movida para a linha que a cita');
      }
    }
  }

  // "2 x egg burger, 1 sem maionese": a leitora às vezes devolve duas linhas
  // (2 e 1) com o MESMO trecho, a frase inteira — não dá para saber qual é o
  // total. Com o total escrito no trecho, vira uma linha só com o total; a
  // divisão abaixo separa pelo número colado no "sem" (prova de 18/09).
  const porTrecho = new Map();
  for (const i of plano.itens) {
    const chave = `${i.item_id}|${norm(i.trecho || '')}`;
    porTrecho.set(chave, [...(porTrecho.get(chave) || []), i]);
  }
  for (const grupo of porTrecho.values()) {
    if (grupo.length < 2 || !grupo[0].trecho) continue;
    const escrito = totalEscrito(grupo[0].trecho, cardapio.itemById(grupo[0].item_id));
    if (!escrito) continue;
    const [primeira, ...resto] = grupo;
    primeira.quantidade = escrito;
    for (const campo of ['remover', 'acrescentar']) {
      primeira[campo] = [...new Set(grupo.flatMap((i) => i[campo]))];
    }
    for (const campo of ['ponto_bife', 'ponto_bacon', 'maionese_a_parte']) {
      if (!primeira[campo]) {
        const achado = resto.find((i) => i[campo]);
        if (achado) primeira[campo] = achado[campo];
      }
    }
    plano.itens = plano.itens.filter((i) => !resto.includes(i));
    log.info({ evt: 'guiado', motivo: 'linhas_do_mesmo_trecho', produto: primeira.item_id, total: escrito },
      'linhas repetidas do mesmo trecho viraram o total escrito');
  }

  // "2 xegg burguer 1 sem maionese": a leitora às vezes põe a observação nos
  // dois (teste de 18/09). O número colado no "sem/com" diz quantos levam a
  // observação; o resto vai sem. Só quando o produto veio numa linha só.
  const contagem = new Map();
  for (const i of plano.itens) contagem.set(i.item_id, (contagem.get(i.item_id) || 0) + 1);
  for (const i of [...plano.itens]) {
    if (contagem.get(i.item_id) !== 1 || i.quantidade < 2) continue;
    if (!i.remover.length && !i.acrescentar.length && !i.ponto_bife && !i.ponto_bacon && !i.maionese_a_parte) continue;
    const parte = quantosComObservacao(i.trecho);
    if (!parte || parte >= i.quantidade) continue;
    plano.itens.splice(plano.itens.indexOf(i), 0, {
      ...i, quantidade: i.quantidade - parte, remover: [], acrescentar: [],
      ponto_bife: undefined, ponto_bacon: undefined, maionese_a_parte: undefined,
    });
    i.quantidade = parte;
    log.info({ evt: 'guiado', motivo: 'observacao_em_parte', produto: i.item_id, com_observacao: parte },
      'observação só em parte dos lanches');
  }
  for (const i of plano.itens) {
    if (i.ponto_bife === undefined) delete i.ponto_bife;
    if (i.ponto_bacon === undefined) delete i.ponto_bacon;
    if (i.maionese_a_parte === undefined) delete i.maionese_a_parte;
  }

  // "2 x egg bacon, 1 com maionese à parte": a leitora às vezes devolve o total
  // (2) E a especificação (1), somando 3. A linha que diz o total cita o
  // produto e não tem observação; as especificações não citam o produto. Elas
  // saem do total. "2 x tudo e 1 x tudo sem cebola" continua 3: ali a segunda
  // linha cita o produto.
  const porProduto = new Map();
  for (const i of plano.itens) porProduto.set(i.item_id, [...(porProduto.get(i.item_id) || []), i]);
  for (const grupo of porProduto.values()) {
    const semObservacao = (i) => !i.remover.length && !i.acrescentar.length && !i.ponto_bife && !i.ponto_bacon && !i.maionese_a_parte;
    const especificacoes = grupo.filter((i) => !i.citaProduto);
    // "2 x egg burger, 1 sem maionese": a leitora às vezes copia o "sem
    // maionese" também na linha do total (prova de 18/09). Total com o número
    // escrito que só repete observações das especificações é o total puro.
    const escritoAqui = totalEscrito(texto, cardapio.itemById(grupo[0].item_id));
    const citando = grupo.filter((i) => i.citaProduto);
    if (especificacoes.length && citando.length === 1 && escritoAqui && citando[0].quantidade === escritoAqui &&
        !semObservacao(citando[0])) {
      const t0 = citando[0];
      const dasEspecificacoes = (campo) => new Set(especificacoes.flatMap((i) => i[campo]));
      const repete = t0.remover.every((id) => dasEspecificacoes('remover').has(id)) &&
        t0.acrescentar.every((id) => dasEspecificacoes('acrescentar').has(id)) &&
        (!t0.ponto_bife || especificacoes.some((i) => i.ponto_bife === t0.ponto_bife)) &&
        (!t0.ponto_bacon || especificacoes.some((i) => i.ponto_bacon === t0.ponto_bacon)) &&
        (!t0.maionese_a_parte || especificacoes.some((i) => i.maionese_a_parte));
      if (repete) {
        t0.remover = []; t0.acrescentar = [];
        delete t0.ponto_bife; delete t0.ponto_bacon; delete t0.maionese_a_parte;
      }
    }
    const totais = grupo.filter((i) => i.citaProduto && semObservacao(i));
    const soma = especificacoes.reduce((t, i) => t + i.quantidade, 0);
    // Só desconta quando a linha do total é o número que ele escreveu e a soma
    // passou dele: se a leitora já separou certo (1 + 1 de 2), nada muda.
    const escrito = totalEscrito(texto, cardapio.itemById(grupo[0].item_id));
    if (totais.length === 1 && especificacoes.length && escrito &&
        totais[0].quantidade === escrito && totais[0].quantidade + soma > escrito &&
        totais[0].quantidade >= soma) {
      totais[0].quantidade -= soma;
      log.info({ evt: 'guiado', motivo: 'total_e_especificacao', produto: totais[0].item_id, restam: totais[0].quantidade },
        'especificação descontada do total');
    }
  }
  plano.itens = plano.itens.filter((i) => i.quantidade > 0);

  // O cliente escreveu o total ("3 x tudo") e a soma anotada deu outro número:
  // anota o que foi lido e pergunta. Frase como a do #155 ("3 x tudo, os 2...,
  // 1 sem alface, 1 com banana") é ambígua até para gente.
  for (const [id, grupo] of porProduto) {
    const total = totalEscrito(texto, cardapio.itemById(id));
    const soma = grupo.filter((i) => i.quantidade > 0).reduce((t, i) => t + i.quantidade, 0);
    if (total && soma && soma !== total) {
      plano.avisos.push(t(lang, 'guiado_confere_total', { total, soma, produto: nome(cardapio.itemById(id), lang) }));
    }
  }

  // "Não é egg bacon, quero x egg bacon": o produto novo, sem número dito,
  // herda a quantidade e as observações do que saiu.
  const tiradas = plano.correcoes.filter((c) => c.acao === 'tirar');
  if (tiradas.length === 1) {
    const saiu = tiradas[0].linha;
    for (const i of plano.itens) {
      if (i.qtdDita) continue;
      i.quantidade = saiu.qty;
      if (saiu.maioneseAParte && !i.maionese_a_parte) i.maionese_a_parte = true;
      if (saiu.pontoBife && !i.ponto_bife) i.ponto_bife = saiu.pontoBife;
      if (saiu.pontoBacon && !i.ponto_bacon) i.ponto_bacon = saiu.pontoBacon;
    }
  }

  // R1/R8: acréscimo sem lanche indicado vai no único lanche possível; com
  // mais de um, pergunta em qual.
  for (const alvo of plano.alvos) {
    const novosLanches = plano.itens.filter((i) => ehLanche(cardapio.itemById(i.item_id)));
    const noCarrinho = (sess.cart || []).filter((l) => ehLanche(cardapio.itemById(produtoDaLinha(l))));
    if (novosLanches.length + noCarrinho.length === 1) {
      const aParte = alvo.ingrediente === 'maionese_a_parte';
      if (novosLanches.length) {
        if (aParte) novosLanches[0].maionese_a_parte = true;
        else novosLanches[0].acrescentar = [...new Set([...novosLanches[0].acrescentar, alvo.ingrediente])];
      } else {
        plano.correcoes.push({
          acao: 'alterar', linha: noCarrinho[0], sem: [], com: aParte ? [] : [alvo.ingrediente],
          ...(aParte ? { maionese_a_parte: true } : {}), trecho: alvo.trecho,
        });
      }
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
        linha_exata: true,
        quantidade: c.linha.qty,
        remover: (c.sem || []).filter((id) => removiveis.has(id)),
        acrescentar: (c.com || []).filter((id) => acrescentaveis.has(id)),
        ...(c.ponto_bife ? { ponto_bife: c.ponto_bife } : {}),
        ...(c.ponto_bacon ? { ponto_bacon: c.ponto_bacon } : {}),
        ...(c.maionese_a_parte ? { maionese_a_parte: true } : {}),
      });
      if (r?.bloqueiaFluxo) log.warn({ evt: 'guiado', motivo: 'alteracao_recusada', resultado: r.resultado }, 'alteração não aplicada');
    }
  }

  for (const { qtdDita: _dita, trecho: _trecho, citaProduto: _cita, ...i } of plano.itens) {
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
  const opcoes = lanches.map((l) => l.name).join(' ou ');
  if (alvo.ingrediente === 'maionese_a_parte') return t(lang, 'guiado_qual_lanche_maionese', { opcoes });
  return t(lang, 'guiado_qual_lanche', { ingrediente: modifiers.nomeDe(alvo.ingrediente, lang), opcoes });
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

/**
 * Carrinho do catálogo recebido: o fluxo guiado segue daqui, com a pergunta
 * fixa. Antes quem perguntava era o agente antigo, em texto livre, e a
 * leitora não sabia o que tinha sido perguntado — o "Não" seguinte (teste de
 * 18/09) não foi entendido, e o estado ficava em MENU.
 */
async function aposCarrinho(sess, send) {
  const lang = sess.lang || 'pt';
  if (['LANGUAGE', 'MENU'].includes(sess.state)) sess.state = 'ORDER';
  const proxima = tools.mensagemColeta(sess);
  const texto = `${t(lang, 'guiado_anotei')}\n${require('../bot/handlers/order').summaryLines(sess.cart, lang)}` +
    (proxima ? `\n\n${proxima}` : '');
  await send(texto);
  anotar(sess.phone, { de: 'cliente', texto: '[carrinho do catálogo]',
    leitura: sess.cart.map((l) => `${l.qty}x ${l.productId || l.id}`).join(', ') });
  anotar(sess.phone, { de: 'bot', texto });
  estado(sess).ultimaPergunta = proxima || null;
  return true;
}

// ------------------------------------------------------------------ entrada

/**
 * Atende uma mensagem pelo fluxo guiado. Devolve false quando não conseguiu
 * ler — aí o agente de sempre assume.
 */
// ------------------------------------------------ conversa para o painel

// O log de conversas (aba Conversas do painel) gravava só o histórico do
// agente antigo; com o fluxo guiado ligado ele ficava vazio. Aqui fica o que o
// cliente disse, o que o bot respondeu e o que a leitura entendeu — que é o
// material para corrigir a leitura depois. Grava quando a sessão reinicia.
const transcricoes = new Map();
const MAX_LINHAS = 120;

function anotar(phone, linha) {
  if (!transcricoes.has(phone)) transcricoes.set(phone, []);
  const linhas = transcricoes.get(phone);
  if (linhas.length < MAX_LINHAS) linhas.push(linha);
}

function resumoDoPlano(plano) {
  const partes = plano.itens.map((i) => [
    `${i.quantidade}x ${i.item_id}`,
    ...i.remover.map((id) => `-${id}`),
    ...i.acrescentar.map((id) => `+${id}`),
    ...(i.ponto_bife ? [`~${i.ponto_bife}`] : []),
    ...(i.ponto_bacon ? [`~bacon_${i.ponto_bacon}`] : []),
    ...(i.maionese_a_parte ? ['~maionese_a_parte'] : []),
  ].join(' '));
  for (const c of plano.correcoes) partes.push(`${c.acao} ${c.linha?.id}${c.qtd != null ? ` ${c.qtd}` : ''}`);
  for (const a of plano.ambiguos) partes.push(`? ${a.opcoes.join('|')}`);
  return partes.join(', ');
}

function fecharTranscricao(phone) {
  const linhas = transcricoes.get(phone);
  transcricoes.delete(phone);
  if (!linhas || !linhas.some((l) => l.de === 'cliente')) return;
  require('../db/queries').registrarConversa(phone, linhas)
    .catch((err) => log.error({ evt: 'conversas_log', err }, 'falha ao registrar conversa do fluxo guiado'));
}
session.aoReiniciar(fecharTranscricao);

async function atender(sess, texto, send, opcoes = {}) {
  const linhaCliente = { de: 'cliente', texto: String(texto || '').trim() };
  const respostas = [];
  const enviar = async (msg) => {
    respostas.push(msg);
    return send(msg);
  };
  const atendido = await atenderSemAnotar(sess, texto, enviar, opcoes, linhaCliente);
  if (atendido) {
    anotar(sess.phone, linhaCliente);
    for (const r of respostas) anotar(sess.phone, { de: 'bot', texto: String(r || '').trim() });
  }
  return atendido;
}

async function atenderSemAnotar(sess, texto, send, { citada } = {}, linhaCliente = {}) {
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
  const entendeu = resumoDoPlano(plano);
  if (entendeu) linhaCliente.leitura = entendeu;
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

module.exports = { ligado, atender, validar, aposCarrinho, _transcricoes: transcricoes };
