/**
 * Liga a entrega para uma suíte.
 *
 * Em produção as cidades estão com `active: false`: o truck está em fase de
 * testes, só retirada, e o bot nem chega a perguntar como o cliente quer
 * receber. O código da entrega continua inteiro e volta quando o delivery
 * começar — então as suítes que provam esse caminho o ligam aqui, de propósito,
 * em vez de depender do que estiver valendo no `config/delivery.json` de hoje.
 *
 * Sem isto, desligar a entrega em produção derrubaria cinco suítes, e a saída
 * fácil seria apagá-las — justamente as que garantem que o delivery volta
 * funcionando.
 */
const delivery = require('../src/services/delivery');

const CIDADES = [
  { id: 'everett', label: 'Everett', delivery_fee: 5, active: true },
  { id: 'chelsea', label: 'Chelsea', delivery_fee: 7, active: true },
  { id: 'malden', label: 'Malden', delivery_fee: 7, active: true },
];

const original = delivery.getCities;

function ligar(cidades = CIDADES) {
  delivery.getCities = () => cidades;
  return cidades;
}

/** Volta ao que o `config/delivery.json` diz — hoje, nenhuma cidade. */
function desligar() {
  delivery.getCities = original;
}

module.exports = { ligar, desligar, CIDADES };
