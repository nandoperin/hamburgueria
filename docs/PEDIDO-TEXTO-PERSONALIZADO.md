# Pedido personalizado após exibir o menu

Reprodução: `menu` → `1` → `Xtudo sem tomate e xtudo com salsicha extra`.
O seletor antigo só resolvia nomes simples; frases com ingredientes dependiam
inteiramente da IA. A mensagem de fallback não distingue falha de API, teto de
gasto ou uma frase não compreendida. O print sozinho não identifica qual ocorreu.

Agora, enquanto existe uma seleção de menu exibida em MENU/ORDER, pedidos novos
com nomes exatos, variantes X Tudo/X-Tudo/Xtudo, quantidade e grupos `sem`/`com`
podem ser interpretados localmente, sem chamada paga. Frases não reconhecidas
inteiramente continuam na IA, sem alteração parcial pelo novo caminho.

O exemplo produz duas linhas distintas: X Tudo sem tomate por $20 e X Tudo com
salsicha adicional por $21. Subtotal $41, antes da entrega. Pergunta à parte/junto
e registra preparo sem cobrar novamente. Não pergunta personalização quando
o cliente não pediu. Não reativa upsell nem muda o fluxo do catálogo nativo.

A lista de produtos/ingredientes e os preços vêm da configuração vigente.
O caminho reaproveita a validação e a ferramenta adicionar_item existentes em
um rascunho de carrinho, só aplicando depois de todos os itens. Não aceita preço
ditado pelo cliente, substituições ambíguas, quantidades de adicionais não suportadas,
ou instruções misturadas de endereço/entrega. Esses casos ficam para a IA.

Testes percorrem o roteador real desde menu/categoria, verificam duas variantes,
preço, preparo, zero chamadas de IA (ligada ou desligada) e ausência de compra
parcial em frases que o parser não consegue interpretar.
