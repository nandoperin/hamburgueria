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

## Produtos visíveis no aplicativo, mas leitura vazia pelo Baileys

Diagnóstico independente: o administrador pode enviar `!catalogo colecoes`.
Consulta somente as coleções, sem passar primeiro pelo catálogo geral. Usa o
pedido nativo getCollections (`smax_id: 35`), telefone explícito, até 50 coleções
e 50 itens por coleção, com prazo de 60 segundos (padrão da versão instalada).
O bot avisa que está consultando e responde com contagens e alguns nomes, ou
código/status da falha. Uma consulta por vez. Não chama IA, banco ou operações
de escrita no catálogo. Nenhum resultado é usado para liberar a importação.

Timeout lançado como 408 e resposta ausente ocultada pelo SDK são falhas,
nunca "zero produtos". Os logs usam `evt: catalogo_leitura`, com códigos
`colecoes_*`. A aceitação real só pode ser comprovada na conexão viva depois do
deploy; testes locais validam o protocolo e as proteções, não o servidor WhatsApp.

`parseCatalogNode` do SDK também retorna `products: []` quando o envelope
`product_catalog` não está presente. Portanto, zero produtos não comprova catálogo
vazio nem erro de moeda. A leitura da importação agora verifica o envelope original
antes de usar o parser da versão instalada, sem alterar node_modules.

Consulta explicitamente o telefone da conexão como `@s.whatsapp.net`, com o mesmo
protocolo de leitura do SDK, em páginas de até 50. Na primeira página vazia ou
inesperada, tenta uma vez com o tamanho padrão de 10. Um resultado desconhecido
bloqueia a importação. A consulta às coleções serve apenas para diagnosticar a
divergência: nunca se usa uma lista possivelmente parcial para excluir produtos.

O log `evt: catalogo_leitura` contém apenas códigos, contagens, status numéricos e
tags estruturais conhecidas, sem conteúdo de produtos, URLs de fotos ou credenciais.
Nenhuma promessa de compatibilidade no número real: depois do deploy, validar
`!catalogo conferir` na conexão viva. Se persistir, a mensagem identifica a etapa
e o log estrutural permite investigar a resposta, em vez de adivinhar preços.

## Se o catálogo de teste não tiver os mesmos produtos/preços

A tentativa original depende de referências iguais entre os dois cardápios. Se
elas não existirem ou os preços antigos forem diferentes, ela não pode determinar
a conversão. Não significa que os 28 produtos novos estejam errados.

Envie `!catalogo conferir`. É somente leitura: lista alguns produtos do Business
e devolve um comando com o número do bot e o ID de um produto preenchidos.
Confira no próprio aplicativo o preço ATUAL desse produto e substitua `VALOR`
no comando, com duas casas decimais. Ao enviá-lo, começa a importação.

Essa confirmação independe do nome e preço dos produtos novos. Ela vale por
10 minutos, para o mesmo administrador e a mesma conexão, e exige que o produto
não tenha mudado de nome, moeda ou preço desde a leitura. Sem preço em USD,
não tenta converter moedas. Nenhuma escala é adotada como padrão por falta de dados.

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
  entre referências impede a operação automática, em vez de arriscar um preço
  incorreto. O caminho `!catalogo conferir` permite confirmar explicitamente o
  preço atual de um produto e determinar a escala sem depender do menu antigo.
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
