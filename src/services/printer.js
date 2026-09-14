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

/** Telefone americano legível no papel; outros formatos continuam completos. */
function telefoneCliente(phone) {
  let digitos = String(phone || '').replace(/\D/g, '');
  if (digitos.length === 11 && digitos.startsWith('1')) digitos = digitos.slice(1);
  if (digitos.length === 10) {
    return `(${digitos.slice(0, 3)})${digitos.slice(3, 6)}-${digitos.slice(6)}`;
  }
  return digitos ? `+${digitos}` : 'sem telefone';
}

/** Identificação do cliente no rodapé — nome junto do telefone quando houver. */
function linhaCliente(order) {
  const nome = (order.customer_name || '').trim();
  const fone = telefoneCliente(order.phone);
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
 * A comanda sai na confirmação do pedido, antes do comprovante e antes de o
 * dono conferir o banco. O papel diz só o que se sabe — `COMPROVANTE RECEBIDO`
 * quando o print chegou, e onde conferir quando não chegou — em vez de afirmar
 * um pagamento que ninguém olhou, e sem tom de suspeita, porque a comanda chega
 * às mãos do cliente. Liberada à mão, leva o nome de quem mandou sair.
 *
 * Onde conferir depende do tipo, e por isso o pedido entra aqui: na retirada é
 * o caixa, na entrega é o extrato do dono. Dizer "conferir no caixa" numa
 * comanda de entrega mandaria o entregador cobrar um Zelle já enviado.
 *
 * Só os quatro últimos dígitos, pela mesma razão de `porQuem`: o papel fica na
 * cozinha e vai grampeado no pedido do cliente. Quatro bastam para o dono se
 * reconhecer, e não bastam para ligar para ninguém.
 *
 * Mantido separado do layout para a mesma regra servir às comandas e aos
 * comprovantes administrativos.
 */
function linhasPagamento(payment, order) {
  if (!payment) return ['PAGAMENTO: ZELLE'];

  if (payment.method === 'cash') {
    const linhas = ['PAGAMENTO: CASH', `COBRAR: ${money(payment.amount)}`];
    if (payment.change_for !== null && payment.change_for !== undefined) {
      linhas.push(`TROCO PARA: ${money(payment.change_for)}`);
      linhas.push(`DEVOLVER: ${money(Number(payment.change_for) - Number(payment.amount))}`);
    } else {
      linhas.push('SEM TROCO');
    }
    return linhas;
  }

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

  if (!liberado) {
    if (payment.status === 'pending') {
      return [
        'PAGAMENTO: ZELLE',
        `VALOR: ${money(payment.amount)}`,
        order?.order_type === 'delivery'
          ? 'COMPROVANTE NAO ENVIADO - CONFERIR NO BANCO'
          : 'CONFERIR NO CAIXA NA RETIRADA',
      ];
    }
    if (['awaiting_review', 'review_reminded'].includes(payment.status)) {
      return ['PAGAMENTO: ZELLE - COMPROVANTE RECEBIDO'];
    }
    return ['PAGAMENTO: ZELLE - CONFIRMADO'];
  }
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

function centerAmp(text, largura = 1) {
  const colunas = Math.floor(WIDTH / largura);
  const pad = Math.max(0, Math.floor((colunas - text.length) / 2));
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
 * A quantidade abre a linha ("2x Hambúrgão"). No fim dela, pequena e
 * encostada na margem, passava despercebida: no pedido #66 o cliente pediu 2
 * hambúrgões e 2 guaranás e recebeu 1 de cada. No Android ela sai em letra
 * dupla (ver `destacarComandaEscPos`), por isso a quebra reserva a largura
 * dobrada.
 *
 * Combos trazem as carnes escolhidas em `choices` — elas viram sub-linhas
 * indentadas, para a cozinha ler tudo sem nada truncado.
 */
function itemLines(item) {
  const qty = `${item.qty}x`;
  // `nomeCozinha` vem sempre em português. Os outros dois são fallback para
  // pedidos gravados antes dessa separação existir.
  const label = item.nomeCozinha || item.baseName || item.name;
  const nameWidth = WIDTH - qty.length * 2 - 2;

  const [first, ...rest] = wrap(label, nameWidth);
  const lines = [` ${qty} ${first}`];

  const recuo = ' '.repeat(qty.length + 2);
  for (const extra of rest) {
    lines.push(`${recuo}${extra}`);
  }

  for (const choice of item.choicesCozinha || item.choices || []) {
    for (const line of wrap(choice, WIDTH - 6)) {
      lines.push(`   > ${line}`);
    }
  }

  return lines;
}

/** Texto-base da comanda; o agente Android o converte para ESC/POS abaixo. */
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
    ...linhasPagamento(payment, order),
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

// ------------------------------------------------- páginas fora do pedido
//
// Relatório, aviso de cancelamento e segunda via não são comandas, mas usam
// o mesmo protocolo ESC/POS do agente Android.

/** Ampliação ESC/POS usada nas páginas administrativas. */
function ampSeDer(texto, altura, largura = 1) {
  return ampEscPos(texto, altura, largura);
}

function centroSeDer(texto, largura) {
  return centerAmp(texto, Math.min(largura, 2));
}

/** Data curta — o papel tem 42 colunas e a linha divide espaço com o comando. */
function carimboDeHora() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/** Fecha uma página ESC/POS, incluindo avanço e corte. */
function fecharPagina(linhas) {
  return ESC_POS_NORMAL + ascii(linhas.join('\n')) + '\n' + ESC_POS_CORTAR;
}

function buildTestPage() {
  return fecharPagina([
    '='.repeat(WIDTH),
    ampEscPos(centerAmp('TESTE DE FONTE', 2), 2, 2),
    '='.repeat(WIDTH),
    '',
    '1. Normal',
    ampEscPos('2. Altura dupla', 2),
    ampEscPos('3. Altura e largura duplas', 2, 2),
    '',
    '='.repeat(WIDTH),
  ]);
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
 * O agente de impressão não consulta o horário. O comprovante de "dia
 * encerrado" sai mesmo com o bot recusando pedidos, assim que o Android voltar.
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

  return (
    ESC_POS_NORMAL +
    ascii(carimbo) +
    '\n' +
    destacarComandaEscPos(buildTicket(order, payment)) +
    ESC_POS_CORTAR
  );
}

/** Comandos ESC/POS usados pelo agente Android. */
const ESC_POS_NORMAL = '\x1b\x21\x00';
const ESC_POS_ALTURA_DUPLA = '\x1b\x21\x10';
const ESC_POS_DUPLO = '\x1b\x21\x30';
const ESC_POS_FONTE_A = '\x1b\x4d\x00';
const ESC_POS_FONTE_B = '\x1b\x4d\x01';

// A cabeça de impressão fica antes da guilhotina. Avança cinco linhas e usa
// o corte parcial ESC/POS com avanço, aceito pela Volcora 500203.
const ESC_POS_CORTAR = '\x1b\x64\x05\x1d\x56\x42\x00';

/** `ESC !` só dobra: altura e largura acima de 2 saem em 2. */
function ampEscPos(texto, altura, largura = 1) {
  const modo = (altura > 1 ? 0x10 : 0) | (largura > 1 ? 0x20 : 0);
  return `\x1b\x21${String.fromCharCode(modo)}${texto}${ESC_POS_NORMAL}`;
}

/**
 * Destaca somente o que a cozinha precisa localizar de relance.
 *
 * O número do pedido cresce nas duas direções. Nos produtos, a quantidade que
 * abre a linha ("2x") também, e o nome só na altura: as colunas continuam
 * disponíveis e nomes compridos não passam a quebrar. As observações usam a
 * fonte B em altura dupla: ficam maiores que o texto normal, mas ainda um
 * pouco menores que o nome do produto, impresso na fonte A. Preços e todo o
 * restante da comanda permanecem no tamanho normal.
 */
function destacarComandaEscPos(ticket) {
  const dashed = '-'.repeat(WIDTH);
  let nosItens = false;

  return ticket.split('\n').map((line) => {
    const texto = line.trim();

    if (/^PEDIDO #\d+$/.test(texto)) {
      return `${ESC_POS_DUPLO}${centerAmp(texto, 2)}${ESC_POS_NORMAL}`;
    }

    if (line === 'ITENS:') {
      nosItens = true;
      return line;
    }

    if (nosItens && line === dashed) {
      nosItens = false;
      return line;
    }

    // Fonte B é fisicamente menor que a fonte A usada no produto. Em altura
    // dupla ela cria o tamanho intermediário pedido para "sem tomate",
    // adicionais e demais observações, sem perder a hierarquia visual.
    if (nosItens && texto.startsWith('>')) {
      return `${ESC_POS_FONTE_B}${ESC_POS_ALTURA_DUPLA}${line}` +
        `${ESC_POS_NORMAL}${ESC_POS_FONTE_A}`;
    }

    // A quantidade sai dupla nas duas direções; o nome e as continuações dele,
    // só mais altos.
    if (nosItens && texto) {
      const quantidade = line.match(/^(\s*)(\d+x)(\s.*)$/);
      if (quantidade) {
        return `${quantidade[1]}${ESC_POS_DUPLO}${quantidade[2]}` +
          `${ESC_POS_ALTURA_DUPLA}${quantidade[3]}${ESC_POS_NORMAL}`;
      }
      return `${ESC_POS_ALTURA_DUPLA}${line}${ESC_POS_NORMAL}`;
    }

    return line;
  }).join('\n');
}

function buildEscPosTicketWithCopies(order, payment) {
  const copies = Math.max(1, parseInt(process.env.PRINTER_COPIES, 10) || 1);
  return Array.from(
    { length: copies },
    () => ESC_POS_NORMAL + destacarComandaEscPos(buildTicket(order, payment)) + ESC_POS_CORTAR
  ).join('');
}

module.exports = {
  buildTicket,
  buildEscPosTicketWithCopies,
  buildTestPage,
  buildTexto,
  buildCancelamento,
  buildRegistroAdmin,
  buildSegundaVia,
  textoImprimivel,
  porQuem,
};
