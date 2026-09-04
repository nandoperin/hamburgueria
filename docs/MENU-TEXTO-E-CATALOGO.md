# Menu por texto e catálogo WhatsApp

O pedido de `menu`, `cardápio` ou `catálogo` funciona inclusive na primeira mensagem.

No Baileys, a lista de categorias inclui o link `https://wa.me/c/NUMERO` do WhatsApp conectado. O cliente toca para abrir o catálogo no aplicativo; nenhuma mensagem consegue forçar a abertura da tela. É necessário já existir catálogo nesse número. Não cria produtos no Business e não utiliza o número do administrador ou de pareamento como destino.

Sem usar catálogo, a pessoa pode escolher:

- Categoria: `1`, `sanduíches` ou `1 sanduiche`.
- Produto da lista: `1`, `1, 2` ou pelo nome.
- Produto com quantidade: `2 X Burger` ou `2x X Burger`.
- Pedido com modificações: `um X Burger sem tomate` continua com a IA.

Números são interpretados como seleção somente enquanto houver uma lista exibida. A lista guarda IDs na ordem apresentada; esgotar/remover um produto não transfere sua posição para outro. Valores e disponibilidade são conferidos novamente antes de adicionar. Números inválidos não compram nada. Ao seguir para a coleta de entrega/retirada ou conversar livremente, a seleção antiga é encerrada.

Seleções simples não chamam IA. Nome, endereço, carrinho e regra de preparo da salsicha são preservados. A API oficial mantém os cartões nativos já implementados; quando indisponíveis, o menu textual continua utilizável.

Referência: https://faq.whatsapp.com/487917009931629/?cms_platform=web
