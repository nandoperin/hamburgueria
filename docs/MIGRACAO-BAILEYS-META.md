# Migração do Baileys para a API oficial da Meta

Este é um roteiro de preparação e operação futura. A existência do código para
o provedor Meta não comprova aprovação da conta, elegibilidade do número,
liberação de coexistência nem homologação do catálogo. Confirme essas condições
no ambiente oficial da Meta antes de marcar uma virada.

## Pré-requisitos

- Acesso administrativo ao portfólio empresarial, ao aplicativo e à conta do
  WhatsApp Business que serão usados na integração.
- Número de homologação separado do atendimento atual, enquanto a elegibilidade
  e a coexistência do número principal não estiverem confirmadas pela Meta.
- Aplicativo da Meta configurado para WhatsApp, com permissões e revisão que a
  Meta exigir no momento da implantação.
- Catálogo criado no Commerce Manager e associado à conta correta do WhatsApp.
- Produtos do catálogo conciliados com os itens disponíveis no painel.
- Webhook público com HTTPS e assinatura obrigatória validada.
- Responsável, janela de mudança, critérios de sucesso e autorização de retorno
  definidos antes da virada.

Não cadastre credenciais reais neste documento. Não presuma que uma etapa
administrativa foi aprovada apenas porque o código inicia localmente.

## Coexistência com o WhatsApp Business

O atendimento atual continua no WhatsApp Business com Baileys durante a
preparação. Faça a homologação da Meta em outro número até que o fluxo oficial
de cadastro informe explicitamente que o número principal pode coexistir com o
aplicativo e que essa opção foi habilitada para a conta.

As regras e a disponibilidade de coexistência podem variar por conta e mudar
com a plataforma. Registre o que a tela oficial da Meta apresentar no dia da
implantação. Não desconecte o aplicativo, não migre o número principal e não
apague a sessão do Baileys como experimento.

Mesmo quando a coexistência estiver disponível, somente um provedor deve
processar cada mensagem no bot. Duas instâncias atendendo o mesmo evento podem
duplicar respostas e pedidos.

## Catálogo no Commerce Manager

1. Crie ou selecione o catálogo da empresa no Commerce Manager.
2. Confirme que ele pertence ao mesmo portfólio e pode ser associado à conta do
   WhatsApp usada na homologação.
3. Cadastre foto, nome e descrição correspondentes ao produto do painel.
4. Preencha o identificador do varejista conforme a convenção da seção seguinte.
5. Associe o catálogo ao canal do WhatsApp somente no ambiente de homologação.
6. Aguarde o processamento e a disponibilidade dos produtos antes do teste de
   carrinho.

O preço exibido no Commerce Manager é informação de vitrine. O preço cobrado e
a disponibilidade continuam vindo do painel e da configuração interna. Uma
divergência deve ser corrigida, mas nunca deve tornar o valor recebido da Meta
autoridade de cobrança.

## Convenção de product_retailer_id

Para cada produto, `product_retailer_id` deve ser exatamente igual ao `item.id`
interno do painel. O valor é estável, único e não deve ser traduzido, abreviado
ou reaproveitado em outro produto.

O carrinho da Meta chega com esse identificador e é normalizado como
`CatalogOrder`. No Baileys, o produto é resolvido pelo nome único em português e
normalizado para o mesmo formato. Os dois caminhos seguem por `routeOrder`, que
aplica as mesmas regras internas de quantidade, preço e disponibilidade.

Antes de publicar um produto, confira a correspondência com o painel. Se o
identificador não existir, o bot deve recusar o item; não corrija o problema
aceitando preço ou descrição enviados pelo WhatsApp.

## Variáveis do Railway

Registre os valores somente no gerenciador de variáveis do ambiente. Neste
documento ficam apenas os nomes e a origem operacional de cada dado.

| Nome | Onde obter ou definir |
|---|---|
| `WHATSAPP_PROVIDER` | Seleção operacional do provedor feita pela equipe responsável pela implantação. |
| `META_PHONE_NUMBER_ID` | Identificador do número exibido na configuração da API do WhatsApp no aplicativo da Meta. |
| `META_ACCESS_TOKEN` | Credencial emitida pela Meta para a integração, com as permissões mínimas necessárias e gestão de validade definida. |
| `META_VERIFY_TOKEN` | Frase secreta criada pela equipe para o handshake; deve coincidir no ambiente e na configuração do webhook. |
| `META_APP_SECRET` | Segredo do aplicativo disponível nas configurações do aplicativo da Meta. |
| `META_CATALOG_ID` | Identificador do catálogo exibido no Commerce Manager. |

Não copie valores para chamados, commits, capturas de tela, relatórios ou logs.
Restrinja o acesso e estabeleça rotação antes da produção.

## Webhook e assinatura

O endpoint implementado é `/meta/webhook`:

- a requisição de verificação compara o token informado pela Meta com a
  configuração do ambiente;
- mensagens recebidas só são aceitas com assinatura válida no cabeçalho
  `X-Hub-Signature-256`;
- em produção, a ausência do segredo do aplicativo fecha o webhook;
- eventos de texto seguem para `route` e pedidos do catálogo seguem para
  `routeOrder` depois de passar pelo adaptador da Meta.

Cadastre a URL pública HTTPS no aplicativo da Meta, conclua o handshake e
assine os eventos necessários primeiro no número de homologação. Uma resposta
de verificação bem-sucedida prova somente o handshake; não prova envio,
recebimento, catálogo, permissões ou aprovação comercial.

## Teste em número de homologação

Use um número sem tráfego real e execute, nesta ordem:

1. Inicie o serviço com o provedor Meta no ambiente de homologação e confira o
   boot sem expor credenciais.
2. Envie e receba texto simples.
3. Abra o catálogo, selecione um produto e várias unidades e envie o carrinho.
4. Confirme que o produto entra uma vez, com a quantidade correta.
5. Altere o preço apenas no painel de homologação e confira que o resumo usa o
   painel, não o catálogo.
6. Marque o item como indisponível no painel e confira que o carrinho é recusado.
7. Depois do carrinho, escreva uma retirada e um adicional permitidos; confirme
   que a IA usa `personalizar_item`, que a retirada é grátis e que o adicional
   usa o painel.
8. Repita sem pedir alteração e confirme que não há pergunta de ingredientes,
   oferta de bebida ou upsell.
9. Percorra entrega e retirada até o resumo e envie uma imagem de comprovante
   de teste, sem dados bancários reais.
10. Reenvie o mesmo evento e confirme que não duplica item, resposta ou pedido.

Registre data, resultado e evidência sanitizada. Não use a conta de produção
para descobrir permissões ou corrigir cadastro.

## Virada de WHATSAPP_PROVIDER

Só autorize a mudança depois de todos os testes de homologação passarem, da
Meta confirmar a situação administrativa necessária e de existir uma janela
com responsável disponível para retorno.

1. Preserve a sessão e o volume do Baileys; não apague nem esvazie o conteúdo.
2. Confirme o catálogo vinculado, o webhook assinado e as credenciais no
   ambiente de produção sem mostrá-las.
3. Garanta que não exista outra instância do bot processando o mesmo número.
4. Selecione o provedor Meta na configuração do ambiente e faça uma única
   implantação controlada.
5. Confira no boot qual provedor foi selecionado e acompanhe texto, carrinho e
   erros do webhook.
6. Execute imediatamente a validação da seção seguinte.

Não mude catálogo, preço, pagamento, impressora e provedor na mesma janela. A
virada deve ter uma causa isolada e uma volta simples.

## Validação de texto, carrinho e comprovante

Depois da virada, use um pedido controlado e confirme:

- texto de entrada e resposta chegam uma única vez;
- o catálogo abre e o carrinho preserva produto e quantidade;
- `product_retailer_id` resolve o item interno esperado;
- preço, disponibilidade, retirada e adicionais obedecem ao painel;
- o bot não pergunta personalização nem oferece upsell sem solicitação;
- uma alteração escrita usa `personalizar_item` e aparece no resumo;
- entrega e retirada chegam ao resumo calculado pelo sistema;
- a imagem de comprovante segue pelo fluxo existente sem dados financeiros
  reais na homologação;
- não surgem pedidos ou respostas duplicadas.

Interrompa a validação e volte para Baileys se houver perda de mensagem,
assinatura inválida persistente, item incorreto, preço divergente, duplicidade
ou indisponibilidade que impeça o atendimento.

## Desativação segura do volume Baileys

O volume não participa do funcionamento do provedor Meta, mas é a volta mais
rápida enquanto a migração ainda está em observação. Não o apague na virada.

Depois de uma janela de estabilidade aprovada:

1. Confirme que nenhum processo Baileys está em execução.
2. Registre a data da última conexão e o responsável pela retenção.
3. Remova apenas a montagem do serviço ativo, mantendo o conteúdo preservado
   durante o período de rollback definido pela equipe.
4. Trate a exclusão definitiva como mudança separada, com autorização e prova
   de que o retorno já não depende daquela sessão.

Nunca monte a mesma sessão em duas instâncias. Não use a desativação do volume
como forma de testar a Meta.

## Retorno imediato para Baileys

O retorno é indicado quando o provedor Meta não mantém texto e carrinho
confiáveis ou quando a situação administrativa da conta impede produção.

1. Pare a instância que recebe os webhooks da Meta para o número em produção.
2. Restaure a seleção do provedor Baileys.
3. Reassocie o volume preservado ao único serviço autorizado.
4. Inicie uma única instância e confirme no log que o WhatsApp conectou.
5. Envie texto e um carrinho de controle; confira reconhecimento pelo nome único
   em português, quantidade, preço do painel e ausência de duplicidade.
6. Mantenha o webhook da Meta sem processamento de produção até a causa ser
   entendida; não apague credenciais ou catálogo durante o incidente.

Se a sessão preservada tiver sido revogada, faça um novo pareamento seguindo
`docs/OPERACAO.md`. Não execute Meta e Baileys simultaneamente para compensar
uma falha: isso aumenta o risco de pedido duplicado.
