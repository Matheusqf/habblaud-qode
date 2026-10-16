# NOTICE

habblaud-qode é um fork de [marmottajr/habblaud](https://github.com/marmottajr/habblaud) (MIT).
O aviso de copyright e a licença MIT originais estão em `LICENSE` e devem ser mantidos em
qualquer redistribuição (inclusive versões whitelabel).

## Arte do escritório

- Móveis, pisos, paredes, personagens e decoração são desenhados **em código** (canvas/pixel
  buffers em `client/src/art/` e `client/src/world/render/`). As adições QODE (rótulos pintados no
  chão, open-space, mesa de reunião grande, rio e pontes do jardim, decoração de Halloween) também
  são 100% procedurais: nenhum PNG, tileset ou sprite de terceiros foi adicionado.
- Nenhum asset, mapa ou sprite do Gather (gather.town) é usado; o layout "estilo Gather" é só
  inspiração de planta (ideias), implementado do zero.
- Projetos estudados como referência de ideias (sem cópia de código ou arte): ver
  `docs/QODE-REFERENCIAS.md`.
- Se no futuro entrarem assets externos, só com licença CC0/MIT/CC-BY compatível e registados aqui
  com autor, origem, licença e data.

## Ideias adaptadas de projetos MIT (sem código nem sprites copiados)

- **vibeoffice** — https://github.com/acost1a/vibeoffice — MIT, Copyright (c) 2026 acost1a.
  Inspiração para `client/src/world/fx/vibe.ts` (café ao esperar permissão, tombo ao erro, confete
  ao terminar). Opt-in `?fx=vibe` / `VITE_HABBLAUD_FX=vibe`.
- **pixel-agents** — https://github.com/pixel-agents-hq/pixel-agents — MIT, Copyright (c) 2026 Pablo De
  Lucca. Inspiração para `shared/areas.ts` (áreas nomeadas mapeadas a pastas).
  Os personagens do pixel-agents (baseados em JIK-A-4 "Metro City") **não** são usados.
