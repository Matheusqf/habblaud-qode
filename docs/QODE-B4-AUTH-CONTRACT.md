# QODE B4 — Contrato efetivo de auth local (L1)

> Fonte de verdade: o código da PR #8 (`server/http/auth.ts`, `server/http/security-preflight.ts`, clientes de hook).
> Este ficheiro é idêntico na PR #6 (docs). Se divergirem, vale o código da #8 e este texto tem de ser corrigido.
> **Remoto/topologia/live: fora deste contrato** (etapa separada, só com ok explícito do Matheus). Funnel: NÃO.

## 1. Matriz de autorização (por principal)

| Principal | Como se prova | Abre | NÃO abre |
|---|---|---|---|
| Anónimo | — | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status`, estáticos | qualquer outra `/api/*` → 401 |
| Operador (browser) | cookie de sessão `HttpOnly; SameSite=Strict; Path=/` (`Secure`/`__Host-` só com `HABBLAUD_REMOTE=1` ou TLS real do socket; nunca via `X-Forwarded-Proto`) | UI/operate: snapshot, `/api/stream`, `*/terminal`, `…/decision`, messages, tasks, etc. | rotas de ingest (abaixo) → cookie **não** autoriza |
| Hook/bridge local | `Authorization: Bearer <token>` + `remoteAddress` loopback | **só** a allowlist: `POST /api/permissions`, `GET /api/permissions/:id/wait`, `POST /api/codex/events`, `POST /api/mod/inbox`, `POST /api/mod/inbox/ack`, `POST /api/codex/bridge/poll`, `POST /api/codex/bridge/ack`, `GET /api/mod/summary` (resumo só-leitura) | UI/operate e qualquer rota/método fora da allowlist |

Host nunca é identidade. Bearer fora de loopback = 401.

## 2. Token de hooks

- Resolução (servidor e **todos** os clientes suportados, mesma regra): `HABBLAUD_HOOKS_TOKEN` (≥32; mais curto = inválido,
  não cai no ficheiro) **senão** `<HABBLAUD_DATA_DIR | $HOME/.habblaud>/hooks.token` (ficheiro regular, ≥32 chars).
- Clientes: `mod/habblaud-permissoes` (hook de permissão), `mod/habblaud` (summary), `mod/habblaud-mensagens`
  (inbox/ack), `scripts/codex-bridge.ts` (poll/ack). O setup padrão (`npm run auth:set-password`) só grava o ficheiro;
  env é opcional. Teste: `server/test/hooks-token-file.test.ts` (só ficheiro, sem env → 200; sem token → 401).
- Mods do Claude Code: o ficheiro só é lido se o engine expuser `$.fs.read`; sem isso o mod usa só a env.
  **Pendente de verificação com `claude plugin test`/Claude Code real** — não alegar integração completa dos mods
  sem env até isso ser confirmado.
- Confiança: o token vale para **a máquina inteira** (qualquer processo do mesmo utilizador que o leia). Sem vínculo
  account/session/task. **Não é identidade** e nunca é reutilizado como credencial B2/cloudbot/ops-room.

## 3. Sessões, epoch e revogação

- `auth.json` = hash scrypt (parâmetros validados) + `generation` (epoch). Gravação atómica (tmp+rename, 0600).
- Cada sessão guarda o epoch sob que foi emitida; epoch ≠ corrente → sessão morta.
- Login reconcilia o epoch **depois** de ler o body e revalida **depois** do scrypt (rotação durante a espera não
  emite sob epoch velho e revoga as antigas).
- Revogação fecha **todos** os SSE (`/api/stream`, `*/terminal`) na hora: logout, rotação de senha, expiração
  (timer automático; idle 8 h, absoluto 7 d) e poll automático de `auth.json`.
- Limites: sessões só em memória (restart desloga); "sessão = tudo" para o operador (sem escopo fino UI); revogação por
  poll de ficheiro tem latência do intervalo do timer.

## 4. Fail-closed

- `auth.json` ausente, corrompido, não-regular (symlink/dir) ou com parâmetros/generation inválidos:
  no boot o preflight recusa; com servidor vivo, todas as sessões/SSE são revogadas e o login recusado.
- Preflight de segurança corre **sempre** e é independente do preflight QODE (`QODE_REQUIRED`): com
  `HABBLAUD_AUTH=1` exige `auth.json` válido e token de hooks válido (env ou ficheiro); `HABBLAUD_ALLOWED_HOSTS` sem
  auth → recusa; `HABBLAUD_REMOTE=1` sem auth, com Vite/dev, bind externo ou senha ausente → recusa.

## 5. Rate-limit de login

- 5 falhas / 15 min por endereço → 429 (`Retry-After`). Tentativas **em andamento** contam: a reserva é feita antes de
  ler o body, logo vários bodies suspensos não passam juntos.

## 6. Pendente para remoto (não feito)

1. C9 com proxy real contra o servidor completo; testes negativos pelo proxy.
2. L2 perfil remote + runbook `tailscale serve` (sem Funnel) — só com ok do Matheus.
3. Identidade própria, escopada e revogável para qualquer canal remoto/cloud (o token de hooks não serve).
4. Sessões persistentes / escopo fino por capacidade no cookie.
