-- ============================================================
-- Schema PostgreSQL (Supabase)
-- Rodar no SQL Editor do Supabase: supabase.com -> SQL Editor
-- ============================================================

-- Clientes (um registro por número de WhatsApp)
CREATE TABLE IF NOT EXISTS customers (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT UNIQUE NOT NULL,
  name       TEXT,
  email      TEXT,
  lang       TEXT NOT NULL DEFAULT 'pt',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pedidos
--
-- items_json carrega os modificadores por item:
--   { id, name, nomeCozinha, qty, price, removed[], added[], choices[] }
-- O preço gravado aqui é o que o código calculou de config/menu.json e
-- config/ingredientes.json — nunca o que a conversa produziu.
CREATE TABLE IF NOT EXISTS orders (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT REFERENCES customers(id),
  phone         TEXT NOT NULL,
  lang          TEXT NOT NULL DEFAULT 'pt',
  items_json    JSONB NOT NULL,
  order_type    TEXT NOT NULL DEFAULT 'delivery',
  customer_name TEXT,
  city          TEXT NOT NULL,
  address       TEXT NOT NULL,
  subtotal      NUMERIC(10,2) NOT NULL,
  delivery_fee  NUMERIC(10,2) NOT NULL,
  total         NUMERIC(10,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fluxo do status, e por que ele importa:
--
--   pending          pedido criado, instrucoes do Zelle enviadas
--   awaiting_review  comprovante chegou, esperando o dono conferir
--   paid             o dono liberou com !liberar  <- unico gatilho da impressao
--   printed          a comanda saiu no papel
--   delivered        entregue
--   rejected         o dono recusou o comprovante
--   cancelled        cancelado antes de pagar
--
-- getNextPrintableOrder() busca status='paid'. Como so o !liberar escreve
-- 'paid', o gate da impressora e um ponto so: comprovante nao confirmado nunca
-- vira comida na chapa. Ver docs/SEGURANCA.md.

-- Pagamentos (Zelle)
--
-- Zelle nao tem webhook nem API de estorno: nada externo confirma o pagamento,
-- e nada desfaz. Por isso a confirmacao e humana e fica registrada aqui — quem
-- liberou e quando.
CREATE TABLE IF NOT EXISTS payments (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT NOT NULL REFERENCES orders(id),
  method            TEXT NOT NULL DEFAULT 'zelle',
  amount            NUMERIC(10,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',

  -- Comprovante enviado pelo cliente. O caminho e gerado pelo servidor
  -- (comprovantes/{orderId}/{uuid}.{ext}); o nome que o cliente manda nunca
  -- vira caminho. Bucket privado, so a service role le.
  proof_path        TEXT,
  proof_received_at TIMESTAMPTZ,

  -- Quem liberou. E o registro que transforma "o pedido saiu" em "fulano
  -- mandou sair", e o telefone completo fica so aqui, nunca no papel.
  approved_by       TEXT,
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,

  paid_at           TIMESTAMPTZ
);

-- Estado do bot que precisa sobreviver a um deploy.
-- Hoje guarda `fechado_ate`: quando o dono encerra o atendimento mais cedo
-- pelo WhatsApp (!fechar), o instante da proxima abertura fica aqui.
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Itens esgotados. So as excecoes ficam aqui: item ausente esta disponivel.
-- Vale tambem para ingrediente (bacon acabou) — o id e o mesmo do
-- config/ingredientes.json.
CREATE TABLE IF NOT EXISTS item_availability (
  item_id    TEXT PRIMARY KEY,
  available  BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consumo da IA, por dia.
--
-- Em memoria nao serviria: o teto de gasto tem que sobreviver a um restart,
-- senao um deploy no meio de um ataque zera a conta e o teto nunca fecha.
CREATE TABLE IF NOT EXISTS ai_usage (
  dia        DATE PRIMARY KEY,
  chamadas   INT NOT NULL DEFAULT 0,
  tokens_in  BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  custo_usd  NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_email   ON customers(email);
CREATE INDEX IF NOT EXISTS idx_orders_phone      ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);

-- ============================================================
-- RLS
--
-- Ligada nas cinco tabelas, com ZERO politicas. Zero politica significa que a
-- chave anon nao le nada — que e o correto aqui, porque nenhum cliente acessa
-- o Supabase direto. So o servidor acessa, com a service role, que passa por
-- cima do RLS por desenho.
--
-- O aviso `rls_enabled_no_policy` do linter do Supabase e esperado nesta
-- arquitetura, e nao um problema a resolver.
-- ============================================================
ALTER TABLE customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage          ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Storage: bucket dos comprovantes
--
-- PRIVADO. A imagem traz nome e, muitas vezes, dados bancarios parciais do
-- cliente. Sem politica nenhuma, so a service role alcanca — o mesmo desenho
-- das tabelas acima.
--
-- Rodar uma vez:
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('comprovantes', 'comprovantes', false)
ON CONFLICT (id) DO NOTHING;
