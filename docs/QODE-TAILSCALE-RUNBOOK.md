# Runbook — QODE Office via Tailscale Serve (SEM Funnel)

Estado: **inerte**. Nada aqui é executado por scripts. Ativação real só com aprovação explícita do Matheus (caminho, plano e custo).

## Pré-requisitos (decisão do Matheus)
- Plano Tailscale: Personal é grátis só para uso **não comercial**; Standard US$8/utilizador/mês (consultado 16/10/2026). Não assumir elegibilidade.
- Nome do dispositivo **não sensível** (o certificado HTTPS publica `<device>.<tailnet>.ts.net` em Certificate Transparency).
- Senha B4 definida: `npm run auth:set-password`.

## Checklist de ativação
1. Política do tailnet: aplicar `deploy/tailscale/acl.inert.hujson` (só `autogroup:member` → `tag:qode-office:443`), correr os `tests` da política no admin; confirmar que a regra padrão "allow all" foi removida.
2. Tag do dispositivo: `tag:qode-office`.
3. Office: `HABBLAUD_REMOTE_RO=1 HABBLAUD_REMOTE_RO_PORT=4320 HABBLAUD_REMOTE_RO_ORIGIN=<device>.<tailnet>.ts.net` (operador continua em 127.0.0.1:4319, **não** é servido).
4. `tailscale serve --bg --https=443 http://127.0.0.1:4320` (equivale a `deploy/tailscale/serve.inert.json`).
5. **Nunca** `tailscale funnel`. Verificar: `tailscale funnel status` → vazio; `tailscale serve status` → só `/ → 127.0.0.1:4320`.

## Verificação pós-ativação
- De um dispositivo do tailnet: `https://<device>.<tailnet>.ts.net/` → 401 até login; após login, sala visível; `POST /api/rooms/rename` → 405; `/api/hooks` → 403.
- De fora do tailnet: hostname não resolve/conecta.
- `ss -ltnp` na máquina: 4319 e 4320 só em 127.0.0.1.
- Revogação: `npm run auth:set-password` (nova senha) → streams abertos fecham em ≤5 s; ou `kill -USR2 <pid>`.

## Rollback
1. `tailscale serve reset` (remove todos os handlers).
2. Reiniciar o Office sem `HABBLAUD_REMOTE_RO`.
3. Opcional: remover a tag/regra no admin; `tailscale logout` no dispositivo.

## Fora de âmbito
Funnel, Cloudflare Quick Tunnel (não suporta SSE), expor 0.0.0.0, servir a porta do operador.
