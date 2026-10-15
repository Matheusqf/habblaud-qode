# QODE Office: runbook seguro de ensaio

Regras de ensaio (Q6). Nada aqui pede para abrir, ler ou citar conteúdo real de Vida OS, UBOTS ou Wellhub.

## Versões fixadas

| Item | Valor |
| --- | --- |
| Fork `Matheusqf/habblaud-qode` (base desta fatia) | `343dbde955eb4474cf14eff20e0327f5573392d4` |
| Upstream `marmottajr/habblaud` (merge-base) | `d5f371869097be683f624f29efefef49d3209c90` |
| `dev-flow` (dependência de orquestração, só-leitura) | `4440485` |

Os nomes técnicos `HABBLAUD_*`, o slug `habblaud` e o `package.json` **não** são renomeados (compatibilidade com o upstream).

## Subir para ensaio

```bash
cp qode/qode.config.ciclo.json ~/.habblaud/qode.config.json   # manifesto do ciclo (8 projetos)
HABBLAUD_UPDATE_CHECK=0 HABBLAUD_QODE_REQUIRED=1 HABBLAUD_HOST=127.0.0.1 npm start
```

- `HABBLAUD_UPDATE_CHECK=0`: sem chamadas ao GitHub durante o ensaio.
- `HABBLAUD_QODE_REQUIRED=1`: o servidor recusa iniciar (sai com código 1) se a config estiver ausente/inválida,
  `HABBLAUD_QODE_CONFIG` for relativo/errado, `projetos` vazio, algum projeto sem `"privado"` explícito, chave
  parecida com `privado` (`privada`, `_privado`…), bind fora do loopback ou `HABBLAUD_ALLOWED_HOSTS` preenchido.
  Sem essa variável, o comportamento é o do upstream.
- Não usar túnel/proxy (Host reescrito) neste ciclo: é superfície crítica sem autenticação.

## Testar privacidade com dados sintéticos

Use só pastas de teste, por exemplo:

```bash
mkdir -p /tmp/qode-ensaio/privado-sintetico && echo "conteudo-falso" > /tmp/qode-ensaio/privado-sintetico/nota.md
```

Num config **de ensaio** (cópia, via `HABBLAUD_QODE_CONFIG=/tmp/qode-ensaio/qode.config.json`), declare
`/tmp/qode-ensaio/privado-sintetico` com `"privado": true` e confira:

```bash
curl -s localhost:4747/api/snapshot | grep -ci 'privado-sintetico'        # 0
curl -s localhost:4747/api/sessions/recent | grep -ci 'privado-sintetico' # 0
```

## Critério do ciclo

**Zero exposição** de projetos proibidos na UI/API/logs. Não é "zero leitura": o servidor ainda lê transcripts em
memória para saber o estado do agente. Pastas fora da lista ainda aparecem como no upstream (Q0, fora desta fatia).
