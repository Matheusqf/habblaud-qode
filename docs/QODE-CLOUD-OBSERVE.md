# QODE Office — observação de agentes cloud (contrato)

Plano ZikaBOT (#poc-habblaud, 16/10/2026), fatias 1–3. **Observe-only. Desligado por padrão.**

## Ligar (só local)
| Variável | Efeito |
|---|---|
| `HABBLAUD_CLOUD=1` | liga a fonte cloud (sem isto nada corre) |
| `HABBLAUD_CLOUD_PROJECTS=dono/repo,...` | allowlist; vazio = nada passa |
| `HABBLAUD_CLOUD_TTL_MS` | validade de uma observação (padrão 180000) |
| `HABBLAUD_CLOUD_CURSOR=1` + `CURSOR_API_KEY` | coletor Cursor Cloud Agents v1 (fatia 2) |
| `HABBLAUD_CLOUD_CODEX=1` | ponte `codex cloud list --json` (fatia 3) |

## Contrato (server/cloud/contract.ts)
- Allowlist de projeto **antes** de guardar/logar/renderizar; item fora dela é descartado inteiro.
- Só sobrevivem: provedor, id nativo (regex por provedor), projeto, estado nativo (`[A-Z_]{1,32}`), estado normalizado, `updatedAt`, `expiresAt`, link https em host do provedor (sem query/fragment).
- **Nunca**: nome/título, prompt, resumo, resultado, branches, transcript, stream.
- Estados: `running` | `idle` (IDLE ≠ sucesso) | `ended` (sai da sala) | `stale` (sem confirmação dentro do TTL, ou atualização antiga) | `unknown`.
- Tokens ficam no coletor (servidor). Erros de coletor são genéricos (sem corpo/headers).
- QODE não cria, responde, cancela nem arquiva agentes. Sem webhooks (v1 "coming soon"; não criar agentes para receber notificações).

## Sala
Cada agente entra como principal com cwd `/cloud/<provedor>/<projeto>` e conta `cloud-<provedor>`; sem terminal nem transcript.

## Claude Code web
Sem interface pública oficial de listagem/status: **observação automática indisponível**. Não extrair cookies nem chamar endpoints privados.

## Codex cloud (fatia 3)
`codex cloud list --json --limit 20` via execFile (sem shell), timeout 15 s, saída ≤ 512 KB, stderr não ecoado. Usa a sessão já existente do CLI; o Office nunca lê `~/.codex/auth.json`. Projeto = mapeamento explícito `HABBLAUD_CLOUD_CODEX_ENVS=env_id=dono/repo,...` (environment_label NÃO é usado; sem mapa → nada passa), depois allowlist. Pagina com `--cursor` (teto 10 → inventário parcial, ausência ≠ encerramento). `HABBLAUD_CLOUD_CODEX_VERSION` = saída exata de `codex --version`. PENDING/QUEUED = unknown (não trabalha). Cobertura cloud novo vs Legacy por validar.

### Formato real validado (codex-cli 0.162.0-alpha.17.2, 16/10/2026)
`codex cloud list --json --limit 20` nesta VM devolve `{"tasks": [], "cursor": null}` (conta sem tarefas cloud): o envelope `tasks`/`cursor` está confirmado; os campos de cada tarefa (`id`, `url`, `status`, `updated_at`, `environment_id`, …) seguem os nomes presentes no binário mas **não foram observados com dados reais**. Os fixtures são sintéticos e marcados como tal.
- `environment_id` null/ausente/não mapeado → tarefa descartada (falha fechada), mesmo que o label coincida.
- Alternativa se `environment_id` vier sempre null: uma chamada `codex cloud list --json --env <ENV_ID>` por ambiente permitido (ids obtidos no painel Codex), atribuindo o projeto pelo ambiente consultado — não implementado até haver dados reais.
## Cursor — estados e janela (review ZikaBOT 16/10)
- Agente `ACTIVE` não é execução: o coletor lê só o `status` do run `latestRunId` (`GET /v1/agents/{id}/runs/{runId}`); `RUNNING` → running; `CREATING`/outros → unknown; run terminal → IDLE (o agente continua).
- Multirepo: o agente só passa se **todos** os `repos` estiverem na allowlist.
- IDLE > 24 h sai do inventário por janela (`lastWindowExcluded`): filtro visual, **não** término — não fecha agentes já na sala.
- TTL/nextAt/backoff contam a partir do fim da consulta (relógio pós-await).

## Codex — pin e paginação (review ZikaBOT 16/10)
- `HABBLAUD_CLOUD_CODEX_VERSION` é **obrigatório**: sem ele o coletor não liga; `codex --version` é verificado em **cada** execução e qualquer divergência falha fechada.
- `cursor: null` = fim (inventário completo). Cursor ausente (campo em falta) ou com formato inválido = inventário **parcial** (não fecha ninguém).
- Uma saída vazia (`{"tasks":[],"cursor":null}`) confirma só o envelope; **não** comprova a forma das tarefas reais.
