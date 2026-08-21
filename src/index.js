require('dotenv').config();

const api = require('./api');
const lock = require('./lock');
const provider = require('./bot/provider');

const BASE_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BASE_URL'];

const PROVIDER_ENV = {
  baileys: [],
  meta: ['META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'META_VERIFY_TOKEN'],
};

/** Só a chave do provedor de IA ativo é exigida — a do outro não faz falta. */
const AI_ENV = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

/**
 * Aqui e em `lock.js` o console é proposital, e não sobra da migração para o
 * log estruturado: são mensagens anteriores ao bot existir, escritas para
 * alguém olhando o terminal, e terminam em `process.exit()` — que pode cortar
 * o pino antes de ele descarregar o que estava na fila.
 */
function checkEnv() {
  const ia = require('./ai/provider');

  const required = [
    ...BASE_ENV,
    ...(PROVIDER_ENV[provider.getProviderName()] || []),
    ...(ia.habilitada() ? AI_ENV[ia.getProviderName()] || [] : []),
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (!missing.length) return;

  console.error('Variáveis de ambiente faltando no .env:');
  for (const key of missing) console.error(`  - ${key}`);
  console.error('\nCopie .env.example para .env e preencha os valores.');
  process.exit(1);
}

/**
 * Confere o que é conteúdo de negócio, e **não derruba o boot por isso**.
 *
 * A escolha é a mesma de `docs/SEGURANCA.md`: um deploy que se recusa a
 * iniciar às 19h de um sábado é pior que um que sobe reclamando alto. A porta
 * fecha do lado certo — sem Zelle configurado, `order.js` recusa fechar pedido
 * e manda o cliente ligar, em vez de pedir que ele transfira dinheiro para
 * `PREENCHER: nome`. O `/health` reprova e o monitor toca.
 */
function conferirConfig(log) {
  const zelle = require('./services/zelle').conferir();
  if (!zelle.ok) {
    log.error(
      { evt: 'boot', faltando: zelle.faltando },
      'ZELLE NAO CONFIGURADO — nenhum pedido sera fechado. Preencha config/pagamento.json'
    );
  }

  const delivery = require('./services/delivery');
  if (delivery.isPickupEnabled() && !delivery.enderecoRetirada()) {
    log.error(
      { evt: 'boot' },
      'ENDERECO DE RETIRADA NAO PREENCHIDO — o cliente nao sabera onde buscar'
    );
  }

  const problemas = require('./services/cardapio').conferir();
  if (problemas.length) {
    log.error(
      { evt: 'boot', problemas },
      `cardapio com ${problemas.length} problema(s) de configuracao — ver config/menu.json`
    );
  }
}

async function main() {
  checkEnv();
  lock.acquire();

  const log = require('./log');

  api.start();

  // Config editável primeiro: o cardápio, as cidades e o horário saem daqui, e
  // tudo abaixo já os lê. Semeia o banco a partir de `config/*.json` no primeiro
  // boot — só o que faltar, para um deploy nunca desfazer o que o dono editou.
  await require('./services/config').start();

  // Carrega o que está esgotado antes de aceitar o primeiro pedido.
  await require('./services/availability').start();

  // E se o dono encerrou o atendimento mais cedo — um deploy no meio da noite
  // não pode reabrir a loja sozinho.
  require('./services/schedule').start();

  await provider.start();

  // Depois do provider: os avisos vão pelo WhatsApp, e antes disso não haveria
  // por onde enviar.
  require('./services/printwatch').start();
  require('./services/pagamentowatch').start();

  conferirConfig(log);

  const ia = require('./ai/provider');

  // `segredos` vai no log de propósito, e não no `/health`: aquele é público, e
  // dizer ao mundo se as portas estão sendo exigidas é justamente a informação
  // que não interessa a quem está do lado de fora. Aqui, é a única maneira de
  // conferir depois de um deploy que o `NODE_ENV` do host é o que se pensava —
  // dele depende a porta fechar ou não quando faltar um segredo.
  log.info(
    {
      evt: 'boot',
      baseUrl: process.env.BASE_URL,
      whatsapp: provider.getProviderName(),
      ia: ia.habilitada() ? `${ia.getProviderName()}/${ia.getModelo()}` : 'desligada',
      segredos: require('./ambiente').exigeSegredos() ? 'exigidos' : 'dispensados',
    },
    'bot no ar'
  );
}

main().catch((err) => {
  console.error('Falha ao iniciar:', err);
  process.exit(1);
});
