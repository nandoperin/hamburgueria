#!/usr/bin/env node
/**
 * Prova da IA leitora (fluxo guiado) contra o modelo REAL, com frases reais.
 *
 * Gasta chamadas pagas (centavos). Não toca no banco: o módulo de queries é
 * substituído antes de qualquer require, e o cardápio é o de config/*.json.
 *
 *   node scripts/prova-leitor.js
 *   node scripts/prova-leitor.js --modelo=mistral-medium-latest
 *   node scripts/prova-leitor.js --caso=hot
 *
 * Cada caso tem as checagens que importam para o dono: produto certo, nada
 * inventado, acréscimo e não porção, pagamento nunca presumido.
 */
require('../src/env')();
const args = process.argv.slice(2);
const opcao = (nome, padrao) => (args.find((a) => a.startsWith(`--${nome}=`)) || '').split('=').slice(1).join('=') || padrao;
if (opcao('modelo')) process.env.AI_MODEL = opcao('modelo');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://prova-sem-banco';
process.env.AI_ENABLED = 'on';
process.env.AI_MAX_USD_DIA = '0';
process.env.AI_MAX_TOKENS_CONVERSA = '0';
process.env.LOG_LEVEL = 'silent';

const path = require('path');
const dbPath = require.resolve(path.join(__dirname, '../src/db/queries'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: new Proxy({}, { get: () => async () => null }) };

// O cardápio de produção (tirado de /cardapio) é o que importa: tem pares
// quase iguais — Egg Bacon e X Egg Bacon — que a semente não tem. --semente
// volta ao config/menu.json.
if (!args.includes('--semente')) {
  const config = require('../src/services/config');
  const getReal = config.get;
  const menuProducao = require('../test/fixtures/menu-producao.json');
  config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
}

const leitor = require('../src/ai/leitor');
const guiado = require('../src/ai/guiado');
const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

let seq = 0;
const tempos = [];
const modelos = new Set();
function sessao({ carrinho = [], pergunta = null, estado = 'MENU' } = {}) {
  const s = session.get(`1999000${String(++seq).padStart(4, '0')}`);
  s.lang = 'pt';
  for (const [id, qtd] of carrinho) tools.carrinho.adicionar(s, { item_id: id, quantidade: qtd });
  s.state = estado;
  s.guiado = { ultimaPergunta: pergunta };
  return s;
}

const itens = (l) => l.itens;
const um = (l, id) => l.itens.filter((i) => i.produto === id);
const soma = (l, id) => um(l, id).reduce((t, i) => t + (i.qtd || 1), 0);

const CASOS = [
  { nome: 'pedido inteiro com "2 hot dog"', texto: 'boa noite\n1 xtudo\n2 hot dog\n1 coca\npara entrega',
    checar: (l) => [
      ['x tudo 1', soma(l, 'x_tudo') === 1],
      ['coca 1', soma(l, 'coca_cola') === 1],
      ['hot dog não escolhido sozinho', !l.itens.some((i) => i.produto.startsWith('hot_')) && l.ambiguos.length >= 1],
      ['entrega', l.entrega === 'entrega'],
    ] },
  { nome: '#155 variações e maionese à parte',
    texto: '3 x tudo , os 2 sem maionese dentro , as maionese a parte \n \n1 sem alface e sem parmesão \n1 com banana 🍌',
    checar: (l) => [
      ['total 3 x tudo, ou pergunta', soma(l, 'x_tudo') === 3 || (l.avisos || []).some((a) => /Confere/.test(a))],
      ['banana é "com", não item', !l.itens.some((i) => i.produto === 'banana') && l.itens.some((i) => i.com.includes('banana'))],
      ['maionese à parte marcada', l.itens.some((i) => i.maionese_a_parte)],
      ['sem sachê cobrado', !l.itens.some((i) => i.produto === 'sache_maionese')],
    ] },
  { nome: '#154 "3x bacon" repetido', texto: '3x bacon', carrinho: [['xbacon', 3]], pergunta: 'Quer algo mais?',
    checar: (l) => [
      ['nada de bacon extra', !l.itens.some((i) => i.produto === 'bacon' || i.com.includes('bacon')) && !l.correcoes.some((c) => c.com.includes('bacon'))],
      ['nada de X-Bacon a mais', soma(l, 'xbacon') === 0 || l.refazer_lista],
    ] },
  { nome: '"com dois ovos"', texto: 'quero 2 macarrao na chapa sem queijo e com dois ovos',
    checar: (l) => [
      ['2 macarrões', soma(l, 'macarrao_chapa') === 2],
      ['ovo é acréscimo', l.itens.some((i) => i.produto === 'macarrao_chapa' && i.com.includes('ovo'))],
      ['nenhuma porção de ovo', !l.itens.some((i) => i.produto === 'ovo')],
    ] },
  { nome: 'cartão', texto: 'Quanto fica? vai ser cartao.', carrinho: [['x_tudo', 1]],
    checar: (l) => [['pagamento = cartão', l.pagamento === 'cartao']] },
  { nome: '"Ok" não é nome', texto: 'Ok', carrinho: [['x_tudo', 1]], pergunta: 'Me passa seu nome e endereço de entrega.',
    checar: (l) => [['sem nome', !l.nome], ['sem itens', !l.itens.length]] },
  { nome: 'nome e endereço', texto: 'Kiki \n13 Prescott st Everett', carrinho: [['xbacon', 3]], pergunta: 'Me passa seu nome e endereço de entrega.',
    checar: (l) => [['nome Kiki', /kiki/i.test(l.nome || '')], ['endereço', /13 prescott/i.test(l.endereco || '')]] },
  { nome: 'ponto do bife', texto: 'um x burger bem passado',
    checar: (l) => [['x burger', soma(l, 'x_burger') === 1], ['bem passado', l.itens.some((i) => i.ponto_bife === 'bem_passado')],
      ['sem bife extra', !l.itens.some((i) => i.com.includes('bife'))]] },
  { nome: 'previsão = status', texto: 'olá\ntem previsão de chegada?',
    checar: (l) => [['status do pedido ou tempo', ['status_pedido', 'tempo'].includes(l.pergunta)], ['sem itens', !l.itens.length]] },
  { nome: 'fiado', texto: 'Ola boa noite, queria ver se poderia me vender hoje, amanha te pago 10 a mais fora o delivery',
    checar: (l) => [['fiado', l.pergunta === 'fiado'], ['sem itens', !l.itens.length]] },
  { nome: '"Só isso"', texto: 'Só isso', carrinho: [['x_tudo', 1]], pergunta: 'Quer algo mais? Digite menu para abrir as opções.',
    checar: (l) => [['concluiu', l.concluiu_itens], ['sem itens', !l.itens.length]] },
  { nome: 'x tudão sem alface/tomate + guaraná', texto: 'Vou querer 1 X-TUDÃO sem alface e sem tomate \n1 Guaraná lata',
    checar: (l) => [['x tudão sem alface e tomate', um(l, 'x_tudao').some((i) => i.sem.includes('alface') && i.sem.includes('tomate'))],
      ['guaraná', soma(l, 'guarana') === 1]] },
  { nome: 'cash', texto: 'Pagamento vai ser em cash', carrinho: [['hot_completo', 1]],
    checar: (l) => [['cash', l.pagamento === 'cash']] },
  { nome: 'troco', texto: 'Troco para 100', carrinho: [['hot_completo', 1]], estado: 'CASH_CHANGE', pergunta: 'Vai precisar de troco?',
    checar: (l) => [['troco 100', l.troco === 100]] },
  { nome: 'tira a coca', texto: 'tira a coca pfv', carrinho: [['x_tudo', 1], ['coca_cola', 1]],
    checar: (l) => [['correção tirar coca', l.correcoes.some((c) => c.acao === 'tirar' && /coca/.test(c.linha))], ['sem itens novos', !l.itens.length]] },
  { nome: 'acréscimo de banana', texto: 'Um x salada com acréscimo de banan',
    checar: (l) => [['x salada com banana', um(l, 'x_salada').some((i) => i.com.includes('banana'))], ['sem porção de banana', !l.itens.some((i) => i.produto === 'banana')]] },
  // ---- o teste do dono de 18/09 (#158), no cardápio de produção
  { nome: '#158 x egg bacon com uma maionese à parte',
    texto: 'Ola boa noite\nQuero um xtudo sem tomate \n2 x egg bacon 1 com maionese a parte',
    checar: (l) => [
      ['x tudo sem tomate', um(l, 'x_tudo').some((i) => i.sem.includes('tomate'))],
      ['X Egg Bacon, não Egg Bacon', soma(l, 'xeggbacon') === 2 && !um(l, 'egg_bacon').length],
      ['só 1 com maionese à parte', um(l, 'xeggbacon').filter((i) => i.maionese_a_parte).reduce((t, i) => t + (i.qtd || 1), 0) === 1],
    ] },
  { nome: '#158 bife bem passado', texto: 'Hamburguer com bife bem passado',
    checar: (l) => [['hamburger', um(l, 'hamburger').length === 1], ['bem passado', l.itens.some((i) => i.ponto_bife === 'bem_passado')]] },
  { nome: '#158 tira tomate', texto: 'Tira tomate egg bacon', carrinho: [['x_tudo', 1], ['xeggbacon', 2]],
    checar: (l) => [
      ['não tira o X-Tudo', !l.correcoes.some((c) => c.acao === 'tirar' && /x_tudo/.test(c.linha) && !c.sem.length)],
      ['tomate sai do egg bacon', l.correcoes.some((c) => /egg/.test(c.linha) && c.sem.includes('tomate'))],
    ] },
  { nome: '#158 troca de produto', texto: 'Nao e egg bacon\nQuero xegg bacon', carrinho: [['egg_bacon', 2]],
    checar: (l) => [
      ['tira o Egg Bacon', l.correcoes.some((c) => c.acao === 'tirar' && /egg_bacon/.test(c.linha))],
      ['põe o X Egg Bacon', um(l, 'xeggbacon').length === 1],
    ] },
  { nome: '#158 maionese à parte não é sachê', texto: 'Sao 2 e um maionese a oarte', carrinho: [['x_tudo', 1], ['xeggbacon', 2]],
    checar: (l) => [['sem sachê', !um(l, 'sache_maionese').length]] },
  { nome: 'responde "qual hot dog?"', texto: 'completo', carrinho: [['x_tudo', 1]],
    pergunta: 'Qual você quer em "2 hot dog"? Temos: Hot plain, Hot simples, Hot Duplo, Hot completo, Hot especial, Hot tudo.',
    checar: (l) => [['hot completo', um(l, 'hot_completo').length === 1]] },

  // Ponto do bacon (pedido do dono, 18/09): observação, não bacon a mais.
  { nome: 'ponto do bacon', texto: 'um x bacon com bacon bem passado',
    checar: (l) => [
      ['x bacon', soma(l, 'xbacon') === 1],
      ['bacon bem passado', um(l, 'xbacon').some((i) => i.ponto_bacon === 'bem_passado')],
      ['sem bacon extra nem ponto do bife', !l.itens.some((i) => i.com.includes('bacon') || i.ponto_bife)],
    ] },
  { nome: 'ponto do bife e do bacon', texto: 'x tudo com bife mal passado e bacon bem passado',
    checar: (l) => [
      ['bife mal passado', um(l, 'x_tudo').some((i) => i.ponto_bife === 'mal_passado')],
      ['bacon bem passado', um(l, 'x_tudo').some((i) => i.ponto_bacon === 'bem_passado')],
    ] },

  // Parecidos (não iguais) com os erros de 18/09 que viraram exemplo:
  // mede se a base de exemplos ensina, e não só decora a frase.
  { nome: 'exemplo: "2 ..., 1 sem maionese" com outra escrita', texto: 'boa tarde\n2 x egg burger, 1 sem maionese',
    checar: (l) => [
      ['2 X Egg Burger', soma(l, 'x_egg_burger') === 2],
      ['só 1 sem maionese', um(l, 'x_egg_burger').filter((i) => i.sem.includes('maionese')).reduce((t, i) => t + (i.qtd || 1), 0) === 1],
    ] },
  { nome: 'exemplo: "3 xtudo 1 sem cebola"', texto: '3 xtudo 1 sem cebola',
    checar: (l) => [
      ['3 X Tudo', soma(l, 'x_tudo') === 3],
      ['só 1 sem cebola', um(l, 'x_tudo').filter((i) => i.sem.includes('cebola')).reduce((t, i) => t + (i.qtd || 1), 0) === 1],
    ] },
];

(async () => {
  const filtro = opcao('caso', '').toLowerCase();
  let ok = 0; let total = 0; let casosOk = 0;
  for (const caso of CASOS.filter((c) => !filtro || c.nome.toLowerCase().includes(filtro))) {
    const s = sessao(caso);
    const r = await leitor.ler(s, caso.texto);
    if (r.ms) tempos.push(r.ms);
    if (r.modelo) modelos.add(r.modelo);
    console.log(`\n\x1b[1m${caso.nome}\x1b[0m  ${JSON.stringify(caso.texto)}`);
    if (!r.ok) { console.log(`  \x1b[31mLEITURA FALHOU: ${r.motivo}\x1b[0m`); total += 1; continue; }
    // O que conta é o que o cliente recebe: a leitura DEPOIS do validador
    // (nome exato, id inventado, total e especificação, bife do ponto...).
    // --cru mede só a leitora.
    const d = r.dados;
    if (!args.includes('--cru')) {
      const plano = guiado.validar(s, JSON.parse(JSON.stringify(d)), caso.texto);
      d.itens = plano.itens.map((i) => ({
        produto: i.item_id, qtd: i.quantidade, sem: i.remover, com: i.acrescentar,
        ponto_bife: i.ponto_bife || null, ponto_bacon: i.ponto_bacon || null, maionese_a_parte: Boolean(i.maionese_a_parte),
      }));
      d.correcoes = plano.correcoes.map((c) => ({ ...c, linha: c.linha.id, sem: c.sem || [], com: c.com || [] }));
      d.ambiguos = plano.ambiguos;
      d.avisos = plano.avisos;
    }
    const resumo = {
      itens: d.itens.map((i) => `${i.qtd ?? '?'}x ${i.produto}${i.sem.length ? ` sem ${i.sem}` : ''}${i.com.length ? ` com ${i.com}` : ''}${i.ponto_bife ? ` ${i.ponto_bife}` : ''}${i.maionese_a_parte ? ' maionese-a-parte' : ''}`),
      ...(d.ambiguos.length ? { ambiguos: d.ambiguos.map((a) => `${a.trecho} → ${a.opcoes.join('/')}`) } : {}),
      ...(d.correcoes.length ? { correcoes: d.correcoes.map((c) => `${c.acao} ${c.linha}${c.qtd != null ? ` ${c.qtd}` : ''}${c.com.length ? ` com ${c.com}` : ''}${c.sem.length ? ` sem ${c.sem}` : ''}`) } : {}),
      ...(d.avisos?.length ? { avisos: d.avisos } : {}),
      ...Object.fromEntries(['refazer_lista', 'concluiu_itens', 'entrega', 'endereco', 'nome', 'pagamento', 'troco', 'pergunta']
        .filter((k) => d[k]).map((k) => [k, d[k]])),
    };
    console.log('  ' + JSON.stringify(resumo));
    let todos = true;
    for (const [rotulo, passou] of caso.checar(d)) {
      total += 1; if (passou) ok += 1; else todos = false;
      console.log(`  ${passou ? '\x1b[32m✔' : '\x1b[31m✘'} ${rotulo}\x1b[0m`);
    }
    if (todos) casosOk += 1;
    await new Promise((res) => setTimeout(res, 1100));
  }
  if (tempos.length) {
    const ord = [...tempos].sort((a, b) => a - b);
    const media = Math.round(tempos.reduce((t, x) => t + x, 0) / tempos.length);
    console.log(`\nmodelo: ${[...modelos].join(', ')} · tempo médio ${media} ms · pior ${ord[ord.length - 1]} ms`);
  }
  console.log(`\n${casosOk}/${CASOS.filter((c) => !filtro || c.nome.toLowerCase().includes(filtro)).length} casos inteiros certos · ${ok}/${total} checagens`);
})().catch((e) => { console.error(e); process.exit(1); });
