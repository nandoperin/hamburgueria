# Cardápio na Conversa Humanizada — Documento de Design

> Status: **proposta aprovada, sem implementação**. Este documento define COMO o
> cardápio é apresentado ao cliente quando a conversa passa a ser conduzida por
> IA. É o contrato que o `agente.js` e as ferramentas devem seguir quando forem
> escritos.

## O problema

O `projeto atendimento` (concluído, referência) mostrava o cardápio pelo
**catálogo nativo do WhatsApp**: um cartão com fotos, o cliente tocava, montava
um carrinho fechado e só então o bot processava. Era clique, não conversa.

A hamburgueria vai usar **conversa humanizada** — a IA conduz. Isso reabre uma
pergunta que o catálogo respondia sozinho: **quando e como o cliente vê as
opções, já que a IA carrega o cardápio inteiro no prompt?**

## A decisão

**A IA conduz a conversa e conhece o cardápio; o cliente vê as opções sob
demanda.** Não há menu numerado obrigatório. Duas peças:

1. **A IA conduz** — abre orientando (as 4 categorias), entende pedido em texto
   livre ("um x-bacon sem cebola"), e só lista itens quando ajuda a decidir.
2. **Gatilho de cardápio completo** — quando o cliente digita `cardápio`
   (`menu`, `carta`, `cardapio`), recebe o cardápio inteiro formatado — texto
   hoje, imagem quando houver arte. Isso NÃO passa pela IA: é o mesmo dado do
   `menu.json`, renderizado direto, barato e sempre consistente.

Por que as duas coisas: a conversa é o caminho principal (é a razão do projeto),
mas quem quer "ver tudo de uma vez" tem uma saída imediata que não gasta tokens
nem depende do modelo acertar a formatação.

## Já existe base para isso no código

Nada aqui parte do zero — a arquitetura foi montada esperando este desenho:

| Peça | Onde | O que faz |
|---|---|---|
| Cardápio para o modelo | `services/cardapio.js` → `paraModelo(lang)` | Cardápio inteiro em texto compacto, para o bloco cacheável do prompt. É como a IA "sabe" o cardápio. |
| Porta dos modificadores | `services/modifiers.js` → `validar(item, {remover, acrescentar})` | Recebe o que a IA pede e valida contra o `menu.json`. Modelo sugere, código decide preço e barra combinação inválida. |
| Autoridade de preço | `menu.json` + `ingredientes.json` | Preço nunca sai da conversa. O total é sempre calculado pelo código. |
| Seletor de provedor | `ai/provider.js` | `AI_ENABLED=off` cai no fluxo numerado. A IA é a camada de cima, não a única. |

## Fluxo da conversa

### Primeira mensagem — lista as 4 categorias com emoji
Orienta sem sobrecarregar. Não é a parede do cardápio inteiro, nem um "o que
você quer?" vago que deixa o cliente sem saber o que existe.

```
👋 Bem-vindo à [Nome]! 🍔

Temos:
🍔 Hambúrgueres   🍝 Massas
🍟 Acompanhamentos 🥤 Bebidas

O que te apetece hoje? (ou escreva *cardápio* pra ver tudo)
```

### Pedido em texto livre — a IA entende e confirma
```
cliente: queria um x-bacon sem cebola
   IA:   Fechou! X-Bacon sem cebola — $14. 🍔
         Quer turbinar? Bacon extra (+$2,50), ovo (+$1,50), cheddar (+$1,50)…
         ou já tá bom assim?
```
- A IA chamou `adicionar_item(x_bacon, remover=[cebola])`.
- `modifiers.validar` confirmou que `cebola` é removível no X-Bacon e devolveu
  preço $14. O texto do preço vem do código, não do modelo.

### Gatilho "cardápio" — lista completa, fora da IA
```
cliente: cardápio
   bot:   🍔 HAMBÚRGUERES
          • X-Burger — $11
          • X-Salada — $12
          • X-Bacon — $14  ⭐
          ...
          🍝 MASSAS
          ...
          _Me diga o que quer, ou monte do seu jeito:_
          _"x-bacon sem cebola com ovo" 😉_
```
Renderizado de `menu.json` (reaproveita a lógica de `paraModelo`, mas formatada
para humano). Quando houver arte de produto, esta é a saída que vira imagem.

## Regras invioláveis (herdadas do projeto)

Estas não mudam com a IA — são o que impede o modelo de causar prejuízo:

1. **Preço é do código, nunca da conversa.** A IA fala de valor para conversar,
   mas o total do carrinho e do resumo sai de `menu.json` + `ingredientes.json`.
   Se divergirem, o código ganha e o cliente confirma o resumo do código.
2. **Remover é sempre grátis.** Regra em `modifiers.js`, não configuração —
   cobrar por tirar cebola exigiria mexer no código e passar por revisão.
3. **Modificador validado por item, não global.** `validar` confere contra a
   lista `removable`/`addable` daquele item. É o que impede "macarrão sem
   alface" e "água com bacon" que o modelo inventaria com naturalidade.
4. **Argumento de ferramenta é entrada não confiável.** Tão não confiável quanto
   o texto do cliente — o modelo pode alucinar ids. Cada id é conferido; a porta
   recusa em vez de corrigir.
5. **Fallback sem IA.** `AI_ENABLED=off` cai no fluxo numerado (feio, e
   funcionando). Todo caminho novo tem volta sem deploy — mesma filosofia de
   `PRINTER_FORMAT=plain` e `BAILEYS_RICH=off`.

## O que falta construir (fora deste documento)

Este design não inclui código. Quando for implementar, a ordem sugerida:

1. `src/ai/claude.js` e `src/ai/openai.js` — as implementações que `ai/provider.js`
   já referencia (hoje faltam). Cada uma expõe
   `conversar({ system, mensagens, ferramentas })`.
2. `src/ai/agente.js` — o laço: monta o system prompt (com `cardapio.paraModelo`),
   declara as ferramentas, executa as chamadas do modelo contra os services.
3. Ferramentas: `adicionar_item`, `remover_item`, `ver_carrinho`, `finalizar`
   — todas passando pelos services existentes (`cardapio`, `modifiers`, `order`).
4. Gancho no `router.js` — quando `ai.habilitada()`, a mensagem vai ao agente;
   o gatilho `cardápio` e os comandos de saída (`0`, `cancelar`) continuam
   interceptados antes, como hoje.
5. i18n — textos de saudação humanizada e do cardápio completo em pt/en/es.

## Decisões em aberto (para depois)

- **Imagem do cardápio completo**: gerar uma arte única (como `scripts/gerar-arte.js`
  faz para produtos) ou montar dinamicamente? Fica para quando houver fotografia.
- **Streaming vs. mensagem única** do WhatsApp: a IA responde de uma vez; não há
  streaming no WhatsApp, então respostas longas precisam caber no limite (1024
  no corpo interativo, 4096 em texto).
