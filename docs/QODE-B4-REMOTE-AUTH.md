# QODE B4 — Auth local + remoto seguro (docs para revisão adversarial)

- **Data:** 2026-10-16 ~00:55 PT (WEST)
- **Repo inventariado:** `Matheusqf/habblaud-qode` @ `6a6c214` (main pós-PR #4)
- **Autorização Matheus:** remoto sim, desde que seguro (senha/criptografia); túnel live só após validação dele
- **Escopo deste passe:** inventário + pesquisa verificável + desenho + critérios de aceite. **Sem túnel live, sem bind 0.0.0.0, sem PR de auth incompleta.**

---

## 0) Respostas explícitas à revisão adversarial

> **Estado:** proposta de desenho. A separação *auth na app + transporte privado* **NÃO** é aprovação da topologia; a topologia (Serve vs WireGuard vs Access) continua pendente de revisão e de validação explícita do Matheus. Nenhum túnel live, nenhum bind externo, nenhuma credencial nesta PR.

### 0.1 Superfícies (HTTP / SSE / WebSocket / hooks)

| Tipo | Superfícies | Requisito alvo com `HABBLAUD_AUTH=1` |
|---|---|---|
| HTTP UI/estáticos | `server/http/static.ts` (`dist/client`); Vite middleware em dev (`server/index.ts`) | SPA pode carregar shell; **nenhum dado** sem sessão; dev/Vite nunca em modo remote |
| HTTP API | todas as `/api/*` (§1.4) | sessão válida obrigatória, excepto `POST /api/auth/login` e `GET /api/auth/status` mínimo |
| SSE | `/api/stream`, `/api/agents/:id/terminal`, `/api/sessions/:conta/:id/terminal` | cookie de sessão verificado **na abertura** e **re-verificado periodicamente / em evento de revogação**; stream encerrado quando a sessão é revogada/expira |
| WebSocket | Só o HMR do Vite (modo dev, mesmo servidor HTTP). A app não tem WS próprio | modo remote **recusa arrancar** em dev; `upgrade` sem sessão → fechar; qualquer WS futuro herda a mesma verificação de sessão |
| Hooks/bridge/plugins | `/api/codex/events`, `/api/permissions*`, `/api/mod/inbox*`, `/api/codex/bridge/*`, `/api/mod/summary` | Bearer de máquina (`hooks.token`, `0600`) **e** política local; nunca isenção só por Host/endereço |

### 0.2 Como o servidor distingue local vs remoto — e porque Host/loopback não chega

**Achado (main `6a6c214`):** as travas de terminal, permissões, mensagens, personagem, eventos Codex e `/api/continuity`/`/api/tasks` dependem de **bind local + `Host` loopback** (`isLoopbackHost`, `server/http/guard.ts`; uso em `server/http/app.ts`; bind/flags em `server/config.ts` `terminalOffReason`/`messagesOffReason`; `server/index.ts` `listen(config.host)`). Algumas também exigem `remoteAddress` loopback.

Um proxy/túnel **local** (Tailscale Serve, `cloudflared`, Caddy, socat) liga-se ao QODE **a partir de 127.0.0.1** e pode reescrever `Host` para `localhost`. Para o servidor, o pedido de um cliente remoto fica indistinguível de um pedido local: Host loopback ✔, `remoteAddress` loopback ✔, bind loopback ✔. **Logo loopback + túnel criptografado NÃO bastam** — o túnel cifra o transporte mas entrega ao processo um pedido que satisfaz todas as travas actuais.

Consequência de desenho:

1. **Local vs remoto deixa de ser um sinal de segurança.** O servidor não tenta adivinhar a origem pela rede; **autentica a origem** (sessão de utilizador ou Bearer de máquina) em cada pedido.
2. **Autorização por capacidade**: cada capacidade (`read`, `terminal`, `messages`, `permissions`, `character`, `tasks`, `hooks-ingest`) é verificada explicitamente contra a identidade autenticada; ex.: sessão de browser não usa rotas de ingestão de hooks; Bearer de hooks não lê snapshot nem terminal.
3. Host/Origin/bind/`remoteAddress` mantêm-se como **defesa em profundidade** (anti DNS-rebinding/CSRF), nunca como credencial.
4. Headers de identidade do proxy (`Tailscale-User-*`, `Cf-Access-Jwt-Assertion`) só como sinal adicional, e no caso Cloudflare apenas com validação criptográfica do JWT.

### 0.3 Sessões e revogação

- Store server-side; cookie `HttpOnly; SameSite=Strict` (+`__Host-`/`Secure` em HTTPS); ID ≥128 bits CSPRNG, guardado como hash; nunca em query string.
- Regeneração no login; idle + absolute timeout; logout invalida no servidor.
- **Revogação**: `logout`, "terminar todas as sessões", rotação da senha e rotação do `hooks.token` invalidam imediatamente. Pedidos seguintes → 401; **streams SSE abertos são encerrados** (o hub mantém o session-id por ligação e fecha as ligações cuja sessão foi revogada/expirou).

### 0.4 Impedir acesso alternativo que contorne o proxy

- Processo sempre em `127.0.0.1`; modo remote recusa `HABBLAUD_HOST`/`HABBLAUD_BIND` não-loopback e `HABBLAUD_ALLOWED_HOSTS` sem auth (preflight).
- Mas como qualquer processo local (ou um segundo proxy) também chega a loopback, **o controlo decisivo é a autenticação na app em todas as rotas** — contornar o proxy não dá acesso sem sessão/Bearer.
- Funnel / túneis públicos sem IdP continuam NO-GO; `Tailscale-User-*` ignorados se o serviço for alcançável fora de localhost.

### 0.5 Modos e fail-closed

- **Opt-in local:** sem `HABBLAUD_AUTH` e com bind loopback, comportamento actual preservado (compatibilidade), com aviso.
- **Modo remote (`HABBLAUD_REMOTE=1`) é fail-closed:** se auth estiver desligada, sem senha configurada, sem `hooks.token`, em modo dev/Vite, ou com bind não-loopback → **recusa arrancar** (não degrada para aberto).

### 0.6 Testes negativos obrigatórios (pelo proxy)

Executados com um proxy de teste local que reescreve `Host: 127.0.0.1` e liga a partir de loopback:

- sem cookie → 401 em `/api/snapshot`, `/api/stream`, terminais, `/api/tasks`, `/api/continuity`, permissions, messages, character, codex events;
- Bearer de hooks em rota de leitura de UI → 403; sessão de browser em rota de ingestão → 403;
- sessão revogada → 401 e SSE aberto encerrado em ≤ N s;
- session-id em query → rejeitado;
- modo remote com auth off → processo não arranca.

---

## 1) Inventário de superfícies (código atual)

**Proteção existente (não é autenticação):**

| Camada | O que faz | Lacuna |
|---|---|---|
| Bind default `127.0.0.1` (`server/config.ts`) | Processo só escuta loopback | Túnel/proxy para loopback contorna; `HABBLAUD_HOST`/`HABBLAUD_BIND` podem abrir rede |
| `createRequestGuard` (`server/http/guard.ts`) | Host allowlist (anti DNS-rebinding); Origin + JSON Content-Type em mutações (anti CSRF parcial) | **Sem credencial.** Host ausente → aceite. Origin ausente → aceite. Qualquer IP literal no Host passa. GETs sem Origin. |
| Trava “Host local” (`isLoopbackHost`) | Terminal, permissões, mensagens, personagem, rename, eventos Codex (e, fora Docker, remoteAddress loopback) | Fácil de reescrever com `--host-header=rewrite` / proxy que define `Host: 127.0.0.1` |
| Preflight QODE (`server/qode/preflight.ts`, `HABBLAUD_QODE_REQUIRED=1`) | Recusa bind externo e `HABBLAUD_ALLOWED_HOSTS` não vazio no perfil local | Só no launcher QODE; não implementa auth |

**Confirmação estática:** zero `Authorization` / cookie de sessão / password gate nas rotas HTTP do servidor. Mascaramento de secrets em transcripts (`shared/activity.ts`) ≠ auth de API.

### 1.1 UI / estáticos

- Produção: `server/http/static.ts` → `dist/client` (SPA, sem gate).
- Dev: Vite middlewareMode em `server/index.ts` (mesmo processo HTTP; WebSocket Vite no mesmo server).
- Tudo passa pelo guard Host/Origin; **nenhuma login page**.

### 1.2 SSE / streams

| Rota | Auth hoje | Sensibilidade |
|---|---|---|
| `GET /api/stream` | Nenhuma (só guard Host) | Snapshot live + feed; pode incluir atividade de projetos (com filtro QODE se privado) |
| `GET /api/agents/:id/terminal` | Host local + bind local | Transcript da sessão = execução/contexto |
| `GET /api/sessions/:conta/:sessionId/terminal` | Mesma trava do terminal | Histórico de conversa |

`EventSource` do browser **não envia headers custom**; cookie `HttpOnly` SameSite é o veículo natural pós-auth.

### 1.3 Hooks / bridge / plugins

| Rota | Cliente | Trava atual |
|---|---|---|
| `POST /api/codex/events` | Hook Codex (`mod/habblaud-codex`) | Host local (+ loopback addr fora Docker) |
| `POST /api/permissions` (+ `.../wait`, `.../decision`) | Hooks Claude/Codex + UI | Bind + Host local |
| `POST /api/mod/inbox`, `/api/mod/inbox/ack` | Plugin Claude | Host local (mensagens) |
| `POST /api/codex/bridge/poll`, `/ack` | `npm run codex:bridge` no host | Host local |
| `GET /api/mod/summary` | Statusline/mod a cada ~5s | **Sem trava local** — só guard Host |

Hooks correm no Mac e falam `127.0.0.1`. Qualquer auth remota **não pode quebrar** estes clientes locais: precisam de bypass loopback autenticado (token de máquina em ficheiro local) ou isenção deliberada só para `remoteAddress` loopback **e** Host loopback (ainda insuficiente sozinho se o túnel reescreve Host — ver NO-GOs).

### 1.4 `/api/*` completo (handler `server/http/app.ts` + módulos)

**Leitura ampla (sem trava de Host local):**

- `GET /api/health` — versão, sources, accounts usageStatus, flags terminal/messages/codex/updates (+ health QODE)
- `GET /api/snapshot`, `GET /api/stream`
- `GET /api/agents/:id`
- `GET /api/mod/summary`
- `GET /api/stats`, `GET /api/stats/days`
- `GET /api/timeline/days`, `GET /api/timeline/:dia`
- `GET /api/updates`
- `GET /api/continuity`, `GET /api/tasks` — **Host local + remoteAddress loopback**

**Mutação / impacto (Host local + recurso ligado, excepto demo/updates):**

- `POST /api/demo`
- `POST /api/updates/check` (consulta GitHub)
- `POST /api/rooms/rename`
- `PUT|DELETE /api/agents/:id/character`
- `POST /api/messages`, `GET /api/messages/:id`
- `POST /api/permissions*` (register / decide / wait)
- Bridge/inbox/codex events (acima)

**Docker:** `Dockerfile` usa `HABBLAUD_HOST=0.0.0.0` *dentro* do container; `docker-compose.yml` publica `${HABBLAUD_BIND:-127.0.0.1}:4747`. Capacidade terminal/messages desliga se bind publicado não for loopback.

---

## 2) Pesquisa — opções verificáveis (fontes com data)

### 2.1 Rede / túnel (transporte)

| # | Opção | Modelo de confiança | Esforço ops | Fontes |
|---|---|---|---|---|
| **R1** | **Tailscale Serve** | Só dispositivos/utilizadores do *tailnet*; HTTPS `*.ts.net`; ACLs; headers de identidade (`Tailscale-User-Login` etc.) **só** se o backend escuta localhost (docs avisam: headers spoofáveis se o serviço for alcançável fora de localhost) | Baixo | [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) (validado Jan 20, 2026); [CLI serve](https://tailscale.com/docs/reference/tailscale-cli/serve) |
| **R2** | **Cloudflare Tunnel + Access** | Hostname público atrás de IdP/OTP/email; deny-by-default; **obrigatório** validar JWT `Cf-Access-Jwt-Assertion` (ou “Protect with Access” no `cloudflared`) — senão misconfig = app aberto | Médio | [Self-hosted public app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) (atualizado Apr 17, 2026); [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/); [Published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/) (Oct 15, 2026) |
| **R3** | **WireGuard cru** | Overlay privado; chaves/peers/`AllowedIPs`/NAT keepalive à mão; app continua em loopback no Mac | Médio–alto | [WireGuard Quick Start](https://www.wireguard.com/quickstart/) |
| **R4** | **Tailscale Funnel** | URL **pública** na internet; **sem** identity headers; docs: não expor dados sensíveis sem auth da app | Baixo mas perigoso sozinho | [Funnel](https://tailscale.com/docs/features/tailscale-funnel) (Jan 20, 2026); [Share local dev](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-internet) |
| **R5** | Port-forward / ngrok sem IdP | Público ou semi-público | Baixo | Recusado para QODE (superfície admin) |

Comparações de terceiros alinhadas com R1/R2/R3 para dashboards pessoais: [selfhosting.cloud](https://selfhosting.cloud/cloudflare-tunnel-vs-tailscale-vs-wireguard-for-secure-remote-access), [TechGeeks](https://www.techgeeks.org/tailscale-vs-wireguard-vs-cloudflare-tunnel-vs-reverse-proxy/) — úteis como síntese, não como certificação.

### 2.2 Auth na aplicação (camada QODE)

| # | Opção | Encaixa no QODE | Notas |
|---|---|---|---|
| **A1** | **Senha + sessão server-side + cookie `HttpOnly; Secure; SameSite=Strict` (`__Host-` quando HTTPS)** | **Recomendado** para UI + SSE | OWASP Session Management: ≥64 bits entropy (preferir ≥128), regenerar após login, idle+absolute timeout, não aceitar session ID em query; [cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Hash de password: Argon2id ou, sem deps nativas, `crypto.scrypt` (Node built-in — o repo hoje **não tem** dependências de runtime). |
| **A2** | Bearer token estático (`Authorization: Bearer`) | Bom para hooks/bridge/scripts | EventSource não manda header → inadequado sozinho para UI/SSE |
| **A3** | Confiar só em headers Tailscale / JWT Cloudflare | Complemento de edge | **Nunca** sozinho: exige bind localhost + validação criptográfica (JWT) ou Serve+localhost; headers Tailscale removidos/repostos pelo proxy só no caminho Serve |
| **A4** | HTTP Basic Auth sobre TLS | Simples | Frágil para SPA/SSE; credencial em cada request; pior UX no telemóvel |
| **A5** | mTLS cliente | Forte | Alto esforço (certs por dispositivo); overkill para 1 utilizador se já há VPN |

MCP Streamable HTTP (referência de desenho, já citada no plano Sol): localhost + Origin + autenticação — [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

---

## 3) Ranking (segurança vs esforço) para o caso Matheus

Objetivo: telemóvel / outro Mac a ver e operar o escritório **sem** expor admin à internet aberta.

| Rank | Combinação | Segurança | Esforço | Veredito |
|---|---|---|---|---|
| **1** | **Auth app A1 (+ A2 para hooks) + Tailscale Serve (R1)**; processo sempre `127.0.0.1` | Alta: overlay privado + HTTPS + ACLs + senha/sessão mesmo se Serve falhar de política | Baixo–médio | **Escolha por defeito** |
| **2** | **A1 + WireGuard (R3)** + app em loopback | Alta; menos “mágica”, mais ops | Médio–alto | Se quiser zero dependência Tailscale |
| **3** | **A1 + Cloudflare Tunnel + Access (R2)** com validação JWT no origin ou Protect with Access | Alta *se* Access+JWT corretos; hostname público aumenta superfície de discovery | Médio | Bom se precisares browser sem cliente VPN; **Access antes** de publicar rota |
| **4** | Só Serve/Access sem auth na app | Média | Baixo | Insuficiente: misconfig de túnel = leitura/ação |
| **5** | Funnel / túnel público + só Host/Origin | Crítica | Baixo | **NO-GO** |
| **6** | `0.0.0.0` / LAN bind sem auth | Crítica | Baixo | **NO-GO** |

**Criptografia em trânsito:** TLS do Serve (`*.ts.net`), Tunnel (Cloudflare edge→cliente) ou WireGuard. A app Node continua em HTTP em `127.0.0.1` por detrás do proxy — padrão documentado pelo Tailscale (“listen on localhost”). Cookie `Secure` exige que o browser veja HTTPS (Serve/Tunnel); em loopback HTTP local, omitir `Secure` / prefixo `__Host-` só no perfil local explícito.

---

## 4) NO-GOs (explícitos)

1. **Não expor** com base só em `Host` / `Origin` / bind loopback aparente.
2. **Não** `HABBLAUD_HOST=0.0.0.0` / `HABBLAUD_BIND=0.0.0.0` / publicação LAN **sem** auth app + política de rede.
3. **Não** Tailscale Funnel / ngrok / Cloudflare Tunnel **sem** Access (ou equivalente) **e** auth app.
4. **Não** túnel live / DNS público / partilha de URL sem **validação explícita do Matheus** neste ciclo.
5. **Não** confiar em `Tailscale-User-*` se o processo for alcançável fora de localhost.
6. **Não** meter session ID na query do EventSource (logs, Referer, histórico).
7. **Não** dados reais de tracks sensíveis neste track.
8. **Não** push `main` / `--force`.
9. **Não** alegar “remoto pronto” só com documentação — critérios §6 têm de passar em teste.

---

## 5) Desenho mínimo — auth local primeiro, túnel depois

### Fase L0 — inventário (este doc) ✅

### Fase L1 — Auth local (obrigatória antes de qualquer remote)

**Identidade:** um operador (Matheus); opcionalmente scopes depois (`read` vs `operate`).

**Credencial:** senha (≥12, política server-side); hash em `dataDir/auth.json` (scrypt/argon2id); ficheiro `0600`; nunca logar.

**Sessão:**

- Cookie: `HttpOnly; SameSite=Strict; Path=/`; `__Host-` + `Secure` quando a origem efectiva é HTTPS.
- Token: CSPRNG ≥128 bits; no store server-side guardar **hash** do verifier (OWASP).
- Regenerar no login; logout invalida server-side; idle (ex. 8h) + absolute (ex. 7d).
- Rate-limit login (ex. 5/15 min); mensagem genérica.

**Rotas novas:**

- `POST /api/auth/login` `{password}` → Set-Cookie
- `POST /api/auth/logout`
- `GET /api/auth/status` → `{authenticated, authRequired}`

**Middleware:** se `HABBLAUD_AUTH=1` (ou perfil `remote` futuro):

- Exigir sessão válida em **todas** as `/api/*` excepto login + (opcional) health **mínimo** sem dados de contas/sources — preferir health autenticado também.
- UI estática pode servir `index` mas a SPA bloqueia até `status.authenticated`.
- SSE `/api/stream` e terminais: cookie automático.

**Hooks locais:** ficheiro `dataDir/hooks.token` (ou env `HABBLAUD_HOOKS_TOKEN`) com Bearer; aceite **apenas** se `remoteAddress` é loopback **e** Bearer válido. Não isentar só por Host.

**Default offline:** com bind loopback e sem `HABBLAUD_AUTH`, comportamento actual (compat); preflight QODE continua a recusar hosts extras. Activar `HABBLAUD_AUTH=1` assim que L1 estiver testado — mesmo só em local, fecha o buraco “qualquer processo no Mac → API”.

### Fase L2 — Perfil remote (código + docs; **túnel off até ok Matheus**)

- Env/perfil: `HABBLAUD_REMOTE=1` implica `HABBLAUD_AUTH=1`, bind loopback, e lista explícita do *proxy esperado* (ex. `Serve`) só para documentação/ACL — **não** reactivar `HABBLAUD_ALLOWED_HOSTS` sem auth.
- Documentar comando Serve: `tailscale serve` → porta do QODE; Funnel desligado.
- Testes: pedido sem cookie → 401; cookie revogado → 401; Host spoofado via proxy de teste **com** auth → 401 sem sessão; com sessão → ok.

### Fase L3 — Túnel real (só após ok Matheus)

1. Instalar Tailscale no Mac + telemóvel; Serve para `127.0.0.1:4747`.
2. Confirmar HTTPS; login senha; SSE; **sem** Funnel.
3. Checklist §6.
4. Alternativa Cloudflare: Access app **antes** da rota do tunnel; Protect with Access ou validação JWT no Node.

---

## 6) Critérios de aceite testáveis

| ID | Critério | Como provar |
|---|---|---|
| C1 | Sem credencial, `/api/snapshot` e `/api/stream` → 401 quando auth on | `curl -i` local |
| C2 | Login errado → 401 genérico; 5 falhas → 429/lockout | script |
| C3 | Login certo → cookie; snapshot 200; logout → 401 | curl -c/-b |
| C4 | Session ID em query **rejeitado** | curl `?session=` |
| C5 | Revogação: apagar sessão no store → pedidos seguintes 401 | unit + manual |
| C6 | Hook sem Bearer em loopback → 401; com Bearer → 200 | teste http existente |
| C7 | Terminal/mensagens/permissions continuam a exigir política local **e** auth | matriz |
| C8 | Preflight: remote sem auth → recusa start | `HABBLAUD_QODE_REQUIRED=1` |
| C9 | **Antes** de túnel live: proxy de teste que reescreve `Host: 127.0.0.1` **sem** cookie → 401 (prova que Host sozinho morreu) | socat/caddy local |
| C10 | Pós-túnel (só com ok Matheus): URL Serve abre login; utilizador fora do tailnet não entra | ensaio real |

---

## 7) Próximo patch concreto (ficheiros) — **não implementado nesta noite**

Auth completa (hash, store, cookie, login UI, EventSource, hooks token, testes) é **~2–4 dias**, não um quick-win seguro. Abrir PR a meio daria falsa segurança. Ficheiros previstos na branch futura `socio/qode-b4-auth-local`:

| Ficheiro | Papel |
|---|---|
| `server/http/auth.ts` | scrypt/argon2id, sessions, cookie parse/set, rate-limit |
| `server/http/auth.test.ts` | C1–C6 |
| `server/http/guard.ts` / `server/index.ts` | Encaixar middleware auth após guard Host |
| `server/http/app.ts` | Rotas `/api/auth/*`; marcar health |
| `server/config.ts` | `HABBLAUD_AUTH`, paths dataDir |
| `server/qode/preflight.ts` | Remote ⇒ auth obrigatória |
| `server/messages/http.ts` + hooks install scripts | Propagar Bearer hooks |
| `mod/habblaud-codex/hook.mjs` (+ plugins Claude) | Header Authorization |
| `client/` (login gate mínimo) | Form senha + status; bloquear office até auth |
| `qode/README.md` + `docs/remote-access.md` | Runbook Serve; NO-GOs; sem passos de Funnel “ready” |

**Quick patch deliberadamente *não* aberto:** stub “401 se flag” sem login UI / sem cookies quebraria o uso local e os hooks.

Esta PR é **só documentação**; nenhum código de auth/túnel incluído.

---

## 8) Decisões para Matheus (amanhã)

1. Confirmar **rank #1** (Tailscale Serve + senha/sessão) ou preferir Cloudflare Access / WireGuard.
2. Auth local Ligada por default após L1, ou só com flag?
3. Quando validar ensaio Serve (C10), avisar — até lá **túnel off**.
4. Scopes: só leitura remota vs operate (mensagens/permissions) no telemóvel?

---

## 9) Relação com B1–B3

- B2 (ops room / bots) depende de B4 para qualquer superfície remota.
- B1 executor não deve ser accionável por rede sem C1–C7.
- B3 (track sensível): mesmo com auth, esse conteúdo continua **fora** deste track até gate próprio.

---

## Adenda — revisão ZikaBOT (2026-10-16)

**Achado:** um proxy local (ou túnel) que reescreve `Host: 127.0.0.1` contorna hoje a combinação *bind loopback + Host loopback* em terminal, permissions, messages e tasks. Host não é identidade: qualquer processo que fale com a porta e escreva o cabeçalho passa. (Detalhe e desenho em §0.)

**Consequências para o desenho:**
1. **Autenticar a origem** (sessão por cookie ou Bearer de máquina com `remoteAddress` loopback) **e autorizar cada capacidade** (terminal, permissions, messages, tasks, hooks) separadamente — não um único "é local" global.
2. **Testes negativos pelo proxy** (C9 antecipado): proxy de teste que reescreve Host **sem** credencial → 401 em cada capacidade; com sessão → só as capacidades autorizadas.
3. **SSE:** `/api/stream` exige sessão; após logout/revogação a ligação SSE aberta é **fechada** pelo servidor (não basta recusar novos pedidos).
4. **Modos:** auth **opt-in em local** (`HABBLAUD_AUTH=1`) é aceitável na transição; **perfil remoto é fail-closed** — `HABBLAUD_REMOTE=1` (ou `HABBLAUD_ALLOWED_HOSTS` não vazio) com auth off → servidor recusa arrancar.
5. Nenhum passo de túnel/Funnel é "ready" até C9 passar e Matheus validar C10.
