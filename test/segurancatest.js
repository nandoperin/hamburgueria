process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '15550001111';
process.env.SUPPORT_PHONE = '18573124606';

/**
 * O que impede alguém de mandar no bot sem ser o dono.
 *
 * As três defesas aqui têm o mesmo formato e motivos diferentes:
 *
 *   1. A assinatura do webhook faz `ADMIN_PHONE` significar alguma coisa. Sem
 *      ela, o número do remetente é um campo que o atacante preenche.
 *   2. O token do CloudPRNT guarda a comanda — nome, endereco e telefone do
 *      cliente — e o botao que marca o pedido como impresso.
 *   3. A limpeza da entrada impede que o texto do cliente vire comando na
 *      impressora ou sequencia ANSI no terminal do dono.
 *
 * O cenario que mais importa e o primeiro: as duas primeiras defesas costumavam
 * **abrir** quando o segredo faltava, e o teste abaixo prova que agora fecham.
 */

const PROJECT = require('path').resolve(__dirname, '..');
const crypto = require('crypto');
const ADMIN = '15550001111';

const guardado = {};
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getSetting: async (k) => guardado[k] ?? null,
  setSetting: async () => {},
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  listUnavailableItems: async () => [],
  getNextPrintableOrder: async () => null,
  getOrder: async () => null,
  getPaymentByOrderId: async () => null,
  markOrderPrinted: async () => {},
  ping: async () => {},
};

const cfgPath = require.resolve(`${PROJECT}/config/schedule.json`);
require(cfgPath);
require.cache[cfgPath].exports = {
  ...require.cache[cfgPath].exports,
  always_open: true, // o assunto aqui nao e horario
};

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

/** Sobe o Express num porta livre e devolve a base para requisicoes. */
function subir(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, server });
    });
  });
}

(async () => {
  const entrada = require(`${PROJECT}/src/entrada`);

  // ============================================ o segredo que falta agora fecha
  titulo('SEM SEGREDO, A PORTA FECHA');

  // Sai do ambiente declarado: e a ausencia da declaracao que fecha a porta,
  // entao qualquer valor que nao seja development/test serve. Ver src/ambiente.js.
  process.env.NODE_ENV = 'production';
  process.env.WHATSAPP_PROVIDER = 'meta';

  checar(
    require(`${PROJECT}/src/ambiente`).exigeSegredos(),
    'fora de development/test, os segredos passam a ser obrigatorios'
  );
  process.env.NODE_ENV = '';
  checar(
    require(`${PROJECT}/src/ambiente`).exigeSegredos(),
    'e NODE_ENV vazio tambem exige — a ausencia nao pode significar "pode abrir"'
  );
  process.env.NODE_ENV = 'production';
  delete process.env.META_APP_SECRET;
  delete process.env.CLOUDPRNT_TOKEN;

  const { app } = require(`${PROJECT}/src/api`);
  const { base, server } = await subir(app);

  // Um POST forjado com o telefone do dono, mandando estornar o pedido 42. E
  // exatamente o que a assinatura existe para barrar.
  const forjado = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { id: 'forjada-1', from: ADMIN, type: 'text', text: { body: '!cancelar 42' } },
              ],
            },
          },
        ],
      },
    ],
  });

  let r = await fetch(`${base}/meta/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: forjado,
  });
  checar(r.status === 401, 'webhook da Meta sem META_APP_SECRET responde 401, nao 200');

  r = await fetch(`${base}/cloudprnt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  checar(r.status === 503, 'CloudPRNT sem token responde 503 em vez de liberar');

  // ======================================== e o monitor fica sabendo na hora
  titulo('O MONITOR ENXERGA A PORTA FECHADA');

  const health = require(`${PROJECT}/src/services/health`);

  // A checagem do WhatsApp bate na Graph API de verdade. Aqui o assunto e outro,
  // e nenhuma suite deste projeto toca em servico real — entao o fetch responde
  // sozinho enquanto a saude e apurada, e volta ao normal logo depois.
  const fetchReal = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });

  health.limparCache();
  const saude = await health.verificar();
  global.fetch = fetchReal;

  checar(!saude.ok, 'o /health reprova enquanto os segredos estiverem faltando');
  checar(
    saude.falhas.includes('segredos'),
    `dizendo qual parte caiu: ${JSON.stringify(saude.falhas)}`
  );
  checar(
    !saude.falhas.includes('whatsapp'),
    'e a reprovacao e mesmo pelos segredos, nao por outra checagem junto'
  );

  // =============================================== com o segredo, so a assinatura certa entra
  titulo('COM SEGREDO, SO A ASSINATURA CERTA ENTRA');

  process.env.META_APP_SECRET = 'segredo-de-teste';

  r = await fetch(`${base}/meta/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=mentira' },
    body: forjado,
  });
  checar(r.status === 401, 'assinatura inventada continua recusada');

  // Assinado de verdade — e por isso aceito. Vai um "oi" de cliente, e nao o
  // corpo forjado acima: o que se prova aqui e o portao, e mandar o `!cancelar`
  // assinado so faria a suite exercitar o estorno de novo, que tem suite propria.
  const legitimo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { id: 'legitima-1', from: '15557778888', type: 'text', text: { body: 'oi' } },
              ],
            },
          },
        ],
      },
    ],
  });

  const assinatura =
    'sha256=' +
    crypto.createHmac('sha256', 'segredo-de-teste').update(Buffer.from(legitimo)).digest('hex');

  r = await fetch(`${base}/meta/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinatura },
    body: legitimo,
  });
  checar(r.status === 200, 'e a assinatura correta e aceita');

  // ============================================ token errado nao le a comanda
  titulo('TOKEN ERRADO NAO LE A COMANDA');

  process.env.CLOUDPRNT_TOKEN = 'token-de-teste';

  r = await fetch(`${base}/cloudprnt?authToken=chute`);
  checar(r.status === 401, 'GET com token errado responde 401');

  r = await fetch(`${base}/cloudprnt?authToken=token-de-teste&token=42`, { method: 'DELETE' });
  checar(r.status === 200, 'e com o token certo a impressora confirma normalmente');

  server.close();

  // ================================== o texto do cliente nao vira comando
  titulo('O TEXTO DO CLIENTE NAO VIRA COMANDO');

  // ESC d 2 e "corte o papel" na linguagem da impressora (ver printer.js), e
  // sobrevivia ao ascii() porque 0x1B esta dentro da tabela ASCII.
  const ESC = String.fromCharCode(0x1b);
  const nomeComEscape = `Joao${ESC}d2 Silva`;

  checar(
    !entrada.limpar(nomeComEscape).includes(ESC),
    'o ESC some do texto recebido — a comanda nao corta sozinha'
  );
  checar(
    entrada.limpar(nomeComEscape) === 'Joaod2 Silva',
    'e o resto do nome fica intacto'
  );

  const zeroWidth = String.fromCharCode(0x200b);
  checar(
    entrada.limpar(`Fer${zeroWidth}nando`) === 'Fernando',
    'caractere invisivel some — nada se esconde dentro de um nome'
  );

  checar(
    entrada.limpar('Rua das Flores\n123') === 'Rua das Flores\n123',
    'mas a quebra de linha fica: endereco de duas linhas e normal'
  );

  // ============================================ nome e endereco tem teto
  titulo('NOME E ENDERECO TEM TETO');

  const { parseProfile } = require(`${PROJECT}/src/bot/handlers/profile`);
  const gigante = 'A'.repeat(4000);

  checar(
    parseProfile(gigante).name.length === entrada.LIMITES.nome,
    `nome de 4000 caracteres vira ${entrada.LIMITES.nome} — o rolo de papel sobrevive`
  );

  checar(
    entrada.curto(gigante, entrada.LIMITES.endereco).length === entrada.LIMITES.endereco,
    `endereco cortado em ${entrada.LIMITES.endereco}`
  );

  // ====================================== rajada de mensagens para de ser respondida
  titulo('RAJADA PARA DE SER RESPONDIDA');

  const vazao = require(`${PROJECT}/src/bot/vazao`);
  vazao.zerar();

  const FLOOD = '15559998888';
  const decisoes = [];
  for (let i = 0; i < vazao.TETO + 5; i += 1) decisoes.push(vazao.avaliar(FLOOD));

  checar(
    decisoes.filter((d) => d === 'ok').length === vazao.TETO,
    `as primeiras ${vazao.TETO} passam`
  );
  checar(
    decisoes.filter((d) => d === 'avisar').length === 1,
    'o cliente e avisado uma vez — quem digitou rapido entende o que houve'
  );
  checar(
    decisoes.slice(-3).every((d) => d === 'silencio'),
    'e o resto da rajada nao gera resposta nenhuma (nem custo)'
  );

  // O dono nao pode ser calado pela propria defesa.
  const admin = require(`${PROJECT}/src/bot/handlers/admin`);
  checar(admin.isAdminPhone(ADMIN), 'o numero do dono e reconhecido como admin');

  // ============================ imprimir nao executa comando que muda estado
  titulo('IMPRIMIR SO ACEITA COMANDO DE CONSULTA');

  // O `!imprimir` executa o comando pedido para capturar a resposta. Quando a
  // regra era lista de proibidos, `!fechar` e `!abrir` — escritos depois dela —
  // passavam: `!imprimir fechar` encerrava o atendimento de verdade e respondia
  // "esta na fila", uma frase sobre impressao. A lista virou de permitidos.
  async function imprimir(alvo) {
    const ditas = [];
    await admin.handle(ADMIN, `!imprimir ${alvo}`, async (t) => ditas.push(t));
    return ditas.join('\n');
  }

  for (const alvo of ['fechar', 'abrir', 'parar', 'voltar', 'cancelar 42', 'esgotou costela']) {
    const r = await imprimir(alvo);
    checar(
      r.includes('Nao imprimo'),
      `"!imprimir ${alvo}" e recusado antes de executar`
    );
  }

  checar(
    (await imprimir('ajuda')).includes('fila'),
    'e o que e consulta continua indo para a impressora'
  );

  // ================================ estorno exige o dono ter lido o pedido
  titulo('CANCELAMENTO NAO ACONTECE NUM COMANDO SO');

  // A unica acao sem desfazer do sistema. O risco nao e ataque, e dedo:
  // "!cancelar 23" em vez de "!cancelar 32" cancela o pedido de outro cliente.
  // Com Zelle o estorno e manual, mas a dupla confirmacao vale igual: o que ela
  // compra e o dono ter lido nome e valor antes de dar baixa.
  const pedido = {
    id: 77,
    status: 'paid',
    phone: '16175551234',
    customer_name: 'Maria Souza',
    items_json: [{ name: 'Combo 1', qty: 2 }],
    total: 41,
    city: 'Everett',
    address: '12 Elm St',
    lang: 'pt',
    created_at: '2026-08-11T22:00:00Z',
  };
  let estornos = 0;

  require.cache[dbPath].exports.getOrder = async (id) => (id === 77 ? pedido : null);
  require.cache[dbPath].exports.getPaymentByOrderId = async () => ({
    id: 9,
    status: 'paid',
  });
  require.cache[dbPath].exports.updateOrderStatus = async (id, s) => { pedido.status = s; };

  // Muta o objeto em vez de trocá-lo no cache: `cancel.js` faz o require dele no
  // topo e já guardou a referência, entao um objeto novo nao o alcancaria.
  // `estornar` do Zelle nao move dinheiro — conta as chamadas para provar que a
  // baixa so acontece depois da confirmacao.
  require(`${PROJECT}/src/services/pagamento`).estornar = async ({ payment }) => {
    estornos += 1;
    return { estornou: false, manual: payment?.status === 'paid' };
  };
  require(`${PROJECT}/src/services/pagamento`).estornoAutomatico = () => false;
  require(`${PROJECT}/src/bot/notify`).register(async () => {});

  async function cancelar(texto) {
    const ditas = [];
    await admin.handle(ADMIN, texto, async (t) => ditas.push(t));
    return ditas.join('\n');
  }

  let r2 = await cancelar('!cancelar 77 ok');
  checar(
    estornos === 0 && r2.includes('Nao ha confirmacao em aberto'),
    'o "ok" sozinho nao cancela — nao da para decorar a frase e pular o resumo'
  );

  r2 = await cancelar('!cancelar 77');
  checar(estornos === 0 && pedido.status === 'paid', 'o primeiro comando nao mexe em nada');
  checar(r2.includes('CONFIRME O CANCELAMENTO'), 'ele mostra o que vai ser cancelado');
  checar(
    r2.includes('Maria Souza') && r2.includes('41.00'),
    'com nome e valor na tela — e o que o dono precisa conferir'
  );

  r2 = await cancelar('!cancelar 77 ok');
  checar(estornos === 1 && pedido.status === 'cancelled', 'confirmado, a baixa sai');

  r2 = await cancelar('!cancelar 77 ok');
  checar(estornos === 1, 'e a confirmacao nao serve duas vezes');

  // ==================================== o papel como canal fora de banda
  titulo('O QUE MUDA O ATENDIMENTO SAI NO PAPEL');

  // Depois das assinaturas fechando, o cenario que sobra nao e invasor remoto:
  // e o celular do dono nas maos de outro. Nesse caso, todo aviso do WhatsApp
  // chega a quem invadiu. O papel e o unico canal que exigiria estar no truck.
  const printqueue = require(`${PROJECT}/src/services/printqueue`);
  const schedule = require(`${PROJECT}/src/services/schedule`);

  // Sai do modo 24h e para dentro do horario: terca 11/08, 20:30 ET.
  require.cache[cfgPath].exports.always_open = false;
  const RealDate = Date;
  const agora = new RealDate('2026-08-12T00:30:00Z');
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : agora; }
    static now() { return agora.getTime(); }
  };

  await schedule.retomar();
  printqueue.limpar();
  checar(schedule.isOpen(), 'truck aberto antes do comando');

  await cancelar('!fechar');
  checar(!schedule.isOpen(), 'o !fechar encerrou o atendimento');
  checar(printqueue.tamanho() === 1, 'e deixou um comprovante na fila da impressora');

  const papel = printqueue.proximo().conteudo;
  checar(papel.includes('ATENDIMENTO ENCERRADO'), 'o papel diz o que aconteceu');
  checar(
    papel.includes('Por:    +...1111'),
    'e o final do numero que mandou — se nao for o do dono, e o alarme'
  );

  printqueue.limpar();
  await cancelar('!fechar');
  checar(
    printqueue.tamanho() === 0,
    'fechar o que ja esta fechado nao gasta papel — o comprovante que importa nao se perde no meio'
  );

  global.Date = RealDate;

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
  process.exit(0);
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
