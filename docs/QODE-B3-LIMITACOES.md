# QODE B3 — limitações da suíte sintética de privacidade

Escopo: fixtures sintéticos (`PrivadoSintetico`), sem dados reais. Esta suíte **não** prova isolamento remoto.

## O que a suíte prova
- `mentionsPrivate` deteta relativo com `/` antes do nome (`../../Documents/PrivadoSintetico/x`), `./PrivadoSintetico`, `$VAR/PrivadoSintetico` (segmento de nome, nomes ≥4 chars).
- Symlink fora da home apontando para a pasta privada contamina; o alias é aprendido (`privateAliases`) e um glob posterior por esse alias continua detetado (`b3-alias-learning.test.ts`, regressão encontrada pelo ZikaBOT e corrigida: `mentionsPrivateTail` corre depois de `isPrivateToken`).
- Delegação: subagente que cita privado contamina principal e irmãos.
- Logs com caminho relativo privado são redigidos.
- Taint inicial na mesma execução (invariante, teste normal — fora do `it.fails`).

## Gaps reproduzidos (`it.fails`, passam enquanto o gap existir)
- `cd PrivadoSintetico` (sem `/` antes do nome).
- Nome montado por variável concatenada (`$P"Sintetico"`).
- Paste de conteúdo sem caminho num agente público.
- Persistência: o taint vive só em memória.

## Limites honestos
- **Restart**: o teste cria um segundo `setupQode` no mesmo processo e `dataDir`. Não é restart real (processo novo) nem replay de transcripts/hooks; só mostra que o taint não está em disco. Restart/replay real está por fazer.
- **SSE**: os casos novos não são verificados via SSE. A cobertura SSE existente testa agentes já privados e não deve ser atribuída a estes casos.
- **Contagem de expected-fail** (ex.: "7+4" citado na revisão) mede gaps conhecidos locais de deteção; **não** é métrica de isolamento remoto nem de auth (ver B4/PR #6, #8).
- Segmento de nome pode dar falso positivo em pastas homónimas noutros sítios (fail closed, intencional).
