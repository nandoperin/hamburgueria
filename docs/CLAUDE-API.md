# Conectar a API do Claude — Passo a Passo

> Para **clientes do Modelo A (BYOK)**: cada dono de hamburgueria habilita a IA
> com a própria chave e créditos. O passo-a-passo abaixo é o roteiro de treinamento
> — **você faz de teste primeiro**, depois passa ao cliente.

## Configuração inicial (faça uma vez de teste)

1. Acesse [console.anthropic.com](https://console.anthropic.com)
2. **Create account** com um email profissional (evite Gmail pessoal). Use o
   e-mail que será **transferido** ao cliente no fim.
3. **Billing → Add payment method**: cartão de crédito em nome de quem
   detém a conta (hoje você; no treinamento, o cliente).
4. **Billing → Add credits**: compre créditos para teste. Mínimo ~US$5. ✅
   _(Você não precisa recarregar muito: o Haiku gasta uns US$2–4 por 100 pedidos.)_
5. **API Keys → Create key**: copie a chave (`sk-ant-...`). ✅
6. No projeto hamburgueria, cole no `.env`:
   ```
   ANTHROPIC_API_KEY=***
   ```
7. Ainda no `.env`, ajuste para usar o Haiku (mais barato) e mantenha o teto de segurança:
   ```
   AI_MODEL=claude-haiku-4-5
   AI_ENABLED=on
   AI_MAX_USD_DIA=25            # estourou o teto? cai no fluxo numerado
   AI_MAX_TURNOS=40             # 40 turnos por sessão de conversa
   AI_MAX_TOKENS_CONVERSA=120000 # 120k tokens acumulados por sessão
   ```
8. Reinicie o bot. Envie uma mensagem teste (ex.: "oi") e veja se responde
   humanizado. ✅

> ⚠️ **Importante:** o `ANTHROPIC_API_KEY` vive em `.env`, que **não entra no
> git** (já está no `.gitignore`). Cliente que puxa o projeto do repositório não
> vê a sua chave — cola a dele no `.env` que baixa.

## Alternativa: Mistral Small 4 (mais em conta)

Se o gasto no Claude apertar, troque **uma linha** — o projeto já suporta
Mistral (`AI_PROVIDER=mistral`), e ele entende português de verdade.

### Cadastro (faça de teste primeiro, repita para o cliente)

1. Acesse [mistral.ai/build](https://mistral.ai/build)
2. Clique em **"Get started for free"** — cadastra com Google, GitHub ou email
3. No console, **API Keys → Create new key** → nomeie (ex: "Hamburgueria") →
   **copia a chave** ✅ (é um `sk-...` longo; some se não copiar agora)
4. Coloque no `.env`:
   ```
   AI_PROVIDER=mistral
   AI_MODEL=mistral-small-4
   MISTRAL_API_KEY=***
   ```
5. Reinicia o bot. ✅

| Modelo Mistral | Quando usar |
|---|---|
| `mistral-small-4` | ✅ Padrão — QA boa, US$25-50/mês pra 100 pedidos/dia |
| `ministral-3b-latest` | Orçamento cheio — mais barata (US$20-40), QA de borda |

## Passo a passo para treinar o cliente

### Fase 1 — O cliente habilita a chave própria

1. Cliente abre [console.anthropic.com](https://console.anthropic.com) e cria
   conta com **seu próprio email**.
2. Cliente coloca **seu cartão** (Billing → Add payment method).
3. Cliente compra créditos (Billing → Add credits). Recomendado: **US$20** para
   começar (dura uns 500–1.000 pedidos de hamburgueria no Haiku).
4. Cliente gera a chave: **API Keys → Create key** → copia. ✅
5. Cliente pega a chave e cola no `.env` do bot:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
6. Cliente edita mais duas linhas no `.env`:
   ```
   AI_MODEL=claude-haiku-4-5
   AI_ENABLED=on
   ```
7. Reinicia o bot. ✅

### Fase 2 — Controle de gasto (o que o cliente precisa saber)

- **Teto diário**: `AI_MAX_USD_DIA=25`. O bot mede o gasto diário em conta da
  Anthropic; se ultrapassar o teto, **cai automaticamente no fluxo numerado**
  (menu de números) sem gastar mais um centavo. Recomendado deixar como está.
- **Consultar saldo**: cliente vê em tempo real no próprio
  [console.anthropic.com → Billing](https://console.anthropic.com/settings/billing).
- **Auto-reload (opcional)**: se o cliente roda o bot em horário comercial sem
  parar, ele pode ligar auto-reload na tela de Billing — recarrega sozinho
  quando o saldo cai de um limiar.

## Modelos disponíveis (referência rápida)

| Modelo | ID na API | Entrada | Saída | Cache (leitura) | Quando usar |
|---|---|---|---|---|---|
| **Haiku 4.5** | `claude-haiku-4-5` | $1/M tokens | $5/M | $0,10/M | ✅ Padrão — atendimento de hamburgueria |
| Sonnet 5 | `claude-sonnet-5` | $2/M | $10/M | $0,20/M | Conversas mais complexas / migração futura |
| Opus 5 | `claude-opus-5` | $5/M | $25/M | — | Não use para atendimento — caro e lento |

> Mudar de modelo é **uma linha no `.env`** (`AI_MODEL=...`) + restart. Nenhum
> deploy de código.

## Estimativa de consumo

- **Haiku**: ~US$ 0,02–0,04 por pedido (com prompt caching do cardápio)
- **100 pedidos/dia** ≈ **US$ 60–120/mês**
- **Sonnet** (caso precise subir): ~US$ 0,04–0,08 por pedido → US$ 120–240/mês

## Segurança

- A chave é um **segredo** — trate como senha.
- O `.env` não entra no git (confirme com `git status` antes de commitar).
- `AI_MAX_USD_DIA` protege contra loops infinitos (cliente manda foto 50x → teto
  cai o bot no fluxo numerado antes que a fatura suba).
- Cliente pode **revogar a chave** a qualquer momento em
  `API Keys → ... → Revoke`, e gerar outra.
