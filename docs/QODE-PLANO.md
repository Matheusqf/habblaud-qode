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

## Próximos passos (ordem proposta)

1. **OpenCode** — nova fonte em `server/sources/` (seguindo o padrão de `server/sources/codex`) lendo as sessões locais do OpenCode, mais plugin (`tool.execute.before`) para atividade ao vivo e aprovações pelo escritório. PR `socio/*` com testes; validação no Mac.
2. **Cursor** — hooks do Cursor (`preToolUse` etc.) para atividade ao vivo e aprovações; histórico completo é mais trabalhoso (fica no banco interno do Cursor) — fazer depois, se valer a pena.
3. **Grok Bot (bots na nuvem)** — exige uma ponte: os bots enviam status para o escritório sem expor o Mac à internet. Desenhar a ponte antes de codar. Por último.
4. **Visual QODE** — gráficos melhores e itens/cenários próprios, em assets e config isolados.
5. **Marca** — nome/logo QODE se for distribuir.
