# Pedido personalizado após exibir o menu

Reprodução: `menu` → `1` → `Xtudo sem tomate e xtudo com salsicha extra`.
O seletor antigo só resolvia nomes simples; frases com ingredientes dependiam
inteiramente da IA. A mensagem de fallback não distingue falha de API, teto de
gasto ou uma frase não compreendida. O print sozinho não identifica qual ocorreu.

Com IA ligada, texto livre passa primeiro pelo modelo. Este reconhecedor é uma
rede de continuidade: só responde se a chamada falhar ou se a IA estiver
desligada. Assim ele não define o estilo da conversa nem impede variações; ainda
mantém pedidos inequívocos funcionando durante indisponibilidade do provedor.
Carrinho estruturado vindo do catálogo também volta à IA para uma confirmação
natural. A proteção contra upsell permite a pergunta genérica "algo mais?", mas
continua recusando oferta de bebida, ingrediente ou produto específico.

Em MENU/ORDER com carrinho vazio OU seleção de menu exibida, pedidos novos
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

Variações cotidianas: batata/batatas resolve para batata palha somente quando
há um único ingrediente permitido correspondente no lanche. Plurais comuns
(ovos, tomates, salsichas) e grafias de mussarela também são reconhecidos.
Não confunde batata frita nem escolhe um queijo entre vários por aproximação.
Na resposta a "Quer algo mais?", quantidade explícita (2, 2x, 2 x, dois) ou
pedido explícito de inclusão permite outra variante de um produto já comprado.
"Xtudo sem batata e 2 xtudo com salsicha" resulta em três lanches, $62 antes
da entrega. "Xtudo sem tomate" seguido de "2 xtudo com salsicha" preserva a
primeira personalização e acrescenta duas unidades, também por $62.

Falhas de chamada à IA registram `evt:ia`, `code:conversa_falhou` e `statusHTTP`
quando o SDK fornece status numérico. Corpo/headers/mensagem do erro não são
registrados. Isso ajuda a distinguir falha HTTP de um limite local `evt:ia_custo`;
não comprova, por si só, a causa de uma falha histórica no Railway.

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

## Pedido inteiro numa mensagem

"um x burger pra entrega, pago em cash": produto, quantidade, entrega e
pagamento de uma vez. O modelo registra tudo na mesma resposta; quando pula uma
parte, o código completa só o que está dito com todas as letras:

- **Pulou o produto** (chamou entrega/pagamento com o carrinho vazio): tira da
  frase entrega, pagamento e cumprimentos e passa o resto por esta mesma
  gramática. Sobrou endereço, nome ou algo que ela não entende? Não registra
  nada, e a recusa diz ao modelo para chamar `adicionar_item` primeiro.
- **Pulou entrega/retirada ou pagamento** depois de registrar o produto
  ("2 x tudo pra retirada, pago no zelle"): registra o que foi dito. Pergunta,
  negação ou os dois tipos juntos ficam com o modelo.

Quem já disse como recebe ou paga não ouve "Quer algo mais?". Depois vem só o
que falta: cliente novo dá nome e endereço numa mensagem; conhecido confirma
"Entrego em ...?" antes do resumo — de propósito, por enquanto (dá para tirar e
ir direto ao resumo). A mesma pergunta vale no fluxo normal, depois de "cash" ou
"Zelle": antes o pagamento pedia o endereço digitado de novo até a quem já
tinha um salvo. "2 x tudo" é lido como 2 X-Tudo; "2x tudo" continua com a IA.
Testes em `test/pedidocompletotest.js`.

## Resposta curta de logística e as travas da noite de 11/09

Com produto no carrinho, "Retirada", "Entrega", "Zelle", "Cash" (e variações
curtas: "é pra entrega", "vou pagar em dinheiro", "retirada e cash") são
registrados pelo código, sem chamar o modelo, e a próxima pergunta é a do
sistema. Veio de dois pedidos do catálogo em que o modelo só conversou ("Cash
ou Zelle?", "Me passa seu nome") sem registrar nada. Qualquer outra coisa na
frase ("retirada, e me vê uma coca") continua com o modelo.

Do mesmo dia, um pedido de 8 lanches numa lista:
- "sem maionese" num lanche que não leva maionese não é recusa — o item entra e
  a resposta avisa que não vem; item sem lista de ingredientes aceita remoção
  de ingrediente conhecido.
- "3 x bacon" com id do adicional `bacon` é recusado apontando os lanches; o
  cardápio no prompt diz que a seção de adicionais não é de lanches.
- Lista de nomes sem preço não é "carrinho"; a correção interna acontece uma
  vez. O teto de rodadas responde "Anotei: …" com o carrinho e a próxima
  pergunta, não "Não entendi".
- O corte do histórico nunca deixa resultado de ferramenta órfão (era HTTP 400
  em toda mensagem seguinte); um 400 descarta o histórico e tenta uma vez.
- "Feito! Seu pedido está pronto" com pedido em aberto vira a próxima
  pergunta do sistema. Testes em `test/noitedeonzetest.js`.

## Adicional vale em qualquer lanche

Regra do dono, e por isso mora em `modifiers.acrescentaveis()` e não em trinta
caixinhas do painel: todo ingrediente que não é `removalOnly` no dicionário
pode ser acrescentado a qualquer item personalizável, pelo mesmo preço. A lista
`addable` de cada item deixou de restringir (continua aceita, só não limita).

Veio do pedido #103: o cliente pediu X bacon com calabresa, a calabresa não
estava marcada naquele item, a ferramenta recusou e o lanche saiu puro — $4 a
menos e um cliente esperando calabresa. Bebida continua sem aceitar adicional
(não tem bloco de modificadores), e ingrediente `removalOnly` — pão, alface —
continua só saindo.

**Quem entra é quem tem preço.** O painel só deixa editar nome e preço do
ingrediente, e diz na própria tela: "Remover é sempre grátis. O preço abaixo é
o de acrescentar". Então o preço é o interruptor — $0 vem no lanche e só sai;
com preço, entra em qualquer um. `removalOnly` deixou de ser consultado para
não existir uma segunda chave, invisível no painel, discordando do preço: foi
assim que a batata palha ficou impossível de acrescentar mesmo depois de o dono
querer vendê-la a $1.

No prompt, a lista aparece **uma vez** no topo do cardápio em vez de repetida
item a item, e vem acompanhada dos que só saem — sem isso o modelo oferecia
"batata palha extra por $1" quando ela ainda não tinha preço, inventando a
opção e o valor.

## Chamada recusada não é repetida

O código guarda, por mensagem, o que já recusou. Chamada idêntica repetida não
é executada de novo: volta a mesma recusa com "não repita, responda ao
cliente". E `adicionar_item` que não muda o carrinho passou a ser recusa de
verdade (`bloqueio`), em vez de resultado comum.

Veio de 12/09: "vocês vendem porção de batata frita?" fez o modelo tentar
`batata_palha` três vezes até estourar o teto de 6 rodadas — e o cliente ficou
sem resposta nenhuma. A recusa de item inexistente também passou a dizer o que
falar ("não temos, ofereça o parecido") em vez de só constatar.

## A ordem das perguntas

1. Entrega ou retirada
2. Endereço — o salvo é oferecido a quem já comprou; cliente novo dá nome e
   endereço na mesma mensagem
3. Nome, se ainda faltar
4. **Como paga, por último** — e uma vez só
5. Resumo

A forma de pagamento vinha logo depois de entrega/retirada, e quem já tinha
respondido "cash" ouvia a pergunta outra vez mais adiante; num teste real o
cliente acabou trocando para Zelle só por causa da repetição. A ordem vale nos
dois fluxos (`tools.mensagemColeta` e `order.startCheckout`), e `faltando()`
segue a mesma sequência para o modelo não inventar outra.

Como o pagamento passou a ser a última pergunta, é nela que o cliente lembra do
refrigerante: corrigir o pedido nessa etapa deixou de ser recusado
(`CORRIGE_O_PEDIDO`) — o estado volta para ORDER e a pergunta do pagamento
reaparece sozinha, porque continua sem resposta.

## Cidade escrita errada, acréscimo e complemento

Três coisas que a noite de 12/09 mostrou, todas resolvidas no código:

- **"Everret"** — `delivery.acharCidade` aceita uma letra trocada (duas, em
  nomes de 7+ letras) e só quando **uma única** cidade atendida fica perto.
  Vale para todas as cidades cadastradas; "Boston" continua sem virar
  "East Boston" — cidade de fora vai para a recusa de cobertura.
- **"Quero 1 com banana"** com um lanche no carrinho é acréscimo, não porção
  avulsa: `adicionar_item` de um adicional nessa situação é recusado apontando
  `personalizar_item` na linha certa (`acrescimoPedido`), e a recusa por
  produto não citado passa a dizer a mesma coisa. Porção avulsa continua
  valendo quando ele diz "porção", "avulso" ou "à parte".
- **"Ap1"** logo depois do endereço é complemento, não nome: entra no endereço
  (`complementoDeEndereco`), sem pergunta nova, e a pergunta que estava de pé
  continua de pé. `definir_cadastro` também recusa gravar isso como nome.

## O "responder" do WhatsApp

O cliente responde a pergunta de duas perguntas atrás citando aquele balão.
Não dá para desligar o *responder* do lado de quem recebe, então o bot ouve: o
texto citado chega em `route(..., { citada })`, passa pela mesma limpeza do
corpo e entra no histórico do modelo como
`[O CLIENTE RESPONDEU CITANDO ESTA MENSAGEM: "..."]`.

Ele **não** entra no texto que as travas leem (`textoCliente`): o balão citado
quase sempre é do próprio bot — resumo, cardápio, "Anotei: 2x X Tudão" — e
sustentar produto com ele seria deixar o bot pedir por conta própria.

Efeito colateral que veio junto: citando o resumo inteiro e dizendo "tira
esse", o modelo tirava todos os itens. Com mais de uma linha no carrinho e o
produto não citado na fala, `remover_item` recusa e manda perguntar qual.
