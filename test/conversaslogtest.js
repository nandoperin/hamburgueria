const assert = require('assert/strict');
const { transcrever } = require('../src/services/conversas-log');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const historico = [
  { role: 'user', content: 'CONTEXTO DO SISTEMA (não é fala do cliente...)\nEste cliente já comprou aqui antes.' },
  { role: 'assistant', content: 'Entendido.' },
  { role: 'user', content: 'quero um x tudo' },
  {
    role: 'assistant',
    content: '',
    chamadas: [{ id: '1', nome: 'adicionar_item', argumentos: { item_id: 'x_tudo' } }],
  },
  { role: 'tool', tool_call_id: '1', nome: 'adicionar_item', content: 'Adicionado: 1x X Tudo...' },
  { role: 'assistant', content: 'Adicionado! Quer algo mais?' },
  { role: 'user', content: '[EVENTO_INTERNO_CARRINHO]\nCarrinho validado pelo sistema: ...' },
  { role: 'assistant', content: 'Entendido. O resumo está aguardando a decisão do cliente.' },
  { role: 'user', content: 'não, obrigado' },
];

const linhas = transcrever(historico);

checar(
  linhas.every((l) => !String(l.texto || '').startsWith('CONTEXTO DO SISTEMA')),
  'contexto do sistema não aparece na transcrição'
);
checar(
  linhas.every((l) => !String(l.texto || '').startsWith('[EVENTO_INTERNO_')),
  'evento interno não aparece na transcrição'
);
checar(
  linhas.every((l) => l.texto !== 'Entendido.' && l.texto !== 'Entendido. O resumo está aguardando a decisão do cliente.'),
  'respostas internas de fechamento de turno não aparecem'
);
checar(
  linhas.some((l) => l.de === 'cliente' && l.texto === 'quero um x tudo'),
  'fala real do cliente aparece'
);
checar(
  linhas.some((l) => l.de === 'bot' && l.ferramentas?.includes('adicionar_item')),
  'chamada de ferramenta aparece anotada na fala do bot'
);
checar(
  linhas.some((l) => l.de === 'bot' && l.texto === 'Adicionado! Quer algo mais?'),
  'texto real do bot aparece'
);
checar(
  linhas.some((l) => l.de === 'cliente' && l.texto === 'não, obrigado'),
  'última fala do cliente aparece'
);
checar(linhas.length === 4, `só sobram as 4 linhas reais (contou ${linhas.length})`);

checar(
  transcrever([{ role: 'user', content: 'CONTEXTO DO SISTEMA' }, { role: 'assistant', content: 'Entendido.' }]).length === 0,
  'conversa sem nenhuma fala real vira transcrição vazia'
);

console.log('\n\x1b[32mconversaslogtest: tudo passou.\x1b[0m');
