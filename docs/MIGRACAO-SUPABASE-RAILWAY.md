# Migração Supabase → Postgres do Railway

Registro do que foi feito em **22/08/2026**, escrito para ser repetido em outro
projeto com a mesma arquitetura. Não é um relato do dia: é um roteiro, com as
armadilhas que só aparecem quando você já está no meio.

---

## Por que migrar — e quando *não* migrar

A instância free do Supabase morreu por falta de memória. Os números do dia:

```
Memória total    408 MB
  Usada          204 MB (50%)
  Cache/Buffers  195 MB (48%)
  Livre          9,1 MB (2,2%)   ← praticamente nada
  Swap           240 MB (59%)    ← swap num banco de dados
```

A causa **não era carga**. Duas evidências:

1. A memória estava estourada com o PostgREST já morto e **zero requisições**
   chegando. Se fosse tráfego, teria aliviado quando tudo parou.
2. Os erros **subiram** quando o tráfego **caiu** 75% (904 → 192 req/h).

A causa era escopo: 512 MB segurando oito serviços — Postgres, PostgREST,
Realtime, Auth, Storage, Kong, postgres-meta e o pooler. Deste projeto só o
Postgres é usado. Nada de Auth (o admin é reconhecido pelo telefone), nada de
Realtime, Storage ou Edge Functions.

**Pagávamos a memória de um BaaS inteiro para usar 5% dele.**

### Quando não migrar

Se você usa Auth, Realtime, Storage ou Edge Functions do Supabase, esta
migração **não se aplica** — você perderia funcionalidade. Ela só faz sentido
para quem usa Supabase como "Postgres com uma biblioteca cliente".

Se o problema for volume de carga de verdade, migrar também não resolve: o
caminho é instância maior, não instância diferente.

### O sintoma, para reconhecer

PostgREST morto com Postgres vivo tem uma assinatura clara:

```
postgrest_logs:  "Warp server error: Thread killed by timeout manager"
                 centenas por hora, dias a fio, sem UMA linha normal
```

E o diagnóstico que confunde: a **API de gerenciamento continua respondendo**
(é outro caminho), então o painel pode dizer `ACTIVE_HEALTHY` enquanto nada
funciona. Confie no teste direto, não no status:

```bash
# gateway vivo? (401 rápido = sim, mas isso NÃO prova o PostgREST)
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
  https://SEU_REF.supabase.co/rest/v1/

# o teste que importa: requisição autenticada de verdade
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 20 \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "https://SEU_REF.supabase.co/rest/v1/orders?select=id&limit=1"
```

Gateway em 0,18s e requisição autenticada pendurando 20s = PostgREST morto.

---

## Ordem das etapas

A ordem importa. Fazer o backup **antes** de qualquer outra coisa é o que
protege você se a migração der errado no meio.

| # | Etapa | Reversível? |
|---|---|---|
| 1 | Backup dos dados enquanto ainda há como ler | — |
| 2 | Provisionar o Postgres novo, **com volume** | sim |
| 3 | Portar o código (`supabase-js` → `pg`) | sim, é branch |
| 4 | Carregar schema + dados | sim |
| 5 | Verificar contra o banco real | — |
| 6 | Apontar a aplicação e subir | sim, tag de retorno |

---

## 1. Backup, antes de tudo

**O plano free não tem backup automático.** Se a camada REST morreu, a única
via de leitura que resta é a API de gerenciamento (MCP do Supabase ou o SQL
Editor do painel) — e ela também pode parar.

Gere os `INSERT` com o próprio Postgres, que cuida do escape:

```sql
SELECT string_agg(linha, E'\n') FROM (
  SELECT 'INSERT INTO customers (id,phone,name,email,lang,created_at,updated_at) VALUES ('
    || id || ',' || quote_nullable(phone) || ',' || quote_nullable(name)
    || ',' || quote_nullable(email) || ',' || quote_nullable(lang)
    || ',' || quote_nullable(created_at) || ',' || quote_nullable(updated_at) || ');' AS linha
  FROM customers
) t;
```

`quote_nullable` resolve aspas, `NULL` e acento sozinho. Para colunas `jsonb`,
use `quote_nullable(coluna::text) || '::jsonb'`.

> **Guarde o arquivo fora do git.** Ele tem telefone, e-mail e id de pagamento
> de cliente real. Confirme com `git check-ignore -v caminho/do/arquivo.sql`
> antes de qualquer commit — e cuidado com `backup/` vs `backups/`, que é o
> tipo de diferença que passa despercebida.

---

## 2. Provisionar o Postgres — a armadilha do volume

**Criar o serviço a partir da imagem crua não funciona.** Falta o volume e
faltam todas as variáveis (`POSTGRES_USER`, `DATABASE_URL`, etc.). Sem volume,
**os dados somem a cada redeploy** — inaceitável quando há pagamento no banco.

Use o template (`+ New` → `Database` → `Add PostgreSQL`), que cria volume e
variáveis juntos. Confirme depois:

```
RAILWAY_VOLUME_ID
RAILWAY_VOLUME_MOUNT_PATH   ← /var/lib/postgresql/data
RAILWAY_VOLUME_NAME
```

Se essas três não aparecerem nas variáveis do serviço, **não prossiga**.

Remover serviço no Railway exige 2FA, que não passa por API — a remoção fica
pendente esperando um clique em `Deploy Changes` no painel.

---

## 3. O port do código

O que tornou isto viável em duas horas: **nada fora de `src/db/` conhecia o
driver.** Se no seu projeto os handlers chamam o cliente do banco direto, essa
faxina vem primeiro.

```bash
npm install pg
npm uninstall @supabase/supabase-js
```

### O que muda em `client.js`

```js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 8_000,   // ver "teto de tempo", abaixo
  query_timeout: 8_000,
  ssl: /\.railway\.internal|localhost/.test(url) ? false : { rejectUnauthorized: false },
});

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }
async function uma(sql, params = []) { return (await q(sql, params))[0] ?? null; }
```

Tradução direta do dialeto:

| Supabase | `pg` |
|---|---|
| `.select()` | `q(...)` → array |
| `.maybeSingle()` | `uma(...)` → objeto ou `null` |
| `.single()` | `uma(...)` + `RETURNING *` |
| `.upsert({...}, {onConflict:'x'})` | `INSERT ... ON CONFLICT (x) DO UPDATE` |
| `.eq('a', b)` | `WHERE a = $1` |
| `.in('s', [...])` | `WHERE s IN ('a','b')` |
| `.select('*, filhos(campo)')` | subquery com `json_agg` |

### ⚠️ A armadilha que quebraria o caminho do dinheiro

**PostgREST e `pg` devolvem os mesmos dados em tipos JavaScript diferentes.**
Se os handlers foram escritos contra o formato do PostgREST, isso vira bug
silencioso:

| Coluna | PostgREST devolvia | `pg` devolve | Onde quebra |
|---|---|---|---|
| `NUMERIC` | `number` | **string** | `total * 100` no estorno |
| `BIGINT` | `number` | **string** | comparação de id |
| `TIMESTAMPTZ` | string ISO | **`Date`** | `created_at.slice(0,10)` |

Alinhe os tipos uma vez, no cliente, e a troca fica invisível para o resto:

```js
const { types } = require('pg');

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // numeric
types.setTypeParser(20,   (v) => (v === null ? null : parseInt(v, 10))); // int8
const paraIso = (v) => (v === null ? null : new Date(v).toISOString());
types.setTypeParser(1184, paraIso); // timestamptz
types.setTypeParser(1114, paraIso); // timestamp
```

### O join aninhado

`.select('*, payments(paid_at, status)')` devolvia `payments` como array dentro
de cada linha. Para manter o mesmo formato:

```sql
SELECT o.*,
       COALESCE(
         (SELECT json_agg(json_build_object('paid_at', p.paid_at, 'status', p.status))
            FROM payments p WHERE p.order_id = o.id),
         '[]'::json
       ) AS payments
  FROM orders o
```

### O teto de tempo, que veio de uma cicatriz

A checagem de saúde não tinha limite de tempo na consulta ao banco. Quando o
banco travou, o endpoint pendurou 45 segundos e o monitor externo registrou
**"Connection Timeout"** — indistinguível de servidor morto. O diagnóstico
começou na direção errada por causa disso.

Com `statement_timeout`, banco fora do ar vira erro rápido e **nomeado**.

---

## 4. Carregar schema e dados

### Conexão sem expor o banco

`DATABASE_URL` aponta para `*.railway.internal`, que só resolve **dentro** do
Railway. Da sua máquina há duas opções, e uma é melhor:

| | Public Access (TCP proxy) | `railway connect --tunnel-only` |
|---|---|---|
| Expõe o banco | **sim** | não |
| Cobra egress | sim | não |
| Precisa de `psql` | não | não |

Prefira o túnel:

```bash
npm install -g @railway/cli
railway login
railway link                       # projeto → ambiente → serviço Postgres
railway connect NOME --tunnel-only --port 55432
```

Pré-requisito que a documentação não destaca: **o túnel exige chave SSH
registrada**.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
railway ssh keys add               # a auto-detecção funciona; passar -k com
                                   # caminho Windows pode falhar
```

Com o túnel aberto, deixe a CLI injetar as credenciais e monte a URL em código
— **a senha nunca é digitada nem exibida**:

```js
const user  = process.env.PGUSER;
const senha = process.env.PGPASSWORD;
const base  = process.env.PGDATABASE;
const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(senha)}@127.0.0.1:55432/${base}`;
```

```bash
DB_TUNNEL_PORT=55432 railway run node scripts/migrar-banco.js
```

### Numa transação, sempre

```js
await client.query('BEGIN');
try {
  await client.query(fs.readFileSync(DADOS, 'utf8'));
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

Banco meio carregado é pior que banco vazio: pedido referencia cliente.

### ⚠️ As sequências — o erro que só aparece no primeiro pedido novo

Inserir `id` explicitamente **não avança o contador**. Sem isto, o próximo
registro nasce com `id` 1 e colide com o que já existe. O sintoma chega como
erro genérico ao cliente, horas depois, sem ninguém ligar as pontas.

```sql
SELECT setval('customers_id_seq', (SELECT COALESCE(MAX(id),1) FROM customers));
SELECT setval('orders_id_seq',    (SELECT COALESCE(MAX(id),1) FROM orders));
SELECT setval('payments_id_seq',  (SELECT COALESCE(MAX(id),1) FROM payments));
```

---

## 5. Verificação — e por que a suíte de testes não serve

**As suítes substituem a camada de banco por uma falsa.** Elas passam idênticas
com o SQL certo ou errado. Descobrir isso é o ponto mais importante deste
documento: *o port inteiro estaria coberto por zero testes.*

Escreva um script separado que roda contra o banco **real** e confere os
**tipos**, não só os valores:

```js
ok(typeof pedido.id === 'number',    `id e number (veio ${typeof pedido.id})`);
ok(typeof pedido.total === 'number', `total e number (veio ${typeof pedido.total})`);
ok(typeof pedido.created_at === 'string', 'created_at e string ISO');
ok(/^\d{4}-\d{2}-\d{2}T/.test(pedido.created_at), 'no formato que slice(0,10) espera');
```

Cubra o ciclo completo — criar cliente, pedido, pagamento, marcar pago, achar
imprimível, estornar — e **limpe o que criou no fim**, inclusive se falhar no
meio (`.then(limpar)` antes do `.finally`).

> **Cuidado com asserção que assume banco vazio.** Uma verificação falhou porque
> esperava que o pedido de teste fosse o primeiro da fila — mas havia pedidos
> reais mais antigos. O código estava certo; o teste é que assumia demais.
> Teste o **contrato** ("devolve o mais antigo"), não a coincidência.

---

## 6. Apontar a aplicação

```
DATABASE_URL = ${{NomeDoServicoPostgres.DATABASE_URL}}
```

A sintaxe de referência é o que mantém o tráfego na rede privada e evita copiar
segredo. Confirme depois que o egress fica em `0 GB`.

Marque o ponto de retorno **antes** de subir:

```bash
git tag -a estavel-AAAA-MM-DD -m "estado validado em producao"
git push origin estavel-AAAA-MM-DD
```

Atualize também a validação de variáveis obrigatórias no boot — trocar
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` por `DATABASE_URL` — e os `process.env`
no topo de cada suíte de teste.

---

## Resultado medido

Depois de migrar, 6 horas de métricas (361 amostras):

| | Antes (Supabase Nano) | Depois (Railway) |
|---|---|---|
| Memória livre | **2,2%** | 45 MB de 48 GB |
| Swap | 240 MB | nenhum |
| CPU | throttle | 0,0005 vCPU |
| Egress bot↔banco | internet pública | **0 GB** (rede privada) |

---

## Melhorias que a migração revelou

Não são parte da migração, mas apareceram durante ela e valem para qualquer
projeto com a mesma forma.

### Reconciliação de pagamento

**Se só o webhook marca um pedido como pago, você tem um ponto único de falha
silencioso.** Webhook perdido = pedido em `pending` para sempre, e o vigia de
comanda atrasada não vê, porque ele só olha pedidos `paid`. Um `pending` órfão
não é "atrasado": é invisível. O cliente paga, o dinheiro sai, e nada acusa.

A defesa é conferir ativamente:

- A cada 5 minutos, pedidos `pending` entre 10 min e 48 h
- Consulta o provedor pelo id gravado na criação do link
- Achou pago: **alimenta o mesmo caminho do webhook**, não uma segunda
  implementação — é lá que mora o estorno de pedido cancelado e o aviso ao
  cliente, e a versão que roda menos é a que ninguém notaria quebrada
- Avisa o dono, porque webhook perdido é sintoma que merece atenção

Sobre volume: o Square devolve `429 RATE_LIMITED` — temporário e reversível,
não bloqueio de conta — e **não publica o limite**, que é dinâmico por endpoint.
Então a defesa não é calcular quanto cabe: é faixa de idade dos dois lados, teto
por rodada, e `429` interrompendo em vez de insistir. Num dia normal, zero
consultas.

### Janela de operação

Consulta de fundo ao banco só de 1h antes de abrir até 1h depois de fechar.

**A margem é o que impede o erro óbvio:** cortar no horário exato de fechamento
perderia o pedido pago dois minutos antes.

E calcule a janela testando três instantes (`agora`, `+1h`, `−1h`) contra a
função de horário que você já tem testada, em vez de reimplementar aritmética
de hora com margem — é onde erro de fuso se esconde.

Duas regras que valem repetir:

- **A fila em memória nunca é bloqueada por horário.** Reimpressão e avisos o
  dono dispara quando precisa.
- **Falha no cálculo assume janela ativa.** O caso não previsto cai do lado
  seguro, e aqui o lado seguro é imprimir a comanda.

---

## Armadilhas do ambiente (Windows + Git Bash)

- `npm test` e `railway run` falham com `'node' is not recognized` porque o
  `cmd.exe` não tem o node no PATH. Resolva com
  `export PATH="/c/caminho/do/node:$PATH"` antes do comando.
- O postinstall do `@railway/cli` é bloqueado por política de scripts e o
  binário não baixa. Rode-o manualmente com o PATH corrigido.
- `date` no Git Bash já mostra o fuso **local**, não UTC. Converter de novo dá
  erro de horas — o que aconteceu neste dia mais de uma vez.

---

## Checklist

```
[ ] Backup dos dados, fora do git (git check-ignore para confirmar)
[ ] Postgres criado pelo TEMPLATE, com RAILWAY_VOLUME_* presentes
[ ] npm install pg && npm uninstall @supabase/supabase-js
[ ] client.js com pool + setTypeParser (numeric, int8, timestamptz)
[ ] queries.js traduzido, mesma assinatura pública
[ ] Variáveis obrigatórias do boot atualizadas
[ ] process.env no topo de cada suíte de teste atualizado
[ ] Chave SSH gerada e registrada (railway ssh keys add)
[ ] Schema + dados carregados EM TRANSAÇÃO
[ ] setval nas sequências
[ ] Script de verificação contra o banco real, conferindo TIPOS
[ ] Tag de retorno criada e no remoto
[ ] DATABASE_URL por referência ${{Servico.DATABASE_URL}}
[ ] Deploy e /health confirmando ok
[ ] Backup automático configurado  ← o Railway nao faz; ver secao final
```

---

## A lacuna que a migração abriu — e como foi fechada

**Backup automático.** O Supabase dava backup diário incluído; o plano Hobby do
Railway **não dá**. Trocar de banco sem resolver isso é sair de um lugar com
rede para um sem, e não perceber.

Ficou pendente por uma semana e foi fechado em 29/08/2026 por
[`src/services/backup.js`](../src/services/backup.js): dump diário às 3h para o
**Cloudflare R2**. Dois detalhes do desenho valem copiar junto:

- **A marca do último backup vai para o banco (`bot_settings`), não para a
  memória.** Um `setInterval` de 24h é zerado a cada deploy — bastaria fazer
  deploy sempre no mesmo horário para o backup nunca disparar, e nada no log
  denunciaria.
- **Falhar dois dias seguidos avisa o dono no WhatsApp.** Backup que para em
  silêncio é como se descobre, tarde demais, que não havia backup.

Se você está repetindo esta migração: **isto é parte dela, não um extra.**

---

## Para reusar noutro projeto

Este documento carrega a parte que não se deduz — os `setTypeParser`, a tabela
de tradução do dialeto, o `json_agg`, a ordem das etapas. Mas três scripts fazem
o trabalho e não cabem aqui dentro:

| Arquivo | Linhas | Por que levar |
|---|---|---|
| [`scripts/conexao.js`](../scripts/conexao.js) | 61 | Resolve os três caminhos até o banco (túnel, proxy público, rede privada), nessa ordem. **Genérico** — copia e usa sem tocar |
| [`scripts/verificar-banco.js`](../scripts/verificar-banco.js) | 241 | Confere **tipos** contra o banco real. É a peça que a seção 5 chama de indispensável; a suíte de testes passa igual com o SQL errado. Específico do projeto: adapte às suas tabelas |
| [`scripts/migrar-banco.js`](../scripts/migrar-banco.js) | 113 | Carrega schema e dados em transação, com `setval` nas sequências |

E `src/services/backup.js`, pela razão acima — não é parte da migração, é a
consequência dela.

O `src/db/client.js` **não precisa ser copiado**: o que ele tem de essencial
(pool, timeouts, os quatro `setTypeParser`) está inline na seção 3. O resto é
específico das colunas deste projeto.
