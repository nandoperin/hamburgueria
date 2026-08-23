/**
 * Quem mandou a mensagem: o telefone, não o endereço.
 *
 * O WhatsApp passou a endereçar contas por **LID** — `189807607161040@lid` —
 * um identificador de privacidade que **não é** um número de telefone. Quando
 * isso acontece, o Baileys põe a forma com telefone em `key.remoteJidAlt`.
 *
 * O código antigo fazia `jid.replace('@s.whatsapp.net', '')`. Num JID de LID
 * isso não substitui nada, e o "telefone" virava `189807607161040@lid`.
 *
 * ## Por que isso passou despercebido
 *
 * Porque **nada quebrava de forma visível**. `toJid()` devolve qualquer coisa
 * com `@` intacta, então a resposta chegava normalmente ao cliente. O bot
 * parecia perfeito. O estrago era todo silencioso, em tudo que usa o telefone
 * como identidade:
 *
 *   - `isAdminPhone()` nunca casava — `!painel` era respondido pela IA como se
 *     fosse pedido de cliente, e os comandos do dono simplesmente não existiam
 *   - `getCustomerByPhone()` nunca achava ninguém — todo cliente parecia novo,
 *     e a memória (nome, endereço, último pedido) nunca disparava
 *   - o pedido era gravado com o LID na coluna `phone`, e `!buscar <numero>`
 *     não encontrava
 *
 * Não é erro. É o sistema funcionando, com a pessoa errada.
 *
 * O caso 1 abaixo usa o LID real que apareceu no log de produção.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '16174449612';

const PROJECT = require('path').resolve(__dirname, '..');
const { telefoneDoRemetente } = require(`${PROJECT}/src/bot/index`);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // ------------------------------------- 1. o caso que quebrou de verdade
  console.log('\n\x1b[36m### 1. LID COM remoteJidAlt (o caso de producao) ###\x1b[0m');
  const chave = {
    remoteJid: '189807607161040@lid',
    remoteJidAlt: '16174449612@s.whatsapp.net',
  };
  const tel = telefoneDoRemetente(chave);

  checar(tel === '16174449612', `tira o telefone do remoteJidAlt (achou ${tel})`);
  checar(!String(tel).includes('@'), 'sem sufixo nenhum grudado');
  checar(
    admin.isAdminPhone(tel),
    'e ESTE numero e reconhecido como admin — era exatamente o que falhava'
  );
  checar(
    !admin.isAdminPhone('189807607161040'),
    'enquanto o LID cru NAO e admin: e o comportamento antigo, provado errado'
  );

  // ---------------------------------- 2. o caso normal continua igual
  console.log('\n\x1b[36m### 2. ENDERECAMENTO POR TELEFONE NAO MUDA ###\x1b[0m');
  checar(
    telefoneDoRemetente({ remoteJid: '16174449612@s.whatsapp.net' }) === '16174449612',
    'JID de telefone puro devolve o numero'
  );
  checar(
    telefoneDoRemetente({
      remoteJid: '16174449612@s.whatsapp.net',
      remoteJidAlt: '189807607161040@lid',
    }) === '16174449612',
    'com o LID no campo alternativo, o telefone ainda ganha — a ordem nao inverte'
  );

  // ---------------------------- 3. sufixo de multi-dispositivo nao entra
  console.log('\n\x1b[36m### 3. O SUFIXO :N NAO FAZ PARTE DO NUMERO ###\x1b[0m');
  const comDispositivo = telefoneDoRemetente({ remoteJid: '16174449612:12@s.whatsapp.net' });
  checar(
    comDispositivo === '16174449612',
    `o ":12" de multi-dispositivo e removido (achou ${comDispositivo})`
  );
  checar(admin.isAdminPhone(comDispositivo), 'e o numero segue casando como admin');

  // ----------------------------------- 4. sem telefone, devolve null
  console.log('\n\x1b[36m### 4. SO LID: null, NAO UM LID DISFARCADO ###\x1b[0m');
  checar(
    telefoneDoRemetente({ remoteJid: '189807607161040@lid' }) === null,
    'sem forma com telefone, devolve null — quem chama decide, e o log avisa'
  );
  checar(telefoneDoRemetente({}) === null, 'chave vazia nao explode');
  checar(telefoneDoRemetente(null) === null, 'chave nula nao explode');
  checar(
    telefoneDoRemetente({ remoteJid: '189807607161040@lid', remoteJidAlt: '55511@lid' }) === null,
    'dois LIDs continuam sendo zero telefones — nao devolve um deles por desespero'
  );

  console.log('\n\x1b[32mlidtest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
