const assert = require('node:assert/strict');
Object.assign(process.env, { DATABASE_URL:'postgresql://fake', LOG_LEVEL:'silent' });
const db = require('../src/db/queries');
const notify = require('../src/bot/notify');
const leitura = require('../src/services/leitura-comprovante');
const comprovante = require('../src/services/comprovante');
const imagem = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
let order, eventos, analises, falhaIA, falhaCliente, corrida, destinosImagem, destinosResumo, legendas, aoCliente;
const detalhes = { tipo:'comprovante', valor:'24.00', moeda:'USD', destinatario:'Point Burger',
  data:'Sep 3, 2026', situacao:'concluido' };
db.getOrderAwaitingProof = async () => order?.status === 'pending' ? {...order} : null;
// O comprovante solta a comanda: o pedido vira `paid` e o pagamento fica a conferir.
db.markProofReceived = async () => {
  if (corrida) return null;
  order.status='paid'; eventos.push('registrou');
  return { order_id: order.id, status: 'awaiting_review' };
};
db.approvePayment = async () => { throw Error('Proibido: aprovacao automatica'); };
notify.dono = () => '15550000000';
notify.admins = () => ['15550000000', '15550000001'];
notify.sendImage = async (phone, msg) => {
  destinosImagem.push(phone); legendas.push(msg.caption); eventos.push('imagem_dono'); assert.ok(msg.buffer); return true;
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
  order={id:11,status:'pending',total:24,phone:args.phone,order_type:'pickup',items_json:[]};
  eventos=[]; analises=0; falhaIA=false; falhaCliente=false; corrida=false;
  destinosImagem=[]; destinosResumo=[]; legendas=[]; aoCliente=[];
}
(async () => {
  reset();
  await Promise.all([comprovante.receber(args),comprovante.receber(args)]);
  assert.equal(analises,1); assert.equal(eventos.filter(e=>e==='registrou').length,1);
  assert.equal(order.status,'paid', 'o comprovante manda a comanda para a cozinha na hora');
  assert.ok(/sendo feito/.test(aoCliente[0]), 'o cliente ouve que o pedido esta sendo feito');
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
  assert.equal(order.status,'paid');
  reset(); falhaCliente=true;
  await comprovante.receber(args); assert.ok(eventos.includes('imagem_dono')); assert.equal(analises,1);
  reset();
  await comprovante.receber({...args,buffer:Buffer.from('nao e imagem')});
  assert.equal(analises,0); assert.ok(!eventos.includes('registrou'));
  assert.equal(order.status,'pending', 'arquivo recusado nao manda nada para a cozinha');
  reset(); order=null;
  assert.equal(await comprovante.receber(args),false); assert.equal(analises,0);
  // Pedido cancelado/expirado entre a consulta e a gravacao: nada sai.
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
  console.log('Recebimento sem armazenamento: cozinha na hora, duplicata e falhas de IA/cliente passaram.');
})().catch(err=>{console.error(err);process.exitCode=1;});
