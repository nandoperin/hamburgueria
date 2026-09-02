# Etapa 5 — Relatório

## Status

DONE

## Arquivos alterados

- `src/ai/tools.js`
- `src/ai/agente.js`
- `src/bot/handlers/menu.js`
- `test/personalizartest.js`
- `test/checkouttest.js`
- `test/memoriatest.js`
- `.superpowers/sdd/2026-09-02-catalogo-baileys-meta/task-5-report.md`

## RED / GREEN

Runtime usado em todas as provas: `C:\Users\ferna\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

### RED

- `node.exe test/personalizartest.js` — falhou com `ferramenta desconhecida: personalizar_item`.
- `node.exe test/checkouttest.js` — falhou porque a ferramenta separada de alteração ainda não existia.
- `node.exe test/memoriatest.js` — falhou porque a repetição do último pedido usava o `id` composto em vez do `productId` base.

A primeira execução isolada de `personalizartest` parou antes do comportamento por ausência das variáveis obrigatórias do cliente de banco. A suíte recebeu credenciais falsas somente no processo de teste, sem alteração de `.env`, e o RED funcional esperado foi repetido e registrado.

### GREEN

- `node.exe test/personalizartest.js` — passou: ambiguidade, ausência de mutação, divisão de unidade, preço interno, desfazer/recombinar, ingrediente proibido, excesso, preservação de modificadores e linha legada.
- `node.exe test/checkouttest.js` — passou: nenhuma ferramenta aceita preço, taxa, valor, total ou desconto; `personalizar_item` aceita somente identidade, quantidade e modificadores.
- `node.exe test/memoriatest.js` — passou: quantidade e personalização do último pedido são preservadas usando o `productId` base.
- `node.exe test/run.js` — todas as 45 suítes passaram.
- `git diff --check` — passou.

O runtime indicado contém somente `node.exe`, sem lançador `npm`; `node.exe test/run.js` executa o mesmo runner definido por `npm test` no `package.json`.

## Decisões de atomicidade e preço

- A seleção procura primeiro o `id` exato da linha; somente na ausência dele usa o `productId` base, com fallback para a parte anterior a `:` em linhas antigas.
- Ambiguidade de mais de uma unidade sem quantidade devolve `bloqueiaFluxo: true` antes de qualquer mutação.
- Existência, disponibilidade, quantidade e conjunto completo de modificadores são validados antes de reduzir ou remover a linha de origem.
- Uma alteração parcial reduz a quantidade da origem e cria ou reúne a linha de destino pelo `cartId`; desfazer modificadores recompõe linhas idênticas.
- Modificadores anteriores são carregados como base e só então recebem restaurações, retiradas e novos pedidos.
- Preço base e disponibilidade vêm de `cardapio`; adicionais permitidos e preço extra vêm de `modifiers.validar`. Nenhum preço, desconto ou taxa entra pela ferramenta.
- Linhas simples novas do menu e da IA recebem `productId`, `removed`, `added` e `choicesCozinha`; linhas antigas do menu são enriquecidas ao receber nova unidade.
- O upsell permaneceu desativado e não foi alterado.

## Commit

- Único commit planejado: `feat: personaliza item existente do carrinho`.
- O hash é informado no retorno da tarefa, pois o commit não pode incluir o próprio hash em seu conteúdo.

## Auto-revisão e preocupações

- Diff limitado aos arquivos da Etapa 5 e a este relatório obrigatório.
- A prova por `id` exato ocorre com outra linha do mesmo produto no carrinho e confirma a preservação da personalização anterior.
- Erros cobertos mantêm o carrinho byte a byte idêntico antes e depois da tentativa.
- Nenhuma alteração em `.env`, Supabase, Railway, deploy ou infraestrutura externa.
- Nenhuma preocupação funcional conhecida após as provas focadas e completas.

## Fix round 1

### Causa

Os caminhos que reutilizavam uma linha existente tratavam apenas a quantidade. `adicionar_item` incrementava uma linha legada sem completar metadados; `juntarLinha` somava a quantidade ao destino legado e descartava os metadados calculados da nova linha; e a divisão parcial reduzia a origem antes de enriquecê-la. Em linhas personalizadas antigas, o estado ainda existia no `cartId`, mas não era reconstruído para `removed`, `added` e `choicesCozinha`.

### RED / GREEN

Runtime: `C:\Users\ferna\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

RED:

- `node.exe test/personalizartest.js` — falhou em `adicionar_item completa os quatro metadados da linha legada`.
- `node.exe test/personalizartest.js` — falhou em `divisão completa os quatro metadados da origem legada restante` no cenário base.
- O cenário foi fortalecido com origem personalizada legada e falhou antes mesmo da asserção de metadados, em `divide parcialmente a origem legada`, porque a personalização anterior não era preservada.
- `node.exe test/personalizartest.js` — falhou em `recomposição completa os quatro metadados do destino legado`.

GREEN:

- `node.exe test/personalizartest.js` — passou com os três caminhos legados e os quatro campos verificados na origem e no destino.
- `node.exe test/checkouttest.js` — passou.
- `node.exe test/memoriatest.js` — passou.
- `node.exe test/run.js` — todas as 45 suítes passaram.
- `node.exe --check src/ai/tools.js` e `node.exe --check test/personalizartest.js` — passaram.
- `git diff --check` — passou.

### Arquivos alterados

- `src/ai/tools.js`
- `test/personalizartest.js`
- `.superpowers/sdd/2026-09-02-catalogo-baileys-meta/task-5-report.md`

### Correção

- Uma rotina única completa somente `productId`, `removed`, `added` e `choicesCozinha` ausentes ou inválidos; arrays válidos existentes não são substituídos.
- `adicionar_item` usa exclusivamente o produto e o resultado de `modifiers.validar` como fallback ao reunir uma linha legada.
- `juntarLinha` completa o destino legado com os metadados internos da linha calculada antes de somar a quantidade.
- A personalização legada codificada no `cartId` é reconstruída apenas como fallback, revalidada por `modifiers.validar` e usada para completar a origem remanescente e calcular o destino.
- A origem só é enriquecida depois que o estado atual e o estado desejado passam por validação; erros continuam sem mutação.
- Nenhum preço é aceito ou recalculado de entrada externa; linhas novas continuam usando `cardapio` e `modifiers.validar`.

### Commit

- Commit separado planejado: `fix: completa metadados de linhas legadas`.
- O hash é informado no retorno da correção, pois o commit não pode incluir o próprio hash em seu conteúdo.

### Auto-revisão e preocupações

- Diff limitado aos dois arquivos do achado e a este relatório.
- Os testes verificam `productId`, `removed`, `added` e `choicesCozinha`, inclusive valores não vazios na origem e no destino personalizados.
- A recomposição cobre destino base legado já existente; a adição cobre reuso direto por `cartId`.
- Nenhuma alteração em upsell, `.env`, Supabase, Railway, deploy ou infraestrutura externa.
- Nenhuma preocupação funcional conhecida após as provas focadas e completas.
