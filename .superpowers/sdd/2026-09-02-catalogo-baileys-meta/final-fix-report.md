# Onda final — relatório de correções

## Status

DONE — base `e67c1b7`, sem push, merge, deploy ou prova Mistral real.

## Causa e correção por achado

1. **CONFIRM / total antigo** — o catálogo mesclava itens sem invalidar os totais já exibidos. A continuação agora pula a IA quando não falta dado obrigatório e chama o checkout determinístico, que recalcula e reenvia o resumo antes de aceitar `sim`. A regressão cobre `$14` → novo Guaraná → resumo `$17` → pedido/pagamento `$17`.
2. **PAYMENT_PENDING** — o reset ocorria antes da validação. A validação pura do lote agora antecede o reset; duplicados continuam saindo primeiro e quantidade, produto ou disponibilidade inválidos preservam sessão, pagamento, estado, carrinho, totais e IDs.
3. **LANGUAGE** — a fala interna da IA saía com a sessão ainda em `LANGUAGE`. Um carrinho aceito move a sessão para `ORDER` antes da continuação; `routeOrder` seguido de `route` prova que welcome não intercepta.
4. **Logs** — catches herdavam telefone do contexto ou registravam erro/produtos. Baileys, Meta, `routeOrder` e agente emitem em contexto vazio apenas origem fechada, código fechado e contagem segura. A nova suíte captura e valida as linhas JSON reais do Pino em todos esses caminhos.
5. **Política pós-catálogo** — o detector existia apenas no script. A política pura foi movida para `src/ai/catalog-policy.js` e é compartilhada por produção, script e teste; fala interna proibida retorna `false`, não é enviada e cai no checkout determinístico.
6. **Variantes** — quantidade permitia escolher arbitrariamente a primeira linha compatível. Um `productId` base com variantes distintas agora bloqueia sem mutação e orienta usar o ID exato; ID composto exato continua funcionando.
7. **Schema** — `personalizar_item.quantidade.maximum` foi alinhado de 20 para 99.
8. **Operação** — `docs/OPERACAO.md` agora descreve a resposta real sem depender de frase literal inexistente.

## RED / GREEN

RED observado antes das correções:

- `checkouttest`: schema ainda limitado a 20.
- `personalizartest`: ID base alterava uma variante arbitrária.
- `catalogiaflowtest`: oferta pós-catálogo era enviada e sessão permanecia em `LANGUAGE`.
- `catalogroutingtest`: lote inválido em `PAYMENT_PENDING` substituía a sessão.
- `cataloglogstest`: linha real de `routeOrder` continha `phone` e campos fora da lista segura.

GREEN:

- Focados: `cataloglogstest`, `provacatalogotest`, `catalogroutingtest`, `catalogordertest`, `catalogiaflowtest`, `personalizartest`, `segurancatest`, `checkouttest` e `carrinhotest` passaram.
- Suíte completa final: `node.exe test/run.js` — **48/48 suítes passaram**.
- `git diff --check` — passou.
- `npm`/`node` não estão no PATH; foi usado o runtime empacotado `node.exe`, executando o mesmo `test/run.js` definido por `npm test`.

## Commit

- `6a9430b` — `fix: fecha regressões finais do catálogo`.

## Auto-revisão e preocupações

- Matriz coberta: `LANGUAGE`, `ORDER/MENU`, `CONFIRM`, `PAYMENT_PENDING`; IA on/off; duplicado, válido e recusas; preservação byte a byte dos campos críticos.
- `npm test` não faz chamadas externas; a prova Mistral real foi omitida conforme prioridade final do usuário.
- Nenhuma alteração em `.env`, Supabase, Railway, Meta, impressora, Zelle ou deploy.
- Nenhuma preocupação funcional conhecida após os testes determinísticos; resta somente o teste manual solicitado pelo usuário.
