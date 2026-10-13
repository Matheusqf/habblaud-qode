# Projeção de continuidade — preparação isolada

Base revalidada: 343dbde955eb4474cf14eff20e0327f5573392d4; branch local feat/continuity-dto-preparation, clone separado. Tasks panel-dto-preparation e panel-dto-functional, owner codex-dto-preparer, host local-mac, autorização apenas preparação local. Esse claim só coordena esta tarefa/cópia; não atribui PR2 nem autoridade distribuída.

Candidata: server/qode/continuity-dto.ts, função pura projectContinuity. Não lê repo/hub, não recebe checkpoint bruto, não altera snapshots upstream, scanner, QODE config, history, mensagens, tools ou terminal. Rota GET /api/continuity e UI opt-in integradas somente na cópia isolada. HABBLAUD_CONTINUITY=1 e HABBLAUD_CONTINUITY_FIXTURE=1 habilitam fixture com IDs fixos; flags ausentes negam. Guard loopback não é autenticação: mock de concessão só para dados inventados, não fonte real. Nenhuma configuração instalada alterada. Testes node --test focados e typecheck do módulo passaram; Dependências existentes do review foram copiadas para cache isolado, sem instalação; npm run typecheck passou; npm test -- --maxWorkers=1: 1210 passaram/2 skipped; tests da rota/leitor32/32; browserheadless novo11checks + ponte canonicalhub→DTO→API→UI. Execução concorrente encontrou timeout400ms de mock Codex não alterado; casos ficaram registrados, sem relaxar asserções.

## Integração seguinte (não ativada)

1. Este patch tem task/claim próprios, não ownership de PR2. Revalidar branch/base antes de incorporar; não editar checkout alheio. Havendo novo SHA, revisar delta e reaplicar em cópia isolada, nunca editar checkout alheio.
2. Incorporador local DevFlow projeta DTO pelo binding read_status existente, com mapeamento de projeto/task/identidades. Input do painel é só DTO JSON limitado (p.ex. 4KiB), não caminho indicado pelo cliente nem snapshot/ledger. Transporte tem que rejeitar JSON não objeto, campos extras, conteúdo/histórico bruto e arquivo ilegível/obsoleto.
3. Adaptador de ACL do servidor fornece authenticated/readStatus e listas nominais de projetos/tasks/identidades. Esses valores não vêm do DTO, query string ou nome informado pelo modelo. ACL real ainda precisa ser ligada e provada; o argumento da função não implementa autenticação.
4. Nova flag continuity independente, desligada por padrão. Fail closed retorna unavailable sem nomes/campos. Sessão nova recebe quem iniciou/owner/action/next/capability/freshness, sem autorizar execução ou transferir owner.
5. UI de tarefas separada da atividade nativa. Não usar atividade/transcript como fonte de estado; mostrar indisponível quando host/fonte ausente. Alteração/proposta é outro fluxo, fora deste leitor.

## Preservação das features

Continuity, history/transcript, tools, artifacts/Deliveries, messages e PTY/remote permanecem flags independentes. Cada superfície exige sua ACL além da flag; habilitar continuidade não habilita nem desabilita as demais. Não remover feature upstream para fazer o teste passar. Neste SHA, ausência de Deliveries/PTY precisa de delta upstream separado; esse patch não inventa suporte existente nem sincroniza upstream.

Não gravar no QODE config instalado ou alterar concessões. Não abrir porta/servidor para nuvem. Provas futuras: DTO privado bloqueado em API/WebSocket/cache/timeline; revoke/expiry/host offline; UI escapa strings; flags têm regressões cruzadas; sessões novas de clientes reais. Esta preparação não constitui essa prova de produto.
