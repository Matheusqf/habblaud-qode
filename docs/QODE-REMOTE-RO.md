# QODE Office — entrada remota só-leitura (fatias 4–5)

**Desligada por padrão. Não ativa nada de rede sozinha.**

- `HABBLAUD_REMOTE_RO=1` + `HABBLAUD_REMOTE_RO_PORT=<1025-65535>` abre uma **segunda** porta, sempre em `127.0.0.1` (não configurável → sem LAN/IPv6 direto).
- `HABBLAUD_REMOTE_RO_ORIGIN=<host público do proxy>` (ex. `office.<tailnet>.ts.net`): Origin exigido no login (CSRF).
- Sessão própria `qode_ro` (HMAC, aud `qode-ro`, 12 h, HttpOnly, SameSite=Strict, Secure). Login `POST /ro/login {password}` com a senha do B4 (`npm run auth:set-password`).
- O cookie do operador não vale aqui; qualquer `Authorization` (token de hooks) → 401.
- Só GET/HEAD: `/api/snapshot`, `/api/stream`, `/api/updates`, `/api/stats[/dia]` e o cliente estático. Hooks, terminal, mensagens, permissões, decisões, sessões, health, continuity, tasks, demo, timeline e qualquer escrita → 403/405.
- `X-Forwarded-*`/`Forwarded`/`X-Real-IP` removidos antes do handler interno.
- SSE: fechado na expiração da sessão e na revogação (troca de senha → nova `generation` no auth.json, verificado a cada 5 s; ou `kill -USR2 <pid>`).
- Testes C9: `server/http/remote-ro.c9.test.ts` (servidor + proxy reais, Host reescrito, headers forjados, cookie/CSRF, negação de hooks/ops, canários, SSE revogação/expiração/cliente lento/reconexão).

Limitação conhecida: o cliente web atual ainda chama rotas de operação (renomear sala etc.) — na entrada só-leitura elas falham com 403/405 por desenho.
