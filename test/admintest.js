process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.SUPPORT_PHONE = '18573124606';
process.env.ADMIN_PHONE = '15550001111';

const PROJECT = require('path').resolve(__dirname, '..');
const ADMIN = '15550001111';
const CLIENTE = '15559998888';

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  listUnavailableItems: async () => [],
  getUnprintedPaidOrders: async () => [
    {
      id: 7,
      customer_name: 'André Gonçalves',
      phone: CLIENTE,
      total: 27,
      created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      payments: [],
    },
  ],
  getRecentOrders: async () => [],
  getReport: async () => ({ count: 0, revenue: 0, items: [] }),
  getRevenueByDay: async () => [],
};

const admin = require(`${PROJECT}/src/bot/handlers/admin`);
const printwatch = require(`${PROJECT}/src/services/printwatch`);
const notify = require(`${PROJECT}/src/bot/notify`);
const { t } = require(`${PROJECT}/src/i18n`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

const ACENTO_OU_EMOJI = /[^\x00-\x7F]/;

async function comando(texto, de = ADMIN) {
  const ditas = [];
  const tratado = await admin.handle(de, texto, async (x) => ditas.push(x));
  return { tratado, resposta: ditas.join('\n') };
}

(async () => {
  // ================================ o corretor do celular nao quebra o comando
  titulo('COMANDO DIGITADO COM ACENTO');

  for (const escrito of ['!relatório hoje', '!últimos', '!catálogo', '!RELATÓRIO HOJE']) {
    const r = await comando(escrito);
    checar(r.tratado, `"${escrito}" e reconhecido`);
  }

  const semAcento = await comando('!relatorio hoje');
  checar(semAcento.tratado, '"!relatorio hoje" continua valendo, claro');

  // =========================================== o que o dono le na tela
  titulo('RESPOSTA SEM ACENTO E SEM EMOJI');

  const fila = await comando('!fila');
  checar(
    !ACENTO_OU_EMOJI.test(fila.resposta),
    'a resposta do !fila nao tem um caractere fora do ASCII'
  );
  checar(
    fila.resposta.includes('Andre Goncalves'),
    'inclusive no nome do cliente, que veio digitado por ele'
  );
  checar(
    !fila.resposta.includes('  Impressora') && !fila.resposta.startsWith(' '),
    'o espaco que sobrou do emoji apagado nao fica'
  );

  const ajuda = await comando('!ajuda');
  checar(!ACENTO_OU_EMOJI.test(ajuda.resposta), 'o !ajuda tambem');
  checar(ajuda.resposta.includes('*'), 'mas o *negrito* fica — nao e acento nem emoji');

  const catalogo = await comando('!catalogo');
  checar(!ACENTO_OU_EMOJI.test(catalogo.resposta), 'e o !catalogo');

  // ============================== avisos que ele recebe sem ter pedido
  titulo('AVISOS ESPONTANEOS AO DONO');

  const enviadas = [];
  notify.register(async (phone, texto) => enviadas.push({ phone, texto }));

  await printwatch.verificar();
  const alerta = enviadas.find((m) => m.phone === ADMIN);
  checar(Boolean(alerta), 'o aviso de comanda nao impressa chegou');
  checar(
    !ACENTO_OU_EMOJI.test(alerta.texto),
    'e ele tambem vem sem acento e sem emoji, mesmo sem passar por comando'
  );

  // ================================= e o cliente segue como estava
  titulo('O CLIENTE NAO E AFETADO');

  const boasVindas = t('pt', 'ask_profile');
  checar(
    ACENTO_OU_EMOJI.test(boasVindas) || /[àáâãéêíóôõúç]/i.test(boasVindas),
    'mensagem ao cliente em portugues mantem acento e emoji'
  );

  const naoAdmin = await comando('!fila', '15557770000');
  checar(
    !naoAdmin.tratado && !naoAdmin.resposta,
    'e numero que nao e admin continua sem saber que o comando existe'
  );

  /**
   * Dois admins: quem manda comando e quem recebe aviso.
   *
   * `ADMIN_PHONE` sempre foi uma lista, mas nunca teve mais de um número — e
   * seis lugares copiaram a linha que a lê, dois deles **sem o `split`**. Com
   * um admin só ninguém notava. No dia em que o segundo entrou, aqueles dois
   * passaram a grudar os números num telefone de 22 dígitos: o aviso de
   * cancelamento de pedido e o de teto de gasto de IA paravam de chegar, sem
   * erro nenhum no log.
   *
   * É o formato de defeito que este projeto já viu antes (o LID): configuração
   * plausível, código que aceita, e a falha aparecendo em silêncio meses
   * depois. Por isso o cenário existe.
   */
  console.log('\n\x1b[36m### DOIS ADMINS ###\x1b[0m');

  const SEGUNDO = '15552223333';
  const original = process.env.ADMIN_PHONE;
  process.env.ADMIN_PHONE = `${ADMIN},${SEGUNDO}`;

  checar(
    admin.isAdminPhone(ADMIN) && admin.isAdminPhone(SEGUNDO),
    'os dois numeros podem dar comandos'
  );
  checar(
    !admin.isAdminPhone('15557770000'),
    'e um terceiro numero continua de fora'
  );
  checar(
    notify.dono() === ADMIN,
    'o aviso automatico vai para o primeiro da lista, e nao para os dois grudados'
  );
  checar(
    !/,/.test(notify.dono()) && notify.dono().length <= 15,
    'o destino e um telefone de verdade, nao a lista concatenada'
  );

  process.env.ADMIN_PHONE = original;

  printwatch.stop();
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.stack);
  process.exit(1);
});
