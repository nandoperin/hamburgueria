# Pedido personalizado após exibir o menu

Reprodução: `menu` → `1` → `Xtudo sem tomate e xtudo com salsicha extra`.
O seletor antigo só resolvia nomes simples; frases com ingredientes dependiam
inteiramente da IA. A mensagem de fallback não distingue falha de API, teto de
gasto ou uma frase não compreendida. O print sozinho não identifica qual ocorreu.

Agora, em MENU/ORDER com carrinho vazio OU seleção de menu exibida, pedidos novos
com nomes exatos, variantes X Tudo/X-Tudo/Xtudo, quantidade e grupos `sem`/`com`
podem ser interpretados localmente, sem chamada paga. Frases não reconhecidas
inteiramente continuam na IA, sem alteração parcial pelo novo caminho.

Não exige abrir menu: `Ola` → `Xtudo sem tomate e xtudo com salsicha` funciona
para cliente novo ou conhecido. Também atende o pedido como primeira mensagem.
Aceita também novos produtos durante a montagem, como "quero uma coca".
Personalização de produto que já está no carrinho, sem seleção aberta, continua
com a IA para distinguir edição de um lanche existente de outra unidade.

Antes de perguntar entrega/retirada, pergunta "Quer algo mais? Digite menu para
abrir as opções." Depois de cada inclusão, permite continuar escolhendo; "não",
"só isso" ou "finalizar" encerra essa etapa. Não repete durante nome/endereço.
Preparo de salsicha tem prioridade. Entrega/retirada informada espontaneamente
é preservada. O mesmo passo vale para carrinhos do catálogo nativo.

O exemplo produz duas linhas distintas: X Tudo sem tomate por $20 e X Tudo com
salsicha adicional por $21. Subtotal $41, antes da entrega. Pergunta à parte/junto
e registra preparo sem cobrar novamente. Não pergunta personalização quando
o cliente não pediu. Não reativa upsell nem muda o fluxo do catálogo nativo.

A lista de produtos/ingredientes e os preços vêm da configuração vigente.
O caminho reaproveita a validação e a ferramenta adicionar_item existentes em
um rascunho de carrinho, só aplicando depois de todos os itens. Não aceita preço
ditado pelo cliente, substituições ambíguas, quantidades de adicionais não suportadas,
ou instruções misturadas de endereço/entrega. Esses casos ficam para a IA.

Testes percorrem o roteador real desde saudação, primeira mensagem e menu/categoria,
com cadastro novo ou conhecido, verificam duas variantes,
preço, preparo, zero chamadas de IA (ligada ou desligada) e ausência de compra
parcial em frases que o parser não consegue interpretar.
