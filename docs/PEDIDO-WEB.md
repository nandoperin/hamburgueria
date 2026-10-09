# Pedido pelo site — projeto

Data: 24/09/2026. **Atualizado em 09/10/2026 — implementado, desligado
(`PEDIR_ATIVO`).**

## O que foi feito (09/10/2026) — vale sobre o plano abaixo

Modelo do food truck (`projeto atendimento/docs/PLANO-PEDIR-ONLINE.md`), com
duas decisões novas do dono:

- **A página mora no site** (`site hamburgueria/pedido.html`, item "Peça
  online" no menu do `index.html` e do `cardapio.html`). A API fica no bot,
  com CORS só para `pointburgerjg.com` e `www.` (`PEDIR_ORIGENS`).
- **Imprime direto**, sem confirmação no WhatsApp (a seção "Por que confirmar
  pelo WhatsApp" abaixo ficou como alternativa recusada). O risco de pedido
  falso é coberto por teto: 3 pedidos/min e 10/h por IP, 3 a cada 30 min por
  telefone, loja fechada recusa no servidor.
- **Ingredientes tipo Flow:** cada produto tem "Customizar ingredientes", que
  abre um popup com o que tirar, adicionais com preço, ponto do bife/bacon e
  maionese à parte.

Rotas (`src/api/pedir.js`), 404 sem `PEDIR_ATIVO`:

| Rota | O que faz |
|---|---|
| `GET /pedir/cardapio` | cardápio do painel, esgotados, promoção do dia, aberto/horário, cidades e taxas, retirada, Zelle |
| `POST /pedir/orcamento` | total exato (promoção, adicionais, taxa) sem gravar — a página chama a cada mudança |
| `POST /pedir/pedido` | recalcula tudo, grava `createOrder` + `createZellePayment`/`createCashPayment` → a comanda sai |

A linha do carrinho é montada por `tools.carrinho.adicionar` — a mesma função
do fluxo guiado —, então id, preço, promoção e texto da comanda são idênticos
aos do WhatsApp. O bot não foi alterado: só `src/api/index.js` ganhou o
`app.use(pedir)`.

Zelle: a página mostra os dados e um botão "Enviar comprovante no WhatsApp";
o comprovante é achado pelo telefone (`getOrderAwaitingProof`), como no bot.

Variáveis: `PEDIR_ATIVO` (liga), `PEDIR_ORIGENS` (opcional), `PEDIR_WHATSAPP`
(opcional, reserva do número da loja quando o WhatsApp não está conectado).

---

Plano original (24/09):

## O que é

Uma página nova no site da loja onde o cliente monta o pedido completo
(lanches, sem/com ingredientes, extras, junto ou à parte, ponto do bife,
entrega ou retirada, endereço, pagamento) e confirma pelo WhatsApp. Confirmado,
o pedido imprime na cozinha como os do bot.

## Decisões do dono (24/09)

- O site já existe e está hospedado. A página de pedido é um **item novo no
  menu do site**, apontando para uma página nova.
- O pedido vem **completo** do site: adicionais, escolhas e extras. Nada de
  "termine na conversa".
- **Rota toda nova.** Nenhum arquivo do fluxo do bot é alterado, exceto o
  ponto de entrada que reconhece a frase de confirmação (item 4 abaixo).
- Validação de endereço, itens e preço fica **no servidor da página**, não no
  bot.
- **Zelle:** a mensagem de confirmação no WhatsApp já traz os dados do Zelle e
  pede o comprovante. A conferência do comprovante é **a mesma que o bot já
  faz hoje** — o pedido do site entra no banco igual a um pedido do bot, então
  o caminho do comprovante (`comprovante.receber`, `!liberar`, `!recusar`,
  lembretes) não precisa de nada novo.

## Por que o bot não precisa mudar

O bot já separa "conversa" de "pedido no banco". Tudo o que acontece depois de
`db.createOrder` + `db.createZellePayment`/`createCashPayment` ([order.js:609](../src/bot/handlers/order.js))
funciona a partir do banco, e não da conversa:

| Etapa | Quem faz | Depende de |
|---|---|---|
| Imprimir a comanda | trigger `pg_notify` + Android | `orders.status` = `paid`/`cash_due` |
| Receber o comprovante | `comprovante.receber` | existir pedido do telefone esperando print |
| Cobrar o comprovante | `pagamentowatch` | `payments.status` |
| `!fila`, `!conferir`, `!liberar`, `!recusar` | admin.js | `orders` + `payments` |
| Painel, relatórios, caixa | painel.js | `orders` + `payments` |
| Cancelar pelo cliente ("cancelar") | cancel.js | pedido do telefone nas últimas 6 h |

Um pedido gravado pela rota nova, no mesmo formato, entra em todas essas
etapas sem que elas saibam de onde veio.

## Como funciona, passo a passo

1. **Cliente abre a página** (`bot.pointburgerjg.com/pedido`, ver decisão em
   aberto sobre o endereço). A página é montada do cardápio do painel, como o
   `/cardapio` de hoje: mudou no painel, mudou na página.
2. **Monta o pedido.** Por lanche: sem X, com Y, extras, junto/à parte, ponto
   do bife/bacon, maionese à parte, quantidade. Depois: entrega ou retirada,
   cidade, endereço, nome, pagamento (Zelle ou dinheiro, com troco).
3. **Toca em "Confirmar pelo WhatsApp".** O servidor:
   - refaz **toda** a conta sozinho (nunca confia no preço que veio do
     navegador): cardápio, adicionais permitidos, promoção do dia, taxa da
     cidade, pedido mínimo, esgotados, horário de funcionamento;
   - grava o pedido no banco com status **`pending`** — não imprime ainda —
     e um **código curto** (ex.: `A7K3`), válido por 30 minutos;
   - devolve o link `wa.me/<número da loja>?text=Confirmo o pedido A7K3`.
4. **O WhatsApp abre com a frase pronta; o cliente aperta enviar.** O bot, na
   entrada da mensagem (uma checagem nova, antes de tudo), reconhece a frase
   exata `Confirmo o pedido <código>`:
   - código existe, não venceu, ainda `pending` → grava o telefone do WhatsApp
     no pedido, passa para `paid` (Zelle) ou `cash_due` (dinheiro) e **a
     comanda imprime**;
   - responde com o resumo do pedido e, no Zelle, com os dados de pagamento e
     "mande o comprovante aqui" — os mesmos textos de hoje;
   - código inválido/vencido → "Este pedido não vale mais. Refaça pelo site."
   - qualquer outra mensagem → segue **exatamente** como hoje.
5. **Zelle:** o cliente manda o print na mesma conversa. `comprovante.receber`
   encontra o pedido pelo telefone, como faz com os do bot. Dono confere com
   `!liberar`/`!recusar`, lembretes saem como sempre.
6. **Pedido não confirmado em 30 minutos** → cancelado sozinho, nunca imprime.

## Por que confirmar pelo WhatsApp (e não só pelo site)

No site qualquer pessoa digita qualquer número. No WhatsApp o número é
garantido pela Meta. Sem a confirmação, qualquer um imprime pedido falso na
cozinha. Com ela:

- pedido falso morre no site: nada imprime sem a mensagem;
- o bot **não** manda mensagem para número desconhecido (importa com o
  Baileys: número que dispara para desconhecidos corre risco de bloqueio);
- o telefone gravado no pedido é o do WhatsApp, não o digitado no site — o
  campo "telefone" da página é dispensável;
- o endereço salvo de um cliente **nunca** é mostrado no site: só aparece no
  WhatsApp, depois da confirmação, como já é hoje.

## O que é novo (arquivos)

| Arquivo | Papel |
|---|---|
| `src/api/pedido-web.js` | rota `GET /pedido` (página) e `POST /pedido/api/confirmar` |
| `src/api/pedido-web-page.js` | HTML/CSS/JS da página, sem recurso externo, como o painel |
| `src/services/pedido-web.js` | validação e cálculo no servidor; monta as linhas do carrinho no **mesmo formato** do bot (`id`, `productId`, `name`, `price`, `qty`, `removed`, `added`, `pontoBife`, `pontoBacon`, `maioneseAParte`, `choicesCozinha`) |
| `src/db/queries.js` | 3 funções novas: `criarPedidoWeb`, `confirmarPedidoWeb(codigo, phone)`, `expirarPedidosWeb` |
| `src/db/schema.sql` | 2 colunas novas em `orders`: `web_code TEXT UNIQUE`, `web_expires_at TIMESTAMPTZ` — **aplicadas à mão no banco**, como sempre |
| `test/pedidowebtest.js` | validação, preço, promoção, esgotado, código vencido, confirmação |

## O que é tocado no que já existe

Um único ponto: `src/bot/router.js`, na entrada da mensagem de texto, **antes**
de qualquer outra regra:

```
se a mensagem for exatamente "Confirmo o pedido <código>":
    confirmar e responder; fim.
senão: tudo como hoje.
```

A frase é fixa e só o site a produz. Cliente que escreve outra coisa nunca
entra nesse ramo.

**Reuso, só leitura:** `cardapio.js`, `modifiers.js`, `promotions.js`,
`delivery.js`, `schedule.js`, `availability.js`, `zelle.js`, `order.summaryLines`.
Nenhum deles muda.

**Não tocados:** `guiado.js`, `leitor.js`, `tools.js`, `agente.js`,
`catalogorder.js`, `comprovante.js`, `printer-agent.js`, Android.

## Riscos e como ficam cobertos

| Risco | Cobertura |
|---|---|
| Preço manipulado no navegador | servidor recalcula tudo; ignora qualquer valor recebido |
| Pedido falso / brincadeira | só imprime após mensagem real no WhatsApp |
| Enxurrada de pedidos `pending` | limite por IP (ex.: 10 por hora), código expira em 30 min, `pending` some sozinho |
| Código adivinhado | 4 caracteres de 32 = 1 milhão de combinações, válido 30 min, e só confirma quem tem o WhatsApp — adivinhar dá ao adivinhador um pedido *para ele mesmo pagar* |
| Cliente confirma duas vezes | segunda mensagem: "já confirmado, pedido #N" |
| Cliente monta o pedido às 16h50 e confirma às 17h05 | horário conferido na **confirmação** também |
| Loja fechada | página mostra o horário e não deixa confirmar |
| Endereço fora da área | cidade só das ativas no painel; endereço passa pela mesma validação de texto do bot (`entrada.js`) |
| Rota nova derruba o bot | rota isolada, com o mesmo tratador de erro das outras; teste próprio |

## Fases (cada uma com commit, teste e deploy separados)

1. **Banco e serviço** — colunas, funções de query, `services/pedido-web.js`
   com validação e cálculo. Só testes; nada visível.
2. **Página** — `/pedido` completa, atrás de `PEDIDO_WEB=on` (desligada em
   produção até o dono aprovar). Dono testa no próprio celular.
3. **Confirmação no bot** — a checagem no `router.js` + resposta com Zelle.
   Teste ponta a ponta com pedido real do dono.
4. **Ligar** — `PEDIDO_WEB=on` em produção e item no menu do site.

Interruptor `PEDIDO_WEB` desliga a página sem deploy, como os outros.

## Decisões em aberto

1. **Endereço da página.** A página precisa do cardápio do painel (banco), que
   só o servidor do bot lê. Opções: (a) `bot.pointburgerjg.com/pedido` e o menu
   do site aponta para lá — mais simples, é o que este plano assume; (b)
   `pointburgerjg.com/pedido` no host do site, chamando a API do bot — exige
   mexer no site e liberar chamadas entre domínios.
2. **Idioma:** só português (decisão do dono de 24/09: inglês/espanhol quase
   não aparecem).
3. **Retirada:** mostrar o endereço de retirada na página, como o bot mostra.
4. **Troco:** perguntar "troco para quanto?" na página, ou deixar em branco e
   o bot pergunta? Plano assume: na página, opcional.
5. **Lembrar o cliente que não confirmou** (fechou o WhatsApp sem enviar):
   não dá — o bot não conhece o número antes da confirmação. Aceito.

## Fora do escopo desta versão

- Pagamento com cartão.
- Acompanhamento do pedido pelo site ("saiu para entrega").
- Cadastro/login no site.
- Cupom de desconto.
