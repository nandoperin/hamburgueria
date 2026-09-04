// Importação pontual autorizada pelo dono. Nunca executado no boot/deploy.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const supabase = require('../src/db/client');
const config = require('../src/services/config');
const cardapio = require('../src/services/cardapio');
const novos = {
  menu: require('../config/menu.json'),
  ingredientes: require('../config/ingredientes.json'),
};
const faqFonte = require('../config/faq.json');
const QUEM = 'cardapio-real-2026-09-03';

async function run() {
  assert.equal(new URL(process.env.SUPABASE_URL).hostname, 'qjqorgvveivtzsdqpnox.supabase.co', 'Projeto Supabase inesperado');
  const {data: atuais, error} = await supabase.from('config_docs').select('key,doc')
    .in('key', ['menu','ingredientes','faq']).abortSignal(AbortSignal.timeout(20000));
  if (error) throw new Error('Não foi possível ler as configurações atuais.');
  assert.equal(atuais.length, 3, 'Faltam configurações; não aplicar importação parcial.');
  // Preserva demais respostas que o proprietário possa ter editado no painel.
  novos.faq = atuais.find(d => d.key === 'faq').doc.map(item =>
    ['vegan','gluten_free'].includes(item.id) ? {...item, answer:faqFonte.find(i=>i.id===item.id).answer} : item);
  for (const [key, doc] of Object.entries(novos)) assert.deepEqual(config.validar(key,doc), []);
  assert.deepEqual(cardapio.conferir(), []);
  console.log('Point Burger confirmado: 28 produtos, ingredientes reais, duas respostas do FAQ corrigidas.');
  if (!process.argv.includes('--apply')) { console.log('Somente conferência. Nenhuma alteração.'); return; }
  const alterados = atuais.filter(row => !isDeepStrictEqual(row.doc, novos[row.key]));
  if (!alterados.length) { console.log('Dados já correspondem à versão enviada.'); return; }
  const historico = await supabase.from('config_historico').insert(alterados.map(row => ({
    key: row.key, doc_antes: row.doc, mudou_quem: QUEM, resumo:'Cardápio real enviado pelo proprietário; cópia anterior preservada.',
  }))).abortSignal(AbortSignal.timeout(20000));
  if (historico.error) throw new Error('Histórico não gravado. Nenhuma configuração substituída.');
  // Uma instrução INSERT ... ON CONFLICT: menu e ingredientes mudam juntos.
  const gravacao = await supabase.from('config_docs').upsert(alterados.map(row => ({
    key:row.key, doc:novos[row.key], updated_by:QUEM, updated_at:new Date().toISOString(),
  })), {onConflict:'key'}).abortSignal(AbortSignal.timeout(20000));
  if (gravacao.error) throw new Error('Gravação não confirmada. Conferir antes de repetir.');
  const leitura = await supabase.from('config_docs').select('key,doc').in('key',alterados.map(r=>r.key))
    .abortSignal(AbortSignal.timeout(20000));
  if (leitura.error) throw new Error('Atualização enviada; confirmação de leitura indisponível.');
  for (const row of leitura.data) assert.deepEqual(row.doc, novos[row.key]);
  console.log('Atualizado e relido: ' + alterados.map(r=>r.key).join(', ') + '. Pedidos e pagamentos preservados.');
}
run().catch(err => { console.error(err.message); process.exitCode = 1; });
