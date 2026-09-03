const assert = require('node:assert/strict');
Object.assign(process.env, { SUPABASE_URL:'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY:'fake', LOG_LEVEL:'silent' });
const db = require('../src/db/queries');
const supabase = require('../src/db/client');
const notify = require('../src/bot/notify');
const leitura = require('../src/services/leitura-comprovante');
const comprovante = require('../src/services/comprovante');
const imagem = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
let order, eventos, analises, falhaStorage, falhaIA, falhaCliente;
const detalhes = { tipo:'comprovante', valor:'24.00', moeda:'USD', destinatario:'Point Burger',
  data:'Sep 3, 2026', situacao:'concluido' };
db.getOrderAwaitingProof = async () => order?.status === 'pending' ? {...order} : null;
db.attachProof = async () => { eventos.push('anexou'); };
db.updateOrderStatus = async (_id,status) => {
  assert.equal(status,'awaiting_review', 'IA nunca pode liberar'); order.status=status; eventos.push(status);
};
db.approvePayment = async () => { throw Error('Proibido: aprovacao automatica'); };
supabase.storage.from = () => ({ upload: async () => {
  eventos.push('upload'); return { error: falhaStorage ? {code:'indisponivel'} : null };
} });
notify.dono = () => '15550000000';
notify.sendImage = async (_phone, msg) => { eventos.push('imagem_dono'); assert.ok(msg.buffer); return true; };
notify.send = async (_phone,msg) => { eventos.push(msg); return true; };
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
  eventos=[]; analises=0; falhaStorage=false; falhaIA=false; falhaCliente=false;
}
(async () => {
  reset();
  await Promise.all([comprovante.receber(args),comprovante.receber(args)]);
  assert.equal(analises,1); assert.equal(eventos.filter(e=>e==='upload').length,1);
  assert.equal(order.status,'awaiting_review');
  assert.ok(eventos.some(e=>e.includes('Valores coincidem')));
  assert.equal(await comprovante.receber(args),false,'reenvio nao e relido');
  reset(); falhaIA=true;
  assert.equal(await comprovante.receber(args),true);
  assert.ok(eventos.includes('imagem_dono'));
  assert.ok(eventos.some(e=>e.includes('Leitura automatica indisponivel')));
  assert.equal(order.status,'awaiting_review');
  reset(); falhaStorage=true;
  await comprovante.receber(args);
  assert.equal(analises,0); assert.ok(eventos.includes('imagem_dono')); assert.equal(order.status,'pending');
  reset(); falhaCliente=true;
  await comprovante.receber(args); assert.ok(eventos.includes('imagem_dono')); assert.equal(analises,1);
  reset();
  await comprovante.receber({...args,buffer:Buffer.from('nao e imagem')});
  assert.equal(analises,0); assert.ok(!eventos.includes('upload'));
  reset(); order=null;
  assert.equal(await comprovante.receber(args),false); assert.equal(analises,0);
  console.log('Recebimento: duplicata, isolamento do pagamento e falhas de IA/Storage/cliente passaram.');
})().catch(err=>{console.error(err);process.exitCode=1;});
