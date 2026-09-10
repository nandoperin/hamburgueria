const assert = require('node:assert/strict');
Object.assign(process.env, { DATABASE_URL:'postgresql://fake', LOG_LEVEL:'silent' });
const db = require('../src/db/queries');
const notify = require('../src/bot/notify');
const leitura = require('../src/services/leitura-comprovante');
const comprovante = require('../src/services/comprovante');
const imagem = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
let order, eventos, analises, falhaIA, falhaCliente, destinosImagem, destinosResumo;
const detalhes = { tipo:'comprovante', valor:'24.00', moeda:'USD', destinatario:'Point Burger',
  data:'Sep 3, 2026', situacao:'concluido' };
db.getOrderAwaitingProof = async () => order?.status === 'pending' ? {...order} : null;
db.markProofReceived = async () => {
  order.status='awaiting_review'; eventos.push('registrou');
};
db.approvePayment = async () => { throw Error('Proibido: aprovacao automatica'); };
notify.dono = () => '15550000000';
notify.admins = () => ['15550000000', '15550000001'];
notify.sendImage = async (phone, msg) => {
  destinosImagem.push(phone); eventos.push('imagem_dono'); assert.ok(msg.buffer); return true;
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
  send:async () => { eventos.push('cliente'); if(falhaCliente) throw Error('WhatsApp'); } };
function reset() {
  order={id:11,status:'pending',total:24,phone:args.phone,order_type:'pickup',items_json:[]};
  eventos=[]; analises=0; falhaIA=false; falhaCliente=false; destinosImagem=[]; destinosResumo=[];
}
(async () => {
  reset();
  await Promise.all([comprovante.receber(args),comprovante.receber(args)]);
  assert.equal(analises,1); assert.equal(eventos.filter(e=>e==='registrou').length,1);
  assert.equal(order.status,'awaiting_review');
  assert.deepEqual(destinosImagem, ['15550000000', '15550000001']);
  assert.deepEqual(destinosResumo, ['15550000000', '15550000001']);
  assert.ok(eventos.some(e=>e.includes('Valores coincidem')));
  assert.equal(await comprovante.receber(args),false,'reenvio nao e relido');
  reset(); falhaIA=true;
  assert.equal(await comprovante.receber(args),true);
  assert.ok(eventos.includes('imagem_dono'));
  assert.ok(eventos.some(e=>e.includes('Leitura automatica indisponivel')));
  assert.equal(order.status,'awaiting_review');
  reset(); falhaCliente=true;
  await comprovante.receber(args); assert.ok(eventos.includes('imagem_dono')); assert.equal(analises,1);
  reset();
  await comprovante.receber({...args,buffer:Buffer.from('nao e imagem')});
  assert.equal(analises,0); assert.ok(!eventos.includes('registrou'));
  reset(); order=null;
  assert.equal(await comprovante.receber(args),false); assert.equal(analises,0);
  console.log('Recebimento sem armazenamento: duplicata e falhas de IA/cliente passaram.');
})().catch(err=>{console.error(err);process.exitCode=1;});
