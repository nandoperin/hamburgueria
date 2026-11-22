# Acesso de manutenção ao painel sem WhatsApp (plano)

Estado: **implementado** em 22/11/2026 (fases 1 a 6). Para ligar, ver
"Como ligar" no fim.

## O problema

O bot não tem WhatsApp próprio: é um aparelho conectado ao WhatsApp **da
loja**. Tudo o que entra e sai pelo bot aparece também no celular da loja:

- o `!painel` mandado pelo número de manutenção, e a resposta com o link;
- **qualquer mensagem que o bot mande para o número de manutenção**, inclusive
  o aviso "⚙️ … ALTERADO PELO PAINEL", que hoje (docs/SUPORTE.md) vai só para
  ele. Esse aviso aparece no celular da loja como mensagem enviada.

Não existe como esconder isso dentro do WhatsApp. A saída é o suporte entrar no
painel **sem passar pelo WhatsApp**, e o bot **nunca mandar mensagem** para o
número de manutenção.

## A proposta

Uma página de entrada própria do suporte, com **senha + código do Google
Authenticator** (dois fatores).

1. O suporte abre `https://bot.pointburgerjg.com/painel/manutencao`, salvo nos
   favoritos do navegador.
2. Digita a **senha** e o **código de 6 dígitos** do autenticador.
3. Entra no painel com uma sessão igual à de hoje (30 minutos, cookie
   `HttpOnly`), ligada ao `MANUTENCAO_PHONE`. Tudo o que já vale para o suporte
   continua valendo: não é admin, alterações não avisam os admins.

### O que não muda

- O `!painel` dos admins pelo WhatsApp, os links de 15 minutos e as sessões.
- O painel em si: mesmas abas, mesmo salvar.
- Sem as variáveis novas, a página não existe (responde 404) e tudo fica como
  hoje.

## Variáveis novas no Railway

| Variável | O que é |
|---|---|
| `MANUTENCAO_TOTP_SECRET` | Segredo do autenticador (base32, 160 bits). Gerado por um script local, nunca escrito no código. |
| `MANUTENCAO_SENHA_HASH` | Hash da senha (scrypt com sal). A senha em si não fica em lugar nenhum do servidor. |
| `MANUTENCAO_PHONE` | Já existe. Diz a qual número a sessão pertence. |

Para gerar as duas primeiras, um script local:

```bash
node scripts/manutencao-gerar.js
```

Ele pede a senha no terminal, imprime o `MANUTENCAO_SENHA_HASH`, o
`MANUTENCAO_TOTP_SECRET` e a chave para digitar no Google Authenticator
("Adicionar código" → "Inserir chave de configuração"). Nada disso é salvo em
arquivo nem enviado a lugar nenhum. Sem biblioteca nova: TOTP e scrypt saem do
`crypto` do Node.

## Proteções

1. **Dois fatores:** senha (o que você sabe) + código do celular (o que você
   tem). Um sem o outro não entra.
2. **Limite de tentativas:** 5 erros seguidos travam a página por 15 minutos;
   20 erros em 24 horas travam por 24 horas. A trava fica no banco
   (`bot_settings`), então um deploy não zera a contagem. Durante a trava, nem
   a senha certa entra.
3. **Código usado uma vez só:** o mesmo código não abre duas sessões (quem
   espiar a tela não reaproveita).
4. **Tolerância de relógio:** aceita o código atual, o anterior e o seguinte
   (±30 s), o padrão do TOTP.
5. **Resposta igual para todo erro:** "senha ou código inválido", sem dizer
   qual dos dois errou.
6. **Página sem rastro para o cliente da loja:** nenhuma mensagem de WhatsApp,
   nenhum aviso aos admins. Entradas, erros e travas ficam só no log do
   Railway (`evt: 'manutencao'`), que só quem tem a conta do Railway vê.
7. **Desligar na hora:** apagar `MANUTENCAO_TOTP_SECRET` no Railway desliga a
   página. Trocar o segredo invalida o autenticador antigo, se o celular for
   perdido.
8. Mesmos cabeçalhos de segurança do painel (CSP com nonce, sem cache, sem
   iframe).

## Mudança junto: o suporte não recebe mais mensagem do bot

Hoje (docs/SUPORTE.md), a alteração feita pelo suporte manda o aviso só para
o número de manutenção, e esse aviso aparece no WhatsApp da loja. Com este
plano:

- alteração feita pelo suporte → **nenhuma mensagem**, só uma linha no log do
  Railway;
- alteração feita por admin → admins avisados, como sempre.

O `!painel` pelo WhatsApp continuaria funcionando para o número de manutenção
(é opcional; pode ser desligado para não deixar rastro por engano).

## Nível de segurança

### Do Google Authenticator (TOTP) sozinho

- É o padrão aberto **TOTP** (RFC 6238): o celular e o servidor guardam o mesmo
  segredo de 160 bits e calculam um código de 6 dígitos a cada 30 segundos.
- Sem o segredo, adivinhar um código é **1 chance em 1 milhão** por tentativa
  (com a tolerância de relógio, cerca de 3 em 1 milhão).
- **Por isso o limite de tentativas é obrigatório.** Só com o código e sem
  trava, um robô acertaria em horas. Com a trava acima (no máximo 20 tentativas
  por dia), dá menos de 1 chance em 15 mil por dia.
- **Com a senha junto**, o robô precisa acertar a senha também. Com uma senha
  de 12+ caracteres, isso fica impraticável.

### Contra o que protege bem

- Alguém que descubra o endereço da página.
- Robô tentando senhas e códigos.
- Alguém que veja a senha digitada uma vez (sem o celular, não entra).
- Alguém que espie um código (vale uma vez só e por segundos).

### Contra o que não protege (e o que fazer)

| Risco | O que fazer |
|---|---|
| **Página falsa** (phishing): alguém faz você digitar senha e código num site falso e usa na hora | Entrar sempre pelo favorito, nunca por link recebido |
| **Celular perdido** | Trocar `MANUTENCAO_TOTP_SECRET` no Railway e cadastrar de novo no celular novo |
| **Conta do Railway invadida** | Quem tem o Railway já controla tudo (banco, código, variáveis): proteger a conta do Railway com autenticação em dois fatores |
| **Computador ou celular com vírus** | Fora do alcance do sistema |

### Comparando com o que existe hoje

| | Link pelo WhatsApp (hoje) | Senha + autenticador (proposta) |
|---|---|---|
| Quem entra | Quem tem o WhatsApp do número | Quem sabe a senha **e** tem o celular |
| Rastro no WhatsApp da loja | Sim | Não |
| Funciona com o WhatsApp do bot fora do ar | Não | Sim |
| Fatores | 1 (o WhatsApp) | 2 |

Mais forte que isso só uma chave de acesso (passkey, a digital do celular),
que é mais complexa de implementar e não compensa aqui.

## Fases

1. **Script local** `scripts/manutencao-gerar.js` (senha → hash; segredo TOTP).
2. **Serviço** `src/services/manutencao-acesso.js`: confere senha e código,
   trava de tentativas, código usado uma vez, abre a sessão do painel.
3. **Rotas** em `src/api/painel.js`: `GET /painel/manutencao` (página) e
   `POST /painel/manutencao` (entrar). Página simples, sem JavaScript de fora.
4. **Silêncio total para o suporte:** `avisarAdmins` deixa de mandar mensagem
   quando quem salvou é o suporte (só log).
5. **Testes:** código certo e errado, senha errada, código repetido, trava de
   5 e de 20, trava sobrevive a reinício, sem variável → 404, sessão aberta
   vale no painel, alteração do suporte não manda mensagem nenhuma.
6. **docs/SUPORTE.md** atualizado.

Nada muda para os clientes, para os admins nem para o fluxo de pedidos.

## Como ligar

1. No seu computador, na pasta do projeto:
   ```bash
   node scripts/manutencao-gerar.js
   ```
   Digite a senha (12+ caracteres, não aparece na tela) duas vezes.
2. No Railway (serviço do bot → Variables), crie `MANUTENCAO_SENHA_HASH` e
   `MANUTENCAO_TOTP_SECRET` com os valores impressos. `MANUTENCAO_PHONE` já
   deve existir.
3. No Google Authenticator: "+" → "Inserir chave de configuração", cole a
   chave impressa, tipo "baseado no tempo".
4. Feche o terminal. Salve `https://bot.pointburgerjg.com/painel/manutencao`
   nos favoritos.

Para desligar: apagar `MANUTENCAO_TOTP_SECRET` no Railway. Celular perdido:
rodar o script de novo e trocar as duas variáveis.

## Onde está no código

- `src/services/manutencao-acesso.js`: TOTP, senha (scrypt), travas, código
  usado uma vez.
- `src/api/painel.js`: `GET`/`POST /painel/manutencao`; `avisarAdmins` em
  silêncio para o suporte.
- `src/api/painel-page.js` (`manutencao`): a página de entrada.
- `scripts/manutencao-gerar.js`: gera as variáveis.
- Testes: `test/manutencaotest.js`, `test/suportetest.js`.
