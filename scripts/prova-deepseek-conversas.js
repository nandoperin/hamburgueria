#!/usr/bin/env node
require('../src/env')();
process.env.LOG_LEVEL = 'error';

/**
 * PROVA PAGA E ISOLADA — DEEPSEEK COM CONVERSAS REAIS.
 *
 * Lê até 11 conversas recentes do PostgreSQL privado por SSH do Railway,
 * anonimiza dados pessoais em memória e repete somente as falas do cliente
 * contra o fluxo atual usando `deepseek-flash`. Não recebe WhatsApp, não cria
 * pedido, não grava uso no banco e não altera o provedor de produção.
 *
 * Uso:
 *   node scripts/prova-deepseek-conversas.js
 *   node scripts/prova-deepseek-conversas.js --quantidade=1
 *   node scripts/prova-deepseek-conversas.js --resumo
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODELO = 'deepseek-flash';
const argumento = process.argv.find((a) => a.startsWith('--quantidade='));
const QUANTIDADE = Math.min(11, Math.max(1, Number(argumento?.split('=')[1]) || 11));
const RESUMO = process.argv.includes('--resumo');

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY não está no .env.');
  process.exit(1);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Uso: node scripts/prova-deepseek-conversas.js [--quantidade=1..11] [--resumo]');
  process.exit(0);
}

const CONSULTA_REMOTA = `
const db = require('./src/db/client');
db.query(
  \`select cl.id, cl.mensagens, c.name, c.email,
          ultimo.address, ultimo.city, ultimo.items_json
     from conversas_log cl
     left join customers c on c.phone = cl.phone
     left join lateral (
       select o.address, o.city, o.items_json
         from orders o
        where o.phone = cl.phone
        order by o.created_at desc
        limit 1
     ) ultimo on true
    order by cl.criada_em desc
    limit $1\`,
  [${QUANTIDADE}]
).then(async ({ rows }) => {
  console.log('DADOS_TESTE:' + Buffer.from(JSON.stringify(rows)).toString('base64'));
  await db.end();
}).catch((erro) => {
  console.error('FALHA_TESTE:' + (erro.message || erro.name));
  process.exit(1);
});`;

function carregarConversas() {
  const env = { ...process.env };
  delete env.RAILWAY_API_TOKEN;
  delete env.RAILWAY_TOKEN;
  env.PATH = process.platform === 'win32'
    ? `C:\\Windows\\System32\\OpenSSH;${env.PATH || ''}`
    : env.PATH;
  const railway = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'hermes', 'node', 'railway.ps1')
    : 'railway';
  const comando = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : railway;
  const comandoArgs = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', railway, 'ssh', 'node', '-e', CONSULTA_REMOTA]
    : ['ssh', 'node', '-e', CONSULTA_REMOTA];
  const saida = execFileSync(
    comando,
    comandoArgs,
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60000 }
  );
  const trecho = saida.match(/DADOS_TESTE:([A-Za-z0-9+/=]+)/)?.[1];
  if (!trecho) throw new Error('Railway não devolveu as conversas esperadas.');
  return JSON.parse(Buffer.from(trecho, 'base64').toString('utf8'));
}

function escaparRegex(valor) {
  return String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anonimizar(texto, dados) {
  let limpo = String(texto || '');
  for (const [original, substituto] of [
    [dados.name, 'Cliente Teste'],
    [dados.email, 'cliente@exemplo.test'],
    [dados.address, '100 Main St, Everett'],
  ]) {
    if (original) limpo = limpo.replace(new RegExp(escaparRegex(original), 'gi'), substituto);
  }
  return limpo
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'cliente@exemplo.test')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '(555) 555-0100')
    .replace(/\b\d{1,6}\s+[\wÀ-ÿ.' -]+\s(?:street|st|road|rd|avenue|ave|parkway|pkwy|broadway|rua|travessa)\b[^,.;\n]*/gi,
      '100 Main St')
    .replace(/\b(?:meu nome (?:é|e)|my name is|sou)\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,60}/gi,
      'meu nome é Cliente Teste');
}

function mensagens(system, historico) {
  const saida = system ? [{ role: 'system', content: system }] : [];
  for (const m of historico) {
    if (m.role === 'tool') {
      saida.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '' });
    } else if (m.role === 'assistant' && m.chamadas?.length) {
      saida.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.chamadas.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.nome, arguments: JSON.stringify(c.argumentos || {}) },
        })),
      });
    } else {
      saida.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }
  }
  return saida;
}

async function conversar({ system, mensagens: historico, ferramentas = [] }) {
  const resposta = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELO,
      messages: mensagens(system, historico),
      tools: ferramentas.length ? ferramentas.map((f) => ({
        type: 'function',
        function: {
          name: f.name,
          description: f.description || '',
          parameters: f.input_schema || { type: 'object', properties: {} },
        },
      })) : undefined,
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw new Error(`DeepSeek HTTP ${resposta.status}: ${corpo.error?.message || 'resposta inválida'}`);
  }
  const msg = corpo.choices?.[0]?.message || {};
  const chamadas = (msg.tool_calls || []).map((tc) => {
    let argumentos;
    try {
      argumentos = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      throw new Error(`JSON inválido na ferramenta ${tc.function?.name || '?'}`);
    }
    return { id: tc.id, nome: tc.function?.name, argumentos };
  });
  const uso = corpo.usage || {};
  return {
    texto: typeof msg.content === 'string' ? msg.content : '',
    chamadas,
    uso: {
      tokensIn: Number(uso.prompt_tokens) || 0,
      tokensOut: Number(uso.completion_tokens) || 0,
      tokensCacheados: Number(uso.prompt_tokens_details?.cached_tokens || uso.prompt_cache_hit_tokens) || 0,
    },
  };
}

function preco(uso, agora = new Date()) {
  const dia = agora.getUTCDay();
  const hora = agora.getUTCHours();
  const pico = dia >= 1 && dia <= 5 && ((hora >= 1 && hora < 4) || (hora >= 6 && hora < 10));
  const entrada = pico ? 0.3 : 0.15;
  const cache = pico ? 0.006 : 0.003;
  const saida = pico ? 1.2 : 0.6;
  const totalIn = Number(uso?.tokensIn) || 0;
  const cacheados = Math.min(Number(uso?.tokensCacheados) || 0, totalIn);
  return ((totalIn - cacheados) * entrada + cacheados * cache +
    (Number(uso?.tokensOut) || 0) * saida) / 1e6;
}

async function main() {
  const conversas = carregarConversas();
  console.log(`\nPROVA DEEPSEEK — ${conversas.length} conversa(s) real(is), anonimizadas`);
  if (conversas.length < QUANTIDADE) {
    console.log(`O banco devolveu ${conversas.length}; foram solicitadas ${QUANTIDADE}.`);
  }

  const provider = require('../src/ai/provider');
  provider.get = () => ({ conversar });
  provider.getModelo = () => MODELO;

  const custo = require('../src/ai/custo');
  const total = { chamadas: 0, tokensIn: 0, tokensOut: 0, tokensCacheados: 0, usd: 0 };
  custo.registrar = (sess, uso) => {
    if (sess) sess.aiTokens = (sess.aiTokens || 0) +
      (Number(uso?.tokensIn) || 0) + (Number(uso?.tokensOut) || 0);
    total.chamadas += 1;
    total.tokensIn += Number(uso?.tokensIn) || 0;
    total.tokensOut += Number(uso?.tokensOut) || 0;
    total.tokensCacheados += Number(uso?.tokensCacheados) || 0;
    total.usd += preco(uso);
    return preco(uso);
  };

  const tools = require('../src/ai/tools');
  const executarReal = tools.executar;
  let ferramentasAtuais = [];
  tools.executar = async (nome, args, sess, send, contexto) => {
    ferramentasAtuais.push(nome);
    if (nome === 'confirmar_resumo') {
      return { resultado: 'SIMULAÇÃO: confirmação reconhecida; pedido não foi criado.' };
    }
    return executarReal(nome, args, sess, send, contexto);
  };

  require('../src/services/conversas-log').registrar = async () => {};
  const agente = require('../src/ai/agente');
  const session = require('../src/bot/session');
  const delivery = require('../src/services/delivery');
  const everett = delivery.getCities().find((c) => /everett/i.test(c.label));

  for (let i = 0; i < conversas.length; i++) {
    const original = conversas[i];
    const phone = `1555${crypto.randomInt(1000000, 9999999)}`;
    const sess = session.get(phone);
    Object.assign(sess, {
      lang: 'pt',
      state: 'MENU',
      greeted: true,
      name: original.name ? 'Cliente Teste' : null,
      email: original.email ? 'cliente@exemplo.test' : null,
      lastAddress: original.address ? '100 Main St' : null,
      lastCityId: original.city && everett ? everett.id : null,
      lastItems: Array.isArray(original.items_json) ? original.items_json : null,
    });

    const falas = (original.mensagens || [])
      .filter((m) => m.de === 'cliente' && m.texto)
      .map((m) => anonimizar(m.texto, original));
    ferramentasAtuais = [];
    const turnos = [];
    let erro = null;
    for (const fala of falas) {
      const respostas = [];
      try {
        await agente.conversar(sess, fala, async (texto) => respostas.push(String(texto)));
        turnos.push({ fala, respostas });
      } catch (e) {
        erro = e.message;
        turnos.push({ fala, respostas });
        break;
      }
    }

    console.log(`\n#${i + 1} — ${falas.length} fala(s) do cliente`);
    console.log(`Ferramentas: ${ferramentasAtuais.join(' → ') || 'nenhuma'}`);
    console.log(`Estado final: ${sess.state}${erro ? ` | ERRO: ${erro}` : ''}`);
    if (RESUMO) {
      const ultima = turnos.at(-1)?.respostas.at(-1) || '(sem resposta)';
      console.log(`Resposta final: ${ultima.replace(/\s+/g, ' ').slice(0, 180)}`);
    } else {
      for (const turno of turnos) {
        console.log(`Cliente: ${turno.fala.replace(/\s+/g, ' ').slice(0, 240)}`);
        for (const resposta of turno.respostas) {
          console.log(`Bot: ${resposta.replace(/\s+/g, ' ').slice(0, 240)}`);
        }
      }
    }  }

  console.log('\nCUSTO MEDIDO');
  console.log(`Chamadas: ${total.chamadas}`);
  console.log(`Tokens: ${total.tokensIn.toLocaleString('pt-BR')} entrada + ${total.tokensOut.toLocaleString('pt-BR')} saída`);
  console.log(`Cache: ${total.tokensCacheados.toLocaleString('pt-BR')} tokens`);
  console.log(`Custo: $${total.usd.toFixed(4)}`);
}

main().catch((erro) => {
  console.error(`Falhou: ${erro.message}`);
  process.exit(1);
});
