# Relatório de segurança — painel, preços e acessos

Data do relatório: 13/09/2026
Projeto: Point Burger
Código analisado: commit `75a84ea893ffb9153c740f0ec3cba23690cc16bf`
Modalidade original: análise e testes isolados; nenhuma correção ou publicação naquela etapa.

## Acompanhamento das correções — 13/09/2026

Após aprovação dos itens 1 e 2, foram implementadas localmente a separação entre
`PAIRING_SECRET` e `PAINEL_SECRET`, sem fallback, e a atualização de sharp para
`0.35.4` com validação do repasse de imagens aos admins. O plano de rotação das
credenciais antigas e os testes estão em
[Segurança: pareamento e imagens](SEGURANCA-PAREAMENTO-IMAGENS.md).

**Não houve deploy nem rotação de credenciais do Railway nesta etapa.** A análise
abaixo é o registro histórico do commit indicado, não uma reavaliação da produção
após correção. A autorização temporária de QR e os demais achados continuam
fora desta implementação.

## Resumo executivo

**Mostrar preços e taxas no navegador é normal. Isso, sozinho, não permite alterar o banco.** O painel exige uma credencial válida, e os valores usados no pedido são calculados no servidor.

As principais fragilidades identificadas estão no controle de acesso ao painel e no processamento de imagens, não em uma SQL injection confirmada.

| ID | Prioridade / gravidade | Resultado |
|---|---|---|
| SEC-01 | Alta | Chave mestra do painel também é usada como credencial na URL de pareamento |
| SEC-02 | Alta, condicionada ao processamento e ambiente | Biblioteca de imagens instalada possui vulnerabilidade publicada |
| SEC-03 | Média | Link já usado pode voltar a funcionar após reinício, dentro da validade |
| SEC-04 | Média | Remover admin não revoga imediatamente links e sessões existentes |
| SEC-05 | Baixa — privacidade | Telefone do admin solicitante aparece no link e no token da página |
| SEC-06 | Média — saída da IA | Campos livres da leitura de comprovantes podem levar instruções ou links ao admin; ataque pela imagem não demonstrado |

“Alta” indica prioridade de tratamento, não evidência de invasão. Não foi feita investigação de incidentes nem comprovado comprometimento em produção.

## Respostas às dúvidas apresentadas

### Os valores deveriam ficar somente no banco?

A configuração é persistida em `config_docs`, carregada pelo servidor e enviada ao navegador quando necessária. Existem arquivos de configuração como valores iniciais e alternativa em caso de indisponibilidade, além de uma cópia em memória. Não é uma configuração mantida apenas no navegador. Evidências: [src/db/queries.js:44](<C:/Users/ferna/Downloads/projeto hamburgueria/src/db/queries.js:44>) e [src/services/config.js:336](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/config.js:336>).

Para exibir um preço, o navegador precisa receber esse preço. A proteção correta é impedir gravações sem autorização e calcular o pedido no servidor, não esconder o preço do cliente.

Alterar o texto da tela com “Inspecionar elemento” muda a cópia local. Uma ferramenta que envie requisições diretamente à API precisa apresentar uma credencial válida para gravar. Essa mesma capacidade é necessária para o admin editar o cardápio.

### Há SQL injection nesse envio de JSON?

Não foi identificada no caminho revisado de leitura e gravação da configuração. O comando SQL usa parâmetros separados, incluindo `$1`, `$2::jsonb` e `$3`. Um teste isolado confirmou que texto com sintaxe SQL permanece como dado, sem ser incorporado ao comando. Evidência: [src/db/queries.js:44](<C:/Users/ferna/Downloads/projeto hamburgueria/src/db/queries.js:44>).

Consultas parametrizadas são a defesa recomendada para esse tipo de injeção; guardar dados no banco, por si só, não oferece essa proteção. [Referência: OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html).

### A URL do painel e os telefones vão para o navegador?

Sim: o navegador recebe a URL que o admin abriu e uma credencial temporária de sessão.

O **telefone do admin que pediu o link** aparece em claro nos dois tokens. Não foi encontrada a lista completa de `ADMIN_PHONE`, a senha do banco ou a chave mestra do painel nos dados enviados pelas páginas normais de cardápio/painel.

Há uma distinção importante: a página de **pareamento do WhatsApp**, separada do painel, exige a própria chave mestra na URL. Esse é o problema SEC-01.

Conhecer apenas o endereço `/painel` ou o telefone do admin não basta para entrar. Porém, copiar um link válido ainda não usado permite utilizá-lo, e copiar uma credencial de sessão válida permite agir como aquele admin até ela expirar.

Uma credencial de sessão deve ser tratada como senha temporária. A assinatura impede adulteração, mas não impede o uso por quem a roubou. [Referência: OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Achados de prioridade alta

### SEC-01 — Chave de assinatura também utilizada na URL de pareamento

**Regra:** EXPRESS-SESS-002 / separação de segredos e credenciais.
**Confiança:** alta sobre o desenho e seu impacto; nenhum vazamento real foi demonstrado.

**Evidências:**

- [src/api/pareamento.js:92](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/pareamento.js:92>): lê `process.env.PAINEL_SECRET` e compara diretamente com `req.query.token`.
- [src/services/painel.js:61](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:61>) e [src/services/painel.js:71](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:71>): essa mesma variável é a chave usada para assinar tokens.
- [src/api/painel.js:77](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel.js:77>): a API aceita uma sessão cuja assinatura passe na validação.

**Impacto:** quem obtiver essa URL de pareamento completa poderá obter a chave com a qual se fabricam acessos ao painel, permitindo alterar cardápio, taxas e promoções e consultar informações acessíveis pelo painel.

O risco é maior que vazar um link temporário: a chave não perde a capacidade de assinar sessões quando o QR desaparece ou quando os 15 minutos de um link comum terminam. O desaparecimento da página após conectar o WhatsApp não revoga a chave.

**Verificação:** em ambiente local, com chave e telefones fictícios, uma sessão assinada usando essa chave compartilhada foi aceita pela API. Nenhuma chave real foi consultada ou utilizada.

**Condição para exploração:** obter a chave ou uma URL de pareamento válida que a contenha. Histórico, compartilhamento de links e registros de URL são superfícies possíveis; não se verificou que algum deles tenha vazado neste sistema.

**Recomendação, não executada:** separar as credenciais de pareamento e assinatura; substituir a chave mestra na URL por autorização temporária e de uso único; revisar a necessidade de rotação da chave atual. Essa rotação encerra acessos existentes e deve ser planejada.

### SEC-02 — Dependência de imagens com vulnerabilidade conhecida

**Regra:** EXPRESS-DEPS-001 / processamento seguro de mídia.
**Confiança:** alta sobre a versão afetada e a existência do caminho de processamento; exploração no Railway não demonstrada.

**Evidências:**

- [package-lock.json:2754](<C:/Users/ferna/Downloads/projeto hamburgueria/package-lock.json:2754>): versão fixada de `sharp` é `0.35.3`.
- A árvore instalada confirma `Baileys 7.0.0-rc14 → sharp 0.35.3`.
- A auditoria das dependências de produção retornou um alerta de gravidade alta.
- [src/bot/router.js:617](<C:/Users/ferna/Downloads/projeto hamburgueria/src/bot/router.js:617>) encaminha imagens de atendimento humano antes da validação específica de comprovantes.
- [src/services/atendimento.js:288](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/atendimento.js:288>) repassa o buffer recebido aos admins.
- [src/bot/index.js:396](<C:/Users/ferna/Downloads/projeto hamburgueria/src/bot/index.js:396>) entrega esse buffer ao envio de imagens do Baileys.
- A dependência gera miniaturas e utiliza `sharp`: [node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:135](<C:/Users/ferna/Downloads/projeto hamburgueria/node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:135>) e [node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js:97](<C:/Users/ferna/Downloads/projeto hamburgueria/node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js:97>).

**Impacto potencial:** uma imagem especialmente preparada, caso alcance o decodificador afetado em um ambiente vulnerável, pode comprometer o processamento e, nas condições descritas pelo fabricante, permitir execução de código no servidor.

O aviso oficial afeta versões anteriores a `0.35.4` e descreve condições específicas envolvendo libheif e Linux/glibc. A correção indicada é `sharp >= 0.35.4`. [Aviso do mantenedor do sharp](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

**Limites:** não foram enviados arquivos maliciosos, testado um exploit ou inspecionados os binários do container. A validação de comprovantes já restringe formatos; o caminho de atendimento humano não utiliza essa mesma validação antes do repasse. Não se deve interpretar o alerta como prova de que qualquer foto comum permita invadir.

**Recomendação, não executada:** atualizar controladamente a dependência, testar o envio de imagens e validar tipo real e tamanho também no repasse de atendimento humano. Confirmar a versão efetivamente instalada no servidor.

## Achados de prioridade média

### SEC-03 — Uso único do link não persiste após reinício

**Regra:** EXPRESS-SESS-002 / ciclo de vida de autenticação.
**Confiança:** alta, reproduzido localmente.

**Evidências:** [src/services/painel.js:39](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:39>), [src/services/painel.js:52](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:52>) e [src/services/painel.js:158](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:158>).

O link vale 15 minutos, mas o registro de que já foi utilizado fica somente em um `Map` da memória do processo.

**Verificação:** um link fictício abriu uma vez, foi recusado na segunda tentativa e voltou a ser aceito após limpar exclusivamente esse registro em memória, reproduzindo a perda de estado de um reinício.

**Impacto:** alguém que tenha uma cópia de um link usado poderá reutilizá-lo se houver reinício antes de sua validade terminar. Múltiplas instâncias sem armazenamento compartilhado também não compartilham a marcação de uso.

**Condição:** o atacante ainda precisa possuir o link completo; isso não permite adivinhar credenciais.

**Recomendação, não executada:** persistir o consumo do link com operação atômica e expiração. O PostgreSQL já utilizado pelo projeto pode cumprir esse papel, sem exigir um novo serviço.

### SEC-04 — Sessões e links antigos não verificam se o admin ainda está autorizado

**Regra:** EXPRESS-SESS-002 / revogação de acesso.
**Confiança:** alta, reproduzido localmente.

**Evidências:** [src/services/painel.js:99](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:99>), [src/services/painel.js:172](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:172>) e [src/api/painel.js:77](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel.js:77>).

A validação verifica assinatura, tipo e validade. Não consulta a lista atual de admins nem um registro de revogação.

**Verificação:** após emitir uma sessão fictícia, a lista de admins foi substituída apenas no processo de teste. A sessão anterior continuou válida.

**Impacto:** remover um telefone das configurações não encerra imediatamente o acesso já concedido. Uma sessão normal dura 30 minutos. Um link antigo ainda válido também pode criar uma nova sessão, mesmo depois da retirada de permissão.

**Condição:** possuir credencial anteriormente emitida. Não é uma forma de entrar sem credencial.

**Recomendação, não executada:** conferir autorização vigente ao abrir o link e utilizar a API; permitir revogação individual e encerramento de sessões. A mudança global da chave invalida todos os tokens, mas é uma medida ampla, não uma revogação individual.

## Achado de privacidade

### SEC-05 — Telefone do solicitante visível nos tokens

**Regra:** minimização de dados em identificadores de sessão.
**Gravidade:** baixa.
**Confiança:** alta, reproduzido localmente.

**Evidências:** [src/services/painel.js:91](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:91>), [src/services/painel.js:141](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/painel.js:141>), [src/api/painel-page.js:83](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel-page.js:83>) e [src/api/painel-page.js:771](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel-page.js:771>).

O formato inclui tipo, telefone, validade, identificador e assinatura. O link leva esse conteúdo na URL, e o token da sessão fica em um atributo do HTML.

**Impacto:** o número do solicitante pode aparecer para quem acessar ou compartilhar o link, o histórico ou o HTML da página. A exposição da credencial inteira permite reutilização durante sua validade.

**Limites:** não é divulgação da lista de todos os admins. O teste confirmou que editar apenas o telefone, sem recalcular a assinatura, invalida o token.

**Recomendação, não executada:** usar identificadores aleatórios sem telefone, mantendo a associação no servidor; retirar o token de entrada da URL depois da autenticação. Avaliar sessão em cookie HttpOnly/Secure com controles adequados para requisições de alteração.

## Adendo — prompt injection em comprovantes Zelle

Escopo confirmado pelo responsável: a conferência do recebimento e dos valores permanece humana. Este adendo trata de impedir que conteúdo do comprovante vire instrução para a IA, para o sistema ou para o admin. Não propõe mudar a liberação da comanda, o pagamento, a retirada ou a entrega.

### SEC-06 — Campos livres podem transportar instruções ou links ao admin

**Regra:** saída de IA deve continuar sendo tratada como conteúdo não confiável.
**Gravidade:** média, pelo potencial de engenharia social no canal administrativo.
**Confiança:** alta sobre a aceitação de texto na saída; não foi comprovado que uma imagem consiga induzir esse comportamento no modelo real.

**Ameaça:** instruções inseridas na imagem podem tentar mudar a tarefa do leitor ou aparecer no texto apresentado ao admin. A OWASP reconhece prompt injection multimodal como uma categoria de ataque. Isso não implica que toda informação escondida em metadados seja lida pelo modelo, nem que código escrito numa imagem seja automaticamente executado. [Referência: OWASP — Multimodal Injection](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html#multimodal-injection).

**Evidências no código:**

- [src/services/leitura-comprovante.js:34](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:34>) remove caracteres de formatação e controles e limita o tamanho, mas mantém texto e URLs comuns.
- [src/services/leitura-comprovante.js:39](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:39>) valida a estrutura do JSON. Os campos `destinatario` e `data` continuam aceitando texto livre.
- [src/services/leitura-comprovante.js:99](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:99>) incorpora esses dois campos à mensagem de apoio à conferência.
- [src/texto.js:47](<C:/Users/ferna/Downloads/projeto hamburgueria/src/texto.js:47>) normaliza a mensagem para o admin, sem neutralizar URLs.

**Verificação realizada:** um teste local simulou uma resposta do modelo com uma URL inofensiva em domínio reservado `.invalid` no destinatário e uma instrução no campo de data. Ambos passaram pela validação e permaneceram no resumo. Não foi acessado o link, enviado WhatsApp, consultado banco ou feita chamada à IA.

**Impacto:** se o modelo copiar conteúdo desse tipo de uma imagem, o admin pode receber um link ou uma orientação enganosa dentro do bloco “leitura da IA”. Isso pode incentivar uma ação humana indevida. Não foi encontrado, nesse leitor, um caminho que execute automaticamente esse texto como comando de admin, SQL ou alteração do cardápio.

**Condição para exploração:** o conteúdo malicioso precisa chegar à saída do modelo e, para produzir o impacto descrito, enganar alguém que leia a mensagem. O teste do validador confirma a passagem da saída; não confirma um ataque completo pela imagem.

### Proteções que já existem e devem ser preservadas

1. **Leitura isolada, sem ferramentas de ação.** A chamada recebe somente instruções fixas de extração e a imagem. Não recebe ferramentas de pedido/admin, histórico da conversa, carrinho, valor esperado ou credenciais dentro do prompt: [src/ai/mistral.js:210](<C:/Users/ferna/Downloads/projeto hamburgueria/src/ai/mistral.js:210>). A chave da API é usada pelo cliente para autenticar a requisição, não apresentada como texto ao modelo.
2. **Imagem explicitamente tratada como dado não confiável.** O prompt manda ignorar instruções escritas nela: [src/services/leitura-comprovante.js:7](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:7>). Essa orientação ajuda, mas não deve ser a única proteção.
3. **Resposta limitada a seis campos.** Há JSON Schema estrito, rejeição de campos extras e nova validação no servidor: [src/services/leitura-comprovante.js:21](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:21>) e [src/services/leitura-comprovante.js:39](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/leitura-comprovante.js:39>). Isso limita a forma da saída, não garante que o conteúdo de um campo seja confiável.
4. **Mensagem final montada pelo código.** A resposta não é enviada como uma conversa livre do modelo. O sistema usa rótulos próprios e alerta de conferência humana.
5. **Limites e tratamento de falhas.** A leitura tem limite de resposta, tempo máximo e nenhuma repetição automática no SDK; falha ou saída inválida resulta em leitura indisponível, sem execução de instruções.
6. **Higiene de texto.** Controles, caracteres invisíveis e determinadas marcações já são removidos. Isso não identifica todas as instruções escritas em linguagem natural.
7. **Separação do fluxo operacional.** A saída da leitura não decide a liberação da comanda nem aprova o pagamento no banco. A regra operacional atual permanece separada dessa análise.

As três suítes locais `comprovantetest`, `leituracomprovantetest` e `comprovanteleiturafluxotest` passaram na verificação anterior deste comprovante. Elas usam simulações; não medem a resistência do modelo real a imagens adversariais. [test/leituracomprovantetest.js:40](<C:/Users/ferna/Downloads/projeto hamburgueria/test/leituracomprovantetest.js:40>) verifica ausência de ferramentas, e [test/leituracomprovantetest.js:69](<C:/Users/ferna/Downloads/projeto hamburgueria/test/leituracomprovantetest.js:69>) cobre limpeza de texto e rejeição de campos adicionais.

### Como reforçar a proteção sem mudar o fluxo

As recomendações abaixo são propostas, não alterações já implementadas.

| Prioridade | Medida recomendada | Efeito esperado e limite |
|---|---|---|
| 1 | Preservar o leitor sem ferramentas e impedir que sua saída seja encaminhada ao roteador de comandos, à conversa principal ou à memória de instruções | Mesmo que a IA seja influenciada, o resultado continua sem autoridade para agir |
| 1 | Validar os campos também pelo conteúdo: neutralizar links, rejeitar instruções evidentes e textos incompatíveis com destinatário/data | Reduz o risco de orientação enganosa ao admin; regras por palavras-chave não detectam todos os ataques |
| 1 | Em saída inválida ou suspeita, omitir o campo ou o resumo automático e mostrar um aviso fixo para conferência manual | Não repetir a instrução suspeita na própria mensagem de alerta; não alterar pedido, pagamento ou impressão |
| 2 | Manter avisos e botões/comandos administrativos definidos exclusivamente pelo código | A IA não deve criar comandos, contatos de pagamento, links de painel ou instruções operacionais |
| 2 | Testar regressões com dados sintéticos e simulações de respostas hostis | Provar que as barreiras do código continuam funcionando após alterações de modelo ou SDK |
| 2 | Registrar apenas eventos mínimos de saída rejeitada e motivo técnico | Permite acompanhar tentativas sem gravar imagem, base64, credenciais ou conteúdo bancário completo |
| 3 | Avaliar normalização da imagem em memória, remoção de metadados e limites de dimensões/pixels | Pode reduzir conteúdo extra e abuso de recursos, mas não elimina instruções visíveis nos pixels; depende de bibliotecas corrigidas, conforme SEC-02 |

Para destinatários, evitar uma restrição que aceite apenas letras: comprovantes legítimos podem mostrar telefone, e-mail ou identificador mascarado. O filtro deve distinguir esses dados de links de navegação e orientações. Para datas não reconhecidas com segurança, preferir “não identificada” a inventar uma data.

**Não basta:** acrescentar mais uma frase no prompt, colocar temperatura zero, retirar metadados ou usar uma segunda IA como filtro. Essas medidas não substituem a ausência de ferramentas, a validação da saída e a separação de permissões. A defesa recomendada é em camadas. [Referência: OWASP — LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

### Testes sugeridos para uma implementação futura

- Instruções disfarçadas em imagens sintéticas, em idiomas diferentes, com texto pequeno ou pouco contraste: avaliar a saída sem dados de clientes.
- JSON com campos extras, texto fora do JSON, URLs, marcação, caracteres de controle e instruções dentro de campos permitidos.
- Tentativas de fazer o resumo apresentar um comando administrativo ou novo contato de pagamento.
- Resultado suspeito ou leitura indisponível: nenhuma execução de ferramenta, gravação de configuração, criação de pedido ou alteração do fluxo já aprovado.
- Telefone, e-mail e identificadores mascarados legítimos: não bloquear a leitura normal por excesso de filtragem.
- Repetir testes controlados quando mudar modelo, prompt ou SDK. Testes reais com IA ficam para uma etapa autorizada; não foram executados neste adendo.

Critério de aceitação: conteúdo extraído é exibido somente como dado de conferência. Nunca vira instrução executável, fonte de configuração ou permissão administrativa.

### Distinções importantes

- **Comprovante falso ou valor incorreto:** continua sob conferência humana, como definido pelo responsável. Este adendo não modifica essa decisão.
- **Prompt injection:** tenta influenciar a interpretação ou a saída do modelo. É o foco deste adendo.
- **Arquivo que explora uma biblioteca de imagem:** é uma vulnerabilidade de processamento, tratada em SEC-02. Reescrever o prompt não corrige esse problema.
- **Não armazenar a imagem:** evita persistência local/bucket, mas não impede ataques durante o processamento em memória ou a leitura pela IA.

Conclusão: a principal barreira contra ações automáticas já está presente no leitor isolado. A melhoria mais direta é reforçar o tratamento dos campos de saída antes de apresentá-los ao admin, mantendo a conferência humana e todo o fluxo operacional atual.


## Melhorias adicionais — não equivalem a invasão comprovada

### Proteção contra scripts no painel

[src/api/painel.js:67](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel.js:67>) permite scripts inline. Isso reduz a proteção adicional que a política CSP oferece caso outra falha permita inserir HTML malicioso.

Nos trechos revisados, o painel constrói elementos e insere texto sem `innerHTML`; o cardápio público escapa conteúdo. Não foi comprovado um caminho de XSS originado de um produto ou conversa. Evidências: [src/api/painel-page.js:95](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel-page.js:95>) e [src/api/cardapio.js:44](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/cardapio.js:44>).

Recomendação: política de scripts com nonce/hash e exposição mínima da credencial à página. Classificação: melhoria de defesa, não XSS confirmado.

### Histórico de alterações e alertas não são garantidos

[src/services/config.js:322](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/config.js:322>) grava a configuração antes de tentar registrar o histórico. Se o histórico falhar, a alteração permanece. O aviso de edição também é de melhor esforço e vai apenas ao primeiro admin: [src/api/painel.js:214](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/painel.js:214>) e [src/bot/notify.js:119](<C:/Users/ferna/Downloads/projeto hamburgueria/src/bot/notify.js:119>).

Isso não permite entrar no painel, mas pode dificultar detectar e reconstruir alterações indevidas.

Recomendação: registro de alteração garantido junto à gravação, comparação de antes/depois calculada no servidor e alertas para os responsáveis definidos pela loja.

### Comentário de segurança desatualizado

[config/delivery.json:7](<C:/Users/ferna/Downloads/projeto hamburgueria/config/delivery.json:7>) afirma que nenhum endpoint escreve configuração e que o arquivo é a única fonte. Hoje existe edição autenticada pelo painel com persistência no banco.

Esse texto não é uma barreira de segurança e não corresponde à arquitetura atual. Deve ser atualizado em uma futura correção documental.

### Limitação de tentativas e infraestrutura

Não foi localizado limitador específico nas rotas do painel e pareamento. A API de vinculação da impressora possui um limitador próprio. Não foi auditada a proteção oferecida pelo proxy ou pelo Railway.

Recomendação: verificar proteção contra abuso nessas rotas. Ausência de limitação não torna uma assinatura forte adivinhável; o risco adicional principal é abuso de recursos e tentativas repetidas.

## Proteções verificadas

- API do painel exige token antes das rotas de leitura e gravação.
- POST de alteração sem credencial foi recusado em teste local, com resposta 401.
- Mudança de telefone em token sem assinatura correspondente foi recusada.
- Consultas de configuração usam parâmetros SQL separados.
- Documentos editáveis são limitados a menu, promoções, ingredientes, entrega e horário: [src/services/config.js:50](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/config.js:50>).
- Preços e taxas de cidades passam por validação numérica no servidor; valores negativos e não finitos são rejeitados nesses campos: [src/services/config.js:164](<C:/Users/ferna/Downloads/projeto hamburgueria/src/services/config.js:164>).
- A ferramenta de adicionar produto utiliza preço cadastrado mais os adicionais validados, não um preço livre fornecido pelo cliente: [src/ai/tools.js:895](<C:/Users/ferna/Downloads/projeto hamburgueria/src/ai/tools.js:895>).
- O resumo calcula subtotal e entrega no servidor: [src/bot/handlers/order.js:181](<C:/Users/ferna/Downloads/projeto hamburgueria/src/bot/handlers/order.js:181>).
- Os adaptadores de catálogo extraem produto e quantidade, sem adotar o preço enviado no pedido externo: [src/bot/catalog/adapters.js:45](<C:/Users/ferna/Downloads/projeto hamburgueria/src/bot/catalog/adapters.js:45>).
- Cardápio público não possui rota de edição; recursos estáticos são servidos de um diretório específico, não da raiz do projeto: [src/api/index.js:47](<C:/Users/ferna/Downloads/projeto hamburgueria/src/api/index.js:47>).
- Testes existentes confirmaram rejeição de webhook sem assinatura válida e autenticação da impressão.

Essas verificações não garantem ausência de falhas em todos os caminhos do sistema.

## Verificações executadas e limites

### Consulta pública, sem credenciais

Foram feitos somente GETs sem autenticação em `https://bot.pointburgerjg.com`:

| Caminho | Resposta |
|---|---:|
| /painel | 401 |
| /painel/api/config/delivery | 401 |
| /painel/api/config/menu | 401 |
| /pareamento | 404 |

Nenhuma tentativa de gravação, exploração ou sessão administrativa foi realizada em produção.

### Testes locais

Sete suítes existentes concluíram com sucesso:

- paineltest
- painelrelatoriotest
- segurancatest
- pareamentotest
- printeragenttest
- catalogservicetest
- catalogordertest

Testes adicionais em memória, com credenciais fictícias e banco substituído por um simulador, confirmaram as condições dos achados SEC-01, SEC-03, SEC-04 e SEC-05, além das proteções de autenticação e parametrização SQL.

A auditoria de dependências foi apenas consultiva. Nenhum pacote do projeto foi atualizado.

### Escopo e exclusões

A revisão usou a skill `security-best-practices`, da coleção OpenAI, com referências de Express e JavaScript de navegador. Ela ampliou a análise para sessões, autorização, scripts, exposição de dados, integridade dos preços e dependências.

A skill foi instalada conforme solicitado, fora do projeto; ficou disponível no catálogo do Codex durante a conversa. O mecanismo específico de varredura da Claude Security não estava disponível e não foi utilizado.

Não houve pentest completo, carga agressiva, revisão de todos os cenários de prompt injection, análise dos celulares, busca de vazamentos em históricos ou inspeção das permissões internas do Railway/PostgreSQL. Valores atuais de cada produto não foram comparados com o banco nesta revisão.

## Ordem sugerida para uma eventual correção

1. Separar a chave de pareamento da chave de assinatura e planejar tratamento de credenciais antigas.
2. Resolver o alerta da biblioteca de imagens com atualização testada e validação do caminho de repasse.
3. Persistir o uso único dos links e implementar revogação de acessos.
4. Retirar telefones dos tokens e reforçar a proteção das sessões no navegador.
5. Melhorar histórico, alertas e documentação.
6. Reforçar a proteção contra prompt injection nos comprovantes conforme SEC-06, sem mudar o fluxo de pagamento ou a conferência humana.

**Este documento é somente um relatório. Não foram alterados código do bot, preços, dados, variáveis do Railway ou configuração de produção. Não houve commit, push ou deploy.**
