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

## Fix round 1

### Causa

A implementação inicial protegeu os catches novos de catálogo e do webhook Meta, mas três catches genéricos preexistentes permaneceram na mesma fronteira revisada: imagem e texto no listener Baileys e processamento de comprovante em `routeImagem`. Eles entregavam o objeto `err` diretamente ao logger; os dois catches do listener também entregavam o telefone.

### Arquivos alterados

- `src/bot/index.js`
- `src/bot/router.js`
- `test/catalogroutingtest.js`
- `.superpowers/sdd/2026-09-02-catalogo-baileys-meta/task-4-report.md`

### RED / GREEN

Runtime: `C:\Users\ferna\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

RED:

- `node.exe test/catalogroutingtest.js` — falhou com oito violações esperadas, cobrindo metadados além de `evt`/`code`, segredos dos três erros e os dois telefones do listener.

GREEN:

- `node.exe test/catalogroutingtest.js` — passou.
- `node.exe test/segurancatest.js` — passou.
- `node.exe test/run.js` — todas as 44 suítes passaram.
- `node.exe --check src/bot/index.js`, `src/bot/router.js` e `test/catalogroutingtest.js` — passaram.
- `git diff --check` — passou.

### Correção e decisões de segurança

- Falha de imagem no listener Baileys registra somente `{ evt: 'imagem', code: 'recebimento_falhou' }`.
- Falha de texto no listener Baileys registra somente `{ evt: 'msg', code: 'roteamento_falhou' }`.
- Falha de comprovante em `routeImagem` registra somente `{ evt: 'imagem', code: 'processamento_falhou' }`.
- Nenhum desses registros recebe `err`, `err.message`, stack, payload, telefone, token, conteúdo da mensagem ou dados do cliente.
- Os textos operacionais do logger foram preservados. `routeImagem` continua enviando exatamente `error_generic`; os catches do listener continuam sem resposta adicional.

### Commit

- Commit separado planejado: `fix: evita dados externos nos logs de entrada`.
- O hash final é informado no retorno da correção, pois o conteúdo do próprio commit não pode auto-referenciar seu hash.

### Auto-revisão e preocupações

- A regressão é comportamental: inicializa um socket Baileys controlado, dispara os listeners reais e força a falha real de `routeImagem`.
- Os objetos entregues ao logger são comparados com listas permitidas exatas, de modo que adicionar qualquer metadado volta a falhar.
- O diff de produção contém somente as três substituições solicitadas.
- Nenhuma preocupação conhecida após as provas focadas, de segurança e completas.

## Fix round 2

### Causa

`routeImagem` abre `log.contexto({ phone }, ...)`. O logger real usa `AsyncLocalStorage` e combina o contexto com os campos locais somente dentro de `emitir()`, por meio de `{ ...ctx, ...primeiro }`. A regressão do Fix round 1 substituía `log.error` antes dessa combinação e, portanto, observava apenas `{ evt, code }`, embora a linha JSON real ainda recebesse `phone`.

### RED / GREEN

Runtime: `C:\Users\ferna\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.

RED:

- `node.exe test/catalogroutingtest.js` — falhou em `logger real remove telefone do registro de falha do comprovante` após o subprocesso observar a saída JSON efetiva do Pino.

GREEN:

- `node.exe test/catalogroutingtest.js` — passou, inclusive após o refactor do import de teste.
- `node.exe test/segurancetest.js` — passou.
- `node.exe test/run.js` — todas as 44 suítes passaram.

### Correção

- O catch de processamento permanece no mesmo ponto e com o mesmo comportamento público.
- Somente a chamada de erro roda em `log.contexto({}, ...)`, que mascara o contexto externo durante essa emissão e o restaura imediatamente depois.
- O log operacional `imagem recebida` continua no contexto normal e conserva `phone`, bytes e tipo para diagnóstico.
- O registro `processamento_falhou` contém somente os campos fixos locais, além dos campos padrão do Pino; não contém telefone, erro, mensagem externa, stack, payload, token, conteúdo ou dados do cliente.
- A resposta ao cliente continua exatamente em `error_generic`.

### Arquivos alterados

- `src/bot/router.js`
- `test/catalogroutingtest.js`
- `.superpowers/sdd/2026-09-02-catalogo-baileys-meta/task-4-report.md`

### Commit

- Commit separado planejado: `fix: isola contexto do log de falha de imagem`.
- O hash final é informado no retorno da correção, pois o conteúdo do próprio commit não pode auto-referenciar seu hash.

### Auto-revisão e preocupações

- A prova agora usa subprocesso, `LOG_FORMAT=json` e o logger real, seguindo o mesmo padrão de `test/logtest.js`.
- O teste verifica simultaneamente que o log operacional mantém `phone` e que somente o log de falha o remove.
- A linha de falha também é inspecionada contra erro bruto e dados externos, e a resposta pública é verificada literalmente.
- O diff de produção está limitado à emissão sanitizada dentro de contexto vazio.
- Nenhuma preocupação conhecida após as provas focadas, de segurança e completas.
