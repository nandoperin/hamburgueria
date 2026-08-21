const { suporte } = require('../i18n');

const WIDTH = 42; // colunas de uma impressora 80mm em fonte padrão

/**
 * A comanda vai grampeada no pedido e chega às mãos do cliente.
 *
 * Por isso nada de comando administrativo impresso: `!liberar 28` num papel
 * que o cliente lê é instrução que não é dele, e o dono não precisa dela ali —
 * o número do pedido sai em destaque e `!pedido 28` no WhatsApp traz tudo.
 *
 * O que fica é quem liberou o pagamento, em quatro dígitos — ver
 * `linhasPagamento`.
 */
function rodapeCliente() {
  const fone = suporte();
  return fone ? `Duvidas? Ligue ${fone}` : '';
}

/** Identificação do cliente no rodapé — nome junto do telefone quando houver. */
function linhaCliente(order) {
  const nome = (order.customer_name || '').trim();
  const fone = `+${order.phone}`;
  return wrap(nome ? `Cliente: ${nome} · ${fone}` : `Cliente: ${fone}`, WIDTH);
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

/**
 * O bloco de pagamento da comanda.
 *
 * Com Zelle não há referência externa para imprimir: não existe id de transação
 * que o servidor conheça, nem painel onde estornar. O que existe — e é o que
 * importa — é **quem liberou**.
 *
 * Isso não é enfeite de recibo, é o rastro que fecha o buraco do Zelle: a
 * comanda só sai porque uma pessoa conferiu um comprovante e mandou sair. Uma
 * comanda que aparece sem esse nome é uma comanda que ninguém liberou, e quem
 * lê o papel percebe.
 *
 * Só os quatro últimos dígitos, pela mesma razão de `porQuem`: o papel fica na
 * cozinha e vai grampeado no pedido do cliente. Quatro bastam para o dono se
 * reconhecer, e não bastam para ligar para ninguém.
 *
 * Extraído porque os três formatos (plain, starprnt, markup) montavam a mesma
 * coisa em três lugares — e três cópias é como uma delas fica para trás.
 */
function linhasPagamento(payment) {
  if (!payment) return ['PAGAMENTO: ZELLE'];

  const liberado = payment.approved_by
    ? `LIBERADO POR ${porQuem(payment.approved_by)}`
    : null;

  const quando = payment.approved_at
    ? new Date(payment.approved_at).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : null;

  if (!liberado) return ['PAGAMENTO: ZELLE - CONFIRMADO'];
  return ['PAGAMENTO: ZELLE - CONFIRMADO', `${liberado}${quando ? ` em ${quando}` : ''}`];
}

/**
 * Tira acento e cedilha antes de mandar para a impressora.
 *
 * O papel sai em ASCII: a impressora interpreta byte a byte na code page dela,
 * e nosso texto é UTF-8 — "ç" viaja em dois bytes e sairia como dois símbolos
 * errados. Dá para acertar selecionando a code page com `ESC GS t`, mas isso
 * exigiria reencodar toda a resposta e acertar a tabela; "Linguica" na comanda
 * da cozinha resolve igual.
 *
 * Aplicado no texto final, então pega também nome e endereço do cliente, que
 * vêm digitados por ele e não dá para controlar na origem.
 *
 * Mora em `src/texto.js` porque o canal do admin quer a mesma transformação,
 * por outro motivo — ver lá.
 */
const { ascii } = require('../texto');

function center(text) {
  const pad = Math.max(0, Math.floor((WIDTH - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/** Linha com rótulo à esquerda e valor alinhado à direita. */
function row(label, value) {
  const space = Math.max(1, WIDTH - label.length - value.length);
  return label + ' '.repeat(space) + value;
}

/** Quebra o texto em linhas que cabem na largura, sem cortar palavras. */
function wrap(text, width) {
  const lines = [];
  let current = '';

  for (const word of text.split(' ')) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines;
}

/**
 * Linhas de um item da comanda.
 *
 * Combos trazem as carnes escolhidas em `choices` — elas viram sub-linhas
 * indentadas, para a cozinha ler tudo sem nada truncado.
 */
function itemLines(item) {
  const qty = `x${item.qty}`;
  // `nomeCozinha` vem sempre em português. Os outros dois são fallback para
  // pedidos gravados antes dessa separação existir.
  const label = item.nomeCozinha || item.baseName || item.name;
  const nameWidth = WIDTH - qty.length - 2;

  const [first, ...rest] = wrap(label, nameWidth);
  const lines = [row(` ${first}`, qty)];

  for (const extra of rest) {
    lines.push(`   ${extra}`);
  }

  for (const choice of item.choicesCozinha || item.choices || []) {
    for (const line of wrap(choice, WIDTH - 6)) {
      lines.push(`   > ${line}`);
    }
  }

  return lines;
}

/**
 * Monta o texto da comanda que a impressora vai buscar via CloudPRNT.
 * Retorna texto puro — a TSP143IV renderiza text/plain diretamente.
 */
function buildTicket(order, payment) {
  const negocio = process.env.BUSINESS_NAME || 'HAMBURGUERIA';
  const solid = '='.repeat(WIDTH);
  const dashed = '-'.repeat(WIDTH);
  const items = Array.isArray(order.items_json) ? order.items_json : [];

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
  });

  const isPickup = order.order_type === 'pickup';
  const customer = order.customer_name || '';

  // O bloco de destino é o que o entregador lê de relance — nome e endereço
  // ficam em caixa alta e com destaque, sem competir com o resto da comanda.
  const destination = isPickup
    ? [
        center('*** RETIRADA NO BALCAO ***'),
        '',
        ...(customer ? [`CLIENTE: ${customer.toUpperCase()}`] : []),
      ]
    : [
        center('>>> ENTREGAR PARA <<<'),
        '',
        ...(customer ? wrap(customer.toUpperCase(), WIDTH) : []),
        ...wrap(order.address.toUpperCase(), WIDTH),
        order.city.toUpperCase(),
      ];

  const totals = isPickup
    ? [row('TOTAL:', money(order.total))]
    : [
        row('SUBTOTAL:', money(order.subtotal)),
        row('TAXA ENTREGA:', money(order.delivery_fee)),
        row('TOTAL:', money(order.total)),
      ];

  const rodape = rodapeCliente();

  const lines = [
    solid,
    center(negocio.toUpperCase()),
    center(isPickup ? '*** RETIRADA ***' : '*** DELIVERY ***'),
    solid,
    center(`PEDIDO #${order.id}`),
    timestamp,
    dashed,
    'ITENS:',
    ...items.flatMap(itemLines),
    dashed,
    ...destination,
    dashed,
    ...totals,
    dashed,
    ...linhasPagamento(payment),
    dashed,
    ...linhaCliente(order),
    ...(rodape ? [center(rodape)] : []),
    solid,
    '',
    '',
    '',
  ];

  return ascii(lines.join('\n'));
}

// ------------------------------------------------------- StarPRNT (fonte grande)
//
// A impressora declarou `application/vnd.star.starprnt` no GET, então aceita
// comando nativo. Segundo a especificação oficial (Rev. 4.01, pág. 35):
//
//   ESC i n1 n2   →   hex 1B 69 n1 n2
//   n1 = altura   (0 cancela, 1 = 2x, ... 5 = 6x)
//   n2 = largura  (0 cancela, 1 = 2x, ... 5 = 6x)
//
// O intervalo aceita tanto 0–5 quanto os dígitos ASCII '0'–'5'. Usamos os
// dígitos: são caracteres imprimíveis, sem risco de a codificação UTF-8 da
// resposta mexer em byte de controle.

const ESC = '\x1B';

/** `ESC i` cru — altura e largura em fatores de 1 (normal) a 6. */
function esc(altura = 1, largura = 1) {
  const n = (fator) => String(Math.min(6, Math.max(1, fator)) - 1);
  return `${ESC}i${n(altura)}${n(largura)}`;
}

const NORMAL = esc(1, 1);

/**
 * Corte do papel — `ESC d 2` (hex 1B 64 32), spec pág. 50.
 *
 * O `2` avança o papel até a posição da guilhotina e então corta por inteiro.
 * O `0` também corta, mas na posição atual: o fim da comanda ficaria preso
 * dentro da impressora, atrás do cabeçote.
 *
 * Em `text/plain` a impressora cortava sozinha no fim do documento; no modo de
 * comando ela espera a instrução. Foi o que faltou na primeira versão.
 *
 * Como este comando já faz o avanço, as linhas em branco do rodapé saem — elas
 * só existiam para empurrar o papel além do cabeçote.
 */
const CORTAR = `${ESC}d2`;

/** Envolve o texto na ampliação e volta ao normal — nunca deixa estado solto. */
function amp(text, altura, largura = 1) {
  return `${esc(altura, largura)}${text}${NORMAL}`;
}

/**
 * Centraliza contando as colunas *efetivas*.
 *
 * Com largura dupla cada caractere ocupa dois, então o papel cabe metade do
 * texto. Centralizar com o padding de 42 empurraria a linha para fora e a
 * impressora quebraria no meio.
 */
function centerAmp(text, largura = 1) {
  const colunas = Math.floor(WIDTH / largura);
  const pad = Math.max(0, Math.floor((colunas - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * Página de diagnóstico: mesma linha em quatro tamanhos.
 *
 * Existe porque as duas tentativas anteriores de ampliar a fonte foram
 * verificadas em pedido de verdade — e uma delas custou uma comanda que a
 * impressora confirmou sem imprimir. Com isto o teste é sob demanda, sem
 * envolver pedido nenhum.
 */
function buildTestPage() {
  // Texto do teste em ASCII puro de proposito: acento e travessao sao
  // multi-byte, e se a impressora tropecar neles a gente confundiria problema
  // de codificacao com problema de comando.
  const linhas = [
    '='.repeat(WIDTH),
    amp(centerAmp('TESTE DE FONTE', 2), 2, 2),
    '='.repeat(WIDTH),
    '',
    '1. Normal (como sai hoje)',
    amp('2. Altura 2x (para os itens)', 2),
    amp('3. Alt+Larg 2x', 2, 2),
    amp('4. Triplo', 3, 3),
    '',
    '-'.repeat(WIDTH),
    'As quatro linhas do MESMO tamanho:',
    'a impressora ignora os comandos.',
    '',
    'Tamanhos diferentes: funciona,',
    'e a comanda pode usar fonte grande.',
    '='.repeat(WIDTH),
  ];
  return NORMAL + ascii(linhas.join('\n')) + '\n' + CORTAR;
}

/** Comanda em StarPRNT: mesmo layout do texto puro, com ampliação. */
function buildTicketStarprnt(order, payment) {
  const negocio = process.env.BUSINESS_NAME || 'HAMBURGUERIA';
  const solid = '='.repeat(WIDTH);
  const dashed = '-'.repeat(WIDTH);
  const items = Array.isArray(order.items_json) ? order.items_json : [];

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
  });

  const isPickup = order.order_type === 'pickup';
  const customer = order.customer_name || '';

  const destino = isPickup
    ? [
        amp(centerAmp('*** RETIRADA NO BALCAO ***'), 2),
        '',
        ...(customer ? [amp(`CLIENTE: ${customer.toUpperCase()}`, 2)] : []),
      ]
    : [
        amp(centerAmp('>>> ENTREGAR PARA <<<'), 2),
        '',
        ...(customer ? wrap(customer.toUpperCase(), WIDTH) : []).map((l) => amp(l, 2)),
        ...wrap(order.address.toUpperCase(), WIDTH).map((l) => amp(l, 2)),
        amp(order.city.toUpperCase(), 2),
      ];

  const totais = isPickup
    ? [amp(row('TOTAL:', money(order.total)), 2)]
    : [
        row('SUBTOTAL:', money(order.subtotal)),
        row('TAXA ENTREGA:', money(order.delivery_fee)),
        amp(row('TOTAL:', money(order.total)), 2),
      ];

  const rodape = rodapeCliente();

  const lines = [
    solid,
    amp(centerAmp(negocio.toUpperCase(), 2), 2, 2),
    amp(centerAmp(isPickup ? '*** RETIRADA ***' : '*** DELIVERY ***', 2), 2, 2),
    solid,
    amp(centerAmp(`PEDIDO #${order.id}`, 2), 2, 2),
    timestamp,
    dashed,
    'ITENS:',
    ...items.flatMap(itemLines).map((l) => amp(l, 2)),
    dashed,
    ...destino,
    dashed,
    ...totais,
    dashed,
    ...linhasPagamento(payment),
    dashed,
    ...linhaCliente(order),
    ...(rodape ? [center(rodape)] : []),
    solid,
  ];

  return NORMAL + ascii(lines.join('\n')) + '\n' + CORTAR;
}

// --------------------------------------------------------------- fonte grande
//
// O `text/plain` não tem controle de fonte: sai tudo no tamanho padrão, que na
// correria do serviço obriga a chegar perto para ler. O Star Document Markup
// resolve isso com tags que a própria impressora interpreta.
//
// A regra que mantém tudo funcionando é usar **altura dobrada sem largura
// dobrada** (`[mag: h 2]`) no corpo: o texto fica duas vezes mais alto e legível
// de relance, mas ocupa as mesmas colunas — então o alinhamento calculado em
// WIDTH continua valendo. Largura dupla só onde a linha é curta e centralizada.

/** Envolve o texto em uma ampliação, voltando ao padrão logo depois. */
function mag(text, { w = 1, h = 2 } = {}) {
  return `[mag: w ${w}; h ${h}]${text}[mag]`;
}

/** Só as linhas com conteúdo — evita ampliar separador e linha em branco. */
function magLines(lines, opcoes) {
  return lines.map((line) => (line.trim() ? mag(line, opcoes) : line));
}

/**
 * Mesma comanda do `buildTicket`, em Star Document Markup.
 *
 * A centralização passa a ser tag (`[align: centre]`) em vez de espaços: o
 * motor de quebra de linha da impressora trata as tags como delimitador e pode
 * comer espaços à esquerda, então padding manual não é confiável aqui.
 */
function buildTicketMarkup(order, payment) {
  const negocio = process.env.BUSINESS_NAME || 'HAMBURGUERIA';
  const solid = '='.repeat(WIDTH);
  const dashed = '-'.repeat(WIDTH);
  const items = Array.isArray(order.items_json) ? order.items_json : [];

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
  });

  const isPickup = order.order_type === 'pickup';
  const customer = order.customer_name || '';

  const destino = isPickup
    ? [
        mag('*** RETIRADA NO BALCAO ***'),
        '',
        ...(customer ? magLines([`CLIENTE: ${customer.toUpperCase()}`]) : []),
      ]
    : [
        mag('>>> ENTREGAR PARA <<<'),
        '',
        ...magLines([
          ...(customer ? wrap(customer.toUpperCase(), WIDTH) : []),
          ...wrap(order.address.toUpperCase(), WIDTH),
          order.city.toUpperCase(),
        ]),
      ];

  // Totais em altura dupla: é o número que o entregador confere na porta.
  const totais = isPickup
    ? [mag(row('TOTAL:', money(order.total)))]
    : [
        row('SUBTOTAL:', money(order.subtotal)),
        row('TAXA ENTREGA:', money(order.delivery_fee)),
        mag(row('TOTAL:', money(order.total))),
      ];

    const lines = [
    '[align: centre]',
    solid,
    mag(negocio.toUpperCase(), { w: 2, h: 2 }),
    mag(isPickup ? '*** RETIRADA ***' : '*** DELIVERY ***', { w: 2, h: 2 }),
    solid,
    mag(`PEDIDO #${order.id}`, { w: 2, h: 2 }),
    '[align: left]',
    timestamp,
    dashed,
    'ITENS:',
    ...magLines(items.flatMap(itemLines)),
    dashed,
    '[align: centre]',
    ...destino,
    '[align: left]',
    dashed,
    ...totais,
    dashed,
    ...linhasPagamento(payment),
    dashed,
    ...linhaCliente(order),
    ...(rodapeCliente() ? ['[align: centre]', rodapeCliente(), '[align: left]'] : []),
    solid,
    '',
    '',
    '',
  ];

  return ascii(lines.join('\n'));
}

// ------------------------------------------------- páginas fora do pedido
//
// Relatório, aviso de cancelamento e segunda via não são comanda: não têm
// itens nem endereço, mas saem no mesmo papel e precisam respeitar o mesmo
// formato ativo. Daí os dois auxiliares abaixo, que decidem sozinhos se podem
// usar comando de ampliação ou se o texto tem que sair puro.

/** Amplia só quando o formato ativo entende os comandos da Star. */
function ampSeDer(texto, altura, largura = 1) {
  return formato() === FORMATOS.starprnt ? amp(texto, altura, largura) : texto;
}

/**
 * Centraliza contando as colunas que o texto vai mesmo ocupar.
 *
 * `centerAmp` divide a largura pelo fator porque cada caractere ampliado ocupa
 * dois. Só que em `plain` a ampliação não acontece — usar a mesma conta ali
 * empurraria o título para a esquerda, parecendo desalinhado no papel.
 */
function centroSeDer(texto, largura) {
  return formato() === FORMATOS.starprnt ? centerAmp(texto, largura) : center(texto);
}

/** Data curta — o papel tem 42 colunas e a linha divide espaço com o comando. */
function carimboDeHora() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/**
 * Fecha a página conforme o formato.
 *
 * Em StarPRNT o corte é explícito (`ESC d 2`, que já avança o papel). Em texto
 * puro a impressora corta sozinha no fim do documento, e aí o que falta são as
 * linhas em branco para empurrar o fim para além do cabeçote.
 */
function fecharPagina(linhas) {
  const corpo = ascii(linhas.join('\n'));
  return formato() === FORMATOS.starprnt
    ? NORMAL + corpo + '\n' + CORTAR
    : corpo + '\n\n\n';
}

/**
 * Converte a resposta do WhatsApp em algo que faça sentido no papel.
 *
 * As respostas do bot são escritas para a tela: têm emoji, `*negrito*` e linhas
 * mais largas que os 42 caracteres do papel. Mandar isso cru imprimia asterisco
 * literal e quebrava a linha no meio da palavra.
 *
 * O emoji é removido pelo `ascii()`, e quase sempre ele abria a linha seguido
 * de um espaço ("📊 RELATÓRIO") — daí tirar **um** espaço inicial quando sobra.
 * Dois ou mais são indentação de propósito, como nos itens da fila, e ficam.
 */
function textoImprimivel(texto) {
  return require('../texto')
    .paraAdmin(texto)
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .split('\n')
    .flatMap((linha) => (linha.length <= WIDTH ? [linha] : wrap(linha, WIDTH)))
    .join('\n');
}

/**
 * Página de texto avulso — usada pelo `!imprimir`.
 *
 * O cabeçalho não repete o nome do comando em letra grande porque quase toda
 * resposta do bot já abre com o próprio título ("RELATÓRIO — HOJE", "ESTOQUE").
 * Dois títulos seguidos, um em cada tamanho, ficavam com cara de erro. O comando
 * fica ao lado da hora, pequeno, só para se saber de onde o papel veio.
 */
function buildTexto({ titulo, corpo }) {
  const negocio = process.env.BUSINESS_NAME || 'HAMBURGUERIA';
  const origem = titulo ? ` · ${ascii(titulo)}` : '';

  return fecharPagina([
    '='.repeat(WIDTH),
    ampSeDer(centroSeDer(negocio.toUpperCase(), 2), 2, 2),
    '='.repeat(WIDTH),
    `${carimboDeHora()}${origem}`,
    '-'.repeat(WIDTH),
    '',
    textoImprimivel(corpo),
    '',
    '='.repeat(WIDTH),
  ]);
}

/**
 * Últimos dígitos do número que mandou o comando.
 *
 * É o campo que transforma o papel de registro em alarme. O dono não decora o
 * próprio número inteiro, mas reconhece o final dele na hora — e se o final não
 * for o dele, alguém está dando comando em nome dele.
 *
 * Só o final, e não o número todo, porque este papel fica na loja e pode ser
 * visto por quem passa. Quatro dígitos bastam para reconhecer, e não bastam para
 * ligar para ninguém.
 */
function porQuem(phone) {
  const digitos = String(phone || '').replace(/\D/g, '');
  return digitos ? `+...${digitos.slice(-4)}` : '(numero desconhecido)';
}

/**
 * Cancelamento no papel.
 *
 * ## Para quem é
 *
 * Nasceu para a cozinha, e para o caso em que a comanda **já saiu**: alguém está
 * montando o espeto agora, e mensagem no WhatsApp do dono não alcança quem está
 * na chapa. Daí o número do pedido no maior tamanho que o papel aceita — quem lê
 * está a dois metros, procurando qual comanda arrancar do varal.
 *
 * ## Por que agora sai sempre
 *
 * Passou a sair também quando a comanda **nunca** foi impressa, e aí o leitor é
 * outro: o dono. Liberar um pagamento é a decisão que põe comida na chapa, e com Zelle não
 * há estorno: uma vez liberado, o dinheiro não volta pelo mesmo caminho.
 *
 * O papel importa porque é o canal que um invasor não controla. Quem tomasse o
 * WhatsApp do dono receberia os avisos dele — para adulterar o que já saiu na
 * impressora, teria que estar dentro da loja. É detecção, não tranca: vale pelo
 * dia seguinte, quando alguém lê o que saiu e vê um número que não é o seu.
 */
function buildCancelamento(order, { phone, naCozinha = true } = {}) {
  const items = Array.isArray(order.items_json) ? order.items_json : [];
  const quando = carimboDeHora();

  return fecharPagina([
    '='.repeat(WIDTH),
    ampSeDer(centroSeDer('CANCELADO', 3), 3, 3),
    ampSeDer(centroSeDer(`PEDIDO #${order.id}`, 2), 2, 2),
    '='.repeat(WIDTH),
    '',
    naCozinha
      ? ampSeDer('NAO PREPARAR / DESCARTAR', 2)
      : 'A comanda nao chegou a ser impressa.',
    '',
    '-'.repeat(WIDTH),
    ...items.map((i) => `${i.qty}x ${i.nomeCozinha || i.baseName || i.name}`),
    '-'.repeat(WIDTH),
    ...(order.customer_name ? [`Cliente: ${order.customer_name}`] : []),
    quando,
    '-'.repeat(WIDTH),
    `Cancelado por: ${porQuem(phone)}`,
    'Se esse final nao e o seu, alguem deu',
    'o comando no seu lugar.',
    '='.repeat(WIDTH),
  ]);
}

/**
 * Comprovante de comando administrativo — hoje, `!fechar` e `!abrir`.
 *
 * Mesma ideia do cancelamento acima, pelo mesmo motivo: encerrar o atendimento
 * é uma ação que, feita por outro, o dono só descobriria pelo faturamento no fim
 * do dia. No papel ele descobre ao passar pela impressora.
 *
 * Um detalhe que faz isto funcionar melhor do que parece: o endpoint do
 * CloudPRNT não consulta o horário. O comprovante de "dia encerrado" sai mesmo
 * com o bot recusando pedidos, assim que a impressora acordar.
 */
function buildRegistroAdmin({ titulo, linhas = [], phone }) {
  return fecharPagina([
    '='.repeat(WIDTH),
    ampSeDer(centroSeDer('REGISTRO', 2), 2, 2),
    center('comando administrativo'),
    '='.repeat(WIDTH),
    '',
    ampSeDer(ascii(titulo), 2),
    '',
    '-'.repeat(WIDTH),
    `Quando: ${carimboDeHora()}`,
    `Por:    ${porQuem(phone)}`,
    ...(linhas.length ? ['-'.repeat(WIDTH), ...linhas.map((l) => ascii(l))] : []),
    '-'.repeat(WIDTH),
    'Se esse final nao e o seu, alguem deu',
    'o comando no seu lugar.',
    '='.repeat(WIDTH),
  ]);
}

/**
 * Segunda via da comanda.
 *
 * O carimbo não é enfeite: uma reimpressão idêntica à primeira faz a cozinha
 * montar o pedido duas vezes. Ele existe para quem pega o papel saber que já
 * viu esse pedido antes.
 */
function buildSegundaVia(order, payment) {
  const carimbo = [
    '='.repeat(WIDTH),
    ampSeDer(centroSeDer('*** 2a VIA ***', 2), 2, 2),
    center('ja impressa antes'),
    '='.repeat(WIDTH),
    '',
  ].join('\n');

  return `${formato() === FORMATOS.starprnt ? NORMAL : ''}${ascii(carimbo)}\n${formato().build(order, payment)}`;
}

/**
 * `markup` (padrão) usa fonte ampliada; `plain` volta ao texto puro.
 *
 * A saída fica em variável de ambiente porque não dá para conferir o resultado
 * sem o papel na mão — se a marcação sair errada na impressora, trocar para
 * `plain` restaura a comanda antiga sem precisar de deploy.
 */
/**
 * Formato da comanda, escolhido por `PRINTER_FORMAT`.
 *
 * O padrão é `plain` porque é o único que já se provou nesta impressora. Trocar
 * é uma variável de ambiente, sem deploy — se sair errado, volta na hora.
 *
 *   plain     texto puro (padrão, comprovado)
 *   starprnt  comando nativo com fonte ampliada
 *   markup    Star Document Markup — a impressora aceitou e não imprimiu
 */
const FORMATOS = {
  plain: { build: buildTicket, mime: 'text/plain' },
  starprnt: { build: buildTicketStarprnt, mime: 'application/vnd.star.starprnt' },
  markup: { build: buildTicketMarkup, mime: 'text/vnd.star.markup' },
};

function formato() {
  const nome = (process.env.PRINTER_FORMAT || 'plain').toLowerCase();
  return FORMATOS[nome] || FORMATOS.plain;
}

/** Tipo de mídia coerente com o formato ativo. */
function mediaType() {
  return formato().mime;
}

/** Repete a comanda conforme PRINTER_COPIES (cozinha + entregador, etc). */
function buildTicketWithCopies(order, payment) {
  const copies = Math.max(1, parseInt(process.env.PRINTER_COPIES, 10) || 1);
  const build = formato().build;
  return Array(copies).fill(build(order, payment)).join('\n');
}

module.exports = {
  buildTicket,
  buildTicketMarkup,
  buildTicketStarprnt,
  buildTicketWithCopies,
  buildTestPage,
  buildTexto,
  buildCancelamento,
  buildRegistroAdmin,
  buildSegundaVia,
  textoImprimivel,
  porQuem,
  mediaType,
};
