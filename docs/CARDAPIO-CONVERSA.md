# Cardápio na conversa

> Status atual: o catálogo nativo do WhatsApp é o fluxo de escolha de produtos.
> A antiga proposta de página, lista interna e oferta guiada pela IA é apenas
> histórico e não descreve a operação vigente.

## Fluxo vigente

1. O bot apresenta a entrada para o catálogo nativo do WhatsApp.
2. O cliente abre o catálogo, escolhe produto e quantidade e envia o carrinho.
3. O adaptador do provedor transforma a entrada em um `CatalogOrder`.
4. `routeOrder` envia esse pedido normalizado para a mesma validação e para a
   mesma continuação de checkout, independentemente do provedor.
5. O sistema confere cada item, disponibilidade e quantidade antes de alterar o
   carrinho interno.
6. A conversa segue apenas com os dados obrigatórios que ainda faltam para
   fechar o pedido.

O cliente escolhe produto e quantidade no catálogo nativo. O bot não pergunta se deseja alterar ingredientes. Se o cliente escrever uma alteração, a IA usa `personalizar_item`; retirada não muda o preço e adicional é calculado pelo painel.

O bot também não oferece bebida, adicional, ingrediente ou outro upsell depois
do carrinho. Uma alteração só acontece quando o cliente a pede por escrito.

## Como o produto é reconhecido hoje

Enquanto o provedor é Baileys, os detalhes do carrinho vêm do catálogo do
WhatsApp Business. O sistema procura o nome recebido entre os nomes em português
do painel. Por isso cada nome em português no catálogo precisa corresponder de
forma exata e única ao nome em português do painel.

Se não houver correspondência, ou se o nome puder apontar para mais de um item,
o carrinho é recusado em vez de o bot adivinhar. A correção operacional é
ajustar o nome no WhatsApp Business, não editar IDs, banco ou configuração de
infraestrutura.

## Autoridade de preço e disponibilidade

O catálogo nativo é a vitrine. O painel e a configuração interna são a fonte de
verdade para preço, disponibilidade e adicionais.

- O preço recebido do WhatsApp nunca define quanto será cobrado.
- Um item esgotado no painel não entra no carrinho, mesmo que ainda apareça no
  catálogo.
- Retirar ingrediente não altera o preço.
- Acrescentar ingrediente usa o valor configurado no painel.
- O resumo calculado pelo sistema é o valor que o cliente confirma.

## Futuro provedor Meta

Na futura integração oficial, `product_retailer_id` deve ser exatamente o
`item.id` interno. O adaptador da Meta usa esse identificador diretamente; o
adaptador do Baileys continua resolvendo o nome em português. Depois dessa
normalização, ambos produzem o mesmo `CatalogOrder` e passam por `routeOrder`.

A preparação da integração não significa que a conta, o número ou o catálogo
já tenham sido aprovados pela Meta. Homologação, virada e retorno estão descritos
em `docs/MIGRACAO-BAILEYS-META.md`.

## Histórico: página e lista internas

A proposta anterior previa uma página ou lista interna, um cardápio completo em
texto e sugestões da IA para ajudar o cliente a escolher. Esse desenho foi
substituído pelo catálogo nativo e não deve ser usado como roteiro de operação,
produto ou atendimento.

Listas interativas ainda podem existir para escolhas pontuais exigidas por um
item já selecionado. Elas não são uma segunda vitrine, não substituem o catálogo
nativo e não autorizam personalização ou upsell proativos.
