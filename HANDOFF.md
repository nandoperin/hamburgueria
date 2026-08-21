# 🍔 Point Burger — Handoff para continuar o projeto

> Documento de transferência. Leia isto inteiro antes de mexer em qualquer coisa.
> Última atualização: 21/08/2026

---

## 1. O que é o projeto

Bot de WhatsApp para a hamburgueria **Point Burger** (Estados Unidos, preços em US$).
Atende clientes por conversa natural via IA, monta o pedido, e fecha com pagamento
via **Zelle** (cliente manda comprovante, dono libera com `!liberar <id>`).

- **Stack:** Node.js 22, Baileys (WhatsApp), Supabase (banco), Mistral (IA)
- **Repo:** `github.com/nandoperin/hamburgueria` (branch `main`)
- **Pasta local:** `C:\Users\ferna\Downloads\projeto hamburgueria`
- **Base:** adaptado de um projeto irmão de "espetinho"
  (`C:\Users\ferna\Downloads\projeto atendimento`)

---

## 2. Ambiente (Windows / PowerShell)

Node instalado via Hermes, **não está no PATH**. Sempre rodar antes de `npm`:

```powershell
cd "C:\Users\ferna\Downloads\projeto hamburgueria"
$env:Path = "C:\Users\ferna\AppData\Local\hermes\node;$env:Path"
```

⚠️ **Armadilha conhecida:** o `dotenv` NÃO sobrescreve variáveis que já existem na
sessão do PowerShell. Se você setou `$env:AI_PROVIDER` manualmente, ele "vence" o
`.env`. **Solução:** abra um PowerShell novo, ou rode
`Remove-Item env:AI_PROVIDER, env:AI_MODEL, env:AI_ENABLED -EA SilentlyContinue`.

---

## 3. ⚠️ CORREÇÃO da versão anterior deste documento

A versão anterior dizia, no item 9: *"Se o pagamento Zelle aparecer corretamente
pro cliente → projeto pronto pra operar"*. **Isso estava errado**, e vale entender
por quê antes de confiar em qualquer outra afirmação daqui.

Mostrar as instruções do Zelle é o **começo** do fluxo de pagamento, não o fim. O
que existia era:

```
cliente confirma → recebe instruções do Zelle → manda o comprovante → NADA
```

Três elos faltavam, e nenhum aparecia como erro:

| Elo | Estado |
|---|---|
| Baileys receber a imagem | `bot/index.js` descartava toda mensagem sem texto |
| Guardar e avisar o dono | `comprovante.js` existia, **ninguém chamava** |
| Liberar para a cozinha | `!liberar` não existia; `db.approvePayment` **nunca era chamado** |

Como `db.getNextPrintableOrder()` busca `status = 'paid'` e **nada no código
escrevia `paid`**, a impressora nunca receberia comanda nenhuma. O sintoma seria
o pior tipo: tudo parece funcionar até a hora em que a comida deveria sair.

**Isso foi corrigido.** A cadeia inteira está fechada e coberta por teste
(`test/zelletest.js`).

---

## 4. ✅ O que está pronto e testado

### Conversa por IA
| Arquivo | Papel |
|---|---|
| `src/ai/agente.js` | Laço da conversa: system prompt (com cardápio), histórico, tool loop |
| `src/ai/tools.js` | `adicionar_item`, `remover_item`, `ver_carrinho`, `finalizar_pedido` |
| `src/ai/mistral.js` | Cliente Mistral |
| `src/ai/provider.js` | Roteia `claude \| openai \| mistral` por `AI_PROVIDER` |

`router.js` deixa a IA conduzir em MENU/ORDER; se ela falhar, cai no fluxo
numerado. **Fallback automático.**

### Pagamento por Zelle — cadeia completa
```
cliente confirma
  → order.js cria pedido `pending` + manda instruções (zelle.instrucoes)
  → cliente manda o print
  → bot/index.js#receberImagem   (teto de tamanho ANTES do download)
  → router.routeImagem           (vazão + horário)
  → comprovante.receber          (4 checagens, ver abaixo)
      → Storage privado + status `awaiting_review`
      → encaminha a IMAGEM ao ADMIN_PHONE com !liberar pronto
  → dono: !liberar 42            → status `paid`  ← ÚNICO caminho
  → CloudPRNT acha `paid`        → comanda no papel
```

**Comandos novos do dono:** `!conferir` (fila de comprovantes), `!liberar <id>`,
`!recusar <id> <motivo>`.

### Segurança da porta de upload (`comprovante.js`)
| Checagem | Sem ela |
|---|---|
| Existe pedido esperando? | qualquer número manda foto a qualquer hora |
| Tipo real pelos magic bytes | sobe-se o que quiser com nome de imagem |
| Teto de tamanho (2×: antes e depois do download) | o cliente escolhe quanta banda o servidor gasta |
| Caminho gerado pelo servidor | nome de fora vira caminho, e caminho vira `../` |

### Testes: **17 de 17 passam**
```powershell
npm test
```
`run.js` **força `AI_ENABLED=off`** — antes ele herdava do ambiente, e rodar a
suíte com a IA ligada fazia chamada paga ao Mistral (num CI, em laço).

Suítes novas: `zelletest` (o gate), `comprovantetest` (a porta de upload).

---

## 5. 🔴 O que FALTA — sem isto nenhum pedido fecha

### Configurar o Zelle em `config/pagamento.json`
```json
"zelle": {
  "nome": "PREENCHER: nome que aparece no Zelle",
  "email": "PREENCHER: email cadastrado no Zelle"
}
```
O boot avisa `ZELLE NAO CONFIGURADO` e `order.js` **recusa fechar pedido**
enquanto estiver assim — de propósito, para nunca mandar um cliente transferir
dinheiro para "PREENCHER: nome".
⚠️ **Confira 2×:** nome/email errados = dinheiro do cliente indo para outra pessoa.

### 🟡 Configuração de negócio ainda pendente
- **`config/schedule.json` está com `always_open: true`** — o bot aceita pedido
  às 4 da manhã. Trocar para `false` quando for operar (os campos `open_hour: 17`,
  `close_hour: 24`, `closed_days: [1]` já descrevem Ter–Dom 17h–meia-noite).
- **`BASE_URL`** no `.env` ainda é `https://seu-dominio.com`. A impressora
  precisa alcançá-la pela internet.
- **`config/delivery.json`** — Everett $5, Chelsea/Malden/Medford $7. Confirmar
  os valores.
- **`config/menu.json` e `config/ingredientes.json`** — cardápio e preços foram
  escritos como ponto de partida, **não vieram do dono**. Conferir item a item.
  São dois JSON; trocar tudo não encosta em código.
- **`config/pagamento.json` → `pickup.address`** em `delivery.json` também está
  com `PREENCHER`.

---

## 6. 🕳️ Lacuna conhecida: personalização só existe com IA ligada

`services/modifiers.js` (remover grátis / acrescentar com acréscimo) é chamado
**só** por `ai/tools.js` e pela página `/cardapio`. Não existe handler
determinístico de ingredientes.

**Consequência:** com `AI_ENABLED=off`, o cliente pede o sanduíche mas **não
consegue tirar a cebola**. O fluxo numerado monta o pedido padrão e segue.

Não é falha — é degradação, e o fallback é modo de emergência. Mas quem for
decidir se isso basta precisa saber. Construir o caminho determinístico seria um
handler novo com estados `CUSTOM_ASK → CUSTOM_REMOVE → CUSTOM_ADD`.

**Código morto relacionado:** os estados `CHOOSING_OPTIONS` e `CATALOG_OPTIONS`
no `router.js` e `menu.handleOption` vieram dos combos do espetinho. Nenhum item
do `menu.json` tem `options.picks`, então nada os alcança.

---

## 7. Correções de conteúdo feitas nesta rodada

Coisas que estavam sendo servidas a cliente e estavam erradas:

- **`config/faq.json` era o FAQ do espetinho.** Dizia que o pagamento era por
  *link do Square com Visa/Mastercard/Apple Pay*; que não havia opção vegana
  (o cardápio tem duas); e afirmava não usar *"nenhum ingrediente com glúten"* —
  numa casa de pão e macarrão. Reescrito, com a resposta de glúten dizendo o que
  contém e **sem prometer ausência de contato cruzado**.
- **`{cities}` e `{hours}` agora são gerados** de `delivery.json` e
  `schedule.json` na hora de responder. O projeto irmão já teve o bug de
  prometer Chelsea a $6 cobrando $7 — duas fontes para o mesmo número sempre
  divergem.
- **`FOOD_TRUCK_NAME` foi eliminado do código.** `menu.js` e `welcome.js` liam
  essa variável com fallback `'Passarela Espetinho'` — apagar a variável do
  `.env` faria a Point Burger cumprimentar cliente com o nome do projeto irmão.
  Tudo usa `BUSINESS_NAME` agora; dá para remover `FOOD_TRUCK_NAME` do `.env`.
- **Relatórios não descontam mais "Taxas Square (~3.3%)"** — Zelle não tem
  percentual por transação, e o número saía errado num relatório usado para
  decidir preço.
- **FAQ agora responde em `ORDER_TYPE` e `DELIVERY_CITY`.** Com a entrega ligada
  essas telas estão no caminho de todo mundo, e quem perguntasse "tem opção
  vegana?" ali recebia "opção inválida".

---

## 8. ❌ Descartado (não retomar)

- **OpenRouter / `ring-2.6-1:free`** — testado, o usuário decidiu não usar.
  `src/ai/openrouter.js` foi deletado. **Não reintroduzir sem pedido explícito.**
- **Catálogo do WhatsApp / Meta Commerce** — o cardápio é conversa + imagem +
  link. `catalog.js`/`catalogcheck.js` continuam no repo mas fora do caminho.
- Modelo escolhido: **Mistral `mistral-small-latest`**.

---

## 9. Como subir

```powershell
cd "C:\Users\ferna\Downloads\projeto hamburgueria"
$env:Path = "C:\Users\ferna\AppData\Local\hermes\node;$env:Path"
npm start
```
- Boot deve mostrar `"ia":"mistral/mistral-small-latest"`.
- Primeira vez gera QR — escanear no WhatsApp do número da Point Burger.
- Sessão em `auth_info_baileys/`. **É credencial:** quem a copia fala como a
  hamburgueria. No Railway, precisa de **Volume montado** nesse diretório, senão
  todo deploy derruba a sessão e pede QR novo (e o QR sai nos logs do deploy).

---

## 10. Próximo passo imediato

1. **Preencher o Zelle** em `config/pagamento.json` (nome + email reais).
2. **Conferir o cardápio e os preços** em `config/menu.json` e
   `config/ingredientes.json` — hoje são um ponto de partida, não os seus.
3. **`always_open: false`** em `config/schedule.json` quando for operar.
4. Subir e testar uma conversa real ponta a ponta, **incluindo mandar um print e
   dar `!liberar`** — é o trecho que nunca rodou contra WhatsApp de verdade.
