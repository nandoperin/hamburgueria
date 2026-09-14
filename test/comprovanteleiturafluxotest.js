/**
 * O comprovante que chega: recebe, avisa o dono, e nao julga o conteudo.
 *
 * A comanda ja saiu quando o cliente confirmou (13/09), entao aqui nada da
 * cozinha depende do arquivo. Foto, PDF ou formato desconhecido entram; o que
 * ainda barra e o teto de bytes. A leitura por IA virou opcional
 * (`AI_PROOF_READING=on`) e continua sendo so apoio a conferencia humana.
 */
const assert = require('node:assert/strict');
Object.assign(process.env, { DATABASE_URL:'postgresql://fake', LOG_LEVEL:'silent', AI_PROOF_READING:'on' });
const db = require('../src/db/queries');
const notify = require('../src/bot/notify');
const leitura = require('../src/services/leitura-comprovante');
const comprovante = require('../src/services/comprovante');
const imagem = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(8)]);
let order, esperando, eventos, analises, falhaIA, falhaCliente, corrida,
  destinosImagem, destinosArquivo, destinosResumo, legendas, aoCliente, anexos;
const detalhes = { tipo:'comprovante', valor:'24.00', moeda:'USD', destinatario:'Point Burger',
  data:'Sep 3, 2026', situacao:'concluido' };
// Quem espera o print e o PAGAMENTO; o pedido ja esta `paid` desde a confirmacao.
db.getOrderAwaitingProof = async () => esperando ? {...order} : null;
db.markProofReceived = async () => {
  if (corrida) return null;
  esperando = false; eventos.push('registrou');
  return { order_id: order.id, status: 'awaiting_review' };
};
db.approvePayment = async () => { throw Error('Proibido: aprovacao automatica'); };
notify.dono = () => '15550000000';
notify.admins = () => ['15550000000', '15550000001'];
notify.sendImage = async (phone, msg) => {
  destinosImagem.push(phone); legendas.push(msg.caption); eventos.push('imagem_dono'); assert.ok(msg.buffer); return true;
};
notify.sendDocument = async (phone, msg) => {
  destinosArquivo.push(phone); legendas.push(msg.caption); anexos.push(msg.filename);
  eventos.push('arquivo_dono'); assert.ok(msg.buffer); return true;
};
notify.send = async (phone,msg) => {
  if (msg.includes('apoio a conferencia')) destinosResumo.push(phone);
  eventos.push(msg); return true;
};
leitura.analisar = async ({sess}) => {
  analises++; eventos.push('leitura');
  assert.equal(sess.aiTokens,10);
  assert.ok(eventos.includes('imagem_dono'), 'print chega antes da IA');
  if(falhaIA) throw Error('servico indisponivel');
  return {ok:true,dados:detalhes};
};
const args = { phone:'15551111111', buffer:imagem, mimetype:'image/png', lang:'pt',sess:{aiTokens:10},
  send:async (m) => { eventos.push('cliente'); aoCliente.push(m); if(falhaCliente) throw Error('WhatsApp'); } };
function reset() {
  order={id:11,status:'paid',total:24,phone:args.phone,order_type:'pickup',items_json:[]};
  esperando=true;
  eventos=[]; analises=0; falhaIA=false; falhaCliente=false; corrida=false;
  destinosImagem=[]; destinosArquivo=[]; destinosResumo=[]; legendas=[]; aoCliente=[]; anexos=[];
}
(async () => {
  reset();
  await Promise.all([comprovante.receber(args),comprovante.receber(args)]);
  assert.equal(analises,1); assert.equal(eventos.filter(e=>e==='registrou').length,1);
  assert.equal(order.status,'paid', 'a comanda ja tinha saido; o comprovante nao mexe no pedido');
  assert.ok(/sendo feito/.test(aoCliente[0]), 'o cliente ouve que o pedido esta sendo feito');
  assert.ok(/Média de 25 minutos/.test(aoCliente[0]), 'retirada informa a média de 25 minutos');
  assert.ok(!/conferindo/i.test(aoCliente[0]), 'e nao que esta esperando conferencia');
  assert.deepEqual(destinosImagem, ['15550000000', '15550000001']);
  assert.ok(legendas.every(l => /JA NA COZINHA/.test(l) && /!liberar 11/.test(l) && /!recusar 11/.test(l)),
    'o dono sabe que a comanda saiu e como marcar a conferencia');
  assert.deepEqual(destinosResumo, ['15550000000', '15550000001']);
  assert.ok(eventos.some(e=>e.includes('Valores coincidem')));
  assert.equal(await comprovante.receber(args),false,'reenvio nao e relido');
  reset(); falhaIA=true;
  assert.equal(await comprovante.receber(args),true);
  assert.ok(eventos.includes('imagem_dono'));
  assert.ok(eventos.some(e=>e.includes('Leitura automatica indisponivel')));
  reset(); falhaCliente=true;
  await comprovante.receber(args); assert.ok(eventos.includes('imagem_dono')); assert.equal(analises,1);
  // PDF do banco: vai como arquivo, com nome escolhido por nos.
  reset();
  assert.equal(await comprovante.receber({...args, buffer:pdf, mimetype:'application/pdf'}),true);
  assert.ok(eventos.includes('registrou') && eventos.includes('arquivo_dono'));
  assert.deepEqual(destinosArquivo, ['15550000000', '15550000001']);
  assert.deepEqual(anexos, ['comprovante-11.pdf','comprovante-11.pdf']);
  assert.ok(legendas.every(l => /Veio como arquivo \(pdf\)/.test(l)), 'o dono sabe que nao e foto');
  assert.equal(destinosImagem.length,0,'PDF nao e enviado como imagem');
  // Formato que nao reconhecemos: entra do mesmo jeito, e o dono recebe o aviso.
  reset();
  assert.equal(await comprovante.receber({...args,buffer:Buffer.from('nao e imagem')}),true);
  assert.ok(eventos.includes('registrou'), 'o comprovante nao decide mais nada: nada e recusado por formato');
  assert.equal(destinosImagem.length + destinosArquivo.length, 0);
  assert.ok(eventos.some(e=>/COMPROVANTE RECEBIDO/.test(e) && /Formato nao reconhecido/.test(e)));
  assert.ok(/registrado/i.test(aoCliente[0]), 'e o cliente e agradecido do mesmo jeito');
  // O teto de memoria continua de pe.
  reset();
  assert.equal(await comprovante.receber({...args,buffer:Buffer.alloc(6*1024*1024)}),true);
  assert.ok(!eventos.includes('registrou'));
  assert.ok(esperando, 'arquivo grande demais nao registra comprovante');
  assert.equal(analises,0);
  // Sem pedido esperando o print, nada acontece.
  reset(); esperando=false;
  assert.equal(await comprovante.receber(args),false); assert.equal(analises,0);
  // Pedido cancelado ou ja conferido entre a consulta e a gravacao: nada sai.
  reset(); corrida=true;
  assert.equal(await comprovante.receber(args),false);
  assert.equal(analises,0); assert.ok(!eventos.includes('imagem_dono')); assert.equal(aoCliente.length,0);
  // A conversa sai da espera do comprovante.
  reset();
  const sessPagando = { aiTokens:10, state:'PAYMENT_PENDING', orderId:11, paymentMethod:'zelle' };
  await comprovante.receber({...args, sess:sessPagando});
  assert.equal(sessPagando.state,'ORDER_COMPLETE');
  reset();
  const sessOutroPedido = { aiTokens:10, state:'PAYMENT_PENDING', orderId:99, paymentMethod:'zelle' };
  await comprovante.receber({...args, sess:sessOutroPedido});
  assert.equal(sessOutroPedido.state,'PAYMENT_PENDING', 'sessao de outro pedido nao muda');
  // Leitura desligada (o padrao): o dono recebe o comprovante e mais nada.
  reset(); process.env.AI_PROOF_READING = 'off';
  assert.equal(await comprovante.receber(args),true);
  assert.equal(analises,0,'a IA nao e chamada');
  assert.equal(destinosResumo.length,0,'nem a segunda mensagem ao dono');
  assert.deepEqual(destinosImagem, ['15550000000', '15550000001'], 'o comprovante chega igual');
  process.env.AI_PROOF_READING = 'on';
  console.log('Comprovante recebido sem julgar formato; PDF, teto e leitura opcional passaram.');
})().catch(err=>{console.error(err);process.exitCode=1;});
