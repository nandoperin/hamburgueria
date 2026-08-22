const provider = require('./provider');
const tools = require('./tools');
const custo = require('./custo');
const cardapio = require('../services/cardapio');
const log = require('../log');

/**
 * O laço da conversa humanizada.
 *
 * Junta as três peças que já existiam soltas: o provedor (`provider.js` →
 * claude/openai/mistral), as ferramentas (`tools.js`, que falam com os services)
 * e o histórico da conversa (guardado por telefone, ao lado da sessão).
 *
 * O desenho segue `docs/CARDAPIO-CONVERSA.md`: a IA conduz, conhece o cardápio
 * inteiro (vai no system prompt via `cardapio.paraModelo`), e o cliente pede em
 * texto livre. Quando o modelo decide agir, chama uma ferramenta; o código
 * valida e responde; o modelo continua até ter o que dizer ao cliente.
 *
 * Quando o cliente termina, `finalizar_pedido` entrega o carrinho ao checkout
 * de sempre (`order.js`) — daí a máquina de estados assume e o agente sai de
 * cena. Pagamento, endereço e comanda continuam no código, nunca no modelo.
 */

// Histórico por telefone. Não vai na sessão porque a sessão é serializável e
// reiniciável; o histórico é efêmero e morre com o processo, como a conversa.
const historicos = new Map();

// Teto de mensagens guardadas por conversa — a janela do modelo é finita e uma
// conversa de pedido não precisa de memória longa. Mantém as N mais recentes.
const MAX_HISTORICO = parseInt(process.env.AI_MAX_TURNOS, 10) || 40;

// Teto de rodadas de ferramenta numa única mensagem do cliente. Sem isso, um
// modelo em laço (chama ferramenta, lê erro, chama de novo) rodaria sem fim.
const MAX_RODADAS = 6;

function getHistorico(phone) {
  if (!historicos.has(phone)) historicos.set(phone, []);
  return historicos.get(phone);
}

function limpar(phone) {
  historicos.delete(phone);
}

function empurrar(hist, msg) {
  hist.push(msg);
  // Corta o começo, preservando o fim (o contexto recente é o que importa).
  if (hist.length > MAX_HISTORICO) hist.splice(0, hist.length - MAX_HISTORICO);
}

/**
 * O system prompt. Estático na maior parte — só o cardápio muda com a
 * disponibilidade —, então é o que o prompt caching desconta em toda mensagem.
 */
function systemPrompt(lang) {
  const nome = process.env.BUSINESS_NAME || 'nossa hamburgueria';
  const menu = cardapio.paraModelo(lang);
  // Os fatos da casa — entrega, pagamento, horário, alérgenos. Vêm do
  // `config/faq.json` com {cities} e {hours} já preenchidos da configuração.
  // Sem isto o modelo inventaria: ele não tem como saber que o pagamento é
  // Zelle nem quanto custa a entrega em Medford.
  const fatos = require('../bot/handlers/faq').paraModelo(lang);

  return `Você é o atendente virtual da ${nome}, uma hamburgueria. Você atende pelo WhatsApp, em conversa natural e simpática — nada de menus numerados.

## Seu jeito
- Fale como um atendente brasileiro de verdade: caloroso, direto, sem ser robótico. Emojis com moderação (🍔 é bem-vindo).
- Respostas curtas. É WhatsApp, não e-mail.
- Conduza: na primeira mensagem, dê boas-vindas e apresente as categorias (Sanduíches 🍔, Massas 🍝, Acompanhamentos 🍟, Bebidas 🥤). Não despeje o cardápio inteiro a menos que peçam.
- Entenda pedido em texto livre ("um x-bacon sem cebola com ovo") e monte usando as ferramentas.

## A regra número um: falar não registra
Dizer "anotei", "já registrei", "vou anotando aqui" **não anota nada**. Só a
ferramenta registra. Se você escrever que anotou sem ter chamado a ferramenta,
o cliente acredita que está tudo certo, o pedido chega vazio na cozinha, e a
culpa aparece só na hora da entrega.

Então, a cada mensagem do cliente: **primeiro chame todas as ferramentas do que
ele disse, depois responda**. Se ele despejar tudo numa frase só — "um x-burger,
entrega pra Chelsea, 250 Broadway, meu nome é João" — são quatro ferramentas
numa resposta só, e aí sim você fala. Nunca pergunte de novo o que ele já disse.

## Regras que você não quebra
- NUNCA invente preço, item ou ingrediente. Só existe o que está no cardápio abaixo.
- Preço quem calcula é o sistema (as ferramentas devolvem o valor certo). Você repete o que a ferramenta disser, não inventa.
- Os preços são em DÓLAR (US$). Sempre use "$" ou "US$", nunca "R$" — o estabelecimento fica nos Estados Unidos.
- Remover ingrediente é grátis. Acrescentar tem preço — a ferramenta te diz quanto.
- Se o cliente pedir algo que não existe, diga que não tem e ofereça o parecido do cardápio.
- NUNCA diga que entregamos em algum lugar sem antes chamar definir_cidade. Só ela sabe a área de cobertura, e ela é a palavra final: se disser que não atendemos, não atendemos — por mais perto que o cliente diga que é.
- O resumo final e as instruções do Zelle são enviados pelo sistema. Não os escreva você, nem repita os valores depois.

## Fechando o pedido — conversando, não com menu
Quando o cliente terminar de escolher, conduza o fechamento na conversa,
uma pergunta de cada vez e com as suas palavras:

1. Entrega ou retirada? → definir_entrega
2. Se entrega: qual a cidade? → definir_cidade (ela devolve a taxa, ou diz que não atendemos)
3. Rua e número → definir_endereco
4. Nome (email só se ele oferecer) → definir_cadastro
5. finalizar_pedido → o sistema manda o resumo com o total

Não peça tudo de uma vez, e não faça lista numerada — é conversa de
WhatsApp. Se o cliente já tiver dito algo ("é entrega pra Chelsea, rua tal
123"), registre tudo de uma vez com as ferramentas e siga.

Se finalizar_pedido disser que falta algo, pergunte o que falta com
naturalidade e chame de novo.

### O passo 5 não é opcional
Assim que você tiver item, tipo de entrega, endereço (se for entrega) e nome,
**chame finalizar_pedido imediatamente**. Não escreva você o resumo do pedido:
nada de listar os itens com os preços, nada de "Total: $16.00", nada de
"Confirma tudo?".

Esse resumo é do sistema, e não é frescura de formato — é ele que coloca o
pedido no estado de confirmação. Se você escrever o resumo com as suas
palavras, o "sim" do cliente não fecha pedido nenhum: ele acha que pediu, você
acha que anotou, e não existe pedido. Chame a ferramenta e deixe o texto dela
falar; depois disso, só responda o que o cliente perguntar.

## Ferramentas
- adicionar_item: põe item no carrinho (com remover/acrescentar opcionais)
- remover_item: tira item do carrinho
- ver_carrinho: mostra o carrinho e subtotal
- definir_entrega: entrega ou retirada
- definir_cidade: registra a cidade E diz se atendemos, com a taxa
- definir_endereco: rua e número
- definir_cadastro: nome e email
- finalizar_pedido: manda o resumo para o cliente confirmar

## Cardápio (id | nome | preço)
${menu}

## Informações da casa
Responda perguntas sobre isto com as suas palavras, no seu tom — não copie o
texto abaixo, e não repita tudo quando a pergunta for sobre uma parte só. Mas
**não invente nada que não esteja aqui**: se o cliente perguntar algo que não
está, diga que vai confirmar com a equipe e passe o contato.

Duas exceções, em que o conteúdo não pode ser suavizado nem resumido:
- **Alérgenos:** sempre que falar de glúten, diga o que contém E o aviso de
  cozinha compartilhada. Nunca afirme que algo é seguro para celíaco.
- **Pagamento:** o valor e os dados do Zelle quem manda é o sistema, no fim do
  pedido. Você nunca dita nome, email ou valor de transferência.

${fatos}

Responda sempre em ${lang === 'en' ? 'inglês' : lang === 'es' ? 'espanhol' : 'português'}.`;
}

/**
 * Processa uma mensagem do cliente pela IA.
 *
 * @param {object} sess  sessão do cliente (carrinho, lang, estado)
 * @param {string} texto mensagem do cliente
 * @param {Function} send async (texto) => envia ao cliente
 * @returns {Promise<boolean>} true se tratou; false para o router cair no fluxo
 *                             numerado (IA indisponível ou erro).
 */
async function conversar(sess, texto, send) {
  const lang = sess.lang || 'pt';

  // O teto de gasto, antes de qualquer coisa. Aqui em cima — e não dentro do
  // laço — porque a mensagem ainda não entrou no histórico e nenhuma ferramenta
  // rodou: devolver `false` agora entrega ao fluxo numerado uma conversa
  // inteira e limpa, em vez de um pedido pela metade.
  const antes = custo.podeChamar(sess);
  if (!antes.ok) {
    log.warn(
      { evt: 'ia_custo', phone: sess.phone, motivo: antes.motivo, detalhe: antes.detalhe },
      `teto de IA atingido (${antes.motivo}): ${antes.detalhe} — caindo no fluxo numerado`
    );
    avisarDono(antes);
    return false;
  }

  const hist = getHistorico(sess.phone);

  empurrar(hist, { role: 'user', content: texto });

  try {
    // Dentro do `try` porque `getModelo` lança com `AI_PROVIDER` inválido, e
    // essa é exatamente a falha que tem que virar fluxo numerado, não exceção.
    const modelo = provider.getModelo();

    for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
      // Dentro do laço a checagem é a mesma, mas a saída é outra: aqui já pode
      // ter rodado ferramenta, então o carrinho da sessão está mexido e jogar a
      // mensagem no fluxo numerado confundiria os dois. Encerra a fala com
      // elegância e devolve `true`; a próxima mensagem cai na checagem de cima.
      if (rodada > 0) {
        const durante = custo.podeChamar(sess);
        if (!durante.ok) {
          log.warn(
            { evt: 'ia_custo', phone: sess.phone, motivo: durante.motivo },
            `teto de IA atingido no meio da conversa: ${durante.detalhe}`
          );
          avisarDono(durante);
          await send(SEM_FOLEGO[lang] || SEM_FOLEGO.pt);
          return true;
        }
      }

      const resp = await provider.get().conversar({
        system: systemPrompt(lang),
        mensagens: hist,
        ferramentas: tools.SCHEMA,
        model: modelo,
      });

      custo.registrar(sess, resp.uso, modelo);

      // Sem chamadas de ferramenta: é a resposta final ao cliente.
      if (!resp.chamadas || !resp.chamadas.length) {
        const fala = resp.texto?.trim();
        if (fala) {
          empurrar(hist, { role: 'assistant', content: fala });
          await send(fala);
        }
        return true;
      }

      // Guarda a fala do modelo (com as chamadas) antes de executá-las, para o
      // provedor remontar o histórico de tool calls no formato dele.
      empurrar(hist, {
        role: 'assistant',
        content: resp.texto || '',
        chamadas: resp.chamadas,
      });

      let entregou = false;
      for (const chamada of resp.chamadas) {
        log.info(
          { evt: 'ia_tool', nome: chamada.nome, args: chamada.argumentos },
          `ferramenta: ${chamada.nome}`
        );
        const { resultado, entregouAoFluxo } = await tools.executar(
          chamada.nome,
          chamada.argumentos,
          sess,
          send
        );
        empurrar(hist, {
          role: 'tool',
          tool_call_id: chamada.id,
          nome: chamada.nome,
          content: resultado,
        });
        if (entregouAoFluxo) entregou = true;
      }

      // finalizar_pedido entregou a conversa ao checkout — o agente sai de cena
      // e o histórico da IA se encerra (o pedido virou máquina de estados).
      if (entregou) {
        limpar(sess.phone);
        return true;
      }
    }

    // Estourou o teto de rodadas sem resposta final: degrada com elegância.
    log.warn({ evt: 'ia', phone: sess.phone }, 'teto de rodadas de ferramenta atingido');
    await send(
      lang === 'en'
        ? "Sorry, I got a bit lost. Could you say that again?"
        : lang === 'es'
        ? 'Perdón, me perdí un poco. ¿Puedes repetir?'
        : 'Desculpa, me perdi um pouco. Pode repetir?'
    );
    return true;
  } catch (err) {
    // IA fora do ar, cota estourada, chave inválida: o router cai no fluxo
    // numerado. É a mesma filosofia do AI_ENABLED=off, só que automática.
    log.error({ evt: 'ia', err, phone: sess.phone }, 'falha na conversa por IA');
    return false;
  }
}

/** O que o cliente ouve quando o teto estoura no meio da fala. */
const SEM_FOLEGO = {
  pt: 'Só um instante — vou te passar as opções por aqui mesmo. 🍔',
  en: 'One moment — let me walk you through the options right here. 🍔',
  es: 'Un momento — te paso las opciones por aquí mismo. 🍔',
};

// O dono precisa saber que o bot degradou, e precisa saber **uma vez**: um
// aviso por chamada bloqueada viraria dezenas de mensagens no mesmo minuto,
// que é o mesmo que não avisar. Rearma quando o dia vira.
let avisado = null;

function avisarDono(veredito) {
  // O teto por conversa é rotina — um cliente falador estourou o dele, e isso
  // não é notícia. O teto do dia é que fecha a IA para a casa inteira.
  if (veredito.motivo !== 'dia') return;

  const dia = new Date().toISOString().slice(0, 10);
  if (avisado === dia) return;
  avisado = dia;

  const admin = process.env.ADMIN_PHONE;
  if (!admin) return;

  const notify = require('../bot/notify');
  Promise.resolve(
    notify.send(
      admin,
      `⚠️ *Teto de gasto de IA atingido*\n\n${veredito.detalhe}\n\n` +
        'O bot continua atendendo pelo cardápio numerado — ninguém fica sem ser ' +
        'atendido, mas a conversa por IA está fora até amanhã.\n\n' +
        'Para liberar hoje, aumente `AI_MAX_USD_DIA`.'
    )
  ).catch((err) => log.warn({ evt: 'ia_custo', err }, 'falha ao avisar o dono do teto'));
}

/**
 * Abre a conversa: a IA dá as boas-vindas e apresenta as categorias.
 *
 * Chamado logo após a escolha de idioma, no lugar do fluxo numerado. Semeia o
 * histórico com o "oi" que o cliente de fato mandou para iniciar (foi o que
 * disparou a tela de idioma), e roda o laço uma vez para o modelo saudar. Se a
 * IA falhar, devolve false e o `welcome` cai no fluxo de sempre.
 *
 * @returns {Promise<boolean>}
 */
async function saudar(sess, send) {
  const lang = sess.lang || 'pt';
  // Histórico limpo no início da conversa — um "oi" para o modelo abrir.
  historicos.set(sess.phone, []);
  const hist = getHistorico(sess.phone);
  empurrar(hist, {
    role: 'user',
    content: lang === 'en' ? 'Hi' : lang === 'es' ? 'Hola' : 'Oi',
  });

  const veredito = custo.podeChamar(sess);
  if (!veredito.ok) {
    log.warn(
      { evt: 'ia_custo', phone: sess.phone, motivo: veredito.motivo },
      `teto de IA atingido na saudação: ${veredito.detalhe}`
    );
    avisarDono(veredito);
    return false;
  }

  try {
    const modelo = provider.getModelo();
    const resp = await provider.get().conversar({
      system: systemPrompt(lang),
      mensagens: hist,
      ferramentas: tools.SCHEMA,
      model: modelo,
    });
    custo.registrar(sess, resp.uso, modelo);

    const fala = resp.texto?.trim();
    if (fala) {
      empurrar(hist, { role: 'assistant', content: fala });
      await send(fala);
    }
    return true;
  } catch (err) {
    log.error({ evt: 'ia', err, phone: sess.phone }, 'falha ao saudar por IA');
    return false;
  }
}

module.exports = { conversar, saudar, limpar };
