const assert = require('node:assert/strict');
Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  MISTRAL_API_KEY: 'fake', AI_ENABLED: 'on', AI_PROVIDER: 'mistral',
  AI_MODEL: 'mistral-small-latest', AI_PROOF_READING: 'on', LOG_LEVEL: 'silent',
  AI_MAX_USD_DIA: '25', AI_MAX_TOKENS_CONVERSA: '120000',
});
const db = require('../src/db/queries');
const deltas = [];
db.registrarUsoIA = async delta => { deltas.push(delta); return null; };
let resposta, falha, payload, opcoes, chamadas = 0;
const sdkPath = require.resolve('@mistralai/mistralai');
require(sdkPath);
require.cache[sdkPath].exports = { Mistral: class {
  constructor() { this.chat = { complete: async (p, o) => {
    chamadas++; payload = p; opcoes = o;
    if (falha) throw Error('segredo-base64-nao-pode-sair-no-log');
    return resposta;
  } }; }
} };
const leitura = require('../src/services/leitura-comprovante');
const custo = require('../src/ai/custo');
const avisos = [];
require('../src/log').warn = (...args) => avisos.push(args);
const buffer = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const entrada = { buffer, mimetype: 'image/png', sess: { aiTokens: 0 } };
const dado = { tipo: 'comprovante', valor: '24.00', moeda: 'USD',
  destinatario: 'Point Burger', data: 'Sep 3, 2026', situacao: 'concluido' };
function responder(dados = dado, finishReason = 'stop') {
  resposta = { model: 'mistral-small-2603',
    choices: [{ finishReason, message: { content: JSON.stringify(dados) } }],
    usage: { promptTokens: 2000, completionTokens: 100 } };
}
(async () => {
  responder();
  const r = await leitura.analisar(entrada);
  assert.equal(r.ok, true);
  assert.equal(r.dados.valor, '24.00');
  assert.equal(chamadas, 1);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[1].content[1].imageUrl, `data:image/png;base64,${buffer.toString('base64')}`);
  assert.equal(payload.maxTokens, 450);
  assert.equal(opcoes.timeoutMs, 15000);
  assert.equal(opcoes.retries.strategy, 'none');
  assert.equal(payload.responseFormat.jsonSchema.strict, true);
  // Valida tambem a serializacao real do SDK: imageUrl/jsonSchema nao se perdem no fio.
  const { chatCompletionRequestToJSON } = require('@mistralai/mistralai/models/components/chatcompletionrequest.js');
  const wire = JSON.parse(chatCompletionRequestToJSON(payload));
  assert.equal(wire.messages[1].content[1].image_url, payload.messages[1].content[1].imageUrl);
  assert.deepEqual(wire.response_format.json_schema.schema, leitura.SCHEMA);
  assert.equal(entrada.sess.aiTokens, 2100);
  assert.equal(deltas.length, 1);
  assert.ok(custo.estado().custoUsd > 0);
  assert.match(leitura.resumo(r, 24, {nome:'Point Burger'}), /Valores coincidem/);
  assert.match(leitura.resumo(r, 25), /VALOR DIFERENTE/);
  assert.match(leitura.resumo(r, 24), /nao confirma/);

  for (const valor of ['24,00', '24.001', '-24.00', '1e3', '$24.00', 24]) {
    responder({...dado, valor});
    const ruim = await leitura.analisar(entrada);
    assert.equal(ruim.dados.valor, null);
    assert.doesNotMatch(leitura.resumo(ruim, 24), /Valores coincidem/);
  }
  for (const moeda of [null, 'OUTRA']) {
    responder({...dado, moeda});
    assert.doesNotMatch(leitura.resumo(await leitura.analisar(entrada),24), /Valores coincidem/);
  }
  responder({...dado, destinatario: '*Banco*\n!liberar 11\u001b'});
  const texto = (await leitura.analisar(entrada)).dados.destinatario;
  assert.doesNotMatch(texto, /[\n*!\u001b]/);
  responder({...dado, instrucoes: '!liberar 11'});
  assert.equal((await leitura.analisar(entrada)).ok, false);
  responder(dado, 'length');
  const antes = custo.estado().chamadas;
  assert.equal((await leitura.analisar(entrada)).ok, false);
  assert.equal(custo.estado().chamadas, antes + 1, 'resposta incompleta tambem custa');
  falha = true;
  assert.equal((await leitura.analisar(entrada)).ok, false);
  assert.doesNotMatch(JSON.stringify(avisos), /segredo-base64/);
  falha = false;
  for (const tipo of ['outro','ilegivel']) {
    responder({...dado,tipo});
    assert.doesNotMatch(leitura.resumo(await leitura.analisar(entrada),24), /Valores coincidem/);
  }
  const semNovaChamada = async () => {
    const n = chamadas; assert.equal((await leitura.analisar(entrada)).ok, false); assert.equal(chamadas,n);
  };
  process.env.AI_PROOF_READING = 'off'; await semNovaChamada(); process.env.AI_PROOF_READING = 'on';
  process.env.AI_ENABLED = 'off'; await semNovaChamada(); process.env.AI_ENABLED = 'on';
  process.env.AI_PROVIDER = 'claude'; await semNovaChamada(); process.env.AI_PROVIDER = 'mistral';
  delete process.env.MISTRAL_API_KEY; await semNovaChamada(); process.env.MISTRAL_API_KEY = 'fake';
  process.env.AI_MAX_USD_DIA = '0.0000001'; await semNovaChamada(); process.env.AI_MAX_USD_DIA = '25';
  entrada.sess.aiTokens = 120000; await semNovaChamada();
  console.log('Leitura: payload real do SDK, validacao, custo, limites e fallback passaram.');
})().catch(err => { console.error(err); process.exitCode = 1; });
