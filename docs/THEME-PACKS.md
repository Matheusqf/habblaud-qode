# Pacotes de tema (white-label)

Um *pacote de tema* é um objeto de config tipado que define a identidade da página do escritório:
nome do produto (título da aba, topbar, avisos), logotipo desenhado em código, paleta (vars CSS),
fontes (só stacks de sistema), padrões de cenário e opções (apelidos, eventos sazonais). Entre os
dois pacotes que vêm no projeto, `habblaud` (neutro) é o **padrão** e `qode` reproduz a marca
QODE Office.

Módulo: `shared/theme-packs.ts` (tipos, validador, built-ins e resolvers puros). Aplicação no
boot: `client/src/main.ts` chama `applyThemePack(currentThemePack(), document)` uma única vez —
não há custo por frame.

## Resolução

1. `?theme=` na URL (ex.: `http://localhost:4747/?theme=qode`);
2. senão a var de build `VITE_HABBLAUD_THEME` (ex.: no build do QODE Office: `VITE_HABBLAUD_THEME=qode npm run build:client`);
3. senão o padrão `'habblaud'`.

Id desconhecido numa origem passa à seguinte (URL inválida → build → padrão). O id resolve para os built-ins da
`shared/theme-packs.ts`.

## Pacote em JSON

Um pacote próprio pode entrar pela var de build `VITE_HABBLAUD_THEME_JSON` (conteúdo JSON do
pacote inteiro). Ele vence o built-in de mesmo id se passar na validação (`validateThemePack`);
id diferente do resolvido, JSON inválido ou fora do schema = ignorado, sem quebrar a página.

## Schema

```jsonc
// exemplo: um pacote "acme" a jogar em VITE_HABBLAUD_THEME_JSON
{
  "id": "acme",                  // id curto, minúsculas/dígitos/hífen (usado em ?theme=)
  "name": "Acme Workspace",      // nome legível
  "brand": {
    "text": "Acme Workspace",    // document.title, topbar, avisos
    "logo": "",                  // SVG inline (string); vazio = usa a arte pixel do app
    "wordmark": "text"           // "pixel" usa o wordmark pixels do app; "text" (padrão) usa o texto abaixo
  },
  "palette": {                   // vars CSS por cima do styles.css (o pacote pinta o chrome)
    "--ui-accent": "#55ff9a",
    "--ui-accent-soft": "rgba(85, 255, 154, 0.13)",
    "--ui-bg": "rgba(16, 22, 18, 0.85)",
    "--ui-bg-solid": "rgba(18, 26, 21, 0.97)",
    "--ui-text": "#eaf5ec"
  },
  "fonts": {                     // stacks de sistema (sem download de fonte)
    "body": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "brand": "Avenir Next, Montserrat, 'Segoe UI Semibold', system-ui, sans-serif"
  },
  "scenery": {                   // tudo opcional; parâmetros/vars explícitas seguem valendo:
    "office": "gather",          //   'gather' | 'classic'  (?office=, VITE_HABBLAUD_OFFICE)
    "rooms": "openspace",        //   'gather' | 'island' | 'openspace'  (?rooms=)
    "garden": "river",           //   'river' | 'off'  (?garden=)
    "fx": "off"                  //   'vibe' | 'off'  (?fx=, VITE_HABBLAUD_FX)
  },
  "nicknames": true,             // apelidos de protagonistas (?nicknames=0/1 muda na hora)
  "seasonal": true               // eventos sazonais: Halloween auto em outubro (?season=halloween/off)
}
```

O tema sazonal em vigor (`?season=auto`, o padrão) avalia UMA vez ao abrir a página; sem recarga
automática. Prioridade nos padrões de cenário: parâmetro da URL > var de build
(`VITE_HABBLAUD_OFFICE`, `VITE_HABBLAUD_FX`) > `scenery` do pacote > nada.

## Onde o pacote entra

- `document.title` e texto da marca no topbar/Splash (logotipo SVG inline e wordmark em texto ou
  pixels), página de entrada da auth (`client/src/net/auth-gate.ts`) e meta tags de compartilhamento;
- vars CSS: `<style id="theme-pack">` por cima do `client/src/ui/styles.css` (`.ui-root`);
- cenário: `client/src/world/season.ts` (office/rooms/garden) e `client/src/world/fx/vibe.ts` (fx);
- apelidos: `shared/nicknames.ts` (`nicknamesEnabled`, consumido por `client/src/net/store.ts`);
- sazonais: `resolveSeason` em `client/src/world/season.ts` (consumido por `client/src/world/sim/sim.ts`).

`shared/brand.ts` expõe `PRODUCT_NAME` (live binding) e `setProductName` para os textos do produto.
