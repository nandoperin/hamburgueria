# Hamburgueria Bot 🤖🍔

Bot de atendimento pelo WhatsApp para hamburgueria, com **conversa humanizada pela Mistral** e pagamento via **Zelle** (estorno manual).

> ⚠️ **Status de desenvolvimento:** o projeto tem arquivos de estrutura e configuração
> prontos, mas **ainda precisa de `.env` real + PostgreSQL ligado** para rodar localmente.
> Veja [`.env.example`](.env.example).

## 📦 Como rodar localmente

```bash
git clone git@github.com:nandoperin/hamburgueria.git
cd hamburgueria
npm install

# Copia o template de ambiente
cp .env.example .env
# -> edita .env: coloca DATABASE_URL, AI_MODEL e MISTRAL_API_KEY
npm start
```

### `.env` mínimo

```ini
# PostgreSQL
DATABASE_URL=postgresql://postgres:senha@host:5432/railway

# WhatsApp (Baileys)
WHATSAPP_PROVIDER=baileys

# IA (modelo A: dono traz a própria chave)
AI_ENABLED=on
AI_MODEL=mistral-small-4
MISTRAL_API_KEY=***
VOXTRAL_MODEL=voxtral-mini-latest # áudio usa a mesma chave Mistral

# Teto de segurança
AI_MAX_USD_DIA=10
AI_MAX_TURNOS=40
AI_MAX_TOKENS_CONVERSA=120000
```

## 🤖 IA

O bot usa somente Mistral. O modelo padrão é `mistral-small-latest`.

## 💳 Pagamento (Zelle — estorno manual)

O projeto usa **Zelle** hoje. O estorno é feito pelo dono pelo app do banco —
o código **avisa** quando precisa acontecer, não faz sozinho.

O fluxo:
```
cliente → pede pelo WhatsApp → paga no Zelle → manda o print →
impressora printa na hora → cozinha entrega → cliente retira
                         ↘ dono confere o banco depois (!liberar / !recusar)
```

Em cash, a comanda sai quando o cliente confirma o pedido.

## 📄 Testes

```bash
npm test
```

## 📁 Estrutura

```
src/
├── ai/              # Conversa e integração Mistral
├── bot/             # WhatsApp + router + handlers (conversa)
├── services/        # Domínio: cardápio, pagamento, impressão, agenda
├── db/              # PostgreSQL: conexão, consultas e schema
├── api/             # HTTP (agente Android da impressora, webhooks)
└── index.js         # Boot do sistema
docs/                # Operação e decisões do projeto
```

## 🤝 Contribuir

1. Fork → branch (`feature/minha-coisinha`) → PR
2. Testes novos ou atualizados para mudanças de comportamento
3. `main` é protegida — tudo via PR (mesmo sendo você)
