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
- **Base:** foi adaptado de um projeto irmão de "espetinho" (por isso 9 testes falham — ver seção 6)

---

## 2. Ambiente (Windows / PowerShell)

Node instalado via Hermes, **não está no PATH**. Sempre rodar antes de `npm`:

```powershell
cd "C:\Users\ferna\Downloads\projeto hamburgueria"
$env:Path = "C:\Users\ferna\AppData\Local\hermes\node;$env:Path"
```

⚠️ **Armadilha conhecida (JÁ RESOLVIDA, mas cuidado):** o `dotenv` NÃO sobrescreve
variáveis que já existem na sessão do PowerShell. Se você setou `$env:AI_PROVIDER`
manualmente numa sessão, ele "vence" o `.env`. **Solução:** abra um PowerShell novo,
ou rode `Remove-Item env:AI_PROVIDER, env:AI_MODEL, env:AI_ENABLED -EA SilentlyContinue`.

---

## 3. ✅ O que JÁ ESTÁ PRONTO E TESTADO

### Agente de IA conversacional (funciona ponta a ponta)
| Arquivo | Papel |
|---|---|
| `src/ai/agente.js` | Laço da conversa: system prompt (com cardápio), histórico por telefone, tool loop, `saudar()` + `conversar()` |
| `src/ai/tools.js` | 4 ferramentas: `adicionar_item`, `remover_item`, `ver_carrinho`, `finalizar_pedido` — todas passam pelos services existentes (`cardapio`, `modifiers`, `order`) |
| `src/ai/mistral.js` | Cliente Mistral. Import correto `{ Mistral }`, suporta histórico de tool calls (role `tool`), parse robusto de `content` (string OU array) |
| `src/ai/provider.js` | Roteia `claude \| openai \| mistral` por `AI_PROVIDER`. Default mistral = `mistral-small-latest` |

### Integração
- `src/bot/router.js` — quando `ia.habilitada()` e estado ∈ {MENU, ORDER}, a IA conduz.
  Se a IA falhar (erro/cota/fora do ar), `conversar()` devolve `false` e cai no fluxo
  numerado antigo. **Fallback automático.**
- `src/bot/handlers/welcome.js` — após escolha de idioma, IA dá as boas-vindas (`agente.saudar`)
  e estado vira `MENU`.

### Configuração
- `.env`: `BUSINESS_NAME=Point Burger`, `FOOD_TRUCK_NAME=Point Burger`,
  `AI_PROVIDER=mistral`, `AI_MODEL=mistral-small-latest`, `AI_ENABLED=on`
- Chaves já preenchidas no `.env`: `MISTRAL_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (dummy só pra passar no boot)

### Teste ponta a ponta que PASSOU
```
IA> "Oi! 🍔 Bem-vindo à Point Burger!" (apresenta 4 categorias)
Usuário> "um x-tudo e uma batata frita"
IA> monta carrinho, subtotal $22.00
Usuário> "pode fechar"
IA> chama finalizar_pedido → entrega ao checkout → "Entrega ou Retirada?"
    (estado vira ORDER_TYPE, máquina de estados assume: endereço→nome→Zelle)
```
Carrinho sai no shape correto da comanda: `{ id, name, nomeCozinha, choicesCozinha, qty, price }`
com modificadores `choicesCozinha: ["- sem cebola"]`.

### Como rodar o teste isolado da IA (sem WhatsApp)
```powershell
node -e "
require('dotenv').config();
(async () => {
  const agente = require('./src/ai/agente');
  const session = require('./src/bot/session');
  const sess = session.get('5511999999999');
  sess.lang = 'pt'; sess.state = 'MENU';
  const send = async (t) => console.log('BOT>', t, '\n');
  await agente.saudar(sess, send);
  await agente.conversar(sess, 'quero um x-bacon sem cebola', send);
  console.log(JSON.stringify(sess.cart, null, 2));
  process.exit(0);
})();
"
```

---

## 4. 🚧 O QUE FALTA FAZER (prioridade)

### 🔴 CRÍTICO — sem isto nenhum pedido fecha
**Configurar Zelle** em `config/pagamento.json`:
```json
"zelle": {
  "nome": "PREENCHER: nome que aparece no Zelle",
  "email": "PREENCHER: email cadastrado no Zelle",
  "telefone": ""
}
```
O boot avisa `ZELLE NAO CONFIGURADO — nenhum pedido sera fechado` enquanto estiver com
os placeholders. Precisa do **nome e email reais** da conta Zelle da Point Burger.
⚠️ Confira 2x: nome/email errados = dinheiro do cliente indo pra outra pessoa.

### 🟡 IMPORTANTE — configuração de negócio ainda com placeholder
- `BASE_URL=https://seu-dominio.com` no `.env` — ainda é placeholder. Usado pela comanda
  (impressão via CloudPRNT) e pelo link público. Trocar pelo domínio real quando tiver.
- Verificar `config/schedule.json` (horário de funcionamento) — durante os testes estava
  bloqueando com "estabelecimento fechado"; conferir se os horários batem com a operação real.
- Verificar `config/delivery.json` (cidades de entrega + taxas) — herdado do projeto irmão,
  confirmar se as cidades/taxas são as da Point Burger.

### 🟢 DESEJÁVEL — validação real
- [ ] Testar conversa REAL pelo WhatsApp (não só o teste isolado): mandar "oi", pedir,
      finalizar, e ir até o pagamento Zelle de verdade.
- [ ] Testar o fallback: com `AI_ENABLED=off`, confirmar que o fluxo numerado ainda funciona.
- [ ] Ajustar tom/prompt do agente se necessário (system prompt está em `src/ai/agente.js`,
      função `systemPrompt()`).

---

## 5. ❌ O que foi DESCARTADO (não retomar)

- **OpenRouter / modelo `ring-2.6-1:free`** — foi tentado, o usuário decidiu NÃO usar.
  Arquivo `src/ai/openrouter.js` foi **deletado** e `provider.js` revertido. Não existe
  mais referência a openrouter no código. **Não reintroduzir sem pedido explícito.**
- Decisão final de modelo: **Mistral `mistral-small-latest`** (barato, testado, funciona).

---

## 6. Testes (contexto importante)

`AI_ENABLED=off npm test` → **6 passam, 9 falham**. Os 9 que falham
(`carrinhotest`, `enxutotest`, `faqtest`, `fluxotest`, `funiltest`, `idiomatest`,
`logtest`, `robusteztest`, `impressaotest`) são **do projeto espetinho original** —
testam link de pagamento Square, "espeto de frango", header "Passarela Espetinho", etc.,
que NÃO existem na Point Burger. **É esperado que falhem** — fora de escopo.
Adaptar esses fixtures pro domínio burger é trabalho futuro opcional, não bug.

Os que passam (`admintest`, `botoestest`, `fecharttest`, `filatest`, + 2) cobrem o núcleo.

---

## 7. Como subir o bot (produção local)

```powershell
cd "C:\Users\ferna\Downloads\projeto hamburgueria"
$env:Path = "C:\Users\ferna\AppData\Local\hermes\node;$env:Path"
npm start
```
- Boot deve mostrar: `"ia":"mistral/mistral-small-latest"` (se mostrar `claude/...`,
  é variável fantasma na sessão — ver seção 2).
- Primeira vez gera QR code — escanear no WhatsApp do número da Point Burger.
- Sessão salva em `auth_info_baileys.json` (não pede QR de novo). Pra forçar novo QR:
  `Remove-Item auth_info_baileys.json -Force`.

---

## 8. Arquitetura em uma frase

> **A IA conduz a conversa e monta o carrinho; o código cuida do dinheiro.**
> A IA nunca calcula preço nem toca em pagamento/endereço — ela só chama
> `finalizar_pedido`, que entrega o carrinho pronto para a máquina de estados
> existente (`order.js`), que faz entrega/retirada → endereço → nome → Zelle.

---

## 9. Próximo passo imediato sugerido

1. Preencher o Zelle em `config/pagamento.json` (nome + email reais).
2. Subir o bot (`npm start`) e testar uma conversa real pelo WhatsApp até o fim.
3. Se o pagamento Zelle aparecer corretamente pro cliente → **projeto pronto pra operar**.
