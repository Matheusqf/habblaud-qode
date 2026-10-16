# QODE — referências, licenças e backlog de ideias

Pesquisa feita em 2026-10-16 (PT). Base: `/workspace/flow-os/qode-whitelabel-gather-plan.md`.
Regra: **ideias e formatos podem ser reaproveitados; código só de licenças compatíveis (MIT/Apache)
com atribuição; arte de terceiros com licença incerta nunca é copiada.** Nada do Gather.

## Fontes

| Projeto | Licença | Estado (2026-10-16) | O que reaproveitar |
|---|---|---|---|
| [marmottajr/habblaud](https://github.com/marmottajr/habblaud) (upstream) | MIT | ativo, ~640★ | Base. Manter aviso MIT; sync por merge normal. |
| [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) @ d1e007a (2026-10-08) | MIT | muito ativo, ~9.7k★ | Ideias + código MIT com atribuição: `core/src/provider.ts` (HookProvider/AgentEvent normalizados), Areas, editor de layout, packs de assets por manifesto. **Personagens baseados em JIK-A-4 "Metro City" (itch.io) — licença própria, NÃO copiar sprites.** |
| [acost1a/vibeoffice](https://github.com/acost1a/vibeoffice) @ f177f67 (2026-07-14) | MIT | pequeno (~5★) | Ideias: animações de estado (café ao esperar permissão, cair da cadeira em erro, confete ao concluir), zonas no piso, custo/tokens por agente, papéis ao "contratar". Sprites não copiados. |
| [kevinshen56714/SkyOffice](https://github.com/kevinshen56714/SkyOffice) | MIT | ~1.3k★, último push 2025-12 | Ideias: mapas Tiled, proximidade. Verificar origem dos tilesets antes de qualquer arte. |
| [workadventure/workadventure](https://github.com/workadventure/workadventure) | AGPL-3.0 + termos extra | muito ativo | Só ideias ("áreas" com propriedades). Não copiar código (AGPL incompatível com whitelabel fechado). |
| [morluto/rea](https://github.com/morluto/rea) ("Reverse Engineer Anything") | MIT | ativo; npm `rea-agents` | Ferramenta MCP/CLI de engenharia reversa. Usar só em software próprio/MIT. **Nunca contra o Gather.** Nº de stars anómalo: avaliar em sandbox. |
| Gather (gather.town) | proprietário | — | Só screenshots do próprio Matheus como inspiração de planta. ToS tipicamente proíbe engenharia reversa; assets/mapas proprietários. |
| Outros clones "gather town clone" (eweren, aditya1876, pixi-town…) | variadas / sem licença | parados/pequenos | Sem licença = não copiar. |

## Backlog priorizado (features para adotar)

1. **Animações de estado** (vibeoffice): esperar permissão → ir ao café; erro de ferramenta → "cair da cadeira"/fumaça; tarefa concluída/PR → confete (já há confete de PR). Custo baixo, alto valor visual.
2. **Áreas por projeto mapeadas a pastas/repos** (pixel-agents Areas): agentes novos sentam na ilha do projeto do seu `cwd`/repo. Base já existe: `layout/zones.ts` + `?rooms=openspace`.
3. **Provider normalizado por ferramenta** (pixel-agents `HookProvider`/`AgentEvent`: toolStart/toolEnd/turnEnd/subagent*/permissionRequest): unificar coletores Claude/Codex/Cursor numa interface só, facilita a versão whitelabel.
4. **Editor de layout** (pixel-agents): pintar pisos/paredes/móveis e zonas, export/import JSON (o formato `ZoneDef` já é serializável).
5. **Packs de assets por manifesto** (pixel-agents `docs/external-assets.md`): permite whitelabel trocar arte sem código; só packs CC0/licenciados, registados no NOTICE.
6. **Custo/tokens por agente e "contratar" com papel/modelo** (vibeoffice `pricing.ts`, `roles.ts`).
7. **Sons opcionais** em permissão/fim de turno (pixel-agents) — já existe `sound-cues.ts`; alinhar.

## Estado das fatias do mapa estilo Gather

- G1 zonas (`layout/zones.ts`), G2 open-space com nome no chão, G3 alcançabilidade do prédio inteiro, G4 mesa de reunião grande rotulada, G5 rio/pontes decorativos, G6 arte só em código + `NOTICE.md`, G7 preset por config (`VITE_HABBLAUD_OFFICE=gather`, `?office=gather`, `?rooms=openspace`, `?garden=river`). Tudo opt-in; padrão inalterado.

## Estado do backlog

- Item 1 (animações de estado): `client/src/world/fx/vibe.ts`, opt-in `?fx=vibe` / `VITE_HABBLAUD_FX=vibe` — café (ícone) ao entrar em espera de permissão, tombo (estrelinhas de tontura + suor) ao erro, confete ao `done` do agente principal.
- Item 2 (Areas por projeto): `shared/areas.ts` + `VITE_HABBLAUD_AREAS='[{"name":"Singolo","paths":["/caminho/singolo"]}]'` — a sala de um projeto dentro dessas pastas passa a mostrar o nome da área (placa, rótulo no chão, lista).
