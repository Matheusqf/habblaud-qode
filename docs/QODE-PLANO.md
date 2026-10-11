# Habblaud QODE — plano de próximos passos

Fork de [marmottajr/habblaud](https://github.com/marmottajr/habblaud) (MIT) para a QODE Studio.
Criado em 11/10/2026 a partir da v0.8.0 (`d5f3718`). **Status: PR 1 (salas por projeto + Vida OS privado) em revisão.**

## Regras do fork

- Manter o `LICENSE` original com o copyright de Márcio Junior (exigência da MIT).
- Customizações da QODE ficam isoladas (pastas e config próprias), mexendo o mínimo no núcleo, para os merges do upstream quase nunca darem conflito.
- Se virar produto público: trocar nome e logo "Habblaud" por marca QODE; não usar arte do Habbo.

## Sincronização com o upstream

- Toda segunda de manhã o Sócio BOT compara com `marmottajr/habblaud`, abre PR `socio/upstream-sync-AAAAMMDD` (merge normal, nunca cherry-pick) e revisa segurança/performance.
- **Quem faz o merge:** o Sócio BOT faz o merge desse PR semanal **só** com os testes verdes (`npm run typecheck`, `npm test`, `npm run build`) e a revisão de segurança limpa. Se algo falhar ou a revisão achar problema, o PR fica aberto para o Matheus.
- A regra "sem merge" vale só para os agentes que implementam features (eles abrem PR e param). Ela não se aplica ao sync semanal do Sócio BOT.
- O sync precisa manter os testes de `server/qode/` verdes: um campo novo do upstream em `AgentInfo`, `RoomInfo`, `Activity`, `FeedItem`, `Notice` ou no snapshot quebra o typecheck de `server/qode/privacy.ts` até alguém decidir se ele pode aparecer para projetos privados.
- Pontos revisados: rede/destinos externos novos, `exec`/`eval`, dependências novas, hooks/plugins do Claude e Codex (`mod/`, `scripts/*-install`), guard HTTP, bind de host e Docker, leitura de credenciais, telemetria, polling mais pesado.

## Revisão de segurança inicial (v0.8.0, 11/10/2026)

- Zero dependências em runtime; sem chamadas a APIs de IA (não gasta tokens).
- Escuta só em loopback; proteção contra DNS rebinding; escrita só com Origin local e JSON.
- Docker: read-only, `cap_drop: ALL`, `no-new-privileges`, porta presa em 127.0.0.1.
- Única saída externa: checagem de versão no GitHub a cada 6 h (mantida como no upstream; `HABBLAUD_UPDATE_CHECK=0` desliga).
- Risco aceito: com os plugins de permissões/mensagens ligados, quem tem a aba aberta aprova comandos dos agentes. Usar só no Mac pessoal; não instalar no computador cloud dos bots.

## Estado (júri de 11/10/2026)

Avaliado por um júri de 3 (segurança, manutenção/upstream, produto) em [QODE-JURI-2026-10-11.md](QODE-JURI-2026-10-11.md).
O júri mandou mudar o passo 1 (aprovações do OpenCode adiadas e privacidade do Vida OS antes de qualquer fonte nova).
O Matheus aceitou a proposta revisada com ajustes de uma terceira opinião (allowlist em todas as saídas, detecção do
caminho do Vida OS dentro do que o agente lê, subagentes herdam a privacidade, config em JSON à mão, sem Docker e sem
OpenCode neste PR). O PR 1 está no [PR #2](https://github.com/Matheusqf/habblaud-qode/pull/2); como usar e validar: [qode/README.md](../qode/README.md).

Fatos do Mac (11/10/2026): OpenCode 1.18.35 (linha 1.x, alvo do PR 2); o Habblaud nunca rodou lá (sem `~/.habblaud`) e
vai rodar em Node, sem Docker; home `/Users/matheusdequeiroz`.

| Passo | Veredito do júri | Estado |
| --- | --- | --- |
| Portfólio: sala por projeto + Vida OS privado (`server/qode/`) | Aprovar com mudanças, **primeiro** | **Implementado (PR 1, PR #2)**; falta validar no Mac |
| 1. OpenCode — fonte de leitura | Aprovar com mudanças | Próximo (PR 2), só OpenCode 1.x, em Node (Docker fora) |
| 1. OpenCode — plugin | Só status ao vivo (P1), opt-in, PR separado; aprovações adiadas | Proposto (PR 3); aprovações num passo 1b |
| 2. Cursor | Aprovar com mudanças (só hooks de status, sem banco interno, sem aprovações) | Não iniciado |
| 3. Ponte para os bots na nuvem | Só desenho, até exceção escrita às regras de rede | Não iniciado |
| 4. Visual QODE | Aprovar com mudanças, baixa prioridade (assets isolados) | Não iniciado |
| 5. Marca | Rejeitar por ora (só se distribuir) | Não iniciado |

Ordem recomendada pelo júri: portfólio/privacidade → OpenCode leitura → plugin P1 → Cursor → aprovações do OpenCode
(1b) → visual → desenho da ponte → marca.

## Próximos passos (ordem original, antes do júri)

1. **OpenCode** — nova fonte em `server/sources/` (seguindo o padrão de `server/sources/codex`) lendo as sessões locais do OpenCode, mais plugin (`tool.execute.before`) para atividade ao vivo e aprovações pelo escritório. PR `socio/*` com testes; validação no Mac.
2. **Cursor** — hooks do Cursor (`preToolUse` etc.) para atividade ao vivo e aprovações; histórico completo é mais trabalhoso (fica no banco interno do Cursor) — fazer depois, se valer a pena.
3. **Grok Bot (bots na nuvem)** — exige uma ponte: os bots enviam status para o escritório sem expor o Mac à internet. Desenhar a ponte antes de codar. Por último.
4. **Visual QODE** — gráficos melhores e itens/cenários próprios, em assets e config isolados.
5. **Marca** — nome/logo QODE se for distribuir.
