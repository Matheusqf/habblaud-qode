// Limites horizontais EFETIVAMENTE desenhados dos itens de parede (px de mundo), não só o footprint do
// catálogo: sombras/molduras procedurais que passam do trecho, artes prontas (assets) em tamanho nativo e
// a placa da recepção (brand/signage.png), que o renderer desenha maior que os 3 tiles do `sign`.
// Puro e sem depender do módulo de arte: os números abaixo são conferidos contra os sprites reais e os
// PNGs distribuídos em wall-extent.test.ts (o teste falha se um asset ou sprite mudar de tamanho).
import { FURNITURE, type FurnitureKind } from '../../art/api';
import { TILE } from '../constants';

/** Área cuja placa (`sign`) o renderer troca por brand/signage.png quando o asset existe. */
export const SIGNAGE_AREA_ID = 'core:recepcao';

/** Tamanho nativo de client/public/assets/brand/signage.png (conferido contra o PNG e o manifesto). */
export const SIGNAGE_ASSET = { w: 64, h: 16 } as const;

/** Caixa máxima da placa da recepção; escala inteira sempre que couber (pixels nítidos). */
export const SIGNAGE_MAX = { w: 5 * TILE, h: 24 } as const;

/** Tamanho com que o renderer desenha a placa da recepção (usado por renderer.drawSign e pela decoração). */
export function signageDrawSize(aw: number, ah: number): { w: number; h: number; k: number } {
  const fit = Math.min(SIGNAGE_MAX.w / aw, SIGNAGE_MAX.h / ah);
  const k = fit >= 1 ? Math.floor(fit) : fit;
  return { w: Math.round(aw * k), h: Math.round(ah * k), k };
}

/**
 * Artes prontas de parede (manifest.json -> wallArt), largura nativa máxima por lugar, com moldura;
 * desenhadas centradas em tamanho nativo + 1px de sombra à direita (scene.drawWallArtAsset).
 */
export const WALL_ART_ASSET_W = { painting: 32, paintingWide: 64, poster: 12 } as const;
const ART_SHADOW = 1;

/**
 * Sprites procedurais que passam do footprint (offset do 1º e após o último px desenhado, relativo ao
 * centro do trecho). Os demais ficam dentro do footprint. Conferido contra renderFurniture no teste.
 */
export const SPRITE_SPAN: Readonly<Partial<Record<FurnitureKind, readonly [number, number]>>> = {
  tv: [-16, 17],
  elevator: [-17, 17],
  door_frame: [-19, 19],
  pumpkin_garland: [-24, 25],
  neon_sign: [-16, 17],
};

/** Offsets [esquerda, direita) do que é desenhado, relativos ao `cx`, para um item de parede de face. */
export function wallItemOffsets(kind: FurnitureKind, variant: string | undefined, areaId?: string): [number, number] {
  const h = (FURNITURE[kind].footprint.w * TILE) / 2;
  let lo = -h;
  let hi = h;
  const widen = (a: number, b: number) => {
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  };
  const s = SPRITE_SPAN[kind];
  if (s) widen(s[0], s[1]);
  if (kind === 'sign' && areaId === SIGNAGE_AREA_ID) {
    const d = signageDrawSize(SIGNAGE_ASSET.w, SIGNAGE_ASSET.h).w;
    widen(-d / 2, d / 2);
  }
  if (kind === 'painting') {
    const aw = variant === 'wide' ? WALL_ART_ASSET_W.paintingWide : WALL_ART_ASSET_W.painting;
    widen(-aw / 2, aw / 2 + ART_SHADOW);
  }
  if (kind === 'poster') widen(-WALL_ART_ASSET_W.poster / 2, WALL_ART_ASSET_W.poster / 2 + ART_SHADOW);
  return [lo, hi];
}

/** Limites [x0, x1) em px de mundo (com folga de arredondamento do desenho em px inteiros). */
export function wallItemSpan(kind: FurnitureKind, variant: string | undefined, cx: number, areaId?: string): [number, number] {
  const [lo, hi] = wallItemOffsets(kind, variant, areaId);
  return [Math.floor(cx + lo), Math.ceil(cx + hi)];
}
