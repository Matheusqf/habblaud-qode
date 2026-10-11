# Habblaud QODE — plano de próximos passos

Fork de [marmottajr/habblaud](https://github.com/marmottajr/habblaud) (MIT) para a QODE Studio.
Criado em 11/10/2026 a partir da v0.8.0 (`d5f3718`). **Status: em espera** — Matheus retoma quando quiser.

## Regras do fork

- Manter o `LICENSE` original com o copyright de Márcio Junior (exigência da MIT).
- Customizações da QODE ficam isoladas (pastas e config próprias), mexendo o mínimo no núcleo, para os merges do upstream quase nunca darem conflito.
- Se virar produto público: trocar nome e logo "Habblaud" por marca QODE; não usar arte do Habbo.

## Sincronização com o upstream

- Toda segunda de manhã o Sócio BOT compara com `marmottajr/habblaud`, abre PR `socio/upstream-sync-AAAAMMDD` (merge normal, nunca cherry-pick), revisa segurança/performance e faz merge se estiver limpo.
- Pontos revisados: rede/destinos externos novos, `exec`/`eval`, dependências novas, hooks/plugins do Claude e Codex (`mod/`, `scripts/*-install`), guard HTTP, bind de host e Docker, leitura de credenciais, telemetria, polling mais pesado.

## Revisão de segurança inicial (v0.8.0, 11/10/2026)

- Zero dependências em runtime; sem chamadas a APIs de IA (não gasta tokens).
- Escuta só em loopback; proteção contra DNS rebinding; escrita só com Origin local e JSON.
- Docker: read-only, `cap_drop: ALL`, `no-new-privileges`, porta presa em 127.0.0.1.
- Única saída externa: checagem de versão no GitHub (`HABBLAUD_UPDATE_CHECK=0` desliga).
- Risco aceito: com os plugins de permissões/mensagens ligados, quem tem a aba aberta aprova comandos dos agentes. Usar só no Mac pessoal; não instalar no computador cloud dos bots.

## Estado (júri de 11/10/2026)

Avaliado por um júri de 3 (segurança, manutenção/upstream, produto) em [QODE-JURI-2026-10-11.md](QODE-JURI-2026-10-11.md).
O júri mandou mudar o passo 1 (aprovações do OpenCode adiadas e privacidade do Vida OS antes de qualquer fonte nova),
então **nada foi implementado**: o [PR #2](https://github.com/Matheusqf/habblaud-qode/pull/2) traz só os documentos e a proposta revisada, à espera da decisão do Matheus.

| Passo | Veredito do júri | Estado |
| --- | --- | --- |
| Portfólio: sala por projeto + Vida OS privado (`server/qode/`) | Aprovar com mudanças, **primeiro** | Proposto (PR 1 da proposta revisada); aguarda decisão |
| 1. OpenCode — fonte de leitura | Aprovar com mudanças | Proposto (PR 2); aguarda decisão e versão do OpenCode no Mac |
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
