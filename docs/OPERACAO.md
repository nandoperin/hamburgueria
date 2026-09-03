# Operação — Point Burger

O que fazer no dia a dia, e o que fazer quando algo quebra.

Este documento existe porque quem construiu o sistema **não vai monitorá-lo**.
Tudo que está aqui é coisa que some da memória em duas semanas e vira meia hora
de confusão depois.

---

## Onde cada coisa mora

| O quê | Onde | Muda como |
|---|---|---|
| O bot (código) | Railway, projeto **Hamburgueria** | `git push` na `main` → deploy automático |
| Banco, comprovantes, config | Supabase | pelo painel, ou SQL |
| Endereço público | `https://bot.pointburgerjg.com` | Railway → Settings → Domains |
| Site institucional | Vercel, `www.pointburgerjg.com` | **outro projeto** — não é o bot |
| Sessão do WhatsApp | Volume do Railway em `/app/auth_info_baileys` | ver "Trocar o número" |
| Cardápio, preços, cidades, horário, FAQ | Supabase, via `!painel` | sem deploy |
| Destinatário do Zelle | `config/pagamento.json` | **exige commit + deploy** |

O site do Vercel e o bot do Railway são coisas separadas. Apontar a impressora
ou o `BASE_URL` para `www.pointburgerjg.com` não funciona — lá não roda o bot.

---

## O dia a dia

### Aprovar um pagamento

Nenhum pedido vai para a cozinha sozinho. O Zelle não avisa ninguém quando cai
dinheiro, então **alguém precisa olhar o comprovante e liberar**.

1. O cliente confirma o pedido e recebe as instruções do Zelle
2. Ele manda o print no WhatsApp
3. **Você recebe a imagem** no número admin, com o resumo do pedido
4. Confere o valor e o destinatário no print
5. `!liberar 42` → a comanda entra na fila da impressora

Também pode liberar pelo total: `!liberar 14.50` ou `!liberar 14,50`. Isso só
funciona quando existe **um único** comprovante aguardando com aquele valor. Se
dois pedidos tiverem o mesmo total, o bot mostra os IDs e não libera nenhum.

Se o comprovante continuar sem decisão por 10 minutos, o bot lembra o número
admin automaticamente com o comando de liberação pronto.

A resposta do `!liberar` repete **nome e valor**. Isso não é enfeite: é o que
faz um id errado aparecer na hora, antes de a comida sair.

Se o comprovante não presta:

```
!recusar 42 valor não confere
```

O motivo vai para o cliente, no idioma dele.

### Ver o que está esperando

```
!conferir
```

Lista os comprovantes aguardando decisão. Sinônimo: `!comprovantes`.

### Fim do dia

```
!relatorio hoje
```

Também `!relatorio semana` e `!relatorio mes`.

---

## Comandos do dono

Só funcionam do número em `ADMIN_PHONE`. De qualquer outro número o bot
responde como se fosse um cliente — nunca revela que existem comandos.

### Pedidos e pagamento

| Comando | O que faz |
|---|---|
| `!conferir` | Comprovantes esperando decisão |
| `!liberar 42` | Aprova o pagamento → libera para a cozinha |
| `!liberar 14.50` | Libera pelo valor quando houver um único pedido correspondente |
| `!recusar 42 motivo` | Recusa e avisa o cliente |
| `!pedidos pendentes` | Pedidos em aberto |
| `!ultimos` | Os 10 mais recentes |
| `!pedido 42` | Detalhe de um |
| `!buscar 16174449612` | Por telefone |
| `!cancelar 42` | Mostra o pedido; `!cancelar 42 ok` confirma |

O `!cancelar` é em duas etapas de propósito — a primeira mostra o que vai ser
cancelado, a segunda executa.

### Relatórios

| Comando | O que faz |
|---|---|
| `!relatorio hoje` \| `semana` \| `mes` | Faturamento, ticket médio, itens |
| `!ia` (ou `!custo`) | Quanto a conversa por IA custou hoje |
| `!emails` | Lista de emails coletados |

### Cardápio e estoque

| Comando | O que faz |
|---|---|
| `!painel` | Link para editar cardápio, preços, entrega e horário |
| `!estoque` | O que está esgotado |
| `!esgotou bacon` | Tira do cardápio na hora |
| `!voltou bacon` | Devolve |

`!esgotou` some do cardápio **e das opções de personalização** imediatamente —
não precisa de deploy.

### Impressora

| Comando | O que faz |
|---|---|
| `!fila` | Comandas esperando, e se a impressora está viva |
| `!testeimpressao` | Página de teste, sem gastar pedido |
| `!imprimir 42` | Segunda via da comanda |
| `!imprimir relatorio hoje` | Qualquer relatório no papel |

### Atendimento

| Comando | O que faz |
|---|---|
| `!fechar` | Encerra o dia mais cedo |
| `!abrir` | Retoma antes da hora |

O `!fechar` **volta sozinho** na próxima abertura programada. Ninguém precisa
lembrar de reabrir no dia seguinte.

---

## O painel

```
!painel
```

Gera um link que **vale 15 minutos e abre uma vez só**. Depois disso ele morre
— inclusive se alguém interceptar a mensagem.

Não encaminhe o link. Precisa de novo, peça outro.

Abas: **Cardápio · Ingredientes · Entrega · Horário · Relatórios**

O que dá para mudar sem deploy: itens, preços, descrições, ingredientes e
acréscimos, cidades atendidas e taxas, horário de funcionamento, FAQ.

O que **não** está no painel, de propósito: o destinatário do Zelle. Uma sessão
de painel comprometida não pode redirecionar pagamento.

### Se o link não abrir

- Passou de 15 minutos, ou já foi usado → peça outro
- `PAINEL_SECRET` mudou no Railway → invalida todos os links em circulação (é
  justamente o que fazer se um link vazar)
- O domínio caiu → confira `https://bot.pointburgerjg.com/health`

## Produtos no catálogo enquanto o bot usa Baileys

1. Abra WhatsApp Business → Ferramentas comerciais → Catálogo.
2. Cadastre foto, nome, descrição e preço do produto.
3. Copie no nome exatamente o nome em português mostrado no painel da Point Burger.
4. Envie um carrinho de teste para o próprio número.
5. Confira o resumo do bot: o valor cobrado pelo sistema é o do painel, mesmo que o catálogo esteja desatualizado.

Se o bot informar que não reconheceu o produto do catálogo, compare o nome do catálogo com o painel. Não altere IDs, banco ou variáveis do Railway para corrigir um nome.

---

## Manutenção

### Parear o WhatsApp

O número do bot **não é uma variável de configuração**. Ele é definido por qual
celular pareou, e a credencial fica gravada no volume.

`PAIR_PHONE` não escolhe o número: ele só diz para **qual** número mandar o
código de pareamento. Quem decide de fato é quem digita o código no celular.

Defina nas variáveis do Railway — só dígitos, com código de país:

```
PAIR_PHONE=16175551234
```

Salvar já dispara o redeploy. No log aparece:

```
CODIGO DE PAREAMENTO: ABCDEFGH  (oito caracteres, digite sem espaço e sem traço)
```

No celular: **Aparelhos conectados → Conectar aparelho → "Conectar com número
de telefone"** → digite o código.

> **São oito caracteres corridos.** O log já mostrou esse código com um hífen no
> meio (`ABCD-EFGH`) — formatação nossa, para facilitar a leitura, que o campo do
> WhatsApp não aceita. O resultado era "código incorreto" em todas as tentativas,
> com o log parecendo certo. Se você vir um traço num código, ele não é do
> WhatsApp.
>
> **O código dura menos de 3 minutos.** Deixe o celular já parado na tela de
> "Conectar com número de telefone" **antes** de abrir o log: entre ler, copiar e
> navegar, a janela fecha. Se expirar, o bot emite outro sozinho a cada ~3 min —
> não é preciso reiniciar nada.

Isso existe porque o QR sai no log como 33 linhas de arte ASCII e o
visualizador do Railway quebra o desenho. Sem `PAIR_PHONE` o bot volta ao QR.

### Trocar para OUTRO número, depois de já ter pareado

Este é um caso diferente do de cima, e a diferença está numa linha de
`src/bot/index.js`:

```js
if (!telefone || state.creds?.registered) return;
```

**Sessão já gravada = nenhum código é pedido.** O bot conecta com o número
antigo e ignora o `PAIR_PHONE` novo — ele não tem como adivinhar que você quer
trocar.

Antes do volume, isso não era problema: todo deploy apagava a sessão e trocar
de número saía de graça. A sessão passou a persistir (que era o objetivo), e o
preço disso é que agora **ela precisa ser removida à mão**:

1. Instale a CLI do Railway e conecte no projeto **Hamburgueria**
2. `railway volume browse /`
3. Apague o conteúdo de `auth_info_baileys/`
4. Ajuste `PAIR_PHONE` para o número novo
5. Redeploy → agora sim o log traz o código

### Qual dos dois casos é o meu?

Olhe o log depois do redeploy:

| O que aparece | Significa |
|---|---|
| `CODIGO DE PAREAMENTO: ...` | Volume vazio. Só digitar o código no celular |
| `bot no ar`, sem código | Já havia sessão. Conectou com o número **antigo** |
| `escaneie o QR code` | `PAIR_PHONE` não está definido, ou tem menos de 10 dígitos |
| `sessão encerrada pelo WhatsApp (401)` | Sessão revogada. O bot **apaga sozinho** e repareia no reboot seguinte |

> **Não pareie um segundo aparelho enquanto o primeiro roda.** O WhatsApp
> aceita vários dispositivos vinculados: os dois receberiam cada mensagem e os
> dois responderiam. Cliente recebe tudo em duplicado, e dois caminhos tentam
> criar o mesmo pedido. Isso já aconteceu nesta sessão, com um bot local e o
> Railway ao mesmo tempo.

`PAIR_PHONE` **não é o mesmo que `ADMIN_PHONE`.** O primeiro é o número do bot;
o segundo é quem pode dar `!liberar` e ver faturamento.

### Configurar a impressora

Na página de setup da Star TSP143IV:

```
https://bot.pointburgerjg.com/cloudprnt?authToken=SEU_CLOUDPRNT_TOKEN
```

O token está na variável `CLOUDPRNT_TOKEN` do Railway.

Detalhes que custam se errados:

- **`https`, nunca `http`.** O token vai na URL. Em HTTP puro ele viaja
  legível, e quem o tiver lê a comanda inteira (nome, endereço, telefone do
  cliente) e pode marcar como impressa antes de a impressora pegar — a comanda
  **nunca sai**, e a cozinha descobre pelo cliente ligando.
- **É `authToken`, não `token`.** O protocolo já usa `token` para outra coisa.
- **A impressora precisa alcançar a internet** saindo da rede da loja. Teste
  abrindo `https://bot.pointburgerjg.com/health` no celular no wi-fi de lá.

Conferir com `!fila`. Durante os testes, o `/health` confirma somente que o
servidor está no ar; ele não consulta a impressora.

### Deploy

`git push` na `main` → o Railway sobe sozinho.

Com o volume montado, **todo deploy tem uma pausa curta** — o Railway impede
duas instâncias no mesmo volume ao mesmo tempo. Isso é desejável: é o que
impede dois bots atropelarem a mesma sessão.

Antes de subir:

```bash
node test/run.js
```

> Neste ambiente o `npm` não acha o `node` (gerenciador de versões + shim do
> cmd.exe). Use `node test/run.js` e `node src/index.js` direto, não
> `npm test` / `npm start`.

---

## Quando algo quebra

### O bot não responde

1. `https://bot.pointburgerjg.com/health` responde?
   - **Não** → o serviço caiu. Railway → Deployments → ver o log
   - **Sim** → siga
2. Nos logs do Railway, procure `escaneie o QR` ou `CODIGO DE PAREAMENTO`
   - Aparece → **a sessão caiu**. Repareie
   - Não aparece → procure `conexão caiu`

`conexão caiu — status 405` é bloqueio temporário de IP por excesso de
tentativas. Espere algumas horas. Não fique reiniciando: piora.

`sessão encerrada pelo WhatsApp (401)` é a sessão revogada — alguém desvinculou
o aparelho, ou a credencial expirou. **Isso o bot resolve sozinho**: apaga a
sessão morta e reinicia pedindo pareamento novo. Só é preciso digitar o código
de novo no celular.

### O bot responde, mas como um formulário

Perguntando um campo por vez, ignorando o que o cliente já disse na mesma
frase: **a IA está fora e o fluxo numerado assumiu**. Isso é a rede de
segurança funcionando — feio, e vendendo.

Procure nos logs:

- `teto de IA atingido` → estourou o limite de gasto. Veja `!ia`
- `falha na conversa por IA` → provedor fora do ar ou chave inválida
- `AI_ENABLED=off` → alguém desligou de propósito

### A comanda não sai

Na ordem:

1. `!conferir` — o pagamento foi liberado? Sem `!liberar`, nada imprime
2. `!fila` — a impressora está viva?
3. A URL do CloudPRNT está certa na impressora? (`https`, `authToken`)
4. A rede da loja deixa a impressora sair para a internet?

Comanda parada há mais de 2 minutos **avisa no WhatsApp sozinha**.

### O cliente diz que pagou e o pedido sumiu

O pedido expira em **30 minutos** sem comprovante (lembrete aos 10). Depois
disso a sessão é liberada e ele precisa refazer.

`!buscar <telefone>` mostra o histórico dele.

### A conta da IA subiu

```
!ia
```

Mostra chamadas, tokens, custo do dia, custo por pedido e quanto do teto foi
usado. Estourando o teto, o bot cai no cardápio numerado e avisa no WhatsApp
— uma vez por dia, não a cada mensagem.

Para mexer no teto: `AI_MAX_USD_DIA` no Railway.

---

## Os interruptores

Todo caminho novo tem volta sem precisar de deploy. Variáveis do Railway:

| Variável | Efeito |
|---|---|
| `AI_ENABLED=off` | Desliga a IA. O bot atende pelo cardápio numerado |
| `BAILEYS_RICH=off` | Desliga botões e listas; tudo vira texto |
| `PRINTER_FORMAT=plain` | Se a impressora imprimir as tags como texto literal |
| `AI_MAX_USD_DIA=0` | Desliga o teto de gasto (decisão consciente) |

---

## O que NÃO fazer

- **Não pareie o WhatsApp em dois lugares** ao mesmo tempo (local e nuvem)
- **Não aponte a impressora para `www.pointburgerjg.com`** — lá é o site, não o bot
- **Não encaminhe o link do `!painel`** — ele autentica quem o abrir
- **Não edite `config/*.json` direto no servidor** — o banco é a verdade; use o painel
- **Não mexa em `config/pagamento.json`** sem conferir duas vezes: é para onde
  o dinheiro do cliente vai, e errar ali **não gera erro nenhum** no sistema

---

## Pendências conhecidas

Coisas que ainda **não** foram feitas, e que impedem atender cliente de verdade:

- [ ] **Parear o WhatsApp no Railway** — sem isso o bot não recebe mensagem
- [ ] **Zelle real** — hoje é valor de teste (`pointburgerjg@gmail.com`)
- [ ] **Revisar cardápio e preços** — os 17 itens foram inventados no
      desenvolvimento, nenhum veio do dono
- [ ] **Desligar `always_open`** — hoje o bot aceita pedido às 4h da manhã
- [ ] **Endereço da retirada** — ainda não foi preenchido, e a retirada está ligada
- [ ] **Configurar a impressora**
- [ ] **Confirmar as taxas** — Everett $5, demais $7, pedido mínimo $0

Os quatro do meio se resolvem pelo `!painel`, sem deploy. O Zelle exige commit.
