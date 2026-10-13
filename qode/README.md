# QODE: uma sala por projeto e Vida OS privado

Personalização do fork QODE (código em `server/qode/`). Ela só liga quando existe o arquivo
`~/.habblaud/qode.config.json`, ou o arquivo apontado por `HABBLAUD_QODE_CONFIG`. Sem esse arquivo, o Habblaud
funciona igual ao upstream.

## O que faz

- **Uma sala por projeto.** Cada projeto do arquivo vira uma sala com o nome dele. Entram na mesma sala o repositório,
  as subpastas e as worktrees irmãs: um caminho terminado em `*` (ex.: `~/Documents/GitHub/singolo-*`) pega todas as
  pastas que começam assim. A comparação de caminhos ignora maiúsculas e minúsculas, como no disco do Mac.
- **Projeto privado** (`"privado": true`). Para um projeto privado, o escritório mostra **só** o nome do projeto e o
  estado dos agentes: trabalhando, esperando, lendo, editando e afins, sempre com um texto genérico. Título, tarefas,
  comandos, caminhos, diffs, perguntas, modelo, branch, números de uso e pedidos de permissão não aparecem. O
  terminal e o histórico de sessões não abrem. Para isso, o filtro funciona por **allowlist**: só sai o que está
  marcado `keep` em `server/qode/privacy.ts`.
- **Vale para todas as saídas:** snapshot e SSE (`/api/stream`), `/api/snapshot`, `/api/agents/:id`,
  `/api/mod/summary` (statusline do mod), linha do tempo gravada em disco, estatísticas do "Meu dia", terminal,
  `/api/sessions/*`, pedidos de permissão, mensagens e logs. Nos logs, os caminhos privados viram `[privado]`.
- **Caminhos canônicos.** Antes de classificar, a pasta do agente e cada caminho citado são lidos de dois jeitos, e
  se um deles cair no privado, o privado ganha:
  - **como texto:** `.`, `..` e barras duplas resolvidos;
  - **como o disco lê:** symlinks seguidos com o `..` ainda no lugar. O caminho cru vai para o realpath; se um
    componente não existe ou não pode ser lido (EACCES, ELOOP…), o resto é colapsado como texto e a caminhada
    **continua** a partir daí, até não haver mais `..` nem symlink resolvível.

  As três leituras (só texto, física estrita e texto+física) são candidatas: se qualquer uma cair no privado, o
  privado ganha. Um erro numa leitura não torna o caminho público se outra for privada.

  Assim caem no Vida OS: `~/atalho-vida` apontando para `~/Documents/Vida`, `~/Documents/GitHub/clinicas/../../Vida`,
  `clinicas/ponte/../Vida` e também `clinicas/nao-existe/../ponte/secret.md`, quando `ponte` aponta para o Vida. As
  respostas do disco ficam guardadas só por 2 segundos, e só quando o caminho existe, então um symlink criado ou
  trocado depois vale logo.
- **Quem cita o Vida OS vira privado.** Um agente em outra pasta que lê, busca ou roda algo com um caminho do projeto
  privado também vira privado. O detector reconhece estas formas:
  - caminho absoluto, `~/…`, `~usuario/…`, `$HOME/…` e `${HOME}/…`, inclusive com aspas no meio (`"$HOME"/Documents/…`,
    `$HOME"/Documents/Vida"`) e com espaço no nome (`"/tmp/qode alias/…"`, `/tmp/qode\ alias/…`, aspas concatenadas
    no estilo do shell e `bash -c 'cat "…/qode alias/…"'`);
  - URL-encoding (`%2F`, `%20` no meio do nome, também no cwd e no `caminhos` da config), `\u002f` no JSON, `file://` e `file://localhost/`, barras escapadas
    de JSON (`\/`), `.`, `..` e `//` no meio;
  - globs que incluem parte do nome da pasta (`~/Documents/Vi*`);
  - a pasta codificada do Claude Code (`-Users-…-Documents-Vida`);
  - qualquer combinação de maiúsculas e minúsculas.

  `~/Documents/Vidal` **não** conta, porque a comparação é por pasta inteira. Junto com o agente ficam privados o
  principal, todos os subagentes e a sessão inteira (pelo `sessionId`, mesmo que o pedido de permissão chegue antes
  de o agente aparecer). Isso não se desfaz enquanto o servidor estiver rodando.
- **Permissões já registradas** antes da contaminação também somem: o vínculo pedido→sessão vale enquanto o pedido
  existir (não é descartado para “fazer espaço”). Sem identidade do pedido, leitura e aprovação fecham.
- **Transcript em JSON:** cada linha é inspecionada já decodificada (`JSON.parse`). Uma linha completa que parece
  JSON e não parseia fecha o acesso. Uma linha ainda incompleta (escrita pela metade) só bloqueia na hora, sem
  marcar a sessão para sempre; quando a linha termina, o servidor olha de novo. Num texto grande demais (muitos
  caminhos ou muitos bytes), a inspeção para e o agente é tratado como privado — falha fechada, para não travar o
  servidor. O mesmo teto vale no scanner do transcript e no histórico.
- **Subagentes herdam** a privacidade do principal. Um subagente sem principal conhecido é tratado como privado
  (só quando existe algum projeto privado). O papel do subagente aparece sempre genérico ("Subagente"), porque nomes
  de agentes customizados podem revelar o projeto.
- **Transcript ilegível = fechado.** Se o servidor não consegue ler o transcript de uma sessão, o terminal e o
  histórico dela não abrem.
- **Arquivo inválido = tudo privado e opaco.** JSON quebrado, chave desconhecida (ex.: `"privada"` em vez de
  `"privado"`), `*` fora do fim do caminho ou caminho relativo deixam **todos** os agentes privados. As salas viram
  "Privado xxxx", com um id que é um hash e não o caminho, inclusive na linha do tempo, nas estatísticas e no
  `rooms.json`. Os logs escondem qualquer caminho da sua home. O log avisa em vermelho até você corrigir, e
  `/api/health` mostra `"qode": {"config": "invalida", "erro": "…"}` — o erro é só o diagnóstico, sem ecoar a chave ou
  o caminho que quebraram o arquivo. Com o arquivo certo aparece `"config": "ok"`, e sem arquivo, `"ausente"`.
- **Logs:** a linha é cortada no primeiro caminho privado. Tudo o que vem depois vira `[privado]`.

## Configurar no Mac

Você precisa do Node 22.12 ou mais novo e dos comandos abaixo, rodados na pasta do repositório:

```bash
npm install
npm run build
mkdir -p ~/.habblaud
cp qode/qode.config.example.json ~/.habblaud/qode.config.json
```

Confira os dois caminhos marcados como "a confirmar" (Atelier Lisboa e Fantasy) e ajuste o arquivo, se for preciso:

```bash
ls -d ~/Documents/GitHub/projeto-interiores ~/Documents/GitHub/fantasies-x
```

Formato do arquivo:

- `projetos`: lista com `nome` (até 40 caracteres), `caminhos` (absolutos ou começando com `~/`) e, opcionalmente,
  `privado` (true/false) e `nota` (texto livre, que o Habblaud ignora).
- Chaves começando com `_` ou `$` são comentários.

Se um caminho cair em mais de um projeto, o privado ganha.

## Validar (passo a passo)

1. Suba o servidor. A checagem de versão no GitHub continua ligada, como no upstream; para desligar, use
   `HABBLAUD_UPDATE_CHECK=0`:

   ```bash
   HABBLAUD_UPDATE_CHECK=0 npm start
   ```

   No log deve aparecer `QODE: 9 projeto(s) no qode.config.json, 1 privado(s).`, e
   `curl -s localhost:4747/api/health` deve mostrar `"qode":{"config":"ok",…}`.
2. Abra http://localhost:4747 e, num terminal, abra o Claude Code (ou o Codex) em
   `~/Documents/GitHub/singolo` e em uma worktree `~/Documents/GitHub/singolo-<algo>`. Os dois agentes precisam
   aparecer na **mesma sala**, "Singolo".
3. Abra o Claude Code em `~/Documents/Vida`. A sala aparece como **"Vida OS"**. O agente mostra só o estado (ex.:
   "Lendo", "Pensando") e nenhum título, tarefa ou caminho. O botão do terminal responde "transcript do agente não
   encontrado".
4. Confira o que sai pela API:

   ```bash
   curl -s localhost:4747/api/snapshot | grep -ci 'documents/vida'     # tem que dar 0
   curl -s localhost:4747/api/sessions/recent | grep -ci 'vida'        # tem que dar 0
   grep -ril 'documents/vida' ~/.habblaud/timeline ~/.habblaud/stats   # não pode listar nada
   ```

5. Num projeto público (ex.: Clínicas), peça ao agente para ler um arquivo **sem importância** de
   `~/Documents/Vida` pelo caminho absoluto. Na hora, o agente de Clínicas passa a mostrar só o estado, e o terminal
   dele para de abrir.
6. Teste do fail closed: troque `"privado"` por `"privada"` no arquivo e reinicie. O log mostra `inválido … TODOS os
   agentes ficam privados`, as salas viram "Privado xxxx", nenhum agente mostra título e
   `curl -s localhost:4747/api/snapshot | grep -c "$HOME/Documents"` dá 0. Desfaça a troca e reinicie.

## Limites conhecidos

- O servidor ainda **lê** os transcripts do Vida OS em memória, porque é assim que ele sabe o estado. O que este PR
  garante é que esse conteúdo não **sai**: nem para a tela, nem para a API, nem para o disco, nem para os logs.
- O agente só vira privado quando o caminho privado aparece no que ele faz. **Não** são detectados:
  - caminho relativo a partir de outra pasta (ex.: `cat ../../Documents/Vida/x` ou `cd Documents; cat Vida/x`);
  - variáveis que não sejam `HOME` (ex.: `D=~/Documents; cat $D/Vida/x`);
  - globs genéricos de uma pasta acima (ex.: `ls ~/Documents/*`, `grep -r x ~/Documents`);
  - conteúdo do Vida OS que chega sem caminho (colado no prompt, por exemplo);
  - o que o agente já mostrou antes de citar o caminho: a contaminação vale dali em diante.
- O histórico de sessões esconde as sessões cujo projeto, título ou agente aberto é privado, e as sessões sem projeto
  conhecido. Uma sessão de outro projeto que citou o Vida OS lá no começo ainda pode aparecer na lista com o título. Ao
  abrir, o servidor varre o transcript inteiro e recusa a sessão.
- A primeira abertura do terminal de uma sessão grande varre o arquivo inteiro uma vez. Depois disso, só os bytes
  novos são lidos.
- Para agentes privados, as estatísticas do "Meu dia" contam a presença, mas não os tokens nem o custo.
- Fora deste PR: OpenCode (o PR 2 mira a linha 1.x) e Docker. O Habblaud roda direto no Node.
