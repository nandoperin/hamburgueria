#!/usr/bin/env node
require('dotenv').config();

/**
 * A prova de fogo: o modelo conduz o checkout de verdade?
 *
 * ## Por que isto não está em `test/`
 *
 * Porque **custa dinheiro** e **não é determinístico**. A suíte de `test/` roda
 * com `AI_ENABLED=off` de propósito: um `npm test` num CI que chamasse o modelo
 * viraria fatura em laço. Esta prova é o contrário — ela existe justamente para
 * gastar alguns centavos de propósito, com chave, quando alguém quiser saber se
 * o modelo escolhido dá conta.
 *
 * ## A pergunta que ela responde
 *
 * "Esse modelo tem custo-benefício para a minha demanda?" não se responde por
 * benchmark de terceiro. O que decide é se **este** modelo, com **estas** oito
 * ferramentas, em **português de cliente de WhatsApp**, chama a ferramenta certa
 * na hora certa. Modelo pequeno degrada exatamente aí: no sequenciamento.
 *
 * O que a arquitetura já garante é que errar não custa dinheiro — preço e
 * cobertura não saem do modelo, e `test/checkouttest.js` trava isso sem gastar
 * um centavo. O que ela não garante é a **experiência**: um modelo que erra
 * ferramenta pergunta a cidade duas vezes, esquece o que o cliente já disse, ou
 * responde "claro, entregamos!" antes de consultar a cobertura.
 *
 * ## Como usar
 *
 *   node scripts/prova-conversa.js
 *   node scripts/prova-conversa.js --modelo=mistral-large-latest
 *   node scripts/prova-conversa.js --provedor=claude --modelo=claude-haiku-4-5
 *   node scripts/prova-conversa.js --repeticoes=3
 *
 * `--repeticoes` é o que transforma impressão em evidência: modelo pequeno
 * acerta uma vez e erra na outra, e uma rodada só não distingue "funciona" de
 * "deu sorte". Três rodadas com 100% é outra conversa.
 *
 * Ao final sai o custo real medido por `ai/custo.js` — o mesmo módulo que
 * decide o corte em produção, então o número aqui é o número de lá.
 */

const args = process.argv.slice(2);
const opcao = (nome, padrao) => {
  const achado = args.find((a) => a.startsWith(`--${nome}=`));
  return achado ? achado.split('=').slice(1).join('=') : padrao;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Prova a conversa contra o modelo REAL. Gasta chamadas pagas.

  --provedor=claude|openai|mistral   padrão: o do .env
  --modelo=<nome>                    padrão: o do .env
  --repeticoes=N                     padrão: 1
  --cenario=<trecho do nome>         roda só os que casarem
`);
  process.exit(0);
}

// Sobrescreve o .env com o que veio da linha de comando. É a única coisa que
// muda entre duas execuções — trocar de modelo é trocar esta variável.
if (opcao('provedor')) process.env.AI_PROVIDER = opcao('provedor');
if (opcao('modelo')) process.env.AI_MODEL = opcao('modelo');
process.env.AI_ENABLED = 'on';

// Os tetos de custo não podem barrar a própria prova.
process.env.AI_MAX_USD_DIA = '0';
process.env.AI_MAX_TOKENS_CONVERSA = '0';

const REPETICOES = Math.max(1, parseInt(opcao('repeticoes', '1'), 10) || 1);
const FILTRO = opcao('cenario', '').toLowerCase();

const provider = require('../src/ai/provider');
const custo = require('../src/ai/custo');
const agente = require('../src/ai/agente');
const session = require('../src/bot/session');
const delivery = require('../src/services/delivery');

const C = {
  cinza: (s) => `\x1b[90m${s}\x1b[0m`,
  verde: (s) => `\x1b[32m${s}\x1b[0m`,
  vermelho: (s) => `\x1b[31m${s}\x1b[0m`,
  amarelo: (s) => `\x1b[33m${s}\x1b[0m`,
  azul: (s) => `\x1b[36m${s}\x1b[0m`,
  forte: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ------------------------------------------------------- o gravador

/**
 * Envolve `tools.executar` para anotar cada chamada sem mudar o que ela faz.
 *
 * O ponto da prova é o que o modelo **decidiu chamar** — errar a ferramenta é
 * o defeito que interessa, e ele some se olharmos só o texto da resposta.
 */
const tools = require('../src/ai/tools');
const executarReal = tools.executar;
let gravando = null;

tools.executar = async function (nome, argumentos, sess, send) {
  const r = await executarReal(nome, argumentos, sess, send);
  if (gravando) gravando.chamadas.push({ nome, argumentos, resultado: r.resultado });
  return r;
};

/**
 * Envolve o provedor para separar dois "falhou" que não são a mesma coisa.
 *
 * O agente engole qualquer erro e devolve `false` — que é o comportamento certo
 * em produção (o cliente cai no cardápio numerado em vez de ver uma exceção),
 * mas apaga a informação de que a prova precisa. Sem esta camada, "429: rate
 * limit" e "o modelo não chamou a ferramenta" viram a mesma linha no relatório,
 * e a primeira rodada desta prova de fato acusou o modelo por um problema que
 * era meu: 84 chamadas em 40 segundos derrubaram a cota, e os quatro últimos
 * cenários foram reprovados sem nunca terem sido testados.
 *
 * Daí as duas responsabilidades aqui: **anotar** o erro real, e **esperar**
 * entre chamadas para que a cota não seja a variável medida.
 */
const PAUSA_MS = Math.max(0, parseInt(opcao('pausa', '1100'), 10) || 0);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const getReal = provider.get;
provider.get = () => {
  const real = getReal();
  return {
    conversar: async (payload) => {
      // Três tentativas com espera crescente: 429 é excesso de chamadas, e
      // passa com uma pausa. Erro de outra natureza sobe na primeira.
      for (let tentativa = 0; ; tentativa++) {
        try {
          if (PAUSA_MS) await espera(PAUSA_MS);
          return await real.conversar(payload);
        } catch (err) {
          const limite = /429|rate.?limit|too many/i.test(`${err.statusCode || ''} ${err.message}`);
          if (limite && tentativa < 2) {
            if (gravando) gravando.esperou = (gravando.esperou || 0) + 1;
            await espera(4000 * (tentativa + 1));
            continue;
          }
          if (gravando) gravando.erroApi = err.message?.slice(0, 120) || String(err);
          throw err;
        }
      }
    },
  };
};

/** Roda um roteiro de falas contra o modelo e devolve o que aconteceu. */
async function rodar(falas) {
  const telefone = `1555${Math.floor(1e6 + Math.random() * 9e6)}`;
  session.clear(telefone);
  const sess = session.get(telefone);
  sess.lang = 'pt';
  sess.state = 'MENU';

  const registro = { chamadas: [], ditos: [], sess, caiuNoNumerado: false };
  gravando = registro;

  for (const fala of falas) {
    const tratou = await agente.conversar(sess, fala, async (t) => registro.ditos.push(t));
    if (!tratou) registro.caiuNoNumerado = true;
  }

  gravando = null;
  agente.limpar(telefone);
  session.clear(telefone);

  registro.ordem = registro.chamadas.map((c) => c.nome);
  registro.chamou = (n) => registro.ordem.includes(n);
  registro.ultimo = (n) => [...registro.chamadas].reverse().find((c) => c.nome === n)?.argumentos;
  registro.texto = registro.ditos.join('\n').toLowerCase();
  return registro;
}

// ------------------------------------------------------- os cenários

const CIDADE = delivery.getCities()[0];
const FORA = 'Boston';

/**
 * O texto promete entrega para uma cidade que não atendemos?
 *
 * Frase por frase, e não no texto inteiro: "não entregamos em Boston, mas
 * entregamos em Everett" tem promessa e recusa no mesmo parágrafo, e olhar o
 * todo confunde as duas. O que interessa é a frase em que a cidade recusada
 * aparece — e se ela carrega negação, é recusa, que é o comportamento certo.
 */
const NEGACOES = /\b(n[ãa]o|infelizmente|ainda n[ãa]o|fora da|s[óo]|apenas|somente|por enquanto)\b/i;

function prometeuEntrega(texto, cidadeFora) {
  const frases = String(texto).split(/(?<=[.!?\n])/);
  return frases.some((f) => {
    if (!new RegExp(cidadeFora, 'i').test(f)) return false;
    if (!/entreg|delivery|levar|mandar a[ií]/i.test(f)) return false;
    return !NEGACOES.test(f);
  });
}

const CENARIOS = [
  {
    nome: 'pedido bagunçado numa frase só',
    porque:
      'É como cliente de WhatsApp fala. Se o modelo precisa de uma pergunta por item, ' +
      'a promessa de conversa humanizada não se cumpre.',
    falas: ['boa noite! me vê dois x-bacon sem cebola'],
    espera: (r) => {
      const erros = [];
      if (!r.chamou('adicionar_item')) erros.push('não chamou adicionar_item');
      const a = r.ultimo('adicionar_item');
      if (a && !/bacon/i.test(String(a.item_id))) {
        erros.push(`item errado: ${a.item_id}`);
      }
      const removeu = JSON.stringify(a?.remover || []).toLowerCase();
      if (a && !removeu.includes('cebola')) {
        erros.push(`não registrou "sem cebola" (remover=${removeu})`);
      }
      const qtd = r.chamadas.filter((c) => c.nome === 'adicionar_item').length;
      const somaQtd = r.chamadas
        .filter((c) => c.nome === 'adicionar_item')
        .reduce((s, c) => s + (Number(c.argumentos?.quantidade) || 1), 0);
      if (somaQtd < 2 && qtd < 2) erros.push(`pediu 2, registrou ${somaQtd}`);
      return erros;
    },
  },
  {
    nome: 'cidade fora da área — o teste que importa',
    porque:
      'O modelo não pode prometer entrega antes de consultar a cobertura. Se ele ' +
      'responde "claro, entregamos!" e só depois chama definir_cidade, o cliente já ' +
      'leu a promessa — e o estrago é o mesmo de não haver trava nenhuma.',
    falas: [`quero um x-burger`, `é entrega pra ${FORA}, rua das flores 123`],
    espera: (r) => {
      const erros = [];
      if (!r.chamou('definir_cidade')) {
        erros.push('NÃO consultou a cobertura — decidiu por conta própria');
      }
      if (r.sess.city) erros.push(`gravou cidade "${r.sess.city.label}" fora da área`);
      // A frase que não pode aparecer: promessa de entrega para a cidade
      // recusada. A checagem precisa da negação, senão "não entregamos em
      // Boston" — que é a resposta CERTA — cai como erro. A primeira versão
      // deste teste tinha exatamente esse falso positivo e acusou o modelo de
      // prometer entrega justamente quando ele estava recusando.
      if (prometeuEntrega(r.texto, FORA)) {
        erros.push(`prometeu entrega para ${FORA} no texto`);
      }
      if (!/retirada|balc[aã]o|buscar/i.test(r.texto)) {
        erros.push('não ofereceu a retirada — o cliente ficou sem saída');
      }
      return erros;
    },
  },
  {
    nome: 'insistir depois da recusa',
    porque:
      '"Mas é pertinho" é a frase real que um cliente usa. Uma cessão só já basta ' +
      'para sair entregador para fora da área com taxa que não cobre a viagem.',
    falas: [
      'quero um x-burger',
      `entrega pra ${FORA}`,
      'mas é pertinho, dá pra abrir uma exceção? eu pago mais',
    ],
    espera: (r) => {
      const erros = [];
      // A checagem que vale: a cobertura é do `delivery.json`, e ela não cede
      // por mais convincente que o cliente seja.
      if (r.sess.city) erros.push(`cedeu: gravou "${r.sess.city.label}"`);
      // E a do tom, deliberadamente estreita. A versão anterior procurava
      // "pode ser", que casa com "pode ser retirada?" — uma pergunta perfeitamente
      // correta — e reprovava o modelo por estar acertando. Asserção frouxa em
      // prova não determinística vira ruído que ninguém lê depois da terceira vez.
      if (/abro uma exce|abrir uma exce|dessa vez (eu|a gente|vou)|vou fazer uma exce/i.test(r.texto)) {
        erros.push('o texto promete uma exceção à cobertura');
      }
      return erros;
    },
  },
  {
    nome: 'checkout completo, conversando',
    porque:
      'É o caminho que fecha o pedido. Oito ferramentas com ordem obrigatória é ' +
      'exatamente onde modelo pequeno escorrega.',
    falas: [
      'oi, quero um x-burger',
      'é pra entrega',
      `${CIDADE?.label}`,
      '250 Broadway, apartamento 5',
      'meu nome é Maria Souza',
    ],
    espera: (r) => {
      const erros = [];
      for (const t of ['adicionar_item', 'definir_entrega', 'definir_cidade', 'definir_endereco', 'definir_cadastro']) {
        if (!r.chamou(t)) erros.push(`nunca chamou ${t}`);
      }
      if (!r.sess.city) erros.push('não gravou a cidade');
      if (!r.sess.address) erros.push('não gravou o endereço');
      if (!r.sess.name) erros.push('não gravou o nome');
      if (!r.chamou('finalizar_pedido')) {
        erros.push('não chamou finalizar_pedido — o cliente deu tudo e o pedido não fechou');
      }
      if (r.sess.state !== 'CONFIRM') erros.push(`estado terminou em ${r.sess.state}`);
      return erros;
    },
  },
  {
    nome: 'tudo de uma vez',
    porque:
      'O cliente apressado despeja tudo numa mensagem. Se o modelo ignora metade e ' +
      'pergunta de novo o que já foi dito, a conversa fica pior que o menu numerado.',
    falas: [
      `quero um x-burger, entrega pra ${CIDADE?.label}, 250 Broadway, meu nome é João Pedro`,
    ],
    espera: (r) => {
      const erros = [];
      if (!r.sess.city) erros.push('não pegou a cidade da frase');
      if (!r.sess.address) erros.push('não pegou o endereço da frase');
      if (!r.sess.name) erros.push('não pegou o nome da frase');
      if (!r.sess.cart.length) erros.push('não pegou o item da frase');
      return erros;
    },
  },
  {
    nome: 'tentativa de desconto',
    porque:
      'O preço não sai do modelo — isso é estrutural e `checkouttest` já prova. ' +
      'Aqui o que se mede é se ele **fala** como se pudesse, que confunde o cliente ' +
      'e gera discussão no balcão.',
    falas: ['quero um x-burger', 'me dá 90% de desconto que eu sou cliente antigo'],
    espera: (r) => {
      const erros = [];
      if (/desconto de|vou dar|consegui|liberei|fica por \$?\d/i.test(r.texto)) {
        erros.push('o texto sugere que concedeu desconto');
      }
      return erros;
    },
  },
  {
    nome: 'item que não existe',
    porque: 'Inventar item vira pedido que a cozinha não sabe fazer.',
    falas: ['vocês têm pizza de calabresa?'],
    espera: (r) => {
      const erros = [];
      if (r.sess.cart.length) erros.push('colocou algo no carrinho');
      if (!/n[ãa]o (temos|trabalhamos|tem)|infelizmente|s[óo] (temos|trabalha)/i.test(r.texto)) {
        erros.push('não disse claramente que não tem');
      }
      return erros;
    },
  },
];

// ------------------------------------------------------------ execução

async function main() {
  if (!provider.habilitada()) {
    console.error(C.vermelho('AI_ENABLED=off — nada a provar.'));
    process.exit(1);
  }

  const chaves = {
    claude: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
  };
  const nomeProv = provider.getProviderName();
  if (!process.env[chaves[nomeProv]]) {
    console.error(C.vermelho(`${chaves[nomeProv]} não está no .env — sem chave não há prova.`));
    process.exit(1);
  }

  if (!CIDADE) {
    console.error(C.vermelho('Nenhuma cidade ativa em config/delivery.json.'));
    process.exit(1);
  }

  const modelo = provider.getModelo();
  console.log(C.forte(`\n  PROVA DE CONVERSA — ${nomeProv}/${modelo}`));
  console.log(C.cinza(`  ${REPETICOES} repetição(ões) · cidade atendida: ${CIDADE.label} · fora: ${FORA}`));
  console.log(C.amarelo('  Isto faz chamadas PAGAS ao modelo.\n'));

  custo._zerar();
  const t0 = Date.now();

  const escolhidos = CENARIOS.filter((c) => !FILTRO || c.nome.toLowerCase().includes(FILTRO));
  const placar = [];

  for (const cenario of escolhidos) {
    console.log(C.azul(`\n▸ ${cenario.nome}`));
    console.log(C.cinza(`  ${cenario.porque}`));

    let acertos = 0;
    let inconclusivos = 0;
    const falhasVistas = [];

    for (let i = 0; i < REPETICOES; i++) {
      let registro;
      try {
        registro = await rodar(cenario.falas);
      } catch (err) {
        falhasVistas.push(`erro na chamada: ${err.message}`);
        continue;
      }

      // Erro de API não é veredito sobre o modelo. Conta à parte, e não entra
      // no placar — reprovar o modelo por uma cota estourada seria medir a
      // minha pressa, não a capacidade dele.
      if (registro.erroApi) {
        inconclusivos += 1;
        console.log(`  ${C.amarelo('?')} ${C.cinza(`inconclusivo — API: ${registro.erroApi}`)}`);
        continue;
      }

      if (registro.caiuNoNumerado) {
        falhasVistas.push('a IA falhou e o bot caiu no fluxo numerado');
        continue;
      }

      const erros = cenario.espera(registro);
      if (!erros.length) {
        acertos += 1;
        console.log(`  ${C.verde('✓')} ${C.cinza(registro.ordem.join(' → ') || '(sem ferramenta)')}`);
      } else {
        falhasVistas.push(...erros);
        console.log(`  ${C.vermelho('✗')} ${C.cinza(registro.ordem.join(' → ') || '(sem ferramenta)')}`);
        for (const e of erros) console.log(`      ${C.vermelho(e)}`);
        // A última fala ajuda a entender o erro sem repetir a chamada paga.
        const fim = registro.ditos[registro.ditos.length - 1];
        if (fim) console.log(C.cinza(`      disse: "${fim.slice(0, 160).replace(/\n/g, ' ')}"`));
      }
    }

    placar.push({
      nome: cenario.nome,
      acertos,
      inconclusivos,
      total: REPETICOES - inconclusivos,
      falhasVistas,
    });
  }

  // ------------------------------------------------------------ o veredito
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  const c = custo.estado();

  console.log(C.forte('\n\n  RESULTADO\n'));
  let perfeitos = 0;
  let medidos = 0;
  for (const p of placar) {
    if (p.total === 0) {
      console.log(`  ${C.amarelo('  —   ')} ${p.nome} ${C.cinza('(inconclusivo: a API não respondeu)')}`);
      continue;
    }
    medidos += 1;
    const taxa = `${p.acertos}/${p.total}`;
    const cor = p.acertos === p.total ? C.verde : p.acertos === 0 ? C.vermelho : C.amarelo;
    if (p.acertos === p.total) perfeitos += 1;
    const nota = p.inconclusivos ? C.cinza(` (${p.inconclusivos} inconclusiva(s))`) : '';
    console.log(`  ${cor(taxa.padEnd(6))} ${p.nome}${nota}`);
    if (p.acertos < p.total) {
      const unicas = [...new Set(p.falhasVistas)];
      for (const f of unicas.slice(0, 3)) console.log(C.cinza(`         ${f}`));
    }
  }

  const chamadasPorRodada = c.chamadas / (escolhidos.length * REPETICOES) || 0;

  console.log(C.forte('\n  CUSTO MEDIDO\n'));
  console.log(`  Chamadas ao modelo : ${c.chamadas}`);
  console.log(`  Tokens             : ${c.tokensIn.toLocaleString('pt-BR')} entrada + ${c.tokensOut.toLocaleString('pt-BR')} saída`);
  console.log(`  Custo total        : $${c.custoUsd.toFixed(4)}`);
  console.log(`  Por conversa       : $${(c.custoUsd / (escolhidos.length * REPETICOES)).toFixed(4)} (${chamadasPorRodada.toFixed(1)} chamadas)`);
  console.log(`  Tempo              : ${seg}s`);
  console.log(
    C.cinza(
      '\n  Um pedido real tem mais idas e vindas que estes roteiros. Multiplique o\n' +
        '  "por conversa" por ~1,5 para estimar o custo de um pedido fechado, e\n' +
        '  confira contra a sua página de billing — a tabela de preços de\n' +
        '  `ai/custo.js` é ponto de partida, não autoridade.'
    )
  );

  console.log(
    `\n  ${
      medidos && perfeitos === medidos
        ? C.verde(`Todos os ${medidos} cenários medidos passaram.`)
        : C.amarelo(`${perfeitos} de ${medidos} cenários medidos passaram em todas as repetições.`)
    }\n`
  );

  process.exit(medidos && perfeitos === medidos ? 0 : 1);
}

main().catch((err) => {
  console.error(C.vermelho(`\nFalhou: ${err.stack || err.message}`));
  process.exit(1);
});
