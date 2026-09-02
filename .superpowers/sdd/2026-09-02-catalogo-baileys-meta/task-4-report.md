# Etapa 4 — Relatório

## Status

DONE

## Arquivos alterados

- `src/bot/index.js`
- `src/bot/router.js`
- `src/api/webhooks/meta.js`
- `test/catalogroutingtest.js`
- `.superpowers/sdd/2026-09-02-catalogo-baileys-meta/task-4-report.md`

## RED / GREEN

Runtime usado em todas as provas: `C:\Users\ferna\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

### RED

1. `node.exe test/catalogroutingtest.js`
   - Falha esperada: `pedido do catálogo é tratado antes de imagem e texto`.
2. `node.exe test/catalogroutingtest.js`
   - Falha esperada: `retransmissão pendente mantém a mesma sessão`.
3. `node.exe test/catalogroutingtest.js`
   - Falha esperada: `falha interna do roteador não registra erro bruto`.
4. `node.exe test/catalogroutingtest.js`
   - Falha esperada: `webhook Meta não registra erro bruto em nenhum caminho`.

O primeiro disparo da prova nova encontrou antes uma configuração Supabase ausente. A suíte foi isolada com credenciais falsas somente no processo de teste, sem alterar `.env`, e então o RED funcional esperado foi confirmado.

### GREEN

- `node.exe test/catalogroutingtest.js` — passou.
- `node.exe test/catalogadapterstest.js` — passou.
- `node.exe test/catalogordertest.js` — passou.
- `NODE_ENV=test AI_ENABLED=off node.exe test/carrinhotest.js` — passou. A primeira execução manual isolada tentou a IA porque não herdou o ambiente que `test/run.js` força; não houve alteração de produção para mascarar isso.
- `node.exe test/segurancatest.js` — passou.
- `node.exe test/run.js` — todas as 44 suítes passaram. Este é exatamente o runner chamado por `npm test`; o diretório do runtime indicado contém `node.exe`, mas não contém o lançador `npm`.
- `node.exe --check` nos quatro arquivos JavaScript alterados — passou.
- `git diff --check` — passou.

## Decisões de segurança

- Baileys normaliza `orderMessage` com `fromBaileys` antes do roteador e nunca registra a mensagem, o token ou o erro externo bruto.
- Meta normaliza a mensagem completa com `fromMeta` antes de `routeOrder`.
- Erros externos são reduzidos a códigos conhecidos e traduzidos por `publicErrorKey`; nenhuma `err.message` externa chega ao cliente.
- Produto desconhecido ou ambíguo vindo do Baileys chama `avisarDono` somente com o código e nomes sanitizados; não inclui token, payload, telefone ou dados do cliente.
- Logs de falha do carrinho e do webhook Meta usam códigos fixos (`carrinho_falhou`, `payload_invalido`, `mensagem_falhou`) em vez de objetos `err`.
- Foram acrescentadas regressões diretas para ambiguidade no Baileys e para rejeição de `getOrderDetails` cujo erro contém segredo.
- Nenhum segredo, `.env`, Supabase, Railway, push ou deploy foi tocado.

## Comportamento preservado

- `routeOrder(phone, catalogOrder, send)` recebe o contrato normalizado dos dois provedores.
- Em `PAYMENT_PENDING`, uma retransmissão com o mesmo `externalOrderId` é detectada antes do reset e mantém a mesma sessão intacta.
- Um ID novo reinicia o pedido e aplica o novo carrinho, preservando somente os 20 IDs externos mais recentes.
- O checkout continua determinístico; nenhuma chamada de IA foi adicionada.

## Commit

- Único commit desta etapa: `feat: recebe catalogo nativo pelo Baileys`.
- O hash final é informado no retorno da tarefa; ele não pode ser auto-referenciado dentro do conteúdo do próprio commit.

## Auto-revisão e preocupações

- Diff limitado aos arquivos da Etapa 4 e a este relatório obrigatório.
- Sintaxe, espaços, roteamento, deduplicação, sigilo e regressões revisados.
- Nenhuma preocupação funcional ou de segurança conhecida ao concluir.
