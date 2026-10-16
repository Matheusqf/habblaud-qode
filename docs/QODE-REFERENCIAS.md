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

## SkyOffice deep-dive (16/10/2026)

Fonte: [kevinshen56714/SkyOffice](https://github.com/kevinshen56714/SkyOffice) @ `3f66b8b` (19/12/2025). Código **MIT** (© 2021 Kuan-Hsuan Shen). Stack: Phaser 3 + Colyseus + React/Redux + PeerJS.

### Licença dos assets — NÃO copiar
Tilesets (`client/public/assets/tileset/*`, `map/FloorAndGround.png`, `archive/Room_Builder_*`) e personagens (`character/adam|ash|lucy|nancy`) são do **LimeZu** (Modern Interiors / Modern Office, itch.io). A licença LimeZu permite usar em jogos, mas **proíbe redistribuir os ficheiros**, e os packs completos são pagos. A MIT do repo não cobre esses PNGs. Regra: **zero assets do SkyOffice no nosso repo**; usar CC0 (2dPig Pixel Office, Office 8x8) ou arte própria. Os `map.json/.tmx` dependem desses tilesets, então também não se copiam (só a estrutura de camadas como ideia).

### Features
| Feature | O que faz | Arquivos-chave | Encaixe QODE (observe-only) | Valor × esforço | Porte |
|---|---|---|---|---|---|
| Mapa Tiled com camadas de objetos | Itens (Chair, Computer, Whiteboard, VendingMachine) vêm de object layers do Tiled e viram objetos interativos | `client/src/scenes/Game.ts` (L98-150, `addObjectFromTiled`), `client/src/items/*` | Alto: definir mesas/quadros/zonas num JSON Tiled em vez de layout hardcoded (`world/layout`) | Alto × médio | Reescrever loader para o nosso renderer canvas (não usamos Phaser); ideia do contrato de camadas |
| Item selector por sobreposição | Caixa à frente do avatar destaca o item mais próximo e mostra dica ("E para sentar") | `characters/PlayerSelector.ts`, `items/Item.ts` (`onOverlapDialog`) | Médio: hover/foco por teclado em mesas mostra cartão do agente/projeto | Médio × baixo | Copiar a lógica do Item (dialog box) com atribuição MIT, adaptada |
| Computadores "compartilhados" | Ao usar um PC, entra num grupo de screen-share (WebRTC) com quem está no mesmo PC | `items/Computer.ts`, `web/ShareScreenManager.ts`, `components/ComputerDialog.tsx`, `server/rooms/commands/ComputerUpdateArrayCommand.ts` | Adaptado: clicar no monitor de uma mesa abre painel **só leitura** com a ação/ficheiro atual do agente (feature #2 do backlog). Screen-share real = ideia futura | Alto × médio | Reescrever; padrão `connectedUser` por item é bom |
| Whiteboard embutido | Iframe do WBO por sala, com quem está conectado | `items/Whiteboard.ts`, `components/WhiteboardDialog.tsx`, `stores/WhiteboardStore.ts` | Médio: o nosso kanban de parede abre um painel com o board real do projeto (Notion/GitHub Projects), só leitura | Médio × baixo | Reescrever (iframe/link simples) |
| Chat com balões em tempo real | Chat global + balão de fala sobre o avatar que some após alguns segundos | `components/Chat.tsx`, `characters/Player.ts` (`updateDialogBubble`), `stores/ChatStore.ts`, `ChatMessageUpdateCommand.ts` | Já temos `world/social` (balões/linhas). Adotar: balão com a última mensagem/commit do agente, com timeout e limite de caracteres | Médio × baixo | Copiar a lógica de wrap/timeout do bubble (MIT, atribuição) |
| Proximidade (vídeo) | Overlap entre jogadores dispara chamada PeerJS; afastar desliga | `scenes/Game.ts` `handlePlayersOverlap`, `web/WebRTC.ts`, `MyPlayer.ts` | Vídeo/voz: **só ideia futura**. Reuso já: agentes próximos (mesmo projeto/ficheiro) mostram linha de "colaborando" | Médio × baixo (só visual) | Reescrever |
| Salas públicas/privadas com senha | Lobby lista salas Colyseus; criar sala custom com nome, descrição, senha | `components/RoomSelectionDialog.tsx`, `CreateRoomForm.tsx`, `CustomRoomTable.tsx`, `server/index.ts`, `types/Rooms.ts` | Whitelabel: "workspaces" por cliente/equipa com link privado | Alto (venda) × alto | Ideia; arquitetura nossa (sem Colyseus) |
| Seleção de avatar + nome | Login com carrossel de 4 personagens | `components/LoginDialog.tsx`, `anims/CharacterAnims.ts` | Já temos CharacterEditor; ideia de carrossel de presets | Baixo × baixo | Ideia |
| Fundo dia/noite com nuvens | Backdrop e nuvens animadas trocam por modo | `scenes/Background.ts`, `types/BackgroundMode.ts` | Já temos `render/daylight.ts`; ideia: céu/nuvens parallax no exterior do mapa gather | Baixo × baixo | Reescrever com arte CC0 |
| Sentar / animações por direção | `E` senta na cadeira com direção do Tiled | `items/Chair.ts`, `MyPlayer.ts` | Já temos (agentes sentam nas mesas) | — | — |
| Joystick mobile | Joystick virtual | `components/MobileVirtualJoystick.tsx` | Útil para vista telemóvel (pan da câmara) | Baixo × baixo | Ideia |
| Estado autoritativo no servidor | Schema Colyseus (`OfficeState`) + commands | `server/rooms/schema/OfficeState.ts`, `server/rooms/commands/*` | Já temos snapshot do servidor; ideia: comandos pequenos e testáveis por tipo de evento | Médio × médio | Ideia |

### Top recomendado (ordem)
1. **Monitor clicável = painel só leitura do agente** (padrão Computer + `connectedUser`).
2. **Layout via Tiled JSON** (object layers para mesas/quadros/zonas) — destrava o whitelabel.
3. **Balões com última ação/commit** (timeout/wrap do Player bubble).
4. **Kanban de parede abre o board real do projeto** (padrão Whiteboard).
5. **Workspaces privados por cliente** (ideia das salas custom) para a versão whitelabel.

Fora: controlar agentes, vídeo/voz/screen-share (futuro). Atribuição: código copiado leva cabeçalho `Adapted from SkyOffice (MIT) © 2021 Kuan-Hsuan Shen` e entrada no `NOTICE.md`.
