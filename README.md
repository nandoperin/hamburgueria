# Hamburgueria Bot 🤖🍔

Bot de atendimento pelo WhatsApp para hamburgueria, com **conversa humanizada por IA** e pagamento via **Zelle** (estorno manual). Inspirado no projeto irmão `projeto atendimento`, porém independente: provider de IA é trocável (`claude` | `openai` | `mistral`).

> ⚠️ **Status de desenvolvimento:** o projeto tem arquivos de estrutura e configuração
> prontos, mas **ainda precisa de `.env` real + Supabase ligado** para rodar localmente.
> Veja [`.env.example`](.env.example) e [docs/CLAUDE-API.md](docs/CLAUDE-API.md).

## 📦 Como rodar localmente

```bash
git clone git@github.com:nandoperin/hamburgueria.git
cd hamburgueria
npm install

# Copia o template de ambiente
cp .env.example .env
# -> edita .env: coloca SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#    AI_PROVIDER, AI_MODEL, e a chave do provedor de IA
npm start
```

### `.env` mínimo (Modelo A — BYOK)
Cada dono de hamburgueria usa a **sua** conta na Anthropic/OpenAI/Mistral:

```ini
# Supabase (banco)
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=***

# WhatsApp (Baileys)
WHATSAPP_PROVIDER=baileys

# IA (modelo A: dono traz a própria chave)
AI_ENABLED=on
AI_PROVIDER=mistral          # claude | openai | mistral
AI_MODEL=mistral-small-4
MISTRAL_API_KEY=***          # ou ANTHROPIC_API_KEY / OPENAI_API_KEY

# Teto de segurança
AI_MAX_USD_DIA=25
AI_MAX_TURNOS=40
AI_MAX_TOKENS_CONVERSA=120000
```

## 🤖 Provedores de IA suportados

| Provider | Chave env | Modelo default | Custo ~100 pedidos/dia |
|---|---|---|---|
| `claude` (Haiku) | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | US$ 60–120/mês |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-4` | US$ 25–50/mês ✅ |
| `openai` | `OPENAI_API_KEY` | `gpt-5-mini` | US$ 50–100/mês |

> Trocar é **uma linha** (`AI_PROVIDER=`) + a chave correspondente. Veja
> [docs/CLAUDE-API.md](docs/CLAUDE-API.md) para passo a passo de cadastro.

## 💳 Pagamento (Zelle — estorno manual)

O projeto usa **Zelle** hoje. O estorno é feito pelo dono pelo app do banco —
o código **avisa** quando precisa acontecer, não faz sozinho. A abstração
`src/services/pagamento.js` existe para migrar pro Square futuro sem mexer em
`cancel.js`. Veja a skill `provider-swap-migration` pra detalhes da troca.

O fluxo:
```
cliente → pede pelo WhatsApp → confirma no Zelle → dono libera (!liberar) →
impressora printa → cozinha entrega → cliente retira
```

## 📄 Testes

```bash
npm test
```

> ⚠️ Ainda **9 de 15 suítes** falham — elas são testes copiados do projeto espetinho
> (com link do Square, combos e branding) e não foram adaptados ao domínio
> hambúrguer/Zelle. As 6 que passam incluem `segurancatest` (dupla-confirma de
> cancelamento) e `admintest`.

## 📁 Estrutura

```
src/
├── ai/              # Provedores de IA (provider.js dispatcher)
├── bot/             # WhatsApp + router + handlers (conversa)
├── services/        # Domínio: cardápio, pagamento, impressão, agenda
├── db/              # Supabase queries + schema
├── api/             # HTTP (CloudPRNT impressora, webhooks)
└── index.js         # Boot do sistema
docs/                # CLAUDE-API.md, CARDAPIO-CONVERSA.md, IDEIA.md
```

## 🤝 Contribuir

1. Fork → branch (`feature/minha-coisinha`) → PR
2. Testes novos ou atualizados para mudanças de comportamento
3. `main` é protegida — tudo via PR (mesmo sendo você)
