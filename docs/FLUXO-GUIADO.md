# Fluxo guiado (Fase 2)

A IA deixa de conduzir a conversa: ela **só lê** a mensagem e preenche um
formulário JSON. O código valida pelas regras do dono, mexe no carrinho e
responde com texto fixo. Plano completo no doc "Point Burger — Fluxo guiado da
IA" (17/09).

```
mensagem → IA leitora (ai/leitor.js) → validador + carrinho (ai/guiado.js)
         → próxima pergunta do sistema → resposta com texto fixo (i18n)
```

## Como ligar

`FLUXO_GUIADO=on` nas variáveis do Railway. Desligado (padrão), o agente de
sempre conduz — nada muda. Liga e desliga sem deploy.

Se a leitura falhar (provedor fora, teto de gasto, JSON inválido), a mensagem
cai no agente de sempre. A rede continua armada.

## O que as regras seguram

| Regra | Onde | Caso real |
|---|---|---|
| R1 ingrediente é acréscimo, nunca porção | `validar` | "2 macarrão com dois ovos" (13/09) |
| R1 ingrediente solto sem "com/extra/mais" é ignorado | `validar` | "3x bacon" repetido virou bacon extra (#154) |
| R3 cartão nunca vira cash/Zelle | `aplicar` | Vanessa (#129) |
| R4 produto só se está na fala; genérico pergunta qual | `validar` | "2 hot dog" (17/09) |
| R5 "sem" só do que o lanche leva | `validar` | — |
| R9 a mesma mensagem de novo não muda nada | `atender` | "3x bacon" (#154) |
| R10 nome só se está escrito | `aplicar` | "Ok" virou "Ana" (#129) |
| R11 trocar pagamento até confirmar | `aplicar` | Vanessa, Kiki (#154) |
| R13 maionese à parte, de graça | `validar` + `modifiers` | Chaiane (#155) |
| Lista reenviada substitui o carrinho | `aplicar` | Chaiane, $252 (#155) |
| Pergunta fora da lista vai à equipe | `responderPergunta` | fiado (#156), previsão |
| Troco: só "Ok" | `router` (vale nos dois fluxos) | decisão do dono, 18/09 |

## Como testar antes de ligar

- `npm test` — `test/guiadotest.js` percorre as conversas reais com a leitora simulada.
- `node scripts/prova-leitor.js` — a leitora REAL (Mistral) lendo 17 frases reais,
  com banco falso. Custa centavos. Em 18/09: 17/17 casos, 36/36 checagens, duas rodadas.

## O que ainda não está no fluxo guiado

- `PAYMENT_PENDING` e pedido já fechado continuam com o caminho atual.
- Fase 3: aposentar as 14 ferramentas e as travas antigas, quando o guiado
  estiver ligado e estável em produção.
