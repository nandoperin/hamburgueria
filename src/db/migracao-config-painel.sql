-- ============================================================
-- Migração: configuração editável pelo dono (painel)
--
-- Rodar UMA VEZ no SQL Editor do Supabase do projeto da HAMBURGUERIA.
--
-- ⚠️ CONFIRA O PROJETO ANTES DE RODAR.
--    Existe um projeto irmão ("Espetinho") com tabelas de mesmo nome. Este
--    script em si é aditivo e não quebraria nada lá — mas o `schema.sql` deste
--    repositório NÃO é: ele troca as colunas do Square por colunas de Zelle na
--    tabela `payments`. Rodar aquele no banco do Espetinho derruba o bot que
--    está em produção.
--
--    Confira que a URL do SQL Editor bate com o SUPABASE_URL do .env daqui.
-- ============================================================

-- Config que o dono edita sem mexer em código nem em deploy.
--
-- Guardada como documento JSONB inteiro, e não em tabelas normalizadas, porque
-- o formato do menu (categorias → itens → modificadores) já é o que
-- `cardapio.js`, o prompt da IA e os testes consomem. Normalizar exigiria
-- reescrever tudo isso por um ganho que ninguém usa: os relatórios consultam
-- `orders.items_json`, nunca o cardápio.
--
-- Chaves em uso: menu | ingredientes | delivery | schedule | faq
--
-- NÃO existe chave para pagamento, e a ausência é a defesa: quem edita o
-- destinatário do Zelle redireciona o faturamento inteiro. `config/pagamento.json`
-- continua sendo arquivo, fora do alcance do painel por não estar aqui — e não
-- por uma checagem de permissão que alguém afrouxa depois.
CREATE TABLE IF NOT EXISTS config_docs (
  key        TEXT PRIMARY KEY,
  doc        JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Histórico de alterações.
--
-- O painel muda preço e cardápio, e a pergunta que vai aparecer um dia é "quem
-- mudou isso, e quando?". Sem registro, a resposta é o silêncio — e a mesma
-- pergunta feita depois de um prejuízo não tem como ser respondida.
--
-- Guarda o documento ANTERIOR, não o novo: é o que permite desfazer, e o novo
-- já está em `config_docs`.
CREATE TABLE IF NOT EXISTS config_historico (
  id         BIGSERIAL PRIMARY KEY,
  key        TEXT NOT NULL,
  doc_antes  JSONB,
  mudou_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  mudou_quem TEXT,
  resumo     TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_hist_key ON config_historico(key, mudou_em DESC);

-- RLS ligada, zero políticas — o mesmo desenho das outras tabelas.
--
-- Zero política significa que a chave anon não lê nada, que é o correto aqui:
-- nenhum cliente acessa o Supabase direto. Só o servidor acessa, com a service
-- role, que passa por cima do RLS por desenho.
--
-- O aviso `rls_enabled_no_policy` do linter é esperado nesta arquitetura.
ALTER TABLE config_docs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_historico ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Não é preciso inserir nada.
--
-- No primeiro boot, `src/services/config.js` semeia cada documento ausente a
-- partir do `config/*.json` do repositório. Ele só insere o que falta — nunca
-- sobrescreve —, então um deploy não desfaz o que o dono editou.
-- ============================================================
