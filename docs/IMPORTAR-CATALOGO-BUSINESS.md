# Copiar os 28 produtos do bot para o WhatsApp Business

Importação pontual autorizada para o catálogo de teste. Não é sincronização automática:
o checkout continua calculando preços pelo cardápio do servidor.

Depois do deploy, o administrador envia ao bot:

```text
!importar catalogo NUMERO_DO_BOT
```

Substituir NUMERO_DO_BOT pelos dígitos completos, com país, do WhatsApp conectado.
Não é o número do administrador. O remetente deve corresponder exatamente a uma
entrada completa de ADMIN_PHONE. Nenhuma variável nova ou novo pareamento é necessário.
Nenhum catálogo é alterado apenas por fazer deploy ou reiniciar.

## Comportamento

- Lê todas as páginas do catálogo da própria sessão; nunca aceita outro JID.
- Usa os 28 produtos da configuração carregada pelo bot, com preços USD e descrições
  que já incluem ingredientes. Inclui bebidas e adicionais.
- Reaproveita cadastros pelo ID interno/retailerId ou nome normalizado, preservando
  a foto. Produtos sem correspondência usam uma foto existente da mesma categoria
  quando disponível; senão, outra foto do catálogo de teste. Esses produtos recebem
  a observação de imagem ilustrativa na descrição.
- Somente URLs HTTPS de mídia em subdomínios whatsapp.net retornadas pelo próprio
  catálogo são aceitas. Sem foto reutilizável, interrompe antes de escrever.
- A unidade de `price` não é convertida pelo SDK. Antes de escrever, confere uma
  escala única (1, 100 ou 1000) usando pelo menos dois produtos existentes de valores
  distintos, cujos nomes/IDs e preços correspondam ao menu. Qualquer divergência
  entre referências impede a operação, em vez de arriscar um preço incorreto.
- Salva os dados anteriores no volume, em auth_info_baileys/catalog-backups/.
  Essa cópia contém metadados e URLs, não os arquivos das imagens: URLs podem expirar.
  Permite consulta/recadastro manual, não garante restauração de fotos ou IDs antigos.
  Não é pública nem versionada. A limpeza da sessão também remove essa cópia.
- Cria/atualiza sequencialmente, sem IA e sem repetir criações após timeout.
- Só remove IDs excedentes da leitura inicial depois de reler e conferir todos os
  28 cadastros. Se alguém editar um item excedente durante a operação, cancela a limpeza.
- Repetir o comando relê o estado; cadastros já corretos não são recriados.
- A resposta final diferencia sucesso de conferência pendente/erro. O WhatsApp pode
  ainda submeter os produtos à revisão. Os testes locais não comprovam aceitação real.

## Se interromper

Enviar a mensagem de erro ao responsável técnico. Uma falha não desfaz automaticamente
atualizações já aceitas pelo WhatsApp. Antes da fase de limpeza, nenhum item antigo
é excluído. Uma falha durante a limpeza pode deixar apenas parte dos excedentes removida.
Não apagar o catálogo manualmente antes de resolver: ele é a fonte das fotos e da
conferência da unidade de preço. Não criar outra sessão Baileys para executar esta operação.
