// Pacotes de identidade visual ("white-label"): objeto de config tipado com id, marca, paleta,
// fontes, padrões de cenário e opções (apelidos, eventos sazonais). HabbLaud é o NEUTRO/PADRÃO;
// o QODE Office é um pacote que hoje tem a marca à mão (título "QODE Office" etc.) — para
// reproduzir, defina `VITE_HABBLAUD_THEME=qode` no build da página do escritório.
//
// Resolução (uma vez, em boot da página): `?theme=` na URL > `VITE_HABBLAUD_THEME` da build >
// pacote padrão ('habblaud'). Ids desconhecidos caem no padrão. `VITE_HABBLAUD_THEME_JSON` permite
// um pacote próprio em JSON (schema em docs/THEME-PACKS.md); se válido e com o id resolvido, ele
// vence o built-in de mesmo id. Os parâmetros/variáveis explícitos de cenário (?office=, ?rooms=,
// ?garden=, ?fx=, ?season=, VITE_HABBLAUD_OFFICE, VITE_HABBLAUD_FX) continuam valendo sobre os
// padrões do pacote. Funções puras aqui: nada muda por frame; o mundo e a UI leem o pacote uma vez.

/** Id do pacote padrão (usado também quando um id é desconhecido). */
export const DEFAULT_PACK_ID = 'habblaud';

/** Preset do escritório (open-space + jardim, ou clássico). Mesmos literais de client/src/world/season.ts. */
export type ThemePackOfficePreset = 'gather' | 'classic';
/** Estilo único para todas as salas; senão, a semente sorteia. */
export type ThemePackRoomStyle = 'gather' | 'island' | 'openspace';
/** Jardim decorativo no do lado de fora. */
export type ThemePackGardenStyle = 'river' | 'off';
/** Reações "vibe" (?fx=vibe): café, queda da cadeira, confete. */
export type ThemePackFx = 'vibe' | 'off';

/** Marca: texto (título da página, wordmark no topo) e logotipo desenhado em código (SVG inline, sem imagem proprietária). */
export interface ThemePackBrand {
  /** Nome do produto: document.title, topbar, avisos. */
  text: string;
  /** SVG inline (string) do logotipo; renderizado como <img> com data-URI (sem script), até 8 KB em bytes UTF-8 (LOGO_MAX_BYTES). Vazio = usa a marca pixel do próprio app. */
  logo: string;
  /** Wordmark do topbar: 'pixel' usa o logotipo em pixels do app; 'text' (padrão) usa `text` com `--font-brand`. */
  wordmark?: 'pixel' | 'text';
}

/** Vars CSS por cima dos valores do styles.css (o pacote pinta o chrome: acento, fundo, texto). */
export type ThemePackPalette = Record<`--${string}`, string>;

/** Fontes: só stacks de sistema (sem download de fonte). */
export interface ThemePackFonts {
  /** Corpo da interface (painéis, nomes, números). */
  body: string;
  /** Wordmark em texto (quando `brand.wordmark` = 'text'). */
  brand: string;
}

/** Padrões de cenário do pacote; parâmetros e vars de build explícitas seguram o comando. */
export interface ThemePackScenery {
  office?: ThemePackOfficePreset;
  rooms?: ThemePackRoomStyle;
  garden?: ThemePackGardenStyle;
  fx?: ThemePackFx;
}

export interface ThemePack {
  /** Id curto (usado em ?theme= e VITE_HABBLAUD_THEME). */
  id: string;
  /** Nome legível (Sobre, título de aba quando o brand text não é outro). */
  name: string;
  brand: ThemePackBrand;
  palette: ThemePackPalette;
  fonts: ThemePackFonts;
  scenery: ThemePackScenery;
  /** Apelidos de protagonistas no lugar dos nomes: padrão do pacote (?nicknames=0 desliga, =1 liga). */
  nicknames: boolean;
  /** Temas sazonais: Halloween auto em outubro; false = nunca (URL ?season=halloween pode forçar). */
  seasonal: boolean;
}

/** Id válido: minúsculas, dígitos e hífen (o mesmo que a URL aceita sem escape). */
export function isValidPackId(v: string): boolean {
  // nomes do Object.prototype ficam reservados (defesa extra contra lookups herdados)
  return /^[a-z0-9][a-z0-9-]*$/.test(v) && v.length <= 40 && !(v in Object.prototype);
}

/** Valida um valor de fora (JSON) contra o schema do pacote: devolve o pacote tipado ou undefined. */
export function validateThemePack(value: unknown): ThemePack | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;

  if (typeof v.id !== 'string' || !isValidPackId(v.id)) return undefined;
  if (typeof v.name !== 'string' || v.name.length === 0) return undefined;
  if (typeof v.nicknames !== 'boolean' || typeof v.seasonal !== 'boolean') return undefined;

  const brand = isRecord(v.brand) ? v.brand : undefined;
  if (!brand) return undefined;
  if (typeof brand.text !== 'string' || brand.text.length === 0) return undefined;
  if (typeof brand.logo !== 'string' || utf8Bytes(brand.logo) > LOGO_MAX_BYTES) return undefined;
  if (brand.wordmark !== undefined && brand.wordmark !== 'pixel' && brand.wordmark !== 'text') return undefined;

  const palette = isRecord(v.palette) ? v.palette : undefined;
  if (!palette || Object.keys(palette).length === 0) return undefined;
  for (const [k, val] of Object.entries(palette)) {
    if (!/^--[a-z0-9-]+$/i.test(k) || typeof val !== 'string' || !safeCssColor(val)) return undefined;
  }

  const fonts = isRecord(v.fonts) ? v.fonts : undefined;
  if (!fonts) return undefined;
  for (const k of ['body', 'brand']) {
    const val = fonts[k];
    if (typeof val !== 'string' || !safeFontStack(val)) return undefined;
  }

  let scenery: ThemePackScenery = {};
  if (v.scenery !== undefined) {
    if (!isRecord(v.scenery)) return undefined;
    const s = v.scenery as Record<string, unknown>;
    const known: [string, readonly string[]][] = [
      ['office', ['gather', 'classic']],
      ['rooms', ['gather', 'island', 'openspace']],
      ['garden', ['river', 'off']],
      ['fx', ['vibe', 'off']],
    ];
    for (const [k, allowed] of known) {
      const val = s[k];
      if (val === undefined) continue;
      if (typeof val !== 'string' || !allowed.includes(val)) return undefined;
    }
    for (const k of Object.keys(s)) {
      if (!known.some(([name]) => name === k)) return undefined;
    }
    scenery = s as ThemePackScenery;
  }

  return {
    id: v.id,
    name: v.name,
    brand: { text: brand.text, logo: brand.logo, ...(brand.wordmark !== undefined ? { wordmark: brand.wordmark } : {}) },
    palette: palette as ThemePackPalette,
    fonts: { body: fonts.body as string, brand: fonts.brand as string },
    scenery,
    nicknames: v.nicknames,
    seasonal: v.seasonal,
  };
}

const NUM = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg)?`;
const COLOR_FN = new RegExp(String.raw`^(?:rgba?|hsla?)\(\s*${NUM}(?:\s*[,\s/]\s*${NUM}){2,3}\s*\)$`, 'i');

/**
 * Cor de paleta (ALLOWLIST): #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba()/hsl()/hsla() só com números,
 * ou uma palavra-chave (letras: `transparent`, `white`, `rebeccapurple`...). Tudo o resto — `image-set(`,
 * `url(`, `var(`, gradientes, `;`/`}` — é recusado (o valor vai para uma <style> gerada).
 */
export function safeCssColor(v: string): boolean {
  const t = v.trim();
  if (t.length === 0 || t.length > 64) return false;
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || COLOR_FN.test(t) || /^[a-z]{3,20}$/i.test(t);
}

/** Stack de fontes (ALLOWLIST): nomes com letras/dígitos/espaço/hífen, entre aspas ou não, separados por vírgula. */
export function safeFontStack(v: string): boolean {
  if (v.length === 0 || v.length > 300) return false;
  return v.split(',').every((f) => /^\s*(?:"[A-Za-z0-9 -]+"|'[A-Za-z0-9 -]+'|[A-Za-z0-9 -]+)\s*$/.test(f));
}

/** Compatível com a API anterior: valor aceite como cor OU stack de fontes. */
export function safeCssValue(v: string): boolean {
  return safeCssColor(v) || safeFontStack(v);
}

/** Limite do logo em BYTES UTF-8 (não em unidades UTF-16). */
export const LOGO_MAX_BYTES = 8192;

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SYSTEM_BODY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const SYSTEM_DISPLAY = 'Avenir Next, Montserrat, "Segoe UI Semibold", system-ui, sans-serif';

/** Logotipo desenhado em código: prédio pixel (SVG inline, 16 células), tinta por pacote. */
function buildingSvg(accent: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect x="5" y="1" width="6" height="2" fill="${body}"/>` +
    `<rect x="1" y="3" width="14" height="10" fill="${body}"/>` +
    `<rect x="3" y="5" width="3" height="2" fill="${accent}"/>` +
    `<rect x="7" y="5" width="3" height="2" fill="${accent}" opacity="0.85"/>` +
    `<rect x="11" y="5" width="3" height="2" fill="${accent}" opacity="0.7"/>` +
    `<rect x="3" y="8" width="3" height="2" fill="${accent}" opacity="0.7"/>` +
    `<rect x="7" y="8" width="3" height="2" fill="${accent}"/>` +
    `<rect x="11" y="8" width="3" height="2" fill="${accent}" opacity="0.85"/>` +
    `<rect x="7" y="11" width="3" height="2" fill="${accent}"/>` +
    `<rect x="0" y="13" width="16" height="2" fill="${body}"/>` +
  `</svg>`;
}

/** Pacote NEUTRO, padrão do projeto. */
export const HABBLAUD_PACK: ThemePack = {
  id: 'habblaud',
  name: 'HabbLaud',
  brand: { text: 'HabbLaud', logo: buildingSvg('#7cc8ff', '#dfe6f2') },
  palette: {
    '--ui-accent': '#7cc8ff',
    '--ui-accent-soft': 'rgba(124, 200, 255, 0.13)',
    '--ui-bg': 'rgba(18, 21, 29, 0.85)',
    '--ui-bg-solid': 'rgba(20, 24, 33, 0.97)',
    '--ui-text': '#e8ecf5',
  },
  fonts: { body: SYSTEM_BODY, brand: SYSTEM_DISPLAY },
  scenery: {},
  nicknames: true,
  seasonal: true,
};

/** Pacote com a marca QODE Office (o que hoje vai de mãos postas: título, paleta e preset gather). */
export const QODE_PACK: ThemePack = {
  id: 'qode',
  name: 'QODE Office',
  brand: { text: 'QODE Office', logo: buildingSvg('#7cc8ff', '#2b3550'), wordmark: 'pixel' },
  palette: {
    '--ui-accent': '#7cc8ff',
    '--ui-accent-soft': 'rgba(124, 200, 255, 0.13)',
    '--ui-bg': 'rgba(18, 21, 29, 0.85)',
    '--ui-bg-solid': 'rgba(20, 24, 33, 0.97)',
    '--ui-text': '#e8ecf5',
  },
  fonts: { body: SYSTEM_BODY, brand: SYSTEM_MONO },
  scenery: { office: 'gather', rooms: 'openspace', garden: 'river', fx: 'off' },
  nicknames: true,
  seasonal: true,
};

// Map (não objeto literal): ids como `constructor`, `toString` ou `__proto__` não herdam do Object.prototype.
const BUILTIN: ReadonlyMap<string, ThemePack> = new Map([
  [HABBLAUD_PACK.id, HABBLAUD_PACK],
  [QODE_PACK.id, QODE_PACK],
]);

function param(search: string | undefined, key: string): string | null {
  if (search === undefined) return null;
  try {
    return new URLSearchParams(search).get(key);
  } catch {
    return null;
  }
}

/** JSON de pacote de uma config de build (string) já validado, ou undefined (ausente/inválido). */
export function parseThemePackJson(json: string | undefined): ThemePack | undefined {
  if (json === undefined || json.trim() === '') return undefined;
  try {
    return validateThemePack(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** Id resolvido (puro): `?theme=` > `VITE_HABBLAUD_THEME` > padrão 'habblaud'. Id desconhecido numa origem passa à seguinte (URL inválida → build → padrão). */
export function resolveThemePackId(search: string | undefined, envTheme: string | undefined, envJsonId?: string): string {
  const known = (id: string): boolean => isValidPackId(id) && (BUILTIN.has(id) || id === envJsonId);
  const url = param(search, 'theme') || undefined;
  if (url !== undefined && known(url)) return url;
  const env = envTheme || undefined;
  if (env !== undefined && known(env)) return env;
  return DEFAULT_PACK_ID;
}

/** Resolve o pacote (puro): id pela precedência; JSON da build vence o built-in de mesmo id. */
export function resolveThemePack(search: string | undefined, env: Record<string, string | undefined> | undefined): ThemePack {
  const envTheme = env?.VITE_HABBLAUD_THEME;
  const json = parseThemePackJson(env?.VITE_HABBLAUD_THEME_JSON);
  const id = resolveThemePackId(search, envTheme, json?.id);
  if (json && json.id === id) return json;
  // forma validada também nos built-ins: um pacote inválido nunca chega ao boot
  return validateThemePack(BUILTIN.get(id)) ?? HABBLAUD_PACK;
}

function packEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  } catch {
    return undefined;
  }
}

function packSearch(): string | undefined {
  // Sem `location` direto (sem DOM no tsconfig do servidor); globalThis cobre nó e navegador.
  try {
    const g = globalThis as { location?: { search?: string } };
    return typeof g.location?.search === 'string' ? g.location.search : undefined;
  } catch {
    return undefined;
  }
}

let active: ThemePack | undefined;

/** Pacote em vigor nesta página: resolvido UMA vez (boot), depois cacheado. Node/tests: o padrão. */
export function currentThemePack(): ThemePack {
  if (!active) active = resolveThemePack(packSearch(), packEnv());
  return active;
}

/** Fixa o pacote da sessão (usado pelo boot e pelos testes). RESET_THEME_PACK volta ao exigido automaticamente. */
export function setActiveThemePack(pack: ThemePack): void {
  active = pack;
}

/** Descarta o cache (testes): a próxima chamada a currentThemePack() resolve de novo. */
export function resetThemePack(): void {
  active = undefined;
}
