# HB-INT-01 — registo mínimo de tarefas no painel

Base: `343dbde955eb4474cf14eff20e0327f5573392d4` (PR #2, `feat/qode-opencode-portfolio`) + patch `panel-dto-functional.patch`
(SHA256 5f32494146b602bfd6887c5298b7809f1058f217d16954f98b9e50b16c59abc3) reaplicado sem alterações. Sem commit.

## O que existe
- `server/qode/task-registry.ts`: estado `{tasks, seen, transitions, executions}`; função pura `applyMessage`.
  Campos por tarefa: task_id, project, owner, status, blocker, approval_state, version, updated_at, evidence{head,patch_sha256,ref}, review{reviewer,verdict,head,patch_sha256,ref}, origin.
- Regras: um owner (sem takeover implícito); só o owner faz start/submit/block; `start` regista no máximo UMA execução por versão;
  revisão separada (revisor ≠ owner) e vinculada à candidata submetida; `complete` só pelo revisor, com aprovação e execução registada.
- Candidata imutável (v2, após revisão ZikaBOT P1): `submit` exige `head` (commit) e/ou `patch_sha256` (64 hex, delta sem commit).
  A `review` tem de repetir exatamente o mesmo par head+patch_sha256; qualquer divergência (ou ausência) → `candidate_mismatch`.
  O head de base (ex.: 343dbde) NÃO identifica um patch: para candidata sem commit usar `head: null` + `patch_sha256`.
- Bloqueio (v2, P2): só de `claimed`/`running`; `unblock` repõe o estado anterior (`blocked_from`). Submit e complete exigem uma execução registada por `start`.
- Idempotência: `message_id` repetido → `duplicate` (estado idêntico); `expected_version` ≠ atual ou timestamp anterior à tarefa → `stale`, rejeitado, sem execução.
- `projectTasks`: allowlist de 14 campos; refs só `slack:<canal>/<ts>` ou `github:<owner>/<repo>#<n>`; heads só hex; projetos fora da allowlist (ex.: Vida) não saem.
- `GET /api/tasks`: flag própria `HABBLAUD_TASK_REGISTRY=1` (off por padrão), só GET, só loopback (Host + peer), `no-store`. Independente de `HABBLAUD_CONTINUITY*`, terminal, messages e demais flags upstream.
- UI `client/src/ui/tasks.ts`: botão "Tarefas" só quando a API diz enabled; só leitura (sem executar/merge/transferir); `textContent` em tudo;
  campo "Origem" distingue "Manual (transcrito)" de "Automação comprovada".
- Dados reais: `server/qode/task-registry-hb.ts` transcreve (origin=manual) os IDs/timestamps das mensagens do #poc-habblaud para HB-INV-01 (concluída) e HB-INT-01 (em execução). Nenhum texto de mensagem é copiado.

## Atualização
`node node_modules/tsx/dist/cli.mjs scripts/task-registry-apply.ts <dataDir>` aplica as transições (idempotente; reexecutar devolve `duplicate`).
Para submeter HB-INT-01 para revisão: `... task-registry-apply.ts <dataDir> --submit-int01 --patch-sha256 <hex64>`. Isto SÓ submete (pending_review); não há auto-aprovação. A aprovação é uma mensagem `review` do revisor (≠ owner) com a mesma candidata, seguida de `complete` pelo revisor. Escrita atómica (tmp+rename, 0600).
Ligar no servidor: `HABBLAUD_TASK_REGISTRY=1` com bind 127.0.0.1; ficheiro `<dataDir>/task-registry.json`.

## Rollback
1. Desligar: remover `HABBLAUD_TASK_REGISTRY` (painel some; API devolve `enabled:false`). Nenhuma outra feature depende disto.
2. Código: `git apply -R hb-int-01.patch` no checkout onde foi aplicado (ou descartar a worktree isolada). O patch do painel de continuidade é independente.
3. Dados: apagar `<dataDir>/task-registry.json` (só metadados de tarefas; não toca hubs, receipts, snapshots).

## Limites (não comprovado)
- Ingestão é MANUAL: não há ligação Slack→registo; o mapeamento foi transcrito pelo executor. Automação exigiria token/app Slack ou leitura do conector — nova permissão.
- Cooperativo: protege contra duplicado/stale de quem usa o protocolo; não impede um processo que escreva o ficheiro por fora; sem lock entre processos concorrentes (último rename vence).
- Sem autenticação/ACL real além de loopback; não exposto em rede.
- HB-INT-01 aparece "Em execução" até ZikaBOT rever; não há head próprio (sem commit), a evidência é o patch + hashes.

## v2 — correções da revisão ZikaBOT (msg 1791924989.894939)
- Leitura do registo com `O_NONBLOCK`: FIFO/dispositivo no caminho não bloqueia e é rejeitado (não é ficheiro regular).
- Datas inválidas (`2026-13-45…`, `02-31`) são rejeitadas antes de `toISOString` (sem RangeError).
- Projeção: owner/reviewer só de uma allowlist de identidades (`grok-bot`, `socio-bot`, `zikabot`, `matheus`); fora dela a tarefa (owner) não sai ou o revisor fica nulo. Blocker só de uma lista fechada; outro valor aparece como `other`.
- Origem projetada é sempre `manual`: não há prova verificável de ingestão automática; um campo `origin` no ficheiro não basta.
- UI: refreshes concorrentes numerados; respostas superadas são descartadas (sem cartões duplicados nem estado antigo).
