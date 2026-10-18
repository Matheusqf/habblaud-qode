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
- Só sobrevivem: provedor, id nativo (regex por provedor), projeto, estado nativo (`[A-Z_]{1,32}`), estado normalizado, `updatedAt` (horário **nativo** do provedor para o estado observado), `confirmedAt` (instante **local** em que esse item foi confirmado), `expiresAt` (= `confirmedAt` + TTL), link https em host do provedor (sem query/fragment).
- **Nunca**: nome/título, prompt, resumo, resultado, branches, transcript, stream.
- Estados: `running` | `idle` (IDLE ≠ sucesso) | `ended` (sai da sala) | `stale` (sem confirmação dentro do TTL, ou atualização antiga) | `unknown`.
- TTL **por confirmação individual**: cada item vale a partir do seu próprio `confirmedAt`; o fim do poll serve só para agendamento/backoff e nunca renova evidência antiga.
- Mudança de estado do personagem é **só observacional** (`Office.setObservedStatus`): perder RUNNING (stale/unknown/IDLE/CREATING) nunca gera "Concluiu" nem aviso de sucesso.
- Estado unificado/cartões (`shared/unified-state.ts`): agente cloud é tratado antes do fallback idle→«Feito» — fica `inferred` (running, idle, stale, CREATING, unknown); `error` só com estado nativo de erro (ex. `RUN_ERROR`) numa confirmação em dia.
- Cada poll recebe o relógio atual do seu início (coletores sequenciais não herdam o `now` do primeiro).
- Tokens ficam no coletor (servidor). Erros de coletor são genéricos (sem corpo/headers).
- QODE não cria, responde, cancela nem arquiva agentes. Sem webhooks (v1 "coming soon"; não criar agentes para receber notificações).

## Sala
Cada agente entra como principal com cwd `/cloud/<provedor>/<projeto>` e conta `cloud-<provedor>`; sem terminal nem transcript.

## Claude Code web
Sem interface pública oficial de listagem/status: **observação automática indisponível**. Não extrair cookies nem chamar endpoints privados.
