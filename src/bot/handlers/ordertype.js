const { t } = require('../../i18n');
const log = require('../../log');
const delivery = require('../../services/delivery');
const notify = require('../notify');

/**
 * Estados ORDER_TYPE e DELIVERY_CITY — como receber, e para onde.
 *
 * São duas telas porque o WhatsApp aceita no máximo **3 botões por mensagem**
 * (limite total, não por linha). Retirada mais as cidades passa disso. Separar
 * cabe no limite e ainda deixa a primeira pergunta com as duas opções que
 * importam de verdade; quem escolhe retirada nem vê a lista de cidades.
 */

// Acima disso os botões não cabem e a tela vira lista tocável (que vai até 10).
const BOTOES_MAX = 3;

/** Rótulo do botão de cidade — sem campo de descrição, a taxa vai no título. */
function rotuloCidade(city) {
  return `${city.label} $${city.delivery_fee.toFixed(2)}`;
}

// ------------------------------------------------------ tela 1: como receber

async function ask(session, send, aviso = null) {
  const lang = session.lang;
  const temRetirada = delivery.isPickupEnabled();
  const cidades = delivery.getCities();

  if (!temRetirada && cidades.length === 0) {
    log.error(
      { evt: 'config' },
      'nem retirada nem cidades ativas em config/delivery.json'
    );
    await send(t(lang, 'error_generic'));
    return;
  }

  // Só um caminho possível: não faz sentido perguntar.
  if (!temRetirada) {
    await entrarEmEntrega(session, send, aviso);
    return;
  }
  if (cidades.length === 0) {
    await escolherRetirada(session, send, aviso);
    return;
  }

  session.state = 'ORDER_TYPE';

  const opcoes = [
    { id: 'ot:delivery', title: t(lang, 'order_type_btn_delivery') },
    { id: 'ot:pickup', title: t(lang, 'order_type_btn_pickup') },
  ];

  // A saudação do cliente recorrente chega por aqui e vira a primeira linha,
  // em vez de gastar uma mensagem só para dizer "olá".
  const intro = t(lang, 'order_type_intro');
  const corpo = aviso ? `${aviso}\n\n${intro}` : intro;

  const enviou = await notify.sendButtons(session.phone, {
    body: corpo,
    buttons: opcoes,
  });

  // Baileys não tem botões — a ordem numerada aqui é a mesma de `interpretar()`.
  if (!enviou) {
    await send(
      [corpo, '', ...opcoes.map((o, i) => `${i + 1}. ${o.title}`)].join('\n')
    );
  }
}

/**
 * Aceita o id do botão, o número do fallback em texto, ou a palavra digitada.
 * Os ids são estáveis; os rótulos mudam com o idioma, por isso não servem de
 * chave.
 */
function interpretar(text) {
  const valor = String(text || '').trim().toLowerCase();

  if (valor === 'ot:delivery' || valor === '1') return 'delivery';
  if (valor === 'ot:pickup' || valor === '2') return 'pickup';

  if (['entrega', 'delivery', 'envio'].includes(valor)) return 'delivery';
  if (['retirada', 'pickup', 'recoger', 'retirar'].includes(valor)) return 'pickup';

  return null;
}

async function handle(session, text, send) {
  const escolha = interpretar(text);

  if (escolha === 'pickup') {
    await escolherRetirada(session, send);
    return;
  }
  if (escolha === 'delivery') {
    await entrarEmEntrega(session, send);
    return;
  }

  await send(t(session.lang, 'order_type_invalid'));
}

async function escolherRetirada(session, send, aviso = null) {
  session.orderType = 'pickup';
  session.city = null;

  // A confirmação não sai sozinha: vai como primeira linha do cardápio, que é
  // a próxima mensagem de qualquer jeito.
  const confirmacao = t(session.lang, 'order_type_pickup');
  const junto = aviso ? `${aviso}\n\n${confirmacao}` : confirmacao;

  await require('./order').resumeAfterDelivery(session, send, junto);
}

// --------------------------------------------------------- tela 2: cidades

/**
 * Entra no fluxo de entrega — perguntando a cidade só quando não dá para saber.
 *
 * Quem já pediu entrega antes tem a cidade guardada (`lastCityId`, carregado
 * junto do cadastro em `welcome.loadKnownCustomer`), e o endereço já era
 * reaproveitado mais adiante. Perguntar a cidade de novo era perguntar o que o
 * bot já sabia — uma tela inteira para confirmar o óbvio.
 *
 * A cidade é reconferida contra o `delivery.json` porque ela pode ter saído da
 * área de entrega desde o último pedido; nesse caso a pergunta volta.
 */
async function entrarEmEntrega(session, send, aviso = null) {
  session.orderType = 'delivery';

  const lembrada = session.lastCityId
    ? delivery.getCities().find((c) => c.id === session.lastCityId)
    : null;

  if (!lembrada) {
    await askCity(session, send, aviso);
    return;
  }

  await usarCidade(session, send, lembrada, aviso, true);
}

/**
 * Fixa a cidade e segue. `lembrada` só muda o texto: quem não escolheu agora
 * precisa saber que dá para trocar.
 */
async function usarCidade(session, send, cidade, aviso = null, lembrada = false) {
  const lang = session.lang;
  session.orderType = 'delivery';
  session.city = cidade;

  // Cidade e taxa vão fundidas no cardápio, e não numa mensagem só para
  // confirmar o toque — a informação importa, a mensagem extra não.
  const confirmacao = t(lang, lembrada ? 'delivery_city_reused' : 'order_type_delivery', {
    city: cidade.label,
    fee: cidade.delivery_fee.toFixed(2),
  });
  const junto = aviso ? `${aviso}\n\n${confirmacao}` : confirmacao;

  // Mesma cidade do pedido anterior: assume o endereço. O aviso disso sai no
  // checkout, junto do resumo, onde ainda dá para trocar antes de confirmar.
  if (session.lastAddress && session.lastCityId === cidade.id) {
    session.address = session.lastAddress;
  }

  // O endereço não é pedido agora: vai para o cardápio, e o checkout cobra o
  // que faltar. Ver `order.startCheckout`.
  await require('./order').resumeAfterDelivery(session, send, junto);
}

async function askCity(session, send, aviso = null) {
  session.state = 'DELIVERY_CITY';
  const lang = session.lang;
  const cidades = delivery.getCities();
  const intro = aviso
    ? `${aviso}\n\n${t(lang, 'city_intro')}`
    : t(lang, 'city_intro');

  // Mais de três não cabem em botões, e `sendButtons` corta o excedente sem
  // avisar — a cidade sumiria do cardápio de opções. A lista aguenta dez.
  if (cidades.length > BOTOES_MAX) {
    await notify.sendList(session.phone, {
      body: intro,
      button: t(lang, 'order_type_button'),
      sections: [
        {
          title: t(lang, 'order_type_section'),
          rows: cidades.map((city) => ({
            id: `city:${city.id}`,
            title: `🚗 ${city.label}`,
            description: t(lang, 'order_type_row_city_desc', {
              fee: city.delivery_fee.toFixed(2),
            }),
          })),
        },
      ],
    });
    return;
  }

  const enviou = await notify.sendButtons(session.phone, {
    body: intro,
    buttons: cidades.map((city) => ({
      id: `city:${city.id}`,
      title: rotuloCidade(city),
    })),
  });

  if (!enviou) {
    await send(
      [
        intro,
        '',
        ...cidades.map((city, i) => `${i + 1}. ${rotuloCidade(city)}`),
      ].join('\n')
    );
  }
}

/** Id do botão, posição na lista numerada, ou o nome da cidade digitado. */
function acharCidade(text, cidades) {
  const valor = String(text || '').trim().toLowerCase();

  const porId = cidades.find((c) => valor === `city:${c.id}` || valor === c.id);
  if (porId) return porId;

  const posicao = parseInt(valor, 10);
  if (posicao >= 1 && posicao <= cidades.length) return cidades[posicao - 1];

  // O rótulo do botão carrega a taxa junto ("Everett $5.00"), daí o `includes`.
  return cidades.find((c) => valor.includes(c.label.toLowerCase())) || null;
}

async function handleCity(session, text, send) {
  const lang = session.lang;
  const cidades = delivery.getCities();
  const escolhida = acharCidade(text, cidades);

  if (!escolhida) {
    await send(t(lang, 'city_invalid'));
    return;
  }

  await usarCidade(session, send, escolhida);
}

module.exports = { ask, handle, askCity, handleCity, entrarEmEntrega };
