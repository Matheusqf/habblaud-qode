// Aplica o pacote de tema em vigor UMA vez, no boot da página (client/src/main.ts): nome do
// produto (document.title, painéis que usam PRODUCT_NAME), vars de paleta/fonte (`.ui-root` e
// :root) e metadados de compartilhamento. Sem custo por frame: nada disso é lido no loop de
// renderização.
import type { ThemePack } from '../../../shared/theme-packs';
import { currentThemePack } from '../../../shared/theme-packs';
import { setProductName } from '../../../shared/brand';

/** CSS do pacote: paleta e fontes por cima do styles.css (vence por ordem no <head>). */
export function themePackCss(pack: ThemePack): string {
  const vars = [
    ...Object.entries(pack.palette).map(([k, v]) => `  ${k}: ${v};`),
    // --font-ui é a var que o styles.css usa no corpo da interface
    `  --font-ui: ${pack.fonts.body};`,
    `  --font-brand: ${pack.fonts.brand};`,
  ].join('\n');
  return `.ui-root {\n${vars}\n}\n.ui-brand__word { font-family: var(--font-brand); }\n`;
}

/** Logotipo do pacote (SVG inline) para a marca no topbar/Splash, ou undefined quando o pacote usa a arte do app. */
export function packLogoSvg(): string | undefined {
  return currentThemePack().brand.logo || undefined;
}

/**
 * Logotipo do pacote como <img> com data-URI SVG: o navegador não executa script nem carrega recursos
 * externos em SVG usado como imagem (mais seguro que innerHTML para um pacote vindo de JSON).
 */
export function packLogoImg(size: number): HTMLImageElement | undefined {
  const svg = packLogoSvg();
  if (!svg) return undefined;
  if (logoUri?.svg !== svg) logoUri = { svg, uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  const img = document.createElement('img');
  img.src = logoUri.uri;
  img.alt = '';
  img.width = size;
  img.height = size;
  img.draggable = false;
  return img;
}

let logoUri: { svg: string; uri: string } | null = null;

/** Wordmark do topbar conforme o pacote: 'pixel' (arte atual) ou o texto do pacote. */
export function packWordmark(): { pixel: boolean; text: string } {
  const pack = currentThemePack();
  return { pixel: pack.brand.wordmark === 'pixel', text: pack.brand.text };
}

/** Aplica o pacote a um documento (uma chamada, no boot): título, nome do produto, vars e meta tags. */
export function applyThemePack(pack: ThemePack, doc: Document): void {
  setProductName(pack.brand.text);
  doc.title = pack.brand.text;

  const style = doc.createElement('style');
  style.id = 'theme-pack';
  style.textContent = themePackCss(pack);
  doc.head.append(style);

  for (const sel of ['meta[property="og:site_name"]', 'meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    doc.head.querySelector(sel)?.setAttribute('content', pack.brand.text);
  }
}
