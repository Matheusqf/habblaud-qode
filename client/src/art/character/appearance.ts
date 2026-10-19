// Geração determinística de aparência a partir de uma semente (puro, sem DOM). O sorteio e as paletas moraram aqui e
// foram para shared/world/appearance-flat.ts (o mesmo sorteio serve o escritório e o Habblaud World); este módulo
// re-exporta e guarda o que é só do editor do personagem, mais o kit visual do OpenCode (QODE).
import { ACCESSORIES, BOTTOM_STYLES, FACIAL_HAIR, HAIR_STYLES, PART_KEYS, TOP_STYLES, type AppearanceParts, type PartKey } from '../../../../shared/appearance';
import {
  appearanceFromSeed as appearanceFromSeedShared,
  ACC_COLORS,
  BOTTOMS,
  EYES,
  HAIR_FUN,
  HAIR_NATURAL,
  JACKET_COLORS,
  LIGHT_ACCENTS,
  SHIRT_COLORS,
  SHOES,
  SKINS,
  TIE_COLORS,
  TOP_COLORS,
  type SeedAppearance,
} from '../../../../shared/world/appearance-flat';
import type { Provider } from '../../../../shared/types';
import type { Appearance, TopStyle } from '../api';
import { tr } from '../../../../shared/i18n';

export { SKINS } from '../../../../shared/world/appearance-flat';
export type { BottomStyle, FacialHair } from '../../../../shared/world/appearance-flat';

/**
 * Kit visual do OpenCode (agentes com provider 'opencode'), identidade ORIGINAL desenhada em código:
 * paleta grafite/verde-terminal por cima do sorteio (rosto, cabelo e silhueta seguem a semente, então
 * agentes diferentes continuam diferentes) + broche de terminal no peito (render.ts). Peças escolhidas
 * no editor continuam valendo por cima do kit.
 */
export const OPENCODE_KIT = {
  top: '#20303a',
  topAccent: '#4fd8a4',
  bottom: '#2a3644',
  shoes: '#1b2531',
  accessoryColor: '#4fd8a4',
} as const;

export function appearanceFromSeed(
  seed: number,
  opts: { look?: 'f' | 'm'; sub?: boolean; parts?: AppearanceParts; provider?: Provider } = {},
): Appearance {
  const { provider, parts, ...rest } = opts;
  const a = appearanceFromSeedShared(seed, rest) as Appearance;
  // Kit do OpenCode: por baixo das peças escolhidas no editor (o broche vem pelo `kit` no render).
  if (provider === 'opencode') {
    a.top = OPENCODE_KIT.top;
    a.topAccent = OPENCODE_KIT.topAccent;
    a.bottom = OPENCODE_KIT.bottom;
    a.shoes = OPENCODE_KIT.shoes;
    a.accessoryColor = OPENCODE_KIT.accessoryColor;
    a.kit = 'opencode';
  }
  if (!parts) return a;
  const chosen = Object.fromEntries(PART_KEYS.filter((k) => parts[k] !== undefined).map((k) => [k, parts[k]])) as AppearanceParts;
  return { ...a, ...chosen };
}

// O formato de shared/world/appearance-flat.ts e o da arte (art/api.ts) não podem se separar.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameAppearance: Same<SeedAppearance, Omit<Appearance, 'kit'>> = true;
void _sameAppearance;

/** Chave estável de uma aparência (para cache de sprites). */
export function appearanceKey(a: Appearance): string {
  return [
    a.skin, a.hair, a.hairStyle, a.eyes, a.top, a.topAccent, a.topStyle, a.bottom, a.shoes, a.accessory,
    a.accessoryColor, a.lanyard ?? '-', a.look, a.facialHair ?? '-', a.bottomStyle ?? '-', a.kit ?? '-',
  ].join('|');
}

// ------------------------------------------------------------------ editor do personagem

const uniq = (list: readonly string[]): readonly string[] => [...new Set(list)];
const colorsOf = (pairs: readonly (readonly [string, number])[]): string[] => pairs.map(([c]) => c);
const ACCENTS = uniq([...LIGHT_ACCENTS, ...TOP_COLORS]);

/** Cores da parte de cima e do detalhe para cada estilo: as mesmas que o sorteio usa. */
function topPalettes(style: TopStyle): { top: readonly string[]; topAccent: readonly string[] } {
  switch (style) {
    case 'shirt_tie':
      return { top: SHIRT_COLORS, topAccent: TIE_COLORS };
    case 'jacket':
      return { top: JACKET_COLORS, topAccent: ACCENTS };
    default:
      return { top: TOP_COLORS, topAccent: ACCENTS };
  }
}

export type EditorOptions = Readonly<Record<PartKey, readonly string[]>>;

/** Opções de cada peça no editor do personagem, conforme a aparência atual (as cores da roupa dependem do estilo). */
export function editorOptions(a: Appearance): EditorOptions {
  const top = topPalettes(a.topStyle);
  return {
    skin: SKINS,
    hair: [...colorsOf(HAIR_NATURAL), ...HAIR_FUN],
    hairStyle: HAIR_STYLES,
    eyes: uniq(EYES),
    top: top.top,
    topAccent: top.topAccent,
    topStyle: TOP_STYLES,
    bottom: colorsOf(BOTTOMS),
    bottomStyle: BOTTOM_STYLES,
    shoes: colorsOf(SHOES),
    accessory: ACCESSORIES,
    accessoryColor: ACC_COLORS[a.accessory],
    facialHair: FACIAL_HAIR,
  };
}

const TALL_HAIR: readonly string[] = ['afro', 'bun', 'mohawk', 'pigtails'];
const SHORT_HAIR: readonly string[] = ['bald', 'buzz'];

/** Combinação que o sorteio evita (o editor desabilita a opção): devolve o motivo, ou undefined se pode. */
export function editorConflict(a: Appearance, key: PartKey, value: string): string | undefined {
  if (key === 'accessory') {
    if ((value === 'cap' || value === 'beanie') && TALL_HAIR.includes(a.hairStyle)) return tr('Não combina com este cabelo');
    if (value === 'bow' && SHORT_HAIR.includes(a.hairStyle)) return tr('Não combina com este cabelo');
  }
  if (key === 'hairStyle') {
    if ((a.accessory === 'cap' || a.accessory === 'beanie') && TALL_HAIR.includes(value)) return tr('Não combina com o boné ou o gorro');
    if (a.accessory === 'bow' && SHORT_HAIR.includes(value)) return tr('Não combina com o laço');
  }
  return undefined;
}

/**
 * Depois de trocar um estilo: cores que não existem na paleta nova caem na primeira dela. Com `changed`, só
 * refaz o ajuste quando a peça mudada altera uma paleta (estilo da roupa/acessório): trocar cabelo/pele preserva
 * cores fora da paleta do editor (ex.: o kit do OpenCode).
 */
export function fitToOptions(a: Appearance, changed?: PartKey): Appearance {
  if (changed !== undefined && changed !== 'topStyle' && changed !== 'accessory') return a;
  const o = editorOptions(a);
  const fit = (v: string, list: readonly string[]): string => (list.includes(v) ? v : list[0]);
  // topStyle só mexe nas cores da roupa; accessory só na cor do acessório (a peça não editada fica como está).
  const top = changed !== 'accessory';
  const acc = changed !== 'topStyle';
  return {
    ...a,
    top: top ? fit(a.top, o.top) : a.top,
    topAccent: top ? fit(a.topAccent, o.topAccent) : a.topAccent,
    accessoryColor: acc ? fit(a.accessoryColor, o.accessoryColor) : a.accessoryColor,
  };
}
