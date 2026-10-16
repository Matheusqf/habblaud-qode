# Acesso remoto ao QODE Office — estado

> **Remoto NÃO está pronto.** Nenhum túnel está ligado. **Funnel: NÃO** (nunca expor à internet pública).
> **Tailscale Serve: TBD** — só depois de C9 revisto e com ok explícito do Matheus (C10).
> Desenho completo: `docs/QODE-B4-REMOTE-AUTH.md` (PR #6).

## Fase L1 — auth local (opt-in, esta branch)

```bash
npm run auth:set-password      # senha ≥12, stdin SEM eco → <dataDir>/auth.json (scrypt+generation, 0600) + hooks.token
HABBLAUD_AUTH=1 npm start      # bind continua 127.0.0.1; preflight de segurança corre sempre (não só QODE_REQUIRED)
```

- Sem `HABBLAUD_AUTH` o comportamento é o de antes (compat), **excepto** `HABBLAUD_ALLOWED_HOSTS` sem auth → preflight recusa (não fica aberto).
- Com auth: todas as `/api/*` exigem sessão (cookie `HttpOnly; SameSite=Strict; Path=/`)
  excepto `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status`.
- **Secure / `__Host-`**: só com perfil canónico (`HABBLAUD_REMOTE=1` → `secureCookies`) ou TLS real do socket.
  **Nunca** se confia em `X-Forwarded-Proto` arbitrário.
- Hooks/bridge locais: `Authorization: Bearer <hooks.token>` **só** em rotas+métodos de hook
  (`POST /api/permissions`, `GET …/wait`, `POST /api/codex/events`, inbox/bridge).
  Bearer **não** abre UI/operate (snapshot, stream, terminal, `…/decision`, messages, tasks).
  Aceite só com `remoteAddress` loopback. Host nunca é identidade.
- Logout / revogação / **rotação de senha** (`auth.json.generation`) / expiração (timer) fecham **todos** os SSE
  (`/api/stream` e `*/terminal`) sem esperar o próximo pedido. Idle 8h, absoluto 7d. Login: 5 falhas/15 min → 429.
- `HABBLAUD_REMOTE=1` sem `HABBLAUD_AUTH=1` → preflight recusa. Remoto também recusa Vite/dev, bind externo e senha ausente.

## Limitações conhecidas (antes de ligar auth no dia-a-dia)

- Os hooks/mod ainda **não enviam** o Bearer: com `HABBLAUD_AUTH=1` passam a levar 401 nas rotas de hook. Patch seguinte.
- Sessões em memória: reiniciar o servidor desloga (rotação de senha no disco já invalida em quente).
- Autorização fina por escopo UI (terminal vs messages vs tasks) ainda é "sessão = tudo" no cookie; Bearer já é por capacidade.

## Próximos passos (não feitos)

1. Propagar Bearer nos hooks + `hooks:install`.
2. C9 com proxy real (caddy/socat) contra o servidor completo.
3. L2 perfil remote + runbook `tailscale serve` (sem Funnel) — só com ok do Matheus.
