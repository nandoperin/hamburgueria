const provider = require('./provider');
const tools = require('./tools');
const custo = require('./custo');
const cardapio = require('../services/cardapio');
const salsicha = require('../services/preparo-salsicha');
const { ofertaNaoSolicitada } = require('./catalog-policy');
const log = require('../log');
const { t } = require('../i18n');

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

/** A saudação já enviada também faz parte do que o modelo precisa lembrar. */
function registrarSaudacao(sess, fala) {
  const hist = getHistorico(sess.phone);
  semearContexto(hist, sess);
  empurrar(hist, { role: 'assistant', content: fala });
}

/** Reabre para a IA o carrinho cujo resumo foi recusado. */
function registrarEdicaoCarrinho(sess, fala) {
  const hist = getHistorico(sess.phone);
  semearContexto(hist, sess);
  const itens = (sess.cart || []).map((line) => {
    const detalhes = [];
    if (line.removed?.length) detalhes.push(`sem=${line.removed.join(',')}`);
    if (line.added?.length) detalhes.push(`adicionais=${line.added.join(',')}`);
    return `[${line.id}] quantidade atual=${line.qty}; produto=${line.name}` +
      (detalhes.length ? `; ${detalhes.join('; ')}` : '');
  }).join('\n');
  empurrar(hist, {
    role: 'user',
    content:
      '[EVENTO_INTERNO_EDICAO_CARRINHO]\n' +
      'O cliente recusou o resumo para ALTERAR o mesmo pedido. O carrinho atual é:\n' +
      `${itens || '(vazio)'}\n` +
      'Na próxima mensagem, altere essas linhas. Se ele disser a quantidade final ' +
      '(por exemplo, "quero só 1"), use definir_quantidade_item. Não use ' +
      'adicionar_item para corrigir um produto que já está no carrinho. Só adicione ' +
      'quando ele pedir claramente outro produto ou unidades a mais. Não finalize ' +
      'novamente até ele pedir para finalizar.',
  });
  empurrar(hist, { role: 'assistant', content: fala });
}

/**
 * O histórico morre junto com o pedido.
 *
 * Ele era limpo num lugar só — depois de `finalizar_pedido` — e sobrevivia a
 * todo o resto: pedido cancelado, `0` para recomeçar, sessão expirada,
 * comprovante que nunca chegou. O sintoma não parecia de memória; parecia
 * burrice. A sessão nova zerava `orderType`, o modelo continuava lendo o
 * cliente dizer "Entrega" na conversa anterior, e a ferramenta mandava
 * perguntar de novo. O cliente respondia *"Já disse entrega"* — e tinha razão.
 *
 * Registrado uma vez, no carregamento, para valer em todo ponto de reinício:
 * os quatro que existem hoje e os que vierem.
 */
require('../bot/session').aoReiniciar(limpar);

/**
 * A ordem em que as ferramentas de uma mesma resposta rodam.
 *
 * Existe uma dependência real entre duas delas: `definir_endereco` recusa
 * enquanto não houver cidade, porque é a cidade que define a taxa. Enquanto o
 * fechamento era pergunta por pergunta, isso nunca aparecia — cada ferramenta
 * vinha na sua própria rodada, na ordem em que foram perguntadas.
 *
 * Pedir nome e endereço juntos muda isso: o cliente responde "Fernando, 6 Elm
 * St, Everett" e o modelo emite as três chamadas de uma vez, na ordem em que
 * leu a frase — endereço antes de cidade, na metade das vezes. A recusa seria
 * recuperável (o modelo relê o erro e chama de novo), mas custaria uma rodada
 * paga e um titubeio visível, por uma ordem que o código conhece de antemão.
 *
 * A ordem é a do fechamento: carrinho, depois entrega, depois o resumo. Ela
 * importa além do par cidade/endereço, porque cada setter devolve `oQueFalta`
 * — e "o que falta" lido antes de o item entrar no carrinho é outra resposta.
 * Nomes fora da tabela ficam no meio, na ordem do modelo (`sort` estável).
 */
const PRIORIDADE = {
  adicionar_item: 0,
  personalizar_item: 0,
  definir_quantidade_item: 0,
  remover_item: 0,
  definir_entrega: 2,
  definir_cidade: 3,
  definir_endereco: 4,
  definir_cadastro: 5,
  finalizar_pedido: 9,
};

function ordenar(chamadas) {
  return [...chamadas].sort(
    (a, b) => (PRIORIDADE[a.nome] ?? 1) - (PRIORIDADE[b.nome] ?? 1)
  );
}

function empurrar(hist, msg) {
  hist.push(msg);
  // Corta o começo, preservando o fim (o contexto recente é o que importa).
  if (hist.length > MAX_HISTORICO) hist.splice(0, hist.length - MAX_HISTORICO);
}

/**
 * Resume um item do pedido anterior do jeito que o cliente reconheceria.
 *
 * `items_json` guarda `removed`/`added` por item (ver `schema.sql`) — e é
 * justamente a personalização que faz a sugestão valer: "X-Bacon sem cebola" é
 * reconhecível, "X-Bacon" genérico faz o cliente ter que repetir tudo.
 */
function resumirItem(item) {
  const partes = [];
  if (item.qty > 1) partes.push(`${item.qty}x`);
  partes.push(item.name || item.id);

  const detalhes = [
    ...(item.removed || []).map((r) => `sem ${r}`),
    ...(item.added || []).map((a) => `com ${a}`),
  ];
  if (detalhes.length) partes.push(`(${detalhes.join(', ')})`);

  return partes.join(' ');
}

/**
 * O item anterior no formato de CHAMADA, nao de rotulo.
 *
 * `resumirItem` produz texto para o cliente ler. Isto produz o que o modelo
 * precisa executar — e a diferenca nao e cosmetica: dar so o rotulo obriga o
 * modelo a traduzir "X-Bacon (sem cebola)" de volta para `item_id: "x_bacon"`
 * e `remover: ["cebola"]`, adivinhando os ids a partir de texto humano. Era
 * onde "quero o de sempre" falhava em 2 de 3 tentativas: o modelo entendia a
 * frase, respondia simpatico, e nao chamava ferramenta nenhuma.
 */
function argumentosDoItem(item) {
  const productId = item.productId || String(item.id || '').split(':')[0];
  const partes = [`item_id="${productId}"`];
  if (item.qty > 1) partes.push(`quantidade=${item.qty}`);
  if (item.removed?.length) partes.push(`remover=${JSON.stringify(item.removed)}`);
  if (item.added?.length) partes.push(`acrescentar=${JSON.stringify(item.added)}`);
  if (item.preparoSalsicha) {
    partes.push(`preparo_salsicha=${JSON.stringify(item.preparoSalsicha.modo)}`);
    if (item.preparoSalsicha.alvoId) partes.push(`lanche_id=${JSON.stringify(item.preparoSalsicha.alvoId)}`);
    if (item.preparoSalsicha.unidades) partes.push(`unidades_lanche=${item.preparoSalsicha.unidades}`);
  }
  return `adicionar_item(${partes.join(', ')})`;
}

/**
 * O que o sistema já sabe sobre este cliente, para o modelo não perguntar de novo.
 *
 * ## Por que isto NÃO vai no system prompt
 *
 * Porque o system prompt é o que o prompt caching desconta, e ele só desconta
 * enquanto for **idêntico** entre chamadas. Enfiar "Cliente: Maria, 250
 * Broadway" ali dentro criaria um prefixo diferente por pessoa: o cache
 * fragmentaria em um por cliente, e o desconto de 90% que acabou de ser
 * medido (`$0.0042` → `$0.0004` por conversa) viraria quase nada.
 *
 * Nas mensagens, o prefixo cacheado segue igual para todo mundo e o dado do
 * cliente vem depois dele. Ganha-se os dois.
 *
 * ## O endereço: quem falou primeiro decide
 *
 * A primeira versão mandava sempre oferecer e sempre esperar o "sim". O
 * resultado, num teste real: o cliente escreveu "entrega no mesmo endereço", e
 * o bot respondeu repetindo o endereço e perguntando se era aquele mesmo —
 * pedindo que ele dissesse sim duas vezes. Instrução rígida demais produz
 * exatamente o formulário que este projeto existe para evitar.
 *
 * A regra passou a depender de quem trouxe o assunto: se **ele** menciona o
 * endereço, isso já é a confirmação; se **o bot** o traz primeiro, aí espera o
 * "sim". A preocupação que originou a trava continua valendo — a taxa muda com
 * a cidade, e quem se mudou não pode receber no endereço velho sem ser
 * perguntado —, mas ela só se aplica quando o cliente ainda não se manifestou.
 *
 * Nome pode ser afirmado: não muda, e perguntar de novo é ruído puro.
 *
 * @returns {string|null} null quando é cliente novo — nada a dizer.
 */
function contextoDoCliente(sess) {
  const fatos = [];

  if (sess.name) fatos.push(`- Nome: ${sess.name} (já sabemos, NÃO pergunte de novo)`);
  if (sess.email) fatos.push(`- Email: ${sess.email} (já temos)`);

  if (sess.lastAddress) {
    const cidade = sess.lastCityId
      ? require('../services/delivery').getCityById(sess.lastCityId)?.label
      : null;
    const onde = cidade ? `${sess.lastAddress}, ${cidade}` : sess.lastAddress;
    fatos.push(
      `- Último endereço de entrega: ${onde}\n` +
        `  Se ELE mencionar o endereço primeiro ("no mesmo endereço", "manda pro de\n` +
        `  sempre"), isso já é a confirmação: registre com definir_endereco e\n` +
        `  definir_cidade e siga, sem reperguntar.\n` +
        `  Se VOCÊ trouxer o endereço primeiro, aí espere o "sim" antes de registrar.\n` +
        `  Endereço novo que ele der substitui este — gente se muda, e a taxa muda\n` +
        `  com a cidade.`
    );
  }

  if (sess.lastItems?.length) {
    const lista = sess.lastItems.map(resumirItem).join(', ');
    const chamadas = [...sess.lastItems].sort((a, b) => Number(salsicha.avulsa(a)) - Number(salsicha.avulsa(b)))
      .map(argumentosDoItem).join('\n    ');
    fatos.push(
      `- Último pedido dele: ${lista}\n` +
        `  Se ele PEDIR o mesmo ("o de sempre", "igual da última vez", "repete"),\n` +
        `  chame adicionar_item AGORA, uma vez por item, exatamente assim:\n` +
        `    ${chamadas}\n` +
        `  Não ofereça nem adicione o último pedido espontaneamente. Só repita\n` +
        `  quando ele pedir, usando os preços atuais das ferramentas.`
    );
  }

  if (!fatos.length) return null;

  return (
    'CONTEXTO DO SISTEMA (não é fala do cliente — não responda a esta mensagem, ' +
    'apenas use os dados):\nEste cliente já comprou aqui antes.\n' +
    fatos.join('\n') +
    '\nTrate com familiaridade, sem exagero. A mensagem real do cliente vem a seguir.'
  );
}

/**
 * Semeia o histórico com o que já sabemos do cliente, uma vez por conversa.
 *
 * Só quando o histórico está vazio: repetir isso a cada mensagem gastaria
 * tokens e daria ao modelo a impressão de que o cliente ficou se
 * reapresentando.
 */
function semearContexto(hist, sess) {
  if (hist.length) return;
  const contexto = contextoDoCliente(sess);
  if (!contexto) return;

  empurrar(hist, { role: 'user', content: contexto });
  // A resposta do assistant fecha o turno. Sem ela, a mensagem real do cliente
  // viria como segundo `user` seguido — a Anthropic funde os dois num turno só
  // e o contexto se misturaria à fala dele, que é o que este bloco evita.
  empurrar(hist, { role: 'assistant', content: 'Entendido.' });
}

/**
 * Cliente conhecido, carrinho montado e uma resposta inequívoca: não há
 * motivo para pedir ao modelo que traduza "entrega" para definir_entrega.
 *
 * Além de economizar uma chamada, isto fecha uma brecha de variância: se o
 * modelo respondesse apenas em texto, a confirmação do endereço anterior não
 * era armada e o "sim" seguinte podia virar outra pergunta de confirmação.
 */
function escolheuEntregaConhecida(sess, texto) {
  if (
    !sess.cart.length ||
    sess.orderType ||
    !sess.name ||
    !sess.lastAddress ||
    !sess.lastCityId
  ) {
    return false;
  }

  const resposta = String(texto || '').trim().toLowerCase();
  return /^(?:entrega|delivery|para entrega|pra entrega)$/.test(resposta);
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
As boas-vindas já foram enviadas pelo sistema. Não cumprimente novamente nem
repita o nome e "o que vai querer hoje?" quando não entender uma mensagem.
Se não conseguir entender o que ele quer, responda: "${t(lang, 'not_understood')}"
e espere. Não reinicie a conversa nem altere o carrinho por falta de entendimento.
- Fale como um atendente brasileiro de verdade: caloroso, direto, sem ser robótico. Emojis com moderação (🍔 é bem-vindo).
- Respostas curtas. É WhatsApp, não e-mail.
- Continue do ponto atual. Mostre categorias ou cardápio somente quando pedirem.
- Entenda pedido em texto livre ("um x-bacon sem cebola com ovo") e monte usando as ferramentas.
- Depois de EVENTO_INTERNO_EDICAO_CARRINHO, o cliente está corrigindo o carrinho existente. Use personalizar_item para ingredientes e definir_quantidade_item para a quantidade FINAL desejada. Não use adicionar_item para repetir o mesmo produto, a menos que ele diga claramente "mais", "outro" ou "adicionar". Deixe o carrinho aberto até ele pedir para finalizar.
- Em EVENTO_INTERNO_PEDIDO_REINICIADO, o sistema já zerou o carrinho. Apenas confirme naturalmente que o pedido recomeçou e pergunte o que o cliente deseja. Não mostre lista, categorias ou cardápio e não chame ferramenta nessa resposta.

## A regra número um: falar não registra
Dizer "anotei", "já registrei", "vou anotando aqui" **não anota nada**. Só a
ferramenta registra. Se você escrever que anotou sem ter chamado a ferramenta,
o cliente acredita que está tudo certo, o pedido chega vazio na cozinha, e a
culpa aparece só na hora da entrega.

Então, a cada mensagem do cliente: **primeiro chame todas as ferramentas do que
ele disse, depois responda**. Se ele despejar item, tipo de entrega, endereço e
nome numa frase só, são quatro ferramentas numa resposta só, e aí sim você
fala. Nunca pergunte de novo o que ele já disse.

**Nome, endereço e telefone só existem se o CLIENTE os disser nesta conversa,
ou se vierem num bloco CONTEXTO DO SISTEMA.** Não há outra origem. Nunca
chame o cliente por um nome que você não recebeu de um desses dois lugares —
errar o nome de quem está comprando é pior que não usar nome nenhum.

## Cliente que já comprou aqui
Se a conversa começar com um bloco "CONTEXTO DO SISTEMA", ele traz o que já
sabemos dessa pessoa. Use, não repita a pergunta:

- **Nome:** trate pelo nome, e não peça de novo. Já está registrado.
- **Endereço anterior:** quem tocou no assunto primeiro decide.
  - Se **ele** disse "no mesmo endereço", "manda pro de sempre" ou parecido:
    isso **já é** a confirmação. Chame definir_cidade e definir_endereco com o
    endereço do contexto e siga. Não repita o endereço, não pergunte a cidade,
    não peça um segundo "sim" — ele já disse.
  - Se **você** for trazer o endereço primeiro, aí sim ofereça e espere o "sim"
    antes de registrar. Gente se muda, e a taxa muda com a cidade: assumir em
    silêncio manda comida para o endereço errado.
- **Último pedido:** não ofereça espontaneamente. Se ELE pedir "o de sempre",
  recupere os itens e registre pelas ferramentas, com os preços atuais.

Esse bloco não é fala do cliente — não responda a ele, nem comente que
"recebeu um contexto". Só use os dados com naturalidade.

## Regras que você não quebra
- NUNCA invente preço, item ou ingrediente. Só existe o que está no cardápio abaixo.
- Preço quem calcula é o sistema (as ferramentas devolvem o valor certo). Você repete o que a ferramenta disser, não inventa.
- NUNCA conceda, prometa, negocie ou invente desconto. Só valem os preços promocionais que o sistema aplicar automaticamente a partir das promoções cadastradas e ativas. Pedido de desconto, preço especial, arredondamento, brinde ou item grátis deve ser recusado com educação. Retirar ingrediente não reduz o preço.
- Os preços são em DÓLAR (US$). Sempre use "$" ou "US$", nunca "R$" — o estabelecimento fica nos Estados Unidos.
- Remover ingrediente é grátis. Acrescentar tem preço — a ferramenta te diz quanto.
- Se o cliente pedir algo que não existe, diga que não tem e ofereça o parecido do cardápio.
- NUNCA diga que entregamos em algum lugar sem antes chamar definir_cidade. Só ela sabe a área de cobertura, e ela é a palavra final: se disser que não atendemos, não atendemos — por mais perto que o cliente diga que é.
- O resumo final e as instruções do Zelle são enviados pelo sistema. Não os escreva você, nem repita os valores depois.
- EVENTO_INTERNO_CARRINHO significa que produto e quantidade já estão no carrinho.
- Confirme naturalmente e peça somente o próximo dado obrigatório indicado pelo sistema.
- Não ofereça personalização, adicionais ou bebida. Se o cliente pedir uma alteração depois, use personalizar_item.
- Exceção: SALSICHA ADICIONAL exige saber se vai à parte ou junto. Se ele já disse, passe preparo_salsicha (junto/a_parte) na inclusão ou use definir_preparo_salsicha. Não pergunte de novo. Salsicha que já vem no hot dog não exige pergunta.
- Adicionais recebidos como produtos do catálogo JÁ estão cobrados. Para salsicha avulsa, definir_preparo_salsicha só indica preparo e lanche de destino; NÃO use acrescentar para cobrar a mesma unidade outra vez. Se houver vários lanches, esclareça qual. Sachê de maionese é produto à parte.

## Fechando o pedido — conversando, não com menu
Quando o cliente terminar de escolher, conduza o fechamento na conversa,
com perguntas curtas, pedindo apenas o que falta:

Antes de perguntar entrega ou retirada, pergunte "Quer algo mais? Digite menu para abrir as opções."
Espere ele terminar a escolha. Se já informou entrega/retirada espontaneamente, preserve essa escolha.
Não repita essa etapa depois de iniciar a coleta de endereço/nome.

1. Entrega ou retirada? → definir_entrega
2. Se entrega e cliente novo: "Me passa seu nome e endereço de entrega."
   Se já sabe o nome, peça só o endereço. Se há endereço salvo, ofereça uma
   única vez; "entrega no mesmo endereço" já é confirmação, não pergunte de novo.
3. Registre o endereço livre → definir_endereco e o nome → definir_cadastro.
   Identifique a cidade no texto e valide → definir_cidade. Só se a cidade
   não foi informada, pergunte "Qual a cidade?" e preserve o endereço recebido.
   St, Av/Ave, Ct, Ln, vírgula e quebra de linha são pistas de onde começa a
   cidade, não um formato obrigatório. Extraia também cidades FORA da lista:
   passe o nome dito pelo cliente a definir_cidade, nunca omita por não atender.
   Se a ferramenta recusar, informe as cidades atendidas e (857) 353-1025;
   não volte a perguntar a cidade que ele acabou de informar.
4. Se retirada: peça somente o nome se faltar. Email só se ele oferecer.
5. finalizar_pedido → o sistema manda o resumo com o total

Nome e endereço vão JUNTOS na coleta de entrega. Não exija apartamento, ZIP,
número ou formato postal. Não faça lista numerada. Se o cliente já tiver dito
os dados na mesma mensagem, registre todos com as ferramentas e siga.

### Pule o passo cujo dado você já tem
Os passos 1 a 4 existem para DESCOBRIR o que falta, não para confirmar o que
já se sabe. Nome que veio no CONTEXTO DO SISTEMA, ou endereço que o cliente
acabou de mencionar, estão resolvidos: registre e siga.

Perguntar "só para confirmar" o que ele acabou de dizer obriga o cliente a
repetir, e é a diferença entre conversar e preencher formulário. O passo 5
nunca é pulado.

Se finalizar_pedido disser que falta algo, pergunte o que falta com
naturalidade e chame de novo.

### finalizar_pedido é OBRIGATÓRIO — sempre, sem exceção
Isto não faz parte da lista de coleta acima, e não é dispensável por nenhum
motivo. Assim que você tiver item, tipo de entrega, endereço (se for entrega)
e nome — **não importa se eram novos ou se já vieram do contexto** — chame
finalizar_pedido IMEDIATAMENTE.

Não escreva você o resumo do pedido: nada de listar os itens com os preços,
nada de "Total: $16.00", nada de "Confirma tudo?".

Esse resumo é do sistema, e não é frescura de formato — é ele que coloca o
pedido no estado de confirmação. Se você escrever o resumo com as suas
palavras, o "sim" do cliente não fecha pedido nenhum: ele acha que pediu, você
acha que anotou, e não existe pedido. Chame a ferramenta e deixe o texto dela
falar; depois disso, só responda o que o cliente perguntar.

## Ferramentas
- adicionar_item: põe um produto NOVO no carrinho (com remover/acrescentar opcionais)
- personalizar_item: altera uma linha que JÁ existe no carrinho; não adiciona produto novo
- definir_quantidade_item: define a quantidade FINAL de uma linha que já existe
- remover_item: tira item do carrinho
- ver_carrinho: mostra o carrinho e subtotal
- definir_entrega: entrega ou retirada
- definir_cidade: registra a cidade E diz se atendemos, com a taxa
- definir_endereco: endereço livre da entrega, exatamente como o cliente informou
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
 * @param {{ interno?: boolean }} opcoes origem e comportamento da entrada
 * @returns {Promise<boolean>} true se tratou; false para o router cair no fluxo
 *                             numerado (IA indisponível ou erro).
 */
async function conversar(sess, texto, send, opcoes = {}) {
  const lang = sess.lang || 'pt';
  const interno = opcoes.interno === true;
  const permitirPerguntaMaisItens = opcoes.permitirPerguntaMaisItens === true;

  // Se a pergunta anterior foi "posso usar seu endereço salvo?", uma recusa
  // desarma a oferta antes de a IA decidir o próximo passo. Assim o mesmo
  // endereço não é oferecido de novo depois de o cliente dizer não.
  if (!interno) tools.observarMensagem(sess, texto);

  if (!interno && await tools.confirmarEnderecoPendente(sess, texto, send)) return true;

  // A escolha curta de entrega de um cliente conhecido é um dado, não uma
  // conversa criativa. Registra antes da IA e faz a pergunta de confirmação
  // pelo código; assim o modelo não pode trocar a ferramenta por texto.
  if (!interno && escolheuEntregaConhecida(sess, texto)) {
    const execucao = await tools.executar(
      'definir_entrega',
      { tipo: 'delivery' },
      sess,
      send,
      { textoCliente: texto }
    );
    const mensagemDireta = !execucao.bloqueiaFluxo && tools.mensagemAposEntrega(sess);
    if (mensagemDireta) {
      const hist = getHistorico(sess.phone);
      semearContexto(hist, sess);
      empurrar(hist, { role: 'user', content: texto });
      await send(mensagemDireta);
      empurrar(hist, { role: 'assistant', content: mensagemDireta });
      return true;
    }
  }

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

  semearContexto(hist, sess);
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
        ferramentas: interno ? [] : tools.SCHEMA,
        model: modelo,
      });

      custo.registrar(sess, resp.uso, modelo);

      // O carrinho interno já foi validado e aplicado pelo sistema. Esta
      // chamada serve somente para redigir a confirmação e a próxima pergunta:
      // qualquer tentativa de agir volta ao checkout antes de executar a
      // ferramenta ou comprar outra rodada.
      if (interno && resp.chamadas?.length) return false;

      // Sem chamadas de ferramenta: é a resposta final ao cliente.
      if (!resp.chamadas || !resp.chamadas.length) {
        const fala = resp.texto?.trim();
        if (!fala) return false;
        if (interno && ofertaNaoSolicitada(fala, cardapio.allItems())) {
          // "Algo mais?" é a etapa solicitada de montagem, não oferta de um
          // produto. Retire somente essa pergunta e verifique se sobrou upsell.
          const semEtapa = permitirPerguntaMaisItens
            ? fala.replace(/[^.!?]*(?:algo mais|mais alguma coisa)[^.!?]*[.!?]?/gi, '')
            : fala;
          if (ofertaNaoSolicitada(semEtapa, cardapio.allItems())) return false;
        }
        empurrar(hist, { role: 'assistant', content: fala });
        await send(fala);
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
      let pausouParaCliente = false;
      let mensagemDiretaEnviada = null;
      const executadas = [];
      for (const chamada of ordenar(resp.chamadas)) {
        log.info(
          { evt: 'ia_tool', nome: chamada.nome, args: chamada.argumentos },
          `ferramenta: ${chamada.nome}`
        );
        const execucao = await tools.executar(
          chamada.nome,
          chamada.argumentos,
          sess,
          send,
          { textoCliente: texto }
        );
        executadas.push({ chamada, ...execucao });
        if (execucao.entregouAoFluxo) entregou = true;
      }

      // Uma mensagem pode gerar varias ferramentas. So depois de todas elas
      // sabemos o que realmente falta. Antes, cada setter anexava sua propria
      // fotografia intermediaria; a rodada seguinte recebia ao mesmo tempo
      // "falta endereco", "falta nome" e "tudo pronto" e reperguntava dados.
      const temBloqueio = executadas.some((e) => e.bloqueiaFluxo);
      const foraDaArea = tools.mensagemCobertura(sess);
      if (!entregou && foraDaArea) {
        mensagemDiretaEnviada = foraDaArea;
        pausouParaCliente = true;
      }
      const preparoPendente = salsicha.pergunta(sess);
      if (!entregou && !foraDaArea && preparoPendente) {
        mensagemDiretaEnviada = preparoPendente;
        pausouParaCliente = true;
      }
      const avancou = executadas.some((e) => e.atualizarFluxo);
      const maisItensViaModelo = !entregou && !temBloqueio && !preparoPendente &&
        !foraDaArea && executadas.some(e => e.chamada.nome === 'adicionar_item') &&
        require('../services/mais-itens').pendente(sess);
      // Marca a etapa, mas deixa a confirmação e a pergunta serem redigidas
      // pelo modelo na rodada seguinte. Antes o código enviava um template e
      // encerrava a IA exatamente no momento mais visível da conversa.
      if (maisItensViaModelo) require('../services/mais-itens').pergunta(sess);
      // O modelo pode registrar endereco e nome em rodadas separadas.
      // Nao interrompa antes de aproveitar o nome que veio na mesma mensagem.
      const enderecoSemCadastro = !sess.name && executadas.some(
        (e) => e.chamada.nome === 'definir_endereco' && e.atualizarFluxo
      );
      if (!entregou && !temBloqueio && avancou && !enderecoSemCadastro && !maisItensViaModelo) {
        const mensagemDireta = tools.mensagemColeta(sess);
        if (mensagemDireta) {
          mensagemDiretaEnviada = mensagemDireta;
          pausouParaCliente = true;
        }
      }

      if (!entregou && !pausouParaCliente && !temBloqueio) {
        const ultimaQueAvancou = [...executadas].reverse().find((e) => e.atualizarFluxo);
        if (ultimaQueAvancou) {
          ultimaQueAvancou.resultado += tools.orientacao(sess);
        }
      }

      for (const execucao of executadas) {
        empurrar(hist, {
          role: 'tool',
          tool_call_id: execucao.chamada.id,
          nome: execucao.chamada.nome,
          content: execucao.resultado,
        });
      }

      if (mensagemDiretaEnviada) {
        await send(mensagemDiretaEnviada);
        empurrar(hist, { role: 'assistant', content: mensagemDiretaEnviada });
      }

      // finalizar_pedido entregou a conversa ao checkout — o agente sai de cena
      // e o histórico da IA se encerra (o pedido virou máquina de estados).
      if (entregou) {
        limpar(sess.phone);
        return true;
      }

      // A pergunta determinística interrompe esta resposta, mas o pedido e o
      // histórico continuam vivos. Limpar aqui faria a próxima mensagem
      // esquecer que entrega já foi escolhida.
      if (pausouParaCliente) return true;
    }

    // Estourou o teto de rodadas sem resposta final: degrada com elegância.
    log.warn({ evt: 'ia', phone: sess.phone }, 'teto de rodadas de ferramenta atingido');
    await send(t(lang, 'not_understood'));
    return true;
  } catch (_err) {
    // Apenas status numérico: nunca corpo, mensagem, headers ou chave do SDK.
    // Antes todas as falhas viravam o mesmo código, impedindo o diagnóstico.
    const status = Number(_err?.statusCode ?? _err?.status ?? _err?.response?.status);
    const statusHTTP = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    log.contexto({}, () => log.error(
      { evt: 'ia', origem: 'agente', code: 'conversa_falhou', statusHTTP },
      'falha na conversa por IA'
    ));
    return false;
  }
}

/**
 * Continua pela IA depois que o sistema validou e aplicou um carrinho nativo.
 *
 * O evento é montado exclusivamente com a sessão calculada internamente. A IA
 * só confirma o lote e pede o próximo dado obrigatório; se não puder responder,
 * devolve o controle intacto para o checkout determinístico.
 */
async function receberCarrinho(sess, send) {
  if (salsicha.pergunta(sess)) {
    sess.state = 'ORDER';
    const mensagem = salsicha.pergunta(sess);
    await send(mensagem);
    registrarSaudacao(sess, mensagem);
    return true;
  }
  const itens = sess.cart
    .map((line) => `${line.qty}x ${line.name} ($${(line.qty * line.price).toFixed(2)})`)
    .join('; ');
  const proximo = require('../services/mais-itens').pergunta(sess) || tools.orientacao(sess);
  const evento =
    '[EVENTO_INTERNO_CARRINHO]\n' +
    `Carrinho validado pelo sistema: ${itens}.\n` +
    'Confirme em uma frase natural e siga apenas com o próximo dado obrigatório. ' +
    'Não ofereça ingrediente ou produto específico. Perguntar se o cliente quer algo mais é etapa de montagem, não upsell.' +
    proximo;
  return conversar(sess, evento, send, {
    interno: true,
    permitirPerguntaMaisItens: Boolean(sess.aguardandoMaisItens),
  });
}

/** Retoma a conversa natural depois que o cliente zerou o pedido com `0`. */
async function reiniciar(sess, send) {
  const lang = sess.lang || 'pt';
  const evento = lang === 'en'
    ? '[EVENTO_INTERNO_PEDIDO_REINICIADO] The cart is empty. Confirm the restart and ask what the customer would like to order.'
    : lang === 'es'
      ? '[EVENTO_INTERNO_PEDIDO_REINICIADO] El carrito está vacío. Confirma el reinicio y pregunta qué desea pedir.'
      : '[EVENTO_INTERNO_PEDIDO_REINICIADO] O carrinho está vazio. Confirme que o pedido recomeçou e pergunte o que o cliente deseja pedir.';
  return conversar(sess, evento, send, { interno: true });
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

  const notify = require('../bot/notify');
  // Era `process.env.ADMIN_PHONE` cru — sem separar a lista e sem tirar os não
  // dígitos. Com um admin só passava despercebido; com dois, o aviso de teto
  // de gasto ia para um telefone que não existe.
  const admin = notify.dono();
  if (!admin) return;

  Promise.resolve(
    notify.send(
      admin,
      `⚠️ *Teto de gasto de IA atingido*\n\n${veredito.detalhe}\n\n` +
        'O bot continua atendendo pelo cardápio numerado — ninguém fica sem ser ' +
        'atendido, mas a conversa por IA está fora até amanhã.\n\n' +
        'Para liberar hoje, aumente `AI_MAX_USD_DIA`.'
    )
  ).catch(() => log.contexto({}, () => log.warn(
    { evt: 'ia_custo', origem: 'agente', code: 'aviso_falhou' },
    'falha ao avisar o dono do teto'
  )));
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
  semearContexto(hist, sess);
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
  } catch (_err) {
    log.contexto({}, () => log.error(
      { evt: 'ia', origem: 'agente', code: 'saudacao_falhou' },
      'falha ao saudar por IA'
    ));
    return false;
  }
}

// `getHistorico` e `ordenar` saem para que `fechamentotest` prove duas regras
// que não aparecem na resposta ao cliente: que o histórico morre junto com o
// pedido, e que a cidade roda antes do endereço numa mesma leva de chamadas.
module.exports = {
  conversar,
  receberCarrinho,
  saudar,
  registrarSaudacao,
  registrarEdicaoCarrinho,
  reiniciar,
  limpar,
  getHistorico,
  ordenar,
};
