# Acesso remoto ao QODE Office — estado

> **Remoto NÃO está pronto.** Nenhum túnel está ligado. **Funnel: NÃO** (nunca expor à internet pública).
> **Tailscale Serve: TBD** — só depois de C9 revisto e com ok explícito do Matheus (C10).
> Desenho completo: `docs/QODE-B4-REMOTE-AUTH.md` (PR #6).

## Fase L1 — auth local (opt-in, esta branch)

```bash
npm run auth:set-password      # senha ≥12 → <dataDir>/auth.json (scrypt, 0600) + <dataDir>/hooks.token
HABBLAUD_AUTH=1 npm start      # bind continua 127.0.0.1
```

- Sem `HABBLAUD_AUTH` o comportamento é o de antes (compat).
- Com auth: todas as `/api/*` exigem sessão (cookie `HttpOnly; SameSite=Strict; Path=/`, `__Host-`+`Secure` em HTTPS)
  excepto `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status`.
- Hooks/bridge locais: `Authorization: Bearer <hooks.token>` (ou `HABBLAUD_HOOKS_TOKEN`), aceite **só** com `remoteAddress` loopback.
  Host nunca conta como identidade (um proxy pode reescrevê-lo).
- Logout/revogação invalida no servidor e fecha streams SSE abertos. Idle 8h, absoluto 7d. Login: 5 falhas/15 min → 429.
- `HABBLAUD_REMOTE=1` sem `HABBLAUD_AUTH=1` → preflight QODE (`HABBLAUD_QODE_REQUIRED=1`) recusa arrancar.

## Limitações conhecidas (antes de ligar auth no dia-a-dia)

- Os hooks/mod (`mod/habblaud-codex/hook.mjs`, plugins Claude, `scripts/permission-hook.mjs`, codex-bridge) **ainda não enviam**
  o Bearer: com `HABBLAUD_AUTH=1` passam a levar 401. Patch seguinte.
- Sessões em memória: reiniciar o servidor desloga.
- Autorização por capacidade (terminal/permissions/messages/tasks com escopos separados) ainda é "sessão = tudo".

## Próximos passos (não feitos)

1. Propagar Bearer nos hooks + `hooks:install`.
2. C9 com proxy real (caddy/socat) contra o servidor completo.
3. L2 perfil remote + runbook `tailscale serve` (sem Funnel) — só com ok do Matheus.
