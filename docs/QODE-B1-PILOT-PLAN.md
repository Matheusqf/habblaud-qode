# B1 — Piloto floating-flow (executor autónomo via orquestração existente)

**Status:** plano + gancho mínimo QODE (observe-only) — **esta sessão não executa cascata real**  
**Data:** 2026-10-16 ~00:54 PT  
**Autorização:** Matheus (remoto seguro + resto B1–B4); B1 = integrar floating-flow, **não** broker paralelo.  
**Inventário:** inventário QODE ↔ dev-flow (SHA `4440485`, fora do repo)  
**Clone RO:** dev-flow (só leitura; path local não publicado)

---

## 1. Decisão de piloto

| Campo | Valor |
|---|---|
| **Projeto** | **monitor-imobiliario** |
| **Área** | **só** `monitor-imobiliario-saas/` (alvo do gate / CI) |
| **Formato orquestração** | **Cascata** (económico → gate → escala se falhar) ou **Direto** se a tarefa couber num parágrafo |
| **Coordenador** | floating-flow (`flow-orchestrate` + `dispatch.sh` + `flow-worker` / `flow-reviewer`) |
| **UI** | QODE Office — **só observa** estado; **não** despacha, **não** claima tarefas do flow |

### Porquê monitor-imobiliario (não WorkToDo)

| Critério | monitor-imobiliario | WorkToDo |
|---|---|---|
| Gate | Curto e idêntico ao CI: `pnpm typecheck && pnpm build` em `monitor-imobiliario-saas/` | Pesado: typecheck+lint+duplicates+colors+test+context+docs-sync (+ e2e à parte) |
| Sensível | Stripe / RLS / migrations — **fora** do piloto | Feature flags mudam prod **sem deploy**; passkeys; firestore.rules |
| Branch/PR | Declarar `socio/*` + draft PR no despacho (padrão sócio-bot) | Já tem `git.branchPattern: socio/*`, `pushVia: pr` — bom, mas risco operacional maior |

**Não usar** o plano antigo `flow-os/monitor-i18n` (showcase Vite na **raiz**) como primeira fatia B1: o `flow.config.json` limita `scope.paths` a `monitor-imobiliario-saas/**`; evidência de gate não cobriria a raiz.

**WorkToDo** fica como **piloto #2** depois de uma rodada Cascata verde no monitor.

---

## 2. História de aceite do piloto (uma entrega)

**ID:** B1-MI-01  
**Como** Matheus, **quero** que o floating-flow leve uma tarefa mecânica no SaaS até **draft PR**, **para** provar executor+revisor+gate sem segundo coordenador.

**Critério de aceite (binário):**

1. Grill/plan mínimos registados (história + allowlist + viradas erradas = nenhuma).
2. Despacho com envelope `flow-orchestrate/references/contratos.md` (papel, objetivo, allowlist, verificação, FECHADO/EM ABERTO).
3. `dispatch.sh plan` mostrado; **uma** aprovação explícita do dono para o par executor+revisor (ou Matheus já autorizou overnight neste brief — ver §4).
4. Executor escreve **só** na allowlist, em worktree/branch `socio/b1-mi-<slug>`.
5. Gate: `pnpm typecheck && pnpm build` em `monitor-imobiliario-saas/` — exit 0; evidência no relatório.
6. Revisor **outra família** (ou subagent `flow-reviewer` em contexto limpo se o dono pedir subagent) → parecer ACEITE / CORRIGIR / NÃO VERIFICADO.
7. Draft PR aberto (não merge); link no hub/ledger.
8. QODE **não** iniciou `dispatch.sh run` nem reescreveu o plano — só mostrou capability/status se o gancho existir.

**Prova:** artefactos em disco (despacho, relatório executor, parecer, log gate, URL PR) — relato sozinho = NÃO VERIFICADO (`flow-verification`).

---

## 3. Tarefa mecânica sugerida (primeira rodada)

Escolher **uma** (orquestrador mede e fixa no grill):

| Opção | Escopo | Evitar |
|---|---|---|
| **A (preferida)** | Teste unitário ou type-fix trivial em UI/lib **fora** de billing/auth | `supabase/migrations/**`, Stripe, RLS, `.env*` |
| **B** | Docs/README do SaaS alinhado a comportamento já existente | Copy de pricing / compliance |
| **C** | Small a11y/label em componente já coberto por typecheck | Redesign, deps novas |

Se o grill não achar fatia segura em &lt;30 min → **EM ABERTO**: Matheus escolhe ficheiros; não improvisar no Stripe.

---

## 4. Ações pré-autorizadas (piloto B1-MI-01)

**Autorizadas** (overnight / piloto):

- Ler repo + knowledge `docs/knowledge/monitor-imobiliario.md`
- Criar worktree / branch `socio/b1-mi-*`
- Editar ficheiros na **allowlist** do despacho
- Correr gate validate do `flow.config.json`
- Commit na branch `socio/*` (hooks sócio-bot)
- Push da branch + **abrir draft PR** (não merge)
- Escrever hub em `$DEVFLOW/docs/hubs/monitor-imobiliario/` (nunca no repo do produto)
- Registar linha no ledger do `dispatch.sh`

**Proibidas:**

- Segundo broker / task router em QODE ou fork paralelo
- Merge em `main`, `--force`, bypass de hooks
- Touch: Stripe, RLS, migrations, secrets, deploy, Vercel prod
- UBOTS / Wellhub / **Vida real** / CoRaSy merge
- Mensagens externas (Slack/email) sem pedido explícito novo
- `dispatch.sh run` com modelo Claude/GPT/Grok via `opencode:` (exit 13 — regra de custo)
- QODE chamar `run`/`review` ou claimar ownership de tarefa do flow

---

## 5. Tetos (fail closed)

| Teto | Valor piloto |
|---|---|
| Ficheiros tocados | ≤ 12 paths (allowlist explícita) |
| Diff líquido | ≤ ~400 linhas (acima → parar e escalar ao dono) |
| Tempo wall | ≤ 90 min por rodada executor; ≤ 30 min revisor |
| Rodadas Cascata | ≤ 2 escalas (económico → forte); depois EM ABERTO |
| Rede | Sem novas deps / sem `pnpm add` sem aprovação |
| Gasto LLM | Preferir económico no executor (`opencode-go` / free); revisor noutra família na assinatura nativa |
| Writers | 1 escritor por projeto (lock do dispatch) |
| Replay | Cada `run` exige frase de aprovação daquele par; não reutilizar |

Parada testada: se gate vermelho 2× com a mesma virada → CORRIGIR no parecer e **parar** (não loop).

---

## 6. Como o QODE consome estado (sem 2º orquestrador)

```
floating-flow (coordenador)
  ├── flow-orchestrate → envelope / fases
  ├── dispatch.sh      → plan / run / review / ledger / status
  ├── flow-worker / flow-reviewer
  ├── flow-verification / flow-security / flow-closing
  └── flow-hub         → estado da iniciativa (fora do repo produto)
         │
         ▼  (só leitura)
QODE Office = UI
  ├── salas dos 8 projetos operados
  ├── /api/health → capabilities inclui floating-flow (observe)
  └── NÃO: despachar, aprovar pares, claimar task do ledger do flow
```

**Fontes de verdade (ordem):**

1. Despacho + relatórios no worktree / `.flow/` do projeto (transporte)
2. Ledger do `dispatch.sh` (`ledger.jsonl` / `dispatch.sh status`)
3. Hub em `dev-flow/docs/hubs/…` (pessoal; QODE não precisa ingerir conteúdo — só “existe iniciativa”)
4. Task-registry HB do QODE (se usado) = metadados cooperativos **opt-in**; não substitui o ledger do flow

**Regra:** se QODE e floating-flow discordarem de “quem manda”, **vence o floating-flow**. QODE mostra; flow decide.

---

## 7. Gancho mínimo em habblaud-qode (se PR)

**Objetivo:** declarar honestamente no `/api/health` que o coordenador é floating-flow e que QODE só observa.

- Entrada `capabilities[]`: `id: floating-flow`, `capabilities: ['observe']` quando `QODE_DEVFLOW_ROOT` (ou path default) existe; senão `unavailable` / `unknown`
- Campo `qode.orchestrate`: `{ coordinator: 'floating-flow', role: 'observe-only', ready: boolean, note }`
- **Sem** UI de “Run dispatch”; **sem** adapter que execute
- Testes: origem nunca `live`; OpenCode/Cursor/manual/floating-flow sem live enganoso

Se o patch ultrapassar ~pequeno → só stubs + este plano (não forçar).

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| QODE vira 2º broker | Contrato escrito; capability só `observe`; sem botão run |
| Touch acidental Stripe/RLS | Allowlist + deny list no envelope; revisor checklist |
| Gate SaaS vs trabalho na raiz | Piloto só em `monitor-imobiliario-saas/` |
| Custo LLM errado | `dispatch.sh` exit 13; plan mostra canal de cobrança |
| Replay / aprovação reutilizada | Uma frase por par; ledger |
| Contaminação B3/Vida | Piloto sem paths privados; Vida gated noutro track |
| showcase i18n antigo | Fora do B1-MI-01 (scope gate) |

---

## 9. Evidências a anexar no fecho do piloto

- [ ] SHA tip do despacho / branch
- [ ] Comando gate + exit code
- [ ] Path do relatório executor + parecer revisor
- [ ] URL draft PR
- [ ] Linha ledger `dispatch.sh`
- [ ] Screenshot ou JSON `/api/health` com `floating-flow` (se PR do gancho merged)
- [ ] Hub actualizado FECHADO ou EM ABERTO com dono

---

## 10. Ordem operacional (quando acordar / próxima sessão)

1. Confirmar fatia A/B/C no grill (5–15 min).
2. Emitir despacho + `dispatch.sh plan`.
3. Executor → gate → revisor.
4. Draft PR + hub.
5. Só então: alargar tetos ou piloto #2 WorkToDo.

**NO-GO permanente deste track:** segundo broker, Vida real, push main, `--force`, merge CoRaSy sem decisão.

---

## Referências verificadas

- `AGENTS.md`, `flow.config.json` (dev-flow)
- Skills: `flow-orchestrate`, `flow-verification`, `flow-security`, `flow-hub`, `flow-bot-relay` (B2), `flow-worker`/`flow-reviewer`
- Knowledge: `docs/knowledge/monitor-imobiliario.md`, `worktodo.md`
- Inventário QODE ↔ dev-flow (SHA `4440485`, fora do repo)
- Addendum Sol: reformular B1 = integração floating-flow

## Entrega desta sessão

- Draft PR gancho: https://github.com/Matheusqf/habblaud-qode/pull/7 (`8f9dec7`)

---

## 11. Contrato explícito (pedido de revisão adversarial)

### 11.1 Identidade dos atores

| Ator | Quem | Pode | Não pode |
|---|---|---|---|
| **Coordenador** | floating-flow (`flow-orchestrate` + `dispatch.sh`) | Emitir despacho, `plan`, `run`, `review`, escrever ledger/hub | Merge, tocar NO-GOs |
| **Worker** (executor) | `flow-worker`, modelo económico, worktree `socio/b1-mi-<slug>` | Editar allowlist, correr gate, commit+push branch, abrir draft PR | Sair da allowlist, novas deps, merge, autoaprovar |
| **Reviewer** | `flow-reviewer`, **outra família** que o worker, contexto limpo | Ler diff no SHA, parecer ACEITE / CORRIGIR / NÃO VERIFICADO | Editar código, aprovar SHA diferente do revisto |
| **QODE Office** | UI | **observe**: mostrar capability/estado | Despachar, aprovar pares, claimar tarefa, chamar `run`/`review` |
| **Dono** | Matheus | Aprovar par executor+revisor, merge | — |

Cada artefacto (despacho, relatório, parecer, linha ledger) regista o ator e o modelo/família usados.

### 11.2 Tetos (consolidado, fail closed)

| Teto | Valor | Ao exceder |
|---|---|---|
| Tempo worker | ≤ 90 min wall por rodada | Parar, EM ABERTO |
| Tempo reviewer | ≤ 30 min | NÃO VERIFICADO, parar |
| Tempo total piloto | ≤ 3 h | Parar, escalar ao dono |
| Custo LLM | Worker só canal económico/free; reviewer na assinatura nativa; **0 € pay-per-token** (`opencode:` Claude/GPT/Grok → exit 13) | Bloqueio do dispatch |
| Retries gate | ≤ 2 com a mesma virada | CORRIGIR + parar |
| Escalas Cascata | ≤ 2 (económico → forte) | EM ABERTO |
| Ficheiros / diff | ≤ 12 paths / ≤ ~400 linhas | Parar, escalar |
| Rede | sem novas deps, sem chamadas externas além de git push/PR | Parar |

### 11.3 Condições de parada (qualquer uma → parar, sem loop)

1. Gate vermelho 2× com a mesma virada.
2. Qualquer teto de §11.2 excedido.
3. Diff toca path fora da allowlist ou da deny list (Stripe, RLS, `supabase/migrations/**`, `.env*`, deploy).
4. Reviewer devolve CORRIGIR duas vezes ou NÃO VERIFICADO.
5. SHA revisto ≠ head da branch (ver §11.4).
6. Lock de escritor ocupado / aprovação do par ausente ou reutilizada.
7. Pedido de mensagem externa, merge ou `--force`.
8. Ordem do dono para parar (kill do `dispatch.sh`; testado em replay).

### 11.4 Vínculo revisão ↔ SHA

- O parecer cita o **SHA completo** do head revisto e o comando gate + exit code nesse SHA.
- Qualquer commit novo após o parecer **invalida** o ACEITE; nova revisão obrigatória.
- Draft PR e linha do ledger registam o mesmo SHA; divergência = NÃO VERIFICADO.
- Merge (só pelo dono) apenas se head da PR == SHA do último ACEITE.

### 11.5 NO-GOs

- **Sem merge** (nem desta PR #7 nem da PR do piloto) — só dono.
- **Sem Stripe, RLS, migrations, secrets, deploy/Vercel prod.**
- **Sem Vida real** (track B3, gated) nem paths privados.
- **Sem 2º broker**: QODE não orquestra, não despacha, não claima.
- Sem `--force`, bypass de hooks, push em `main`.
- **Cascata real só na próxima sessão**, após o dono confirmar a fatia (§3) e aprovar o par. Esta PR entrega apenas plano + gancho observe-only.
