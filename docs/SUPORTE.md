# Número de suporte técnico (`SUPORTE_PHONE`)

Criado em 22/11/2026.

## Para que serve

Quem faz a manutenção do sistema precisa entrar no painel para cadastrar
informações novas, ver as conversas e ajustar a configuração. Antes, isso
exigia ter o número no `ADMIN_PHONE`, e cada alteração avisava todos os
admins com os 4 últimos dígitos de quem fez:

> ⚙️ *CARDÁPIO ALTERADO PELO PAINEL* … _Por +...1234._

Com o `SUPORTE_PHONE`, o suporte entra no painel **sem ser admin da loja**,
e as alterações feitas por ele **não chegam aos admins**.

## Como configurar

1. No Railway, serviço do bot, crie a variável **`SUPORTE_PHONE`** com o
   número do suporte, com o código do país. Exemplo: `16175550000`.
   Aceita mais de um número, separados por vírgula, como o `ADMIN_PHONE`.
2. **Tire esse número do `ADMIN_PHONE`.** Enquanto ele estiver nas duas
   listas, continua recebendo os avisos de admin (pedidos, caixa, perguntas).
3. Salvar a variável reinicia o bot. Faça isso fora do horário de movimento.

## O que o número de suporte pode fazer

| Ação | Suporte | Admin |
|---|---|---|
| `!painel` / `!admin` pelo WhatsApp (link do painel) | ✅ | ✅ |
| Entrar no painel e alterar qualquer aba | ✅ | ✅ |
| Outros comandos (`!fechar`, `!liberar`, `!cancelar`, relatórios…) | ❌ | ✅ |
| Receber avisos de pedido, caixa do Zelle, perguntas, comprovantes | ❌ | ✅ |

Qualquer outra mensagem do número de suporte é tratada como conversa de
cliente normal (dá para testar o bot com ele).

## Avisos de alteração do painel

| Quem salvou | Quem recebe o aviso "⚙️ … ALTERADO PELO PAINEL" |
|---|---|
| Admin | Todos os admins, como antes. O suporte **não** recebe. |
| Suporte | **Só o suporte.** Nenhum admin recebe. |

O suporte receber o aviso das próprias alterações é proposital: se alguém
usar um link do painel pedido pelo número de suporte, o suporte fica sabendo.

## O que não muda

- Os números do `ADMIN_PHONE` e todos os avisos e comandos deles.
- Sem `SUPORTE_PHONE` configurado, tudo funciona exatamente como antes.
- O link do painel continua valendo 15 minutos e abrindo uma vez; a sessão,
  30 minutos.

## Onde o número fica

Só no servidor: na variável do Railway e na tabela `painel_acessos` (o link e
a sessão, como acontece com os admins). **Não vai para o navegador**: o painel
recebe só a sessão opaca no cookie `HttpOnly`. Não aparece para os admins.

O histórico de alterações (`config_historico`) e o log do Railway guardam o
telefone de quem salvou, como já faziam para os admins. Nenhum dos dois é
mostrado no painel.

**Fica visível no painel:** se o suporte conversar com o bot (testando um
pedido, por exemplo), essa conversa aparece na aba Conversas, como a de
qualquer cliente. Decisão do dono do sistema: não precisa esconder.

## Onde está no código

- `src/services/suporte.js`: lê `SUPORTE_PHONE` (`numeros()`, `ehSuporte()`).
- `src/bot/handlers/admin.js` (`handle`): suporte que não é admin só tem
  `!painel` / `!admin`; o resto segue como conversa.
- `src/services/painel.js` (`adminsAtuais`): o suporte pode abrir o link e
  manter a sessão do painel.
- `src/api/painel.js` (`avisarAdmins`): alteração do suporte avisa só o suporte.
- Teste: `test/suportetest.js`.
