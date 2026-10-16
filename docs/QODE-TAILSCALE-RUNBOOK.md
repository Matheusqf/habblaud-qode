# Runbook — QODE Office via Tailscale Serve (SEM Funnel)

Estado: **inerte**. Nada aqui é executado por scripts. Ativação real só com aprovação explícita do Matheus (caminho, plano e custo).

## Pré-requisitos (decisão do Matheus)
- Plano Tailscale: Personal é grátis só para uso **não comercial**; Standard US$8/utilizador/mês (consultado 16/10/2026). Não assumir elegibilidade.
- Nome do dispositivo **não sensível** (o certificado HTTPS publica `<device>.<tailnet>.ts.net` em Certificate Transparency).
- **Consentimento HTTPS + MagicDNS**: ativar MagicDNS e "HTTPS Certificates" no admin é uma decisão explícita (publica o nome em CT). Sem consentimento, parar aqui.
- Senha B4 definida: `npm run auth:set-password`.

## 0. Inspecionar antes de mexer (guardar o "antes")
```
tailscale serve status --json  > /tmp/serve-before.json
tailscale funnel status --json > /tmp/funnel-before.json
```
- Se já houver handlers de outros serviços: **não** sobrescrever; escolher outra porta HTTPS ou parar e decidir com o Matheus.
- Conferir que nenhum `AllowFunnel` está `true` (nem para outros serviços) antes de continuar.

## 1. Política e identidade
1. Aplicar `deploy/tailscale/acl.inert.hujson`: só `group:qode-owner` (login Tailscale do Matheus — substituir o placeholder) → `tag:qode-office:443`. Outro membro do tailnet é negado (teste na própria política). Confirmar que a regra padrão "allow all" foi removida.
2. Tag do dispositivo: `tag:qode-office`.

## 2. Office
`HABBLAUD_REMOTE_RO=1 HABBLAUD_REMOTE_RO_PORT=4320 HABBLAUD_REMOTE_RO_ORIGIN=<device>.<tailnet>.ts.net` com `HABBLAUD_HOST=127.0.0.1` e sem `--dev`. O preflight recusa arrancar se faltar algo (produção, origem HTTPS canónica, bind loopback). O operador continua em 127.0.0.1:4319 e **não** é servido.

## 3. Serve
`tailscale serve --bg --https=443 http://127.0.0.1:4320` (equivale a `deploy/tailscale/serve.inert.json`).
- **`--bg` persiste após reinício** do tailscaled/da máquina: a exposição continua até ser removida explicitamente (ver Rollback). Registar isto no estado do QODE.
- **Nunca** `tailscale funnel`.

## 4. Verificação (depois)
- `tailscale serve status --json` → só `${host}:443` `/` → `http://127.0.0.1:4320`; comparar com `/tmp/serve-before.json` (só esta entrada é nova).
- `tailscale funnel status --json` → nenhum `AllowFunnel: true` (verificar a config efetiva, não apenas "vazio").
- Do dispositivo do Matheus: `/` → login; `POST /api/rooms/rename` → 405; `/api/hooks` → 403. De outro membro do tailnet: sem acesso à 443. Fora do tailnet: não conecta.
- `ss -ltnp`: 4319 e 4320 só em 127.0.0.1.
- Revogação: `npm run auth:set-password` (nova senha) → streams abertos fecham em ≤5 s; ou `kill -USR2 <pid>`.

## Rollback seletivo (não usar `serve reset`, que apaga handlers de outros serviços)
1. Antes: `tailscale serve status --json > /tmp/serve-pre-rollback.json`.
2. Remover só o handler do Office: `tailscale serve --https=443 off` (ou o comando equivalente para o caminho `/` dessa porta na versão instalada).
3. Depois: `tailscale serve status --json` — o handler do Office sumiu e os restantes estão iguais a `/tmp/serve-pre-rollback.json`; `tailscale funnel status --json` sem `true`.
4. Reiniciar o Office sem `HABBLAUD_REMOTE_RO`; confirmar 4320 fechado (`ss -ltnp`).
5. Opcional: remover tag/regra no admin.

## Fora de âmbito
Funnel, Cloudflare Quick Tunnel (não suporta SSE), expor 0.0.0.0, servir a porta do operador.
