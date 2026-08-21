process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.FOOD_TRUCK_NAME = 'Passarela Espetinho';
process.env.ADMIN_PHONE = '15550001111';
process.env.SUPPORT_PHONE = '18573124606';
// Sem isto o CloudPRNT exige o token e responde 503 — as portas com segredo
// fecham por padrão e só cedem em ambiente declarado. Ver `src/ambiente.js`.
process.env.NODE_ENV = 'test';

const http = require('http');
const PROJECT = require('path').resolve(__dirname, '..');

const ADMIN = '15550001111';

const pedidos = {
  42: {
    id: 42,
    phone: '15559998888',
    lang: 'pt',
    status: 'printed',
    order_type: 'pickup',
    customer_name: 'Fernando Perin',
    city: 'Everett',
    address: 'Rua 1',
    items_json: [{ name: 'Beef Skewer', nomeCozinha: 'Espetinho de Boi', qty: 2, price: 9 }],
    subtotal: 18,
    delivery_fee: 0,
    total: 18,
    created_at: new Date().toISOString(),
  },
};

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getOrder: async (id) => pedidos[id] || null,
  getPaymentByOrderId: async () => ({ id: 7, status: 'paid' }),
  getNextPrintableOrder: async () => null,
  getUnprintedPaidOrders: async () => [],
  markOrderPrinted: async () => {},
  updateOrderStatus: async (id, s) => { pedidos[id].status = s; },
  getReport: async () => ({ count: 3, revenue: 54, items: [] }),
  getRevenueByDay: async () => [],
  listUnavailableItems: async () => [],
};

// Estorno do Zelle é manual: `pagamento.estornar` não move dinheiro, só sinaliza
// que o dono deve devolver pelo banco quando o pagamento já foi confirmado.
const pagamentoPath = require.resolve(`${PROJECT}/src/services/pagamento`);
require(pagamentoPath);
require.cache[pagamentoPath].exports = {
  estornoAutomatico: () => false,
  estornar: async ({ payment }) => ({
    estornou: false,
    manual: payment?.status === 'paid',
  }),
};

const printqueue = require(`${PROJECT}/src/services/printqueue`);
const printer = require(`${PROJECT}/src/services/printer`);
const printwatch = require(`${PROJECT}/src/services/printwatch`);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);
const notify = require(`${PROJECT}/src/bot/notify`);
const { app } = require(`${PROJECT}/src/api`);

notify.register(async () => {});

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

/** Roda um comando de admin e devolve o que ele responderia no WhatsApp. */
async function comando(texto) {
  const ditas = [];
  const tratado = await admin.handle(ADMIN, texto, async (t) => ditas.push(t));
  return { tratado, resposta: ditas.join('\n') };
}

function pedir(servidor, metodo, caminho) {
  const { port } = servidor.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: caminho, method: metodo },
      (res) => {
        let corpo = '';
        res.on('data', (c) => (corpo += c));
        res.on('end', () => resolve({ status: res.statusCode, corpo }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));

  // ================================================ texto pronto para papel
  titulo('CONVERSAO DO TEXTO DA TELA PARA O PAPEL');

  const naTela =
    '📊 *RELATÓRIO — HOJE*\n\n' +
    'Pedidos: 3\n' +
    '_Pagamentos via Zelle já conferidos._\n' +
    '  indentado de proposito';
  const noPapel = printer.textoImprimivel(naTela);

  checar(!noPapel.includes('*'), 'asterisco de negrito nao vai para o papel');
  checar(!noPapel.includes('_'), 'sublinhado de italico tambem nao');
  checar(!/[^\x00-\x7F]/.test(noPapel), 'nada fora do ASCII sobra (emoji, acento)');
  checar(
    noPapel.split('\n')[0] === 'RELATORIO - HOJE',
    'o espaco que sobrou do emoji some, e o titulo comeca na coluna 1'
  );
  checar(
    noPapel.includes('\n  indentado'),
    'mas a indentacao de dois espacos, que e de proposito, fica'
  );
  checar(
    noPapel.split('\n').every((l) => l.length <= 42),
    'nenhuma linha passa das 42 colunas do papel'
  );

  // ============================================ imprimir qualquer comando
  titulo('!IMPRIMIR DE UM COMANDO QUALQUER');

  printqueue.limpar();
  let r = await comando('!imprimir fila');

  checar(r.tratado, 'o comando e reconhecido');
  checar(printqueue.tamanho() === 1, 'um trabalho entrou na fila');
  checar(
    printqueue.proximo().conteudo.includes('PASSARELA ESPETINHO'),
    'a pagina sai com o cabecalho do truck'
  );
  checar(
    r.resposta.includes('impressora') || r.resposta.includes('fila'),
    'e o dono e avisado do que esperar'
  );

  r = await comando('!imprimir !fila');
  checar(printqueue.tamanho() === 2, 'aceita com e sem a exclamacao no comando interno');

  // ==================================================== o que nao imprime
  titulo('COMANDOS QUE O IMPRIMIR RECUSA');

  printqueue.limpar();

  r = await comando('!imprimir cancelar 42');
  checar(printqueue.tamanho() === 0, 'nao imprime !cancelar');
  checar(pedidos[42].status === 'printed', 'e — o que importa — nao cancela o pedido');
  checar(r.resposta.includes('Nao imprimo'), 'explica por que recusou');
  checar(
    r.resposta.includes('!relatorio'),
    'e lista o que imprime, em vez de so dizer nao'
  );

  // A regra virou lista de permitidos. Estes dois nasceram DEPOIS da lista de
  // proibidos e passavam por ela: "!imprimir fechar" encerrava o atendimento de
  // verdade. Ficam aqui como lembrete de que o comando novo chega barrado.
  for (const alvo of ['fechar', 'abrir']) {
    r = await comando(`!imprimir ${alvo}`);
    checar(
      printqueue.tamanho() === 0 && r.resposta.includes('Nao imprimo'),
      `"!imprimir ${alvo}" e recusado — nao mexe no atendimento`
    );
  }

  await comando('!imprimir imprimir fila');
  checar(printqueue.tamanho() === 0, 'nao deixa aninhar !imprimir dentro de !imprimir');

  r = await comando('!imprimir naoexiste');
  checar(printqueue.tamanho() === 0, 'comando inexistente nao vira papel em branco');
  // Antes vinha "nao conheco esse comando", porque o inexistente era executado
  // para so entao descobrir que nao existia. Com a lista de permitidos ele para
  // antes — e a resposta, que lista os imprimiveis, serve igual para um erro de
  // digitacao.
  checar(r.resposta.includes('Nao imprimo'), 'e responde o que de fato imprime');

  // ========================================================== segunda via
  titulo('SEGUNDA VIA DA COMANDA');

  printqueue.limpar();
  r = await comando('!imprimir 42');

  checar(printqueue.tamanho() === 1, 'a comanda do pedido 42 foi para a fila');
  const via = printqueue.proximo().conteudo;
  checar(via.includes('2a VIA'), 'carimbada como segunda via');
  checar(
    via.includes('ja impressa antes'),
    'com o aviso que evita a cozinha montar o pedido de novo'
  );
  checar(via.includes('Espetinho de Boi'), 'e com os itens da comanda original');

  r = await comando('!imprimir 999');
  checar(r.resposta.includes('nao encontrado'), 'pedido inexistente responde erro');

  // ============================================ cancelamento vai ao papel
  titulo('CANCELAMENTO DE COMANDA JA IMPRESSA');

  printqueue.limpar();

  // Estornar exige dois passos: o primeiro mostra o pedido, o segundo executa.
  // Ver `cancel.js` — o que a confirmacao compra e o dono ter lido o valor.
  r = await comando('!cancelar 42');
  checar(
    printqueue.tamanho() === 0 && r.resposta.includes('CONFIRME'),
    'o primeiro comando so mostra o pedido — nada de papel ainda'
  );

  r = await comando('!cancelar 42 ok');

  checar(printqueue.tamanho() === 1, 'o aviso foi para a impressora sozinho');
  const aviso = printqueue.proximo().conteudo;
  checar(aviso.includes('CANCELADO'), 'o papel diz CANCELADO');
  checar(aviso.includes('#42'), 'com o numero do pedido');
  checar(aviso.includes('NAO PREPARAR'), 'e a instrucao para a cozinha');
  checar(
    r.resposta.includes('ja tinha saido'),
    'o dono e informado de que a cozinha esta sendo avisada'
  );

  // Este cenario ja afirmou o contrario: pedido nunca impresso "nao gasta
  // papel". Passou a gastar de proposito. Estornar e a unica acao sem desfazer
  // do sistema, e um pedido pago e ainda nao impresso podia ser cancelado sem
  // deixar rastro nenhum em papel -- o unico canal que quem tomasse o WhatsApp
  // do dono nao controlaria.
  pedidos[42].status = 'paid';
  printqueue.limpar();
  await comando('!cancelar 42');
  await comando('!cancelar 42 ok');
  checar(printqueue.tamanho() === 1, 'cancelamento sai no papel mesmo sem comanda impressa');

  const comprovante = printqueue.proximo().conteudo;
  checar(
    comprovante.includes('nao chegou a ser impressa'),
    'e o papel diz que a cozinha nunca recebeu — em vez de mandar descartar'
  );
  checar(
    comprovante.includes('Cancelado por: +...1111'),
    'com o final do numero que mandou o comando — o campo que vira alarme'
  );

  // ===================================== o ciclo completo do CloudPRNT
  titulo('A IMPRESSORA BUSCANDO O TRABALHO');

  printqueue.limpar();
  printqueue.enfileirar({ conteudo: 'CONTEUDO DE TESTE', descricao: 'teste da suite' });

  let res = await pedir(servidor, 'POST', '/cloudprnt');
  const oferta = JSON.parse(res.corpo);
  checar(oferta.jobReady === true, 'o polling avisa que ha trabalho');
  checar(oferta.jobToken.startsWith('avulso:'), `token de avulso: ${oferta.jobToken}`);

  res = await pedir(servidor, 'GET', `/cloudprnt?token=${oferta.jobToken}`);
  checar(res.corpo === 'CONTEUDO DE TESTE', 'o GET entrega o conteudo enfileirado');
  checar(printqueue.tamanho() === 1, 'e o trabalho continua na fila ate a confirmacao');

  res = await pedir(servidor, 'DELETE', `/cloudprnt?token=${oferta.jobToken}`);
  checar(printqueue.tamanho() === 0, 'o DELETE tira da fila');

  res = await pedir(servidor, 'POST', '/cloudprnt');
  checar(JSON.parse(res.corpo).jobReady === false, 'e a fila vazia volta a nao ter trabalho');

  // ================================================ teto e prioridade
  titulo('TETO DA FILA');

  printqueue.limpar();
  for (let i = 0; i < printqueue.LIMITE; i += 1) {
    printqueue.enfileirar({ conteudo: 'x', descricao: `job ${i}` });
  }
  checar(
    printqueue.enfileirar({ conteudo: 'x', descricao: 'excedente' }) === null,
    `a fila recusa acima de ${printqueue.LIMITE} — nao empilha sem limite`
  );

  r = await comando('!imprimir fila');
  checar(
    r.resposta.includes('cheia'),
    'e o dono e avisado de que nao vai sair, em vez de receber confirmacao falsa'
  );

  printqueue.limpar();
  servidor.close();
  printwatch.stop();
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.stack);
  process.exit(1);
});
