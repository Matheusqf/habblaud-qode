# B2 — Ops room (1 bot) via flow-bot-relay + floating-flow

**Status:** desenho + stub QODE observe-only (`ops-room=unavailable`)  
**Data:** 2026-10-16 ~01:00 PT  
**Autorização:** Matheus — B2 após base B1/B4; remoto seguro (B4); **sem** integração cloud live nesta noite.  
**Dependências:** B1 plano (`qode-b1-pilot-plan.md`); B4 auth (`qode-b4-remote-auth.md`); inventário SHA `4440485`.  
**Skills:** `flow-bot-relay` + `flow-orchestrate` (não reinventar broker).

---

## 1. Objectivo

Uma **ops room** no QODE Office que mostra estado de **um** bot de trabalho (local→cloud quando B4 permitir), com:

- identidade e contexto **por projeto** (sala);
- **zero** cruzamento de salas;
- retries e orçamento **auditáveis**;
- coordenação = floating-flow; QODE = UI observe-only até API comprovada.

**Fora deste track:** Vida BOT, UBOTS, Wellhub, CoRaSy merge, push `main`, `--force`.

---

## 2. Bot inicial proposto

| Campo | Valor |
|---|---|
| **Bot piloto** | **OpenCode** (sessão dedicada `ops-room`, canal já usado pelo `dispatch.sh`) |
| **Papel** | Executor/relayer mecânico sob envelope floating-flow |
| **Alternativa #2** | Cursor Automations (só jobs GitHub PR/audit — **não** chat de sala) |
| **Não-piloto** | Grok Bot / Sócio no chat — **sem API de escrita** (`flow-bot-relay`: humano cola) |

### Porquê OpenCode (API comprovável)

| Critério | OpenCode | Grok Bot chat | Cursor Automations |
|---|---|---|---|
| API/CLI comprovável hoje | **Sim** — CLI + `dispatch.sh` / ledger | **Não** — “humano é o botão enviar” (SKILL flow-bot-relay) | Parcial — dashboard/GitHub triggers; não é API de sala QODE |
| Identidade por projeto | Worktree + allowlist + `socio/*` | Depende do paste do dono | Por repo/automação, não por sala office |
| Orçamento auditável | Plan/`exit 13` + ledger | Ledger manual de despachos | Cota Cursor Models (catálogo) |
| Cloud/remoto | Só **depois** B4 (auth + transporte) | Já “cloud”, mas sem write API | Cloud, escopo PR ≠ ops room |
| Cruzar salas | Negável por cwd/roomKey | Risco se o paste misturar projetos | Triggers por repo |

**Conclusão:** o “1 bot cloud” do B2 = **OpenCode sob floating-flow**, com superfície remota **opt-in só com B4 L1+**. Grok Sócio continua no protocolo `flow-bot-relay` (preparar → Matheus cola → verificar) — **paralelo**, não o bot automatizado da ops room. Cursor Automations ficam para M3/jobs de PR, não para despacho de sala.

**Prova mínima de API (quando for live — NÃO esta noite):**

1. `dispatch.sh plan` mostra canal OpenCode + tetos.
2. Uma rodada B1-MI-01 (ou dry-run) com artefacto em disco + linha ledger.
3. QODE `/api/health` → `ops-room.origin` deixa de ser `unavailable` **só** quando existir adaptador que leia ledger/hub **sem** fingir live.

Até lá: capability **`ops-room` = `unavailable`** (stub).

---

## 3. Arquitectura (sem 2º broker)

```
floating-flow
  ├── flow-orchestrate  → quem/formato/envelope
  ├── flow-bot-relay    → preparar/registar/verificar (humano no Grok se preciso)
  ├── dispatch.sh       → plan / run / review / ledger
  └── flow-worker|reviewer
         │
         │  artefactos (ledger, hub, branch, draft PR)
         ▼
QODE Office = ops room UI
  ├── salas dos projetos operados (1 identidade bot / sala activa)
  ├── /api/health → capabilities inclui ops-room (unavailable até API)
  ├── qode.opsRoom → { bot, role, ready:false, api:'unavailable', … }
  └── NÃO: despachar OpenCode, claimar ledger, cruzar transcripts entre salas
```

**Regra de autoridade:** discordância QODE vs floating-flow → **vence floating-flow**. QODE mostra.

---

## 4. Identidade por projeto

| Campo | Regra |
|---|---|
| **ID bot** | `ops-room/opencode/<projectKey>` (ex. `monitor-imobiliario`) |
| **Sala** | 1 roomKey QODE ↔ 1 projectKey; bot **não** muda de sala mid-task |
| **Worktree** | `socio/b2-<project>-<slug>` (ou B1 `socio/b1-*` enquanto só observa B1) |
| **Allowlist** | Só paths do envelope; deny Stripe/RLS/migrations/secrets |
| **Hub** | `$DEVFLOW/docs/hubs/<project>/` — fora do repo produto |

Trocar de projeto = **nova** tarefa + novo envelope + novo ID de corrida. Sem reutilizar sessão contaminada.

---

## 5. Pacote de contexto (o que o bot pode ver)

**Incluir (mínimo):**

1. Critério de aceite verificável (1 parágrafo).
2. Allowlist de paths + deny list explícita.
3. Comando de gate do `flow.config.json` / CI curto.
4. Ponteiro hub (path) + linha ledger anterior se reabrir.
5. FECHADO / EM ABERTO + actor.

**Excluir sempre:**

- Transcripts / SSE / terminais de **outras** salas.
- Conteúdo Vida / paths privados B3.
- Secrets, `.env*`, tokens, cookies de sessão B4.
- Mensagens Slack/email crus sem sanitizar (usar envelope flow-bot-relay).

---

## 6. NO cruzar salas

| Controlo | Como |
|---|---|
| Binding | `projectKey` no envelope == cwd/worktree do worker |
| QODE | Capability/status **por** projectKey; UI não mistura feeds |
| Relays | `flow-bot-relay` ledger com coluna `<repo>`; um despacho = um repo |
| Teste negativo | Pedido com path de outro project → rejeitar antes de `run` |
| Vida | Sala/track separado; **nunca** no pacote B2 |

---

## 7. Retries e orçamento (auditáveis)

Alinhar tetos B1; ops room **observa** contadores quando API existir:

| Teto | Piloto B2 |
|---|---|
| Retries executor | ≤ 2 escalas Cascata; depois EM ABERTO |
| Wall time | ≤ 90 min executor / ≤ 30 min revisor |
| Ficheiros / diff | ≤ 12 paths / ≤ ~400 linhas |
| Rede / deps | Sem `pnpm add` sem aprovação |
| LLM | Preferir económico; `dispatch.sh` exit 13 em canal caro proibido |
| Replay | Frase de aprovação **por** par; não reutilizar |
| Orçamento diário | Contador no ledger/hub (campo futuro `opsRoom.budget`); soft-stop ao teto |

**Auditoria:** cada retry = linha ledger + razão (gate vermelho / parecer CORRIGIR). Relato sem artefacto = NÃO VERIFICADO (`flow-verification`).

---

## 8. Exclusão Vida BOT

- Vida BOT **não** é o bot deste track.
- Sem paths `Vida/`, sem collector/storage sensível, sem `local-repo-access` do track Vida.
- B3 (privacidade sintética) continua gated à parte; B2 não relaxa B3.
- `flow-bot-relay` menciona Vida só como fronteira — **não invocar** no ciclo QODE Office B2.

---

## 9. Dependência de B4 (auth)

| Superfície | Exigência |
|---|---|
| Ops room **local** (loopback) | Stub ok sem auth; activar `HABBLAUD_AUTH=1` quando L1 existir |
| Qualquer **remoto** (Serve/Tunnel) | B4 C1–C9 verdes; remote ⇒ auth fail-closed |
| Acções operate (se um dia) | Sessão + scope `operate`; sem cookie = 401 mesmo com Host spoof |
| Hooks/bridge | Bearer local (B4); ops room cloud **não** partilha hooks token |

**Sem B4:** ops room remota = **NO-GO**. Doc B4 rank #1 (Tailscale Serve + senha/sessão) permanece a topologia alvo — não aprovada só por este doc.

---

## 10. Critérios de aceite (binários)

| ID | Critério | Prova |
|---|---|---|
| A1 | Doc B2 existe e referencia B1/B4/inventário | path neste ficheiro |
| A2 | Bot piloto = OpenCode justificado; Grok chat = não-API | §2 |
| A3 | Identidade por projeto + no cross-room escritos | §§4–6 |
| A4 | Retries/orçamento com tetos e ledger | §7 |
| A5 | Vida BOT excluído | §8 |
| A6 | Remoto depende B4 fail-closed | §9 |
| A7 | QODE stub: `ops-room` **unavailable**, nunca `live` | `/api/health` + testes |
| A8 | **Não** houve chamada cloud live nesta entrega | evidência negativa (sem credenciais, sem dispatch run) |

**Live B2 (futuro, fora overnight):** A7 flip só com adaptador + rodada B1 verde + auth se remoto.

---

## 11. O que NÃO fazer overnight (NO-GO)

1. Chamar bots cloud de verdade (OpenCode cloud, Cursor agent run, Grok API chat).
2. Meter/ler credenciais, tokens, `OPENCODE_*` para despacho live.
3. Tocar Vida / UBOTS / Wellhub.
4. Push `main`, `--force`, merge sem review.
5. Alegar “B2 live” ou `ops-room.origin=live`.
6. Segundo broker / botão Run dispatch no QODE.
7. Túnel live / Funnel / bind `0.0.0.0`.
8. Cruzar contexto entre salas “para ajudar”.

---

## 12. Stub QODE (esta entrega)

- Capability `ops-room`: `origin: 'unavailable'`, `capabilities: []`, note aponta este doc.
- `qode.opsRoom`: `{ bot: 'opencode', role: 'observe-only', ready: false, api: 'unavailable', crossRoom: 'denied', vida: 'excluded', note }`.
- `hasMisleadingLive` trata `ops-room` como proibido em `live`.
- **Sem** UI de despacho; **sem** adapter HTTP para OpenCode.

Branch: `socio/qode-b2-ops-stub` → draft PR https://github.com/Matheusqf/habblaud-qode/pull/9 (`6440f38`).

---

## 13. Ordem depois de acordar

1. Fechar/merge B1 gancho + (se ok) primeira Cascata monitor.
2. B4 L1 auth local testada (C1–C7).
3. Adaptador observe: ler `dispatch.sh status` / ledger → `ops-room` = `manual`+`observe` (ainda não live).
4. Só então: ensaiar 1 bot OpenCode numa sala (monitor); remoto só com C10 Matheus.

---

## Referências

- `/workspace/flow-os/qode-b1-pilot-plan.md`
- `/workspace/flow-os/qode-b4-remote-auth.md`
- `/workspace/qode-office-dev-flow-inventory.md` (SHA `4440485`)
- `dev-flow` skill `flow-bot-relay`, `flow-orchestrate`, `flow-cursor-automations`
- Estado: `/workspace/flow-os/qode-office-state.md`
