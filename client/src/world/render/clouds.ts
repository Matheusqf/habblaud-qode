// Nuvens de parallax no exterior do presete gather (?office=gather): faixas fixas no bosque ao norte
// e no gramado ao sul (fora da grade caminhável — nunca sobre o prédio), derivando devagar. As formas
// são pré-renderizadas UMA vez em canvases offscreen (3 variantes × dia/noite) e por quadro só há
// blit (drawImage) com globalAlpha: zero alocação por quadro. O tom vem do relógio de luz existente
// (daylight.ts): de dia a nuvem branca aparece sozinha, à noite faz crossfade para a nuvem escura e
// quase some (e o mapa de multiplicação da iluminação ainda a escurece junto com o resto).
// Com prefers-reduced-motion (github-fx.reducedMotion) nada é desenhado; fora do presete gather a
// camada nem é criada. As partes puras (posição, tom, liga/desliga) são testáveis em Node.
import { TILE } from '../../art/api';
import { BUILDING_H } from '../constants';
import type { ExteriorLayout } from '../layout/exterior';
import type { OfficePreset } from '../season';
import { reducedMotion } from './github-fx';
import type { View } from './lighting';

/** Nuvens em cena (4 ao norte, 4 ao sul). */
export const CLOUD_COUNT = 8;
/** Período base de uma travessia da faixa (ms) — bem lento. */
export const CLOUD_DRIFT_MS = 120_000;
/** Fator de paralaxe: a nuvem acompanha 35% do movimento da câmera (mais longe que o chão). */
export const CLOUD_PARALLAX = 0.35;
/** Opacidade da nuvem clara de dia pleno e da nuvem escura de noite fechada. */
const DAY_ALPHA = 0.5;
const NIGHT_ALPHA = 0.45;

const frac = (n: number): number => n - Math.floor(n);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Nuvens ligadas? Só no presete gather e sem prefers-reduced-motion. Puro. */
export function cloudsActive(preset: OfficePreset | string | undefined, reduced: boolean): boolean {
  return preset === 'gather' && !reduced;
}

/**
 * Posição horizontal (px, em [0, span)) da nuvem `i` no instante `t` (ms): cada nuvem tem fase e
 * velocidade próprias (um terço mais devagar/rápido), derivando para o leste. Puro e determinístico.
 */
export function cloudX(i: number, t: number, span: number): number {
  const period = CLOUD_DRIFT_MS + (i % 3) * 40_000;
  return frac(t / period + i * 0.61803398875) * span;
}

/** Opacidade da nuvem clara (dia) conforme o nível de noite (0..1) do ambiente. Puro. */
export function cloudDayAlpha(night: number): number {
  return DAY_ALPHA * (1 - clamp01(night));
}

/** Opacidade da nuvem escura (noite): entra conforme escurece, sempre mais fraca que a de dia. Puro. */
export function cloudNightAlpha(night: number): number {
  return NIGHT_ALPHA * clamp01(night);
}

// ------------------------------------------------------------------ formas pré-renderizadas

/** Puffs (cx, cy, r) em px lógicos; o blit amplia 2x (pixels chunky como o resto da arte). */
const VARIANTS: readonly (readonly (readonly [number, number, number])[])[] = [
  [[4, 4, 3], [8, 3, 4], [12, 4, 3], [6, 6, 3], [10, 6, 3]],
  [[3, 5, 3], [7, 3, 4], [11, 2, 5], [15, 5, 4], [8, 6, 4], [12, 6, 3]],
  [[3, 4, 3], [7, 2, 4], [11, 2, 4], [15, 4, 3], [9, 5, 4], [13, 5, 3], [5, 6, 2]],
];
/** [corpo, topo iluminado, barriga sombreada] — claro para o dia, ardósia para a noite. */
const DAY_TONES: readonly [string, string, string] = ['#e6eef8', '#f6f9fe', '#c8d5e6'];
const NIGHT_TONES: readonly [string, string, string] = ['#2a3048', '#39415e', '#1e2338'];

interface CloudSprite {
  day: HTMLCanvasElement;
  night: HTMLCanvasElement;
  /** Tamanho no mundo (px; o dobro do canvas lógico). */
  w: number;
  h: number;
}

let spriteCache: CloudSprite[] | null = null;

/** Caixa (px lógicos) que contém todos os puffs, com 1px de margem (+1 em baixo para a barriga). Pura. */
export function puffBounds(puffs: readonly (readonly [number, number, number])[]): { dx: number; dy: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, r] of puffs) {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r + 1);
  }
  const dx = Math.ceil(1 - x0);
  const dy = Math.ceil(1 - y0);
  return { dx, dy, w: Math.ceil(x1 + dx + 1), h: Math.ceil(y1 + dy + 1) };
}

/** Variantes expostas para teste (somente leitura). */
export const CLOUD_VARIANTS = VARIANTS;

function paintPuffs(ctx: CanvasRenderingContext2D, puffs: readonly (readonly [number, number, number])[], tones: readonly [string, string, string]): void {
  const [body, top, bottom] = tones;
  ctx.fillStyle = body;
  for (const [x, y, r] of puffs) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = top;
  for (const [x, y, r] of puffs) {
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = bottom;
  for (const [x, y, r] of puffs) {
    ctx.beginPath();
    ctx.arc(x, y + 1, Math.max(1, r - 1), 0, Math.PI);
    ctx.fill();
  }
}

/** As 3 variantes (dia + noite), criadas uma única vez. */
function cloudSprites(): CloudSprite[] {
  if (spriteCache) return spriteCache;
  spriteCache = VARIANTS.map((puffs) => {
    const b = puffBounds(puffs);
    const w = b.w;
    const h = b.h;
    const make = (tones: readonly [string, string, string]): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      // desloca para que o puff mais alto/à esquerda (cy−r / cx−r negativos) não seja cortado
      g.translate(b.dx, b.dy);
      paintPuffs(g, puffs, tones);
      return c;
    };
    return { day: make(DAY_TONES), night: make(NIGHT_TONES), w: w * 2, h: h * 2 };
  });
  return spriteCache;
}

// ------------------------------------------------------------------ camada

/** Linhas (px de mundo, topo do sprite) fora da grade caminhável: bosque ao norte, gramado ao sul. */
function cloudRows(b: { x: number; y: number; w: number; h: number }): number[] {
  const top = b.y * TILE;
  const south = (BUILDING_H + 12) * TILE;
  return [top + 36, top + 92, top + 148, south, south + 56, south + 128];
}

export class CloudLayer {
  private readonly left: number;
  private readonly span: number;
  private readonly rows: number[];

  constructor(ext: ExteriorLayout) {
    const b = ext.bounds;
    this.left = b.x * TILE;
    this.span = b.w * TILE + 48;
    this.rows = cloudRows(b);
  }

  /**
   * Blita as nuvens visíveis (px de mundo; a transform da câmera já está no ctx). `night` é o nível
   * de noite do ambiente (daylight) e `view` o retângulo visível, para a paralaxe e o culling.
   */
  draw(ctx: CanvasRenderingContext2D, t: number, night: number, view: View): void {
    if (reducedMotion()) return;
    const aDay = cloudDayAlpha(night);
    const aNight = cloudNightAlpha(night);
    if (aDay <= 0.01 && aNight <= 0.01) return;
    const sprites = cloudSprites();
    const span = this.span;
    // paralaxe: a posição soma (1 - fator) do deslocamento da câmera e enrola na faixa
    const drift = view.x0 * (1 - CLOUD_PARALLAX);
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const s = sprites[i % sprites.length];
      const x = this.left - s.w + (((cloudX(i, t, span) + drift) % span) + span) % span;
      const y = this.rows[i % this.rows.length] + ((i * 37) % 13) - 6;
      if (x > view.x1 || x + s.w < view.x0 || y > view.y1 || y + s.h < view.y0) continue;
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (aDay > 0.01) {
        ctx.globalAlpha = aDay;
        ctx.drawImage(s.day, xi, yi, s.w, s.h);
      }
      if (aNight > 0.01) {
        ctx.globalAlpha = aNight;
        ctx.drawImage(s.night, xi, yi, s.w, s.h);
      }
    }
    ctx.globalAlpha = 1;
  }
}
