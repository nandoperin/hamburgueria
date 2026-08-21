/**
 * Controla a área de entrega dentro de uma suíte.
 *
 * A premissa deste arquivo já foi o contrário do que é hoje, e vale registrar:
 * no projeto irmão as cidades estavam `active: false` — o truck operava só com
 * retirada — e `ligar()` existia para as suítes que provavam o caminho da
 * entrega sem depender do `delivery.json` do dia.
 *
 * Na Point Burger as quatro cidades estão ativas. Então quem precisa forçar
 * agora é o **outro lado**: as suítes que provam o fluxo de retirada pura, em
 * que o bot nem pergunta como o cliente quer receber.
 *
 * A lição que sobreviveu à inversão é a mesma: suíte que depende do que estiver
 * valendo na configuração de hoje quebra quando alguém acrescenta uma cidade —
 * e a saída fácil seria apagá-la, justamente a que garante o caminho.
 * Cada cenário declara o que precisa.
 */
const delivery = require('../src/services/delivery');

const CIDADES = [
  { id: 'everett', label: 'Everett', delivery_fee: 5, active: true },
  { id: 'chelsea', label: 'Chelsea', delivery_fee: 7, active: true },
  { id: 'malden', label: 'Malden', delivery_fee: 7, active: true },
  { id: 'medford', label: 'Medford', delivery_fee: 7, active: true },
];

const original = delivery.getCities;

/** Cenário "entrega ligada", com a lista fixa acima. */
function ligar(cidades = CIDADES) {
  delivery.getCities = () => cidades;
  return cidades;
}

/**
 * Cenário "só retirada" — nenhuma cidade ativa.
 *
 * Devolve lista vazia em vez de restaurar o `delivery.json`, porque o cenário é
 * "não há entrega", e não "o que o arquivo disser". A diferença aparece no dia
 * em que alguém desativa uma cidade e a suíte de retirada passa a testar outra
 * coisa sem ninguém notar.
 */
function desligar() {
  delivery.getCities = () => [];
}

/** Volta ao que o `config/delivery.json` diz de verdade. */
function restaurar() {
  delivery.getCities = original;
}

module.exports = { ligar, desligar, restaurar, CIDADES };
