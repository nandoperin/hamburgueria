# Perguntas e respostas pelo painel — projeto

Data: 13/11/2026. Estado: **planejamento, nada implementado.**

## O que é

Uma aba nova no painel, **"Perguntas"**, onde o dono cadastra perguntas que os
clientes fazem e a resposta que o bot deve dar. O bot passa a responder essas
perguntas sozinho, no WhatsApp, e continua o pedido de onde parou.

Exemplos do dono:

- "Qual o telefone do Zelle?"
- "O macarrão tem pimenta?"

## Como é hoje

A IA leitora classifica a pergunta do cliente em um de poucos assuntos
(`pergunta` na leitura), e o código responde com texto fixo
(`responderPergunta`, em `src/ai/guiado.js`):

| Assunto | Resposta |
|---|---|
| `cartao` | não aceitamos cartão; cash ou Zelle |
| `taxa_entrega`, `cidades` | tabela de cidades e taxas do painel |
| `horario` | horário do painel |
| `cardapio` | link do site |
| `tempo` | prazo de entrega/retirada |
| `outra` | **repassa para a equipe** (atendimento humano) |

Tudo o que não cabe nos assuntos fixos vira `outra`. Casos reais:
"Qual o zelle?" (08/10) e "Tem como tirar o tomate?" (07/11) foram para a
equipe.

## Como fica

1. **Cadastro no painel.** Cada item tem:
   - a pergunta, escrita como o cliente faz;
   - a resposta, escrita pelo dono;
   - ligado/desligado.
2. **A leitora escolhe, o código responde.** A lista de perguntas cadastradas
   (só o texto da pergunta, com um número) entra no pedido à IA leitora. Quando
   a mensagem do cliente for uma delas — mesmo com outras palavras —, a leitora
   devolve o número. O código envia **a resposta do dono, palavra por
   palavra**. A IA nunca escreve a resposta.
3. **Sem pergunta parecida, nada muda.** Continua `outra` → equipe.
4. **O pedido continua.** Depois da resposta, o bot repete a próxima etapa
   ("Entrega ou retirada?"), como já faz com as perguntas fixas.
5. **Os assuntos fixos têm prioridade.** Horário, taxa, cidades, tempo e cartão
   continuam saindo do painel/config, nunca de texto digitado — para não
   ficarem desatualizados.

### O "aprender"

A aba mostra também as **perguntas que o bot não soube responder** (as que
foram para a equipe como `outra`) nos últimos 30 dias, da mais recente para a
mais antiga, com o botão **"Responder"**: o dono escreve a resposta uma vez e
ela vira um item do cadastro. Na próxima vez o bot responde sozinho.

### Zelle

"Qual o telefone/nome do Zelle?" ganha um assunto fixo novo (`zelle`), com a
resposta montada de `config/pagamento.json` (`zelle.destinatario()`), que é de
onde já saem as instruções de pagamento. Não depende de cadastro e não fica
desatualizada.

## Por que a IA não escreve a resposta

É a regra do projeto: a conversa é da IA, o compromisso é do código. Resposta
sobre ingrediente, alergia ou pagamento escrita por modelo pode sair errada
("não tem pimenta" quando tem). Com o texto do dono, o que o cliente lê é o
que o dono escreveu.

## Arquivos

### Novos

| Arquivo | Papel |
|---|---|
| `src/services/perguntas.js` | carrega e salva o cadastro (`config_docs`, chave `perguntas`), valida, monta o bloco para a leitora, acha a resposta pelo número, anota as não respondidas (`bot_settings`, 30 dias, teto de 200) |
| `test/perguntastest.js` | cadastro, validação, resposta pelo número, pergunta sem cadastro vai para a equipe, pedido continua, lista de não respondidas |

### Acréscimos em arquivos existentes

| Arquivo | O que entra |
|---|---|
| `src/ai/leitor.js` | bloco "Perguntas cadastradas" no pedido à leitora (só quando houver cadastro) e o campo `pergunta_cadastrada` (número ou null) na leitura; assunto `zelle` |
| `src/ai/guiado.js` | em `responderPergunta`: `zelle`; antes de repassar `outra` à equipe, tenta a pergunta cadastrada; quando repassa, anota em "não respondidas" |
| `src/api/painel.js` | `GET/POST/DELETE /perguntas` e `GET /perguntas/pendentes` |
| `src/api/painel-page.js` | aba "❓ Perguntas": lista, formulário, liga/desliga, remover, e o quadro das não respondidas com "Responder" |
| `src/i18n/*.json` | texto da resposta do Zelle |

Nada do fluxo de pedido, carrinho, pagamento ou impressão é alterado. O
caminho de hoje (`outra` → equipe) fica como reserva.

## Regras e limites

| Regra | Por quê |
|---|---|
| Até 50 perguntas, pergunta até 120 caracteres, resposta até 600 | o texto das perguntas vai em toda leitura; resposta cabe numa mensagem |
| Só o texto da **pergunta** vai para a IA; a resposta fica no servidor | menos custo e nenhuma chance de a IA reescrever a resposta |
| Número devolvido pela leitora é conferido contra o cadastro ligado | número inventado ou de item desligado cai em `outra` |
| Pergunta junto de pedido ("1 x tudo, o macarrão tem pimenta?") | o item entra e a resposta vai na mesma mensagem, como as perguntas fixas |
| Resposta é igual para todo cliente | "meu pedido já saiu?" continua indo para a equipe |
| Texto do dono passa por `entrada.limpar` | mesma higiene das outras entradas do painel |
| Não respondidas guardam só o texto da pergunta e a data, sem telefone | privacidade; o histórico completo já está na aba Conversas |

Custo: cerca de 15 tokens por pergunta cadastrada em cada leitura. Com 30
perguntas, perto de $0,00002 a mais por mensagem.

## Riscos

| Risco | Cobertura |
|---|---|
| Leitora casa a pergunta errada | a lista vai com instrução "só se for a MESMA pergunta; na dúvida, null"; o dono vê na aba Conversas o que foi respondido e ajusta ou desliga o item |
| Resposta desatualizada (mudou a receita) | é texto do dono; o painel mostra a data da última edição de cada item |
| Cadastro vazio | o bloco não entra no pedido à IA; comportamento idêntico ao de hoje |
| Banco fora do ar | cadastro fica em memória (como as outras configs); sem ele, cai em `outra` |

## Fases (cada uma com teste; deploy só quando o dono pedir)

1. **Serviço e bot** — `perguntas.js`, leitora, `responderPergunta`, assunto
   `zelle`. Com o cadastro vazio nada muda.
2. **Painel** — aba Perguntas com cadastro.
3. **Não respondidas** — anotação e o botão "Responder".

## Decisões em aberto

1. **Variações da pergunta.** Uma pergunta por item (a IA reconhece as
   variações) ou campo para o dono listar outras formas? Plano assume: uma só,
   mais simples.
2. **Idiomas.** Resposta só em português, mesmo para cliente em inglês ou
   espanhol (quase não aparecem). Plano assume: só português.
3. **Pergunta respondida também vai para a equipe?** Plano assume: não —
   só as sem resposta.
4. **Perguntas iniciais.** O dono cadastra tudo, ou já entram algumas prontas
   (pimenta, estacionamento, aceita Pix…)? Plano assume: lista vazia.
