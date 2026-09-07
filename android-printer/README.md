# Point Burger — Impressora Android

Aplicativo Android dedicado a enviar as comandas do servidor para uma
impressora térmica Bluetooth ESC/POS.

## Instalação na loja

1. Pareie a impressora nas configurações Bluetooth do Android.
2. Baixe `https://bot.pointburgerjg.com/downloads/PointBurger-Impressora.apk`.
3. No WhatsApp do administrador, envie `!impressora vincular`.
4. Digite no aplicativo o código de oito dígitos recebido.
5. Selecione a Volcora, imprima o teste e ative a impressão automática.

Vincular outro celular revoga automaticamente o anterior. Em caso de perda ou
roubo, envie `!impressora revogar` pelo WhatsApp do administrador.

## Controles de segurança

- A APK não contém senha nem token permanente.
- O código de vínculo é de uso único, vence em dez minutos e tem limite de
  tentativas.
- O token individual fica criptografado pelo Android Keystore e não entra em
  backup.
- O servidor guarda somente o hash do token e pode revogá-lo imediatamente.
- Cada comanda tem reserva temporária, confirmação única e verificação SHA-256.
- A APK recebe somente os bytes prontos para impressão e não salva comandas.
- O aplicativo não pede fotos, arquivos, câmera, microfone, contatos,
  localização, acessibilidade nem administração do aparelho.
- Toda comunicação usa HTTPS e o aplicativo aceita apenas o domínio oficial.

## Assinatura e compilação

A chave de produção fica fora do repositório. Guarde com segurança os arquivos
locais de assinatura: sem a mesma chave, o Android não aceitará uma atualização
por cima da versão instalada.

Variáveis esperadas pela compilação de produção:

- `PB_KEYSTORE_PATH`
- `PB_KEYSTORE_PASSWORD`
- `PB_KEY_ALIAS`
- `PB_KEY_PASSWORD`
