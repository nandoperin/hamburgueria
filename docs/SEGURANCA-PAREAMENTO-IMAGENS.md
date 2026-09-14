# Segurança: pareamento e repasse de imagens

Data inicial: 13/09/2026. Atualizado em 14/09/2026.

## Estado da mudança

SEC-01 e SEC-02 já haviam sido corrigidos e publicados. Em 14/09, a URL
estática do QR também foi substituída localmente por autorização temporária de
uso único. Esta segunda etapa ainda não foi publicada e não alterou variáveis,
dados ou credenciais do Railway.

### Chaves independentes

| Variável | Uso | Efeito da troca |
|---|---|---|
| `PAINEL_SECRET` | Derivar hashes de links e sessões opacos do `!painel`; fica no servidor | Invalida links e sessões da chave antiga |
| `PAIRING_SECRET` | Derivar credenciais temporárias da página de QR; fica no servidor | Invalida links e cookies de QR, sem invalidar o painel |

A página de QR exige `PAIRING_SECRET` com pelo menos 32 caracteres e diferente de `PAINEL_SECRET`. Configuração ausente, curta ou reutilizada retorna 404. Não existe fallback para a chave antiga. Isso desabilita somente a página de QR: não desconecta o WhatsApp que já esteja pareado.

O QR continua disponível apenas enquanto há pareamento pendente. Ao surgir a
primeira imagem de QR, o log do Railway mostra um link aleatório válido por 10
minutos. Ele abre uma vez, troca a autorização por cookie `HttpOnly`, `Secure`
e `SameSite=Strict`, redireciona para a URL limpa e permite que a página acompanhe
as atualizações do QR. Conexão concluída ou reinício encerra link e cookie.
Todas as respostas usam `no-store`, `noindex`, `no-referrer` e `nosniff`; scripts
e estilos da página são autorizados por nonce, não por `unsafe-inline`.

O link temporário ainda é uma credencial durante os 10 minutos. Quem tiver
acesso aos logs nesse intervalo pode abri-lo primeiro; por isso o acesso ao
Railway continua restrito. O impacto é limitado à tentativa de pareamento em
curso e não revela nenhuma chave permanente.

## Plano para credenciais antigas — executar na publicação autorizada

1. Considerar a antiga chave compartilhada potencialmente exposta por ter sido usada em URLs. Isso é prevenção, não confirmação de vazamento. Não reutilizar esse valor em nenhuma das duas variáveis novas.
2. Gerar **dois valores aleatórios distintos**, cada um com 32 bytes (64 caracteres hexadecimais), em um gerenciador de senhas ou ferramenta local confiável. Não enviar pelo chat, colocar no Git, compartilhar em prints ou imprimir nos logs do servidor.
3. No serviço do bot no Railway, preparar `PAINEL_SECRET` com uma nova chave de assinatura e `PAIRING_SECRET` com outro valor novo. Publicar o código corrigido junto dessas configurações, em uma janela combinada. Não abrir o QR durante uma transição em que o código antigo ainda esteja rodando.
4. Confirmar que **todas as instâncias antigas terminaram**. A revogação só está completa quando nenhum processo com a chave antiga continua atendendo. Não manter uma lista de chaves anteriores, período de tolerância ou fallback.
5. Pedir um novo `!painel` pelo WhatsApp de um admin autorizado. Links enviados anteriormente e abas com sessões antigas deixarão de autenticar após a rotação; o admin precisará abrir o link novo. O telefone autorizado não muda.
6. Se houver QR pendente, abrir o **link temporário mostrado no log**. Nunca
   montar uma URL com `PAIRING_SECRET`. Sem QR pendente, o 404 é esperado. Não
   apagar `creds.json`, não desparear o WhatsApp e não revincular impressoras
   apenas para testar esta troca.
7. Remover URLs antigas de favoritos, mensagens compartilhadas e históricos sob controle da loja; verificar a retenção e a ocultação de parâmetros de URL em proxies e logs. Apagar cópias não substitui a rotação, porque outras cópias podem existir.

**Impactos esperados:** troca do acesso web dos admins e da URL de QR. Não há migração de banco, mudança de preços, modificação de pedidos nem troca das credenciais da impressora. A sessão do WhatsApp no volume não é alterada. O reinício necessário ao deploy continua sujeito aos efeitos normais da aplicação sobre estado em memória.

**Se precisar reverter:** preferir uma correção para frente. Não restaurar a chave compartilhada antiga. Uma versão anterior a esta correção volta a usar `PAINEL_SECRET` em `/pareamento`; se for indispensável executá-la, bloquear essa rota na infraestrutura antes e manter a chave de assinatura nova fora de URLs. Sem esse bloqueio, não usar esse rollback como solução segura.

**Rotações futuras:** um link temporário vazado pode ser encerrado reiniciando o
processo; trocar `PAIRING_SECRET` se houver suspeita sobre a chave do servidor.
Trocar `PAINEL_SECRET` quando houver suspeita sobre a chave do painel. A ausência
de `PAIRING_SECRET` mantém a página de QR desligada quando não necessária.

## Atualização e validação das imagens

- `sharp` foi fixado em `0.35.4` como dependência direta e override. O Baileys continua em `7.0.0-rc14`, usando a mesma cópia corrigida. O lock mantém os pacotes de Windows e Linux; os binários libvips passaram a `1.3.3`.
- A correção indicada pelo mantenedor inclui libheif `1.23.2`, para o alerta GHSA-rgj7-g3m4-5g8c. [Aviso oficial](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
- O caminho de atendimento humano agora valida o buffer **antes** de chamar o envio aos admins e a geração de miniaturas do Baileys. Antes, ele pulava a validação aplicada aos comprovantes.
- Aceita fotos JPEG, PNG e WebP, conforme a lista permitida dos comprovantes. Confere os bytes reais, o tamanho efetivo do buffer e a coerência do MIME declarado. O teto em bytes usa `PROOF_MAX_MB` (padrão 5 MB).
- Arquivos que se apresentam como JPEG mas contêm SVG, PDF, AVIF, HEIF ou texto são recusados antes do decodificador. Caminhos locais, URLs e objetos não são aceitos no lugar do buffer.
- A biblioteca corrigida confere formato, dimensões (máximo 25 milhões de pixels), imagem estática e decodificação dos pixels. Arquivos truncados e cabeçalhos falsos também são recusados. A opção `failOn: 'warning'` é usada para entrada não confiável. [Documentação do sharp](https://sharp.pixelplumbing.com/api-constructor/).
- Arquivo recusado não é enviado aos admins e não cai na IA nem no fluxo de comprovante. O cliente recebe uma orientação breve para reenviar e continua no atendimento humano. A tentativa conta no limite de repasses já existente.
- Foto válida mantém os bytes originais e vai para todos os admins cadastrados. Se um envio falhar, continua a alternativa em texto e o envio independente aos demais destinatários.

Não foi adicionado salvamento de imagens em banco, bucket ou arquivo pela validação. Não houve alteração na leitura financeira dos comprovantes, na liberação para impressão, no carrinho ou na conversa de escolha dos produtos.

**Limites:** esta validação não é antivírus e não remove metadados da foto
original. A barreira adicional de SEC-06 rejeita links, comandos e instruções
que cheguem aos campos livres da saída do modelo, mas nenhum filtro garante que
todo texto malicioso nos pixels será identificado. Limites de bytes/pixels
reduzem abuso de recursos sem substituir monitoramento e atualização contínua.

## Verificação local e teste após publicação

Testes locais, sem serviços externos nem uso de créditos de IA:

Resultado atualizado em 14/09/2026: **87 suítes passaram** (`npm test`),
incluindo as novas verificações. `npm audit --omit=dev` retornou **0
vulnerabilidades conhecidas**. `npm ls sharp --all` confirmou uma única versão
`0.35.4`, compartilhada pelo app e pelo Baileys; o runtime local informou libheif
`1.23.2` na verificação original.

- `node test/pareamentotest.js`: chave mestra fora da URL, link temporário de uso
  único, cookie protegido, encerramento e cabeçalhos com nonce.
- `node test/imagemrepassetest.js`: imagens JPEG/PNG/WebP reais, miniaturas reais do Baileys com sharp corrigido, arquivos inválidos/disfarçados/truncados/grandes, limite de pixels, repasse a dois admins, falha de um admin e preservação do caminho de comprovante.
- `node test/atendimentotest.js` e `node test/reclamacoesencaminhamentotest.js`: manutenção dos fluxos de atendimento e reclamações.
- `npm test`: toda a regressão; repetir se houver novas mudanças antes de publicar.
- `npm ls sharp --all` e `npm audit --omit=dev`: conferir a versão efetiva e os alertas conhecidos.

A execução local é Windows; não equivale a uma prova de exploração ou a um teste ao vivo no Railway/Linux. Ao publicar, instalar pelo lock (`npm ci`, mantendo dependências opcionais de plataforma), conferir a versão instalada e testar uma foto inofensiva em um atendimento controlado. Confirmar o recebimento em todos os admins. Não usar imagens de exploração nem pedidos reais para essa verificação. Se houver bibliotecas de sistema customizadas substituindo os binários oficiais, verificar também a versão efetiva do libheif.
