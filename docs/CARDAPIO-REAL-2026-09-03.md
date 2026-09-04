# Cardápio real — 3 de setembro de 2026

Fonte: 20 imagens do catálogo WhatsApp Business e cartaz enviados pelo proprietário nesta conversa. Substitui o cardápio de demonstração; não altera pedidos já gravados.

## Produtos em USD

| Categoria | Produto | Valor |
|---|---|---:|
| Sanduíches | X Burger / Hamburgão | 12.00 cada |
| Sanduíches | X Egg Burger / X Salada | 13.00 cada |
| Sanduíches | X Egg Salada | 14.00 |
| Sanduíches | Bacon Burger | 15.00 |
| Sanduíches | Egg Bacon | 16.00 |
| Sanduíches | X Calabresa Bacon | 19.00 |
| Sanduíches | X Tudo | 20.00 |
| Sanduíches | X Tudão | 24.00 |
| Hot dogs | Hot plain / Hot simples / Hot Duplo | 6.00 / 8.00 / 10.00 |
| Hot dogs | Hot completo / Hot especial / Hot tudo | 13.00 / 13.00 / 16.00 |
| Massas | Macarrão na chapa | 17.00 |
| Refrigerantes (lata) | Guaraná Antártica / Coca cola / Fanta laranja | 3.00 / 2.00 / 2.00 |
| Adicionais | Salsicha / Banana / Sachê de maionese | 1.00 cada |
| Adicionais | Ovo / Bife / Mussarela | 2.00 cada |
| Adicionais | Bacon / Calabresa | 4.00 cada |

Receitas completas e quantidades especiais estão em `config/menu.json`. X Tudão leva 2 ovos; Hot Duplo leva 2 salsichas. Bacon Burger e Egg Bacon não listam mussarela nas imagens. X Calabresa Bacon não lista tomate nem milho. Não presumir ingredientes pelo nome do lanche. A “batata” do cartaz foi interpretada como batata palha, conforme descrições dos outros hot dogs no catálogo.

Remover ingredientes não reduz o preço. Somente os adicionais com preço fornecido podem ser acrescentados; os demais ingredientes são `removalOnly`. Sachê de maionese é produto separado, não maionese grátis.

## Salsicha adicional

- Receita padrão de hot dog: não pergunta preparo.
- Adicional sem preparo informado: pergunta “à parte ou junto com o lanche?”.
- Cliente já informou: ferramentas recebem `preparo_salsicha`, sem perguntar novamente.
- Produto salsicha vindo do catálogo já está cobrado. `definir_preparo_salsicha` só orienta a cozinha, sem cobrar outra unidade.
- Havendo vários lanches, identifica o destino; havendo várias unidades do mesmo lanche e várias salsichas, esclarece a distribuição. Não inventa nem aumenta quantidade.
- Preparo vai no resumo, em `items_json.preparoSalsicha` e nas `choicesCozinha` da comanda. O pedido não fecha com preparo pendente.
- Respostas curtas são tratadas localmente, sem chamada de IA. Não reativa upsell.

## Fontes de dados e atualização

Nomes PT precisam corresponder aos do Business (acentos, maiúsculas e pontuação são normalizados). Baileys resolve nomes para IDs internos; Meta usa os IDs internos. O preço confiável do checkout continua sendo a configuração do servidor, nunca o preço enviado pelo cliente.

Os arquivos são sementes. O banco `config_docs` tem precedência e deve receber esta atualização também; editar só o arquivo ou só o Business não altera preços internos automaticamente. Quando mudar o preço de um adicional, mantenha alinhados o produto do cardápio e seu ingrediente no painel. A sincronização automática de preço não faz parte desta alteração.

Aplicação única: `node scripts/aplicar-cardapio-real.js --apply`. Confere o projeto Point Burger, valida documentos, salva os anteriores em `config_historico` e atualiza os documentos numa única operação. Sem `--apply`, apenas informa o resumo. Não usar como rotina de deploy, pois substituiria edições posteriores do dono.

Testes antigos com receitas inventadas usam fixtures isoladas, somente em `test/`. `cardapiorealtest.js` verifica os 28 produtos reais e a cobrança/preparo da salsicha.
