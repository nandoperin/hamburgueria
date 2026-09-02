# Catálogo nativo no Baileys e migração futura para Meta

**Data:** 2026-09-02

**Status:** desenho aprovado em conversa; implementação ainda não iniciada

## Objetivo

Permitir que clientes da Point Burger escolham produtos e quantidades no
catálogo nativo do WhatsApp Business enquanto o bot ainda usa Baileys. O
carrinho recebido deve entrar na mesma conversa humanizada conduzida por IA.
Personalização não é oferecida nem perguntada automaticamente: o cliente pede
para retirar ou acrescentar ingredientes se quiser.

O desenho também deve deixar o domínio de pedidos independente do provedor,
para a troca posterior de Baileys para a API oficial da Meta não exigir uma
reescrita do carrinho, checkout, Zelle, Supabase ou impressão.

## Limites desta fase

- Produtos, fotos e preços serão cadastrados manualmente no aplicativo
  WhatsApp Business.
- O bot não criará, editará nem apagará produtos pelo Baileys.
- O catálogo da Meta e sua sincronização serão tratados quando a empresa e a
  conta oficial estiverem aprovadas.
- O fluxo não oferecerá upsell nem perguntará se o cliente quer modificar o
  produto.
- Preço, disponibilidade e ingredientes continuam sob autoridade do código e
  da configuração vigente carregada do Supabase.

Essa decisão evita depender das operações de catálogo do Baileys 7.0.0-rc13,
que existem na biblioteca, mas possuem [relato atual de timeout exatamente
nessa versão](https://github.com/WhiskeySockets/Baileys/issues/2717). Para esta
fase, o Baileys será usado para receber pedidos de um catálogo criado pelo
aplicativo, não para administrar esse catálogo.

## Fonte da verdade

O cardápio vigente do bot, acessado por `src/services/cardapio.js`, é a fonte da
verdade para:

- existência do produto;
- disponibilidade permanente e esgotamento do dia;
- preço base;
- ingredientes removíveis;
- ingredientes adicionais;
- preço de cada adicional;
- nome usado na cozinha e impressão.

Os valores enviados pelo WhatsApp nunca entram no cálculo. Eles são apenas
dados informativos da vitrine. O total é sempre recalculado pelo bot.

## Cadastro manual no WhatsApp Business

O nome de cada produto no catálogo deve corresponder ao nome em português do
cardápio interno. A correspondência será feita por nome normalizado:

- sem diferença entre maiúsculas e minúsculas;
- sem diferença de acentos;
- espaços repetidos e pontuação cosmética são ignorados;
- o resultado precisa ser único.

Exemplo: `X-Bacon`, `x bacon` e `X–Bacon` podem apontar para o mesmo produto.
Se nenhum item corresponder, ou se mais de um corresponder, o produto é
recusado. O bot não adivinha pelo preço nem escolhe o primeiro resultado.

## Contrato interno de carrinho do catálogo

Os provedores convertem sua mensagem proprietária para um formato comum antes
de chamar o domínio de pedidos:

```js
{
  source: 'baileys' | 'meta',
  externalOrderId: 'identificador semântico do provedor',
  items: [
    {
      productId: 'x_bacon',
      quantity: 1,
      externalProductId: 'identificador para diagnóstico'
    }
  ]
}
```

Depois dessa conversão, o restante do sistema não sabe se o carrinho veio do
Baileys ou da Meta.

## Entrada pelo Baileys

Ao receber `orderMessage`:

1. Validar que existem `orderId` e `token` utilizáveis.
2. Chamar `sock.getOrderDetails(orderId, token)`.
3. Aplicar teto de 99 unidades por linha e 200 unidades no pedido inteiro.
4. Resolver cada produto pelo nome único no cardápio vigente.
5. Descartar preço e total recebidos do WhatsApp.
6. Converter para o contrato comum.
7. Entregar à entrada compartilhada de catálogo.

Erros de rede ou timeout não criam carrinho parcial silencioso. O cliente é
informado de que o carrinho não pôde ser lido e pode tentar novamente ou pedir
em texto. Produtos desconhecidos, ambíguos ou esgotados são nomeados ao cliente
e avisados ao administrador uma vez por produto e por processo.

## Entrada pela Meta

O webhook oficial já recebe `message.order.product_items`. O adaptador Meta
deve converter `product_retailer_id` diretamente para `productId`, mantendo as
mesmas validações de quantidade, existência e disponibilidade.

A entrada compartilhada substitui o acoplamento atual do handler ao formato
snake_case da Meta. Nenhuma regra de preço ou checkout fica dentro dos
adaptadores.

## Comportamento da IA depois do catálogo

Quando o carrinho validado entrar:

1. Os produtos base e quantidades são inseridos na sessão.
2. O histórico da IA recebe um evento interno, separado de fala do cliente,
   contendo o resumo validado do carrinho.
3. A IA confirma o recebimento em uma frase natural.
4. A IA segue somente com o próximo dado obrigatório que estiver faltando:
   entrega ou retirada, endereço/cidade quando necessário, cadastro e resumo.

A IA não pergunta sobre ingredientes, não oferece adicionais e não faz upsell.
Se nome ou endereço já forem conhecidos, continuam valendo as regras atuais de
memória e confirmação, sem repetir perguntas.

Se a IA estiver indisponível, a entrada do catálogo continua pelo checkout
determinístico existente. O carrinho não é perdido.

## Personalização solicitada pelo cliente

Será criada a ferramenta `personalizar_item`, separada de `adicionar_item`.
Isso evita o erro de adicionar um segundo sanduíche quando a intenção era
alterar aquele que já veio do catálogo.

Entrada conceitual:

```js
personalizar_item({
  item_id: 'x_bacon',
  quantidade: 1,
  remover: ['cebola'],
  acrescentar: ['bacon']
})
```

Regras:

- o item precisa existir no carrinho atual;
- cada ingrediente passa por `services/modifiers.js`;
- retirar é sempre gratuito;
- adicional usa o preço vigente do painel;
- modificadores anteriores são preservados, salvo pedido explícito para
  desfazê-los;
- a linha personalizada ganha o identificador composto já usado pelo
  carrinho;
- a comanda recebe as sublinhas de retirada e adicional;
- o subtotal é recalculado pelo código e devolvido à IA.

Quando houver uma única unidade compatível, a alteração é direta. Se houver
várias unidades e o cliente não disser quantas ou em quais aplicar, a
ferramenta bloqueia a mutação e orienta a IA a perguntar se é em todas ou em
uma unidade. A pergunta só aparece depois de uma solicitação ambígua do
cliente.

Para personalizar apenas parte de uma linha com quantidade maior que um, o
carrinho divide a linha: a quantidade não alterada permanece na linha base e
a quantidade modificada vai para a linha personalizada.

## Carrinhos repetidos e estado

- Um carrinho de catálogo recebido durante `PAYMENT_PENDING` inicia pedido
  novo, preservando cadastro e memória do cliente, como o fluxo atual.
- Uma retransmissão do mesmo pedido externo não pode duplicar itens. O
  identificador externo é guardado na sessão durante a conversa e pedidos
  repetidos são ignorados com confirmação curta.
- Um novo carrinho durante pedido ainda aberto é mesclado ao carrinho atual,
  porque o cliente pode voltar ao catálogo para acrescentar bebida ou outro
  produto.
- Um item idêntico e sem modificadores soma quantidade; itens com
  personalizações diferentes ficam em linhas distintas.

## Segurança e limites

- Nunca confiar em preço, total, moeda, nome ou quantidade do payload sem
  validação.
- Quantidade por linha: máximo 99, preservando o teto atual.
- Quantidade total do carrinho recebido: máximo 200 unidades.
- Quantidade ausente, menor que 1, maior que 99 ou total acima de 200 rejeita o
  lote inteiro. O bot não reduz quantidade silenciosamente nem aplica metade
  de um carrinho adulterado.
- Produto sem correspondência única nunca é cobrado.
- Produto esgotado nunca entra no carrinho.
- Erro ao buscar detalhes não deixa sessão parcialmente modificada: primeiro
  validar tudo, depois aplicar o lote.
- Logs registram IDs externos, causa da recusa e quantidade, sem conteúdo de
  sessão ou credenciais.
- O token presente em `orderMessage` nunca é escrito no log.
- O preço final mostrado ao cliente é sempre o resumo calculado pelo sistema
  antes do Zelle.

## Componentes previstos

- `src/bot/index.js`: detectar `orderMessage` e pedir seus detalhes ao socket.
- Novo adaptador Baileys de catálogo: validar e converter o pedido externo.
- `src/api/webhooks/meta.js`: converter o carrinho Meta para o contrato comum.
- Refatoração do handler compartilhado de catálogo para receber o contrato
  normalizado.
- `src/ai/tools.js`: esquema e implementação de `personalizar_item`.
- `src/ai/agente.js`: contexto/evento de carrinho recebido e instrução para não
  sugerir personalização.
- `src/services/catalog.js`: usar o cardápio dinâmico vigente, não
  `require(config/menu.json)` congelado.
- Testes unitários e de fluxo para ambos os provedores.
- `docs/MIGRACAO-BAILEYS-META.md`: manual operacional da futura troca.

## Testes de aceitação

1. Um produto recebido pelo Baileys entra com o preço do cardápio interno.
2. Vários produtos e quantidades entram em um único lote.
3. Preço ou total forjado no WhatsApp não altera o valor calculado.
4. Produto desconhecido, ambíguo ou esgotado é recusado com aviso claro.
5. Quantidade inválida ou excessiva recusa o lote sem alterar o carrinho.
6. O carrinho recebido não dispara pergunta ou sugestão de ingredientes.
7. Cliente pode retirar ingrediente de um item já no carrinho sem custo.
8. Cliente pode acrescentar ingrediente e o subtotal aumenta pelo valor do
   painel.
9. Duas unidades podem ser divididas entre linha base e linha personalizada.
10. Solicitação ambígua em várias unidades não modifica nada antes da resposta.
11. Repetição do mesmo pedido externo não duplica o carrinho.
12. A entrada Meta produz o mesmo carrinho interno que a entrada Baileys.
13. Falha da IA mantém o carrinho e cai no checkout determinístico.
14. O token do pedido Baileys não aparece nos logs.

## Manual de migração para Meta

O documento operacional final deve cobrir:

1. verificação da empresa e da conta na Meta;
2. criação ou vinculação do catálogo no Commerce Manager;
3. convenção de `product_retailer_id` igual ao ID interno do produto;
4. variáveis necessárias no Railway;
5. webhook, assinatura e verificação;
6. recebimento de texto, interações, carrinho e comprovante do Zelle;
7. coexistência com o WhatsApp Business e pausa por intervenção humana;
8. teste completo antes de trocar `WHATSAPP_PROVIDER`;
9. desativação segura da sessão/volume Baileys;
10. procedimento de retorno imediato para Baileys.

## Critério de conclusão

A fase termina quando um cliente real consegue abrir o catálogo nativo no
WhatsApp, enviar um carrinho pelo Baileys, pedir uma personalização opcional em
texto e chegar ao resumo correto do pedido; além disso, a suíte prova que o
mesmo contrato interno aceita o payload da Meta sem mudar as regras de negócio.
