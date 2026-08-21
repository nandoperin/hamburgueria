const log = require('../../log');
const { paraAdmin, comoComando } = require('../../texto');
const db = require('../../db/queries');
const menuConfig = require('../../../config/menu.json');
const availability = require('../../services/availability');

const TZ = 'America/New_York';
const SQUARE_RATE = 0.033;
const SQUARE_FIXED = 0.3;

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

/** Início do dia (no fuso do truck) deslocado por `daysAgo`, em ISO. */
function startOfDay(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const date = new Date(`${parts}T00:00:00-05:00`);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

function startOfMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  return new Date(`${parts}-01T00:00:00-05:00`).toISOString();
}

function formatTopItems(items) {
  if (!items.length) return '';
  const lines = items
    .map((i, idx) => `${idx + 1}. ${i.name} — ${i.qty}x (${money(i.revenue)})`)
    .join('\n');
  return `\n🏆 *TOP ITENS:*\n${lines}`;
}

function formatReportBody(report) {
  const fees = report.revenue * SQUARE_RATE + report.orderCount * SQUARE_FIXED;
  const net = report.revenue - fees;

  return (
    `Pedidos: ${report.orderCount}\n` +
    `💰 Receita bruta: ${money(report.revenue)}\n` +
    `🚗 Taxas de entrega: ${money(report.deliveryFees)}\n` +
    `💳 Taxas Square (~3.3%): ~${money(fees)}\n` +
    `💵 Receita líquida est.: ~${money(net)}\n` +
    `Ticket médio: ${money(report.avgTicket)}\n` +
    formatTopItems(report.topItems)
  );
}

async function buildTodayReport() {
  const from = startOfDay(0);
  const to = new Date().toISOString();
  const report = await db.getReport(from, to);
  return `📊 *RELATÓRIO — Hoje*\n\n${formatReportBody(report)}`;
}

async function buildWeekReport() {
  const from = startOfDay(7);
  const to = new Date().toISOString();

  const [report, byDay] = await Promise.all([
    db.getReport(from, to),
    db.getRevenueByDay(from, to),
  ]);

  const dayLines = byDay
    .map((d) => `  ${d.day}: ${money(d.revenue)} — ${d.count} pedidos`)
    .join('\n');

  return (
    `📊 *RELATÓRIO — Últimos 7 dias*\n\n` +
    `${formatReportBody(report)}\n\n` +
    `*Por dia:*\n${dayLines || '  (sem pedidos)'}`
  );
}

async function buildMonthReport() {
  const from = startOfMonth();
  const to = new Date().toISOString();
  const report = await db.getReport(from, to);
  return `📊 *RELATÓRIO — Este mês*\n\n${formatReportBody(report)}`;
}

async function buildPendingOrders() {
  const orders = await db.getPendingOrders();
  if (!orders.length) return '✅ Nenhum pedido pendente!';

  const lines = orders
    .map((o) => {
      const items = (Array.isArray(o.items_json) ? o.items_json : [])
        .map((i) => `${i.name} x${i.qty}`)
        .join(', ');
      return `*#${o.id}* — +${o.phone}\n  ${items}\n  Total: ${money(o.total)}\n  ${o.city} — ${o.address}`;
    })
    .join('\n\n');

  return `📋 *PEDIDOS PENDENTES (${orders.length})*\n\n${lines}`;
}

async function buildEmailList() {
  const customers = await db.listCustomerEmails();
  if (!customers.length) return '📧 Nenhum email cadastrado ainda.';

  const lines = customers.map((c) => `• ${c.email}`).join('\n');
  return `📧 *EMAILS CADASTRADOS (${customers.length})*\n\n${lines}`;
}

const COMMANDS = {
  '!relatorio hoje': buildTodayReport,
  '!report today': buildTodayReport,
  '!relatorio semana': buildWeekReport,
  '!report week': buildWeekReport,
  '!relatorio mes': buildMonthReport,
  '!report month': buildMonthReport,
  '!pedidos pendentes': buildPendingOrders,
  '!pending orders': buildPendingOrders,
  '!emails': buildEmailList,
  // Sem as grafias acentuadas: a entrada já chega sem acento por `comoComando`,
  // então "!últimos" e "!catálogo" casam com as chaves abaixo.
  '!ultimos': buildUltimos,
  '!estoque': buildEstoque,
  '!fila': () => require('../../services/printwatch').resumo(),
  '!impressora': () => require('../../services/printwatch').resumo(),
  '!catalogo': () => require('../../services/catalogcheck').resumo(),
  '!fechar': buildFechar,
  '!parar': buildFechar,
  '!abrir': buildAbrir,
  '!voltar': buildAbrir,
  '!testeimpressao': buildTesteImpressao,
  '!teste': buildTesteImpressao,
};

/** "terça, 17:00" no fuso do truck — para o dono conferir sem fazer conta. */
function quandoVolta(data) {
  return data.toLocaleString('pt-BR', {
    timeZone: TZ,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `!fechar` — encerra o atendimento antes da hora.
 *
 * Acabou a carne, choveu, o entregador foi embora. A partir daqui o cliente
 * recebe a mensagem de fechado, e o atendimento **volta sozinho** na próxima
 * abertura: ninguém precisa lembrar de reabrir no dia seguinte.
 */
/**
 * Comprovante em papel de um comando que mudou o atendimento.
 *
 * Encerrar o dia é a ação que, feita por outro, o dono só descobriria pelo
 * faturamento no fim da noite. O papel é o canal que quem tomasse o WhatsApp
 * dele não controlaria — teria que estar dentro do truck. Ver `printer.js`.
 *
 * Só sai quando o estado **mudou de verdade**: `!fechar` num truck já fechado
 * não vira papel, senão o comprovante que importa se perde no meio dos outros.
 */
function registrarNoPapel({ titulo, linhas, phone }) {
  try {
    const printer = require('../../services/printer');
    require('../../services/printqueue').enfileirar({
      conteudo: printer.buildRegistroAdmin({ titulo, linhas, phone }),
      descricao: titulo.toLowerCase(),
    });
  } catch (err) {
    log.error({ evt: 'impressao', err }, 'falha ao enfileirar o registro do comando');
  }
}

async function buildFechar(phone) {
  const schedule = require('../../services/schedule');

  // Encerrar o que já está encerrado à mão não repausa nem gasta papel. O
  // comando nunca foi idempotente — mandar duas vezes só devolvia a mesma
  // confirmação —, e isso deixou de ser inofensivo quando ele passou a imprimir:
  // comprovante repetido é o começo de ninguém mais ler comprovante nenhum.
  if (schedule.estadoDaPausa().pausado) {
    return (
      `ℹ️ O atendimento já foi encerrado à mão.\n\n` +
      `Volta sozinho *${quandoVolta(schedule.proximaAbertura())}*.\n\n` +
      `_Para retomar agora: *!abrir*._`
    );
  }

  if (!schedule.abertoPelaAgenda()) {
    const volta = schedule.proximaAbertura();
    return (
      `ℹ️ O atendimento já está fechado agora, pelo horário normal.\n\n` +
      `Próxima abertura: *${quandoVolta(volta)}*.`
    );
  }

  const volta = await schedule.pausarAteProximaAbertura();
  if (!volta) return '❌ Não consegui calcular a próxima abertura. Confira config/schedule.json.';

  registrarNoPapel({
    titulo: 'ATENDIMENTO ENCERRADO',
    linhas: [`Volta sozinho ${quandoVolta(volta)}.`],
    phone,
  });

  return (
    `🔴 *Atendimento encerrado por hoje.*\n\n` +
    `Quem escrever recebe a mensagem de fechado.\n` +
    `Volta sozinho *${quandoVolta(volta)}* — não precisa reabrir.\n\n` +
    `🖨️ Comprovante indo para a impressora.\n` +
    `_Mudou de ideia? *!abrir* retoma agora._`
  );
}

/** `!abrir` — desfaz o `!fechar` antes da hora. */
async function buildAbrir(phone) {
  const schedule = require('../../services/schedule');
  const { pausado } = schedule.estadoDaPausa();

  if (!pausado) {
    return schedule.abertoPelaAgenda()
      ? 'ℹ️ O atendimento já está aberto.'
      : `ℹ️ Nada encerrado à mão. Fora do horário, o bot abre sozinho *${quandoVolta(schedule.proximaAbertura())}*.`;
  }

  await schedule.retomar();
  registrarNoPapel({ titulo: 'ATENDIMENTO RETOMADO', phone });

  return (
    '🟢 *Atendimento retomado.* O bot voltou a aceitar pedidos.\n\n' +
    '🖨️ Comprovante indo para a impressora.'
  );
}

/**
 * Enfileira uma página de diagnóstico da impressora.
 *
 * Não envolve pedido nenhum: serve para conferir papel, conexão e — o motivo
 * de existir — se a impressora obedece aos comandos de fonte ampliada.
 */
function buildTesteImpressao() {
  require('../../api/cloudprnt').pedirTeste();
  return (
    '🖨️ *Teste enviado.*\n\n' +
    'Deve sair em até 5 segundos, com a mesma frase em quatro tamanhos.\n\n' +
    '• Todas iguais → a impressora ignora os comandos de fonte\n' +
    '• Tamanhos diferentes → funciona, e a comanda pode usar\n\n' +
    '_Não gasta pedido nem mexe na fila._'
  );
}

// Abaixo disto, `endsWith` deixaria de ser seguro: um número curto casaria com
// qualquer telefone terminado nos mesmos dígitos, e esses comandos estornam
// dinheiro. Números reais com código de país têm 11+.
const MIN_DIGITOS_ADMIN = 10;

function adminsConfigurados() {
  return (process.env.ADMIN_PHONE || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);
}

/**
 * O número tem permissão de admin?
 *
 * Compara por sufixo porque o mesmo telefone chega com ou sem código de país
 * dependendo de como foi cadastrado — mas só aceita entradas longas o
 * suficiente para que isso não vire uma porta aberta.
 */
function isAdminPhone(phone) {
  const recebido = String(phone || '').replace(/\D/g, '');
  if (!recebido) return false;

  return adminsConfigurados().some((admin) => {
    if (admin.length < MIN_DIGITOS_ADMIN) {
      log.warn(
        { evt: 'admin', digitos: admin.length },
        `entrada de ADMIN_PHONE com menos de ${MIN_DIGITOS_ADMIN} dígitos — ignorada por segurança`
      );
      return false;
    }
    return recebido.endsWith(admin) || admin.endsWith(recebido);
  });
}

// Comandos com argumento não cabem no mapa de texto exato.
// O sufixo é o segundo passo do estorno — `!cancelar 42` mostra o pedido,
// `!cancelar 42 ok` executa. Ver `cancel.js` para o porquê. Três grafias porque
// é o que a mão escreve sem pensar, e errar a palavra no segundo passo obrigaria
// a repetir o primeiro.
const CANCELAR = /^!cancel(?:ar)?\s+#?(\d+)(?:\s+(ok|confirmar|sim))?$/i;
const PEDIDO = /^!pedido\s+#?(\d+)$/i;
const BUSCAR = /^!buscar\s+\+?([\d\s()-]{7,})$/i;
const ESGOTOU = /^!esgotou\s+(.+)$/i;
const VOLTOU = /^!voltou\s+(.+)$/i;
const AJUDA = ['!ajuda', '!help', '!comandos'];
const ESTOQUE = ['!estoque'];
const IMPRIMIR = /^!(?:imprimir|print)\s+#?(.+)$/i;

/**
 * Comandos que o `!imprimir` aceita.
 *
 * Ele executa o comando pedido para capturar a resposta — inofensivo num
 * relatório, nem um pouco inofensivo em qualquer comando que mude estado.
 * Imprimir é para ver, e ver não deve mudar nada.
 *
 * ## Por que é lista de permitidos, e não de proibidos
 *
 * Isto aqui já foi uma lista de proibidos (`!cancelar`, `!esgotou`, `!voltou`,
 * `!teste`, `!imprimir`). Parecia completa e não era: `!fechar` e `!abrir`
 * nasceram depois e ninguém lembrou de acrescentá-los. O resultado é que
 * `!imprimir fechar` **encerrava o atendimento de verdade** — gravava a pausa no
 * banco — e respondia "*!fechar* está na fila", uma frase sobre impressão, sem
 * nenhuma pista de que o truck tinha parado de aceitar pedido.
 *
 * O defeito não estava em qual comando faltava na lista. Estava na forma da
 * lista: enumerar o proibido faz o **caso novo** cair do lado permitido, e o
 * caso novo é sempre o comando que ainda vai ser escrito. Enumerando o
 * permitido, o comando de amanhã chega barrado e alguém decide conscientemente
 * se ele entra.
 *
 * É a mesma inversão de `src/ambiente.js`, pela mesma razão.
 */
const IMPRIMIVEIS = [
  '!relatorio', '!report',
  '!pedidos', '!pending',
  '!pedido',
  '!ultimos',
  '!buscar',
  '!emails',
  '!estoque',
  '!fila', '!impressora',
  '!catalogo',
  '!ajuda', '!help', '!comandos',
];

/**
 * Manda um texto para a fila da impressora e responde o que esperar.
 *
 * A resposta muda com o estado da impressora porque "vai sair" e "vai sair
 * quando ela voltar" são situações bem diferentes para quem está esperando o
 * papel na mão.
 */
function enfileirarEResponder({ conteudo, descricao }) {
  const printqueue = require('../../services/printqueue');
  const token = printqueue.enfileirar({ conteudo, descricao });

  if (!token) {
    return (
      `❌ Fila de impressão cheia (${printqueue.LIMITE} trabalhos esperando).\n\n` +
      `A impressora não está puxando. Use *!fila* para ver o estado dela.`
    );
  }

  const st = require('../../services/printwatch').status();
  if (st.viva) return `🖨️ *${descricao}* indo para a impressora — sai em alguns segundos.`;

  return (
    `🖨️ *${descricao}* está na fila.\n\n` +
    `⚠️ A impressora não dá sinal ${st.nuncaFalou ? 'desde que o servidor subiu' : 'há um tempo'} — ` +
    `sai sozinho quando ela voltar. Confira com *!fila*.`
  );
}

/** `!imprimir 42` — segunda via de uma comanda já impressa. */
async function imprimirComanda(orderId) {
  const order = await db.getOrder(orderId);
  if (!order) return `❌ Pedido #${orderId} não encontrado.`;

  const printer = require('../../services/printer');
  const payment = await db.getPaymentByOrderId(order.id);

  return enfileirarEResponder({
    conteudo: printer.buildSegundaVia(order, payment),
    descricao: `2ª via do pedido #${order.id}`,
  });
}

/**
 * `!imprimir <comando>` — manda ao papel a resposta de qualquer outro comando.
 *
 * Genérico de propósito: em vez de uma versão impressa de cada relatório, o
 * comando é executado com um `send` que captura em vez de enviar, e o que ele
 * responderia na tela vai para a impressora. Vale para os comandos de hoje e
 * para os que ainda não existem.
 */
async function imprimirComando(phone, pedido) {
  const comando = pedido.startsWith('!') ? pedido : `!${pedido}`;
  const base = comoComando(comando).split(/\s+/)[0];

  // A frase serve aos dois casos que caem aqui — comando que muda estado e
  // comando que não existe — porque para quem está com o papel na mão a
  // pergunta é a mesma ("por que não saiu?"), e a lista responde as duas.
  if (!IMPRIMIVEIS.includes(base)) {
    return (
      `❌ Não imprimo *${base}*.\n\n` +
      `Só comando de consulta vai ao papel: imprimir executa o comando para ` +
      `capturar a resposta, e ver não deve mudar nada.\n\n` +
      `*Imprimíveis:* ${IMPRIMIVEIS.join(', ')}`
    );
  }

  const capturado = [];
  const tratado = await handle(phone, comando, async (texto) => {
    capturado.push(texto);
  });

  if (!tratado) return `❌ Não conheço o comando *${comando}*. Veja *!ajuda*.`;
  if (!capturado.length) return `❌ *${comando}* não respondeu nada para imprimir.`;

  const printer = require('../../services/printer');

  return enfileirarEResponder({
    conteudo: printer.buildTexto({
      titulo: comando.replace(/^!/, ''),
      corpo: capturado.join('\n\n'),
    }),
    descricao: comando,
  });
}

function todosItens() {
  return menuConfig.categories.flatMap((c) => c.items);
}

/**
 * Encontra um item por trecho do nome, em qualquer idioma, ou pelo id.
 *
 * Digitar "espetinho_costela" no meio do movimento é impraticável — o dono
 * escreve "costela" e pronto. Devolve a lista quando ambíguo, para ele
 * escolher em vez de a gente adivinhar e esgotar o item errado.
 */
function acharItens(termo) {
  const alvo = termo.trim().toLowerCase();

  const bate = (item) => {
    if (item.id.toLowerCase() === alvo) return 'exato';
    const nomes = Object.values(item.name || {}).map((n) => n.toLowerCase());
    if (nomes.includes(alvo)) return 'exato';
    if (item.id.toLowerCase().includes(alvo)) return 'parcial';
    if (nomes.some((n) => n.includes(alvo))) return 'parcial';
    return null;
  };

  const itens = todosItens();
  const exatos = itens.filter((i) => bate(i) === 'exato');
  if (exatos.length) return exatos;

  return itens.filter((i) => bate(i) === 'parcial');
}

function nomeDe(item) {
  return item.name.pt || item.name.en;
}

async function mudarDisponibilidade(termo, disponivel, send) {
  const achados = acharItens(termo);

  if (!achados.length) {
    await send(
      `❌ Não achei "${termo}" no cardápio.\n\n` +
        `Itens: ${todosItens().map(nomeDe).join(', ')}`
    );
    return;
  }

  if (achados.length > 1) {
    const lista = achados.map((i) => `• ${nomeDe(i)}`).join('\n');
    await send(`🤔 "${termo}" bate com mais de um item:\n\n${lista}\n\nSeja mais específico.`);
    return;
  }

  const item = achados[0];
  await availability.setAvailable(item.id, disponivel);

  await send(
    disponivel
      ? `✅ *${nomeDe(item)}* voltou ao cardápio.`
      : `🚫 *${nomeDe(item)}* marcado como esgotado.\n\n` +
          `Some do cardápio e das opções de combo agora. Para voltar: *!voltou ${termo}*`
  );
}

async function buildEstoque() {
  const esgotados = availability.listarEsgotados();
  if (!esgotados.length) return '✅ Nenhum item esgotado — cardápio completo.';

  const nomes = esgotados
    .map((id) => todosItens().find((i) => i.id === id))
    .filter(Boolean)
    .map((i) => `🚫 ${nomeDe(i)}`)
    .join('\n');

  return `📦 *ESGOTADOS (${esgotados.length})*\n\n${nomes}\n\n_Para liberar: !voltou <nome>_`;
}

const STATUS_LABEL = {
  pending: '⏳ aguardando pagamento',
  paid: '💳 pago',
  printed: '🖨️ na cozinha',
  delivered: '✅ entregue',
  cancelled: '🚫 cancelado',
};

function resumoPedido(o) {
  const itens = (Array.isArray(o.items_json) ? o.items_json : [])
    .map((i) => `${i.name} x${i.qty}`)
    .join(', ');
  const quando = new Date(o.created_at).toLocaleString('pt-BR', { timeZone: TZ });

  return (
    `*#${o.id}* — ${STATUS_LABEL[o.status] || o.status}\n` +
    `  ${quando}\n` +
    `  ${o.customer_name || 'sem nome'} · +${o.phone}\n` +
    `  ${itens}\n` +
    `  ${money(o.total)} — ${o.city}`
  );
}

async function buildPedido(id) {
  const o = await db.getOrder(id);
  if (!o) return `❌ Pedido #${id} não encontrado.`;

  const podeCancelar = o.status !== 'cancelled';
  return (
    `📄 *PEDIDO #${o.id}*\n\n${resumoPedido(o)}\n  ${o.address}\n\n` +
    (podeCancelar ? `_Para cancelar e estornar: !cancelar ${o.id}_` : '_Já cancelado._')
  );
}

async function buildBusca(phone) {
  const limpo = phone.replace(/\D/g, '');
  const pedidos = await db.getOrdersByPhone(limpo, 5);

  if (!pedidos.length) return `❌ Nenhum pedido para +${limpo}.`;
  return `🔎 *ÚLTIMOS PEDIDOS — +${limpo}*\n\n${pedidos.map(resumoPedido).join('\n\n')}`;
}

async function buildUltimos() {
  const pedidos = await db.getRecentOrders(10);
  if (!pedidos.length) return 'Nenhum pedido ainda.';
  return `🕐 *ÚLTIMOS 10 PEDIDOS*\n\n${pedidos.map(resumoPedido).join('\n\n')}`;
}

function buildHelp() {
  return (
    `🛠️ *COMANDOS*\n\n` +
    `*Relatórios*\n` +
    `📊 !relatorio hoje\n` +
    `📊 !relatorio semana\n` +
    `📊 !relatorio mes\n` +
    `📧 !emails\n\n` +
    `*Pedidos*\n` +
    `📋 !pedidos pendentes\n` +
    `🕐 !ultimos — os 10 mais recentes\n` +
    `📄 !pedido 12 — detalhe de um\n` +
    `🔎 !buscar 16174449612 — por telefone\n` +
    `🚫 !cancelar 12 — mostra o pedido; *!cancelar 12 ok* estorna\n\n` +
    `*Estoque*\n` +
    `📦 !estoque — o que está esgotado\n` +
    `🚫 !esgotou costela\n` +
    `✅ !voltou costela\n\n` +
    `*Impressora*\n` +
    `🖨️ !fila — comandas esperando e se ela está viva\n` +
    `🧾 !imprimir relatorio hoje — qualquer comando no papel\n` +
    `🧾 !imprimir 42 — segunda via da comanda\n\n` +
    `*Cardápio*\n` +
    `📦 !catalogo — confere preços e produtos contra a Meta\n\n` +
    `*Atendimento*\n` +
    `🔴 !fechar — encerra o dia mais cedo (volta sozinho na próxima abertura)\n` +
    `🟢 !abrir — retoma antes da hora\n\n` +
    `_Item esgotado some do cardápio e das opções de combo na hora._\n` +
    `_Comanda parada há mais de 2 min avisa aqui sozinha._`
  );
}

/**
 * Retorna true se a mensagem foi tratada como comando de admin.
 * Números não autorizados sempre recebem false — o bot segue o fluxo
 * normal e nunca revela que existem comandos administrativos.
 */
async function handle(phone, text, original_send) {
  if (!isAdminPhone(phone)) return false;

  // Um único ponto de saída, e não cada texto reescrito à mão: tudo que este
  // handler responde sai sem acento e sem emoji, inclusive o que for escrito
  // daqui a um ano. As mensagens ao cliente não passam por aqui.
  const send = (texto) => original_send(paraAdmin(texto));

  // Sem acento também na entrada: o corretor do celular escreve "!relatório"
  // sozinho, e antes disso o comando simplesmente deixava de ser reconhecido.
  const input = comoComando(text);

  if (AJUDA.includes(input)) {
    await send(buildHelp());
    return true;
  }

  // Comandos com argumento. `text` original preserva acentos e maiúsculas do
  // nome do item — "linguiça" precisa casar com o cardápio —, enquanto `input`
  // serve para reconhecer o comando.
  const original = text.trim();

  try {
    // Antes do resto: o argumento do !imprimir é outro comando, e deixá-lo
    // depois faria "!imprimir pedido 42" casar com o padrão de !pedido.
    const imprimir = original.match(IMPRIMIR);
    if (imprimir) {
      const alvo = imprimir[1].trim();
      await send(
        /^\d+$/.test(alvo)
          ? await imprimirComanda(Number(alvo))
          : await imprimirComando(phone, alvo)
      );
      return true;
    }

    const cancelar = input.match(CANCELAR);
    if (cancelar) {
      await require('./cancel').handleAdminCancel(
        Number(cancelar[1]),
        send,
        Boolean(cancelar[2]),
        phone
      );
      return true;
    }

    const pedido = input.match(PEDIDO);
    if (pedido) {
      await send(await buildPedido(Number(pedido[1])));
      return true;
    }

    const buscar = input.match(BUSCAR);
    if (buscar) {
      await send(await buildBusca(buscar[1]));
      return true;
    }

    const esgotou = original.match(ESGOTOU);
    if (esgotou) {
      await mudarDisponibilidade(esgotou[1], false, send);
      return true;
    }

    const voltou = original.match(VOLTOU);
    if (voltou) {
      await mudarDisponibilidade(voltou[1], true, send);
      return true;
    }
  } catch (err) {
    log.error({ evt: 'admin', comando: input, err }, 'falha em comando de admin');
    await send(`❌ Erro ao executar o comando: ${err.message}`);
    return true;
  }

  const fn = COMMANDS[input];
  if (!fn) return false;

  log.info({ evt: 'admin', comando: input }, `comando de admin: ${input}`);

  // O telefone vai para todo comando: quem muda o atendimento — hoje `!fechar` e
  // `!abrir` — precisa dele para o comprovante em papel dizer quem mandou. Os
  // demais ignoram o argumento.
  try {
    await send(await fn(phone));
  } catch (err) {
    log.error({ evt: 'admin', comando: input, err }, 'falha ao gerar relatório');
    await send('❌ Erro ao gerar relatório. Confira os logs do servidor.');
  }

  return true;
}

// `resumoPedido` sai daqui para o `cancel.js` usar na confirmação do estorno:
// o pedido tem a mesma cara em `!pedido`, `!ultimos` e na hora de confirmar, e
// reconhecer o formato é metade de conferir se é o pedido certo.
module.exports = { handle, isAdminPhone, resumoPedido };
