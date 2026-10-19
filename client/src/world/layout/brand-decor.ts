// Decoração da marca por cima de um layout pronto (pacote de tema com `decor`; o neutro não tem):
// pôster de show + néon na face da parede norte (só onde está livre) e mascotes no lugar de
// vasinhos/lixeiras (mesmo footprint 1x1, mesmo bloqueio). Puro; não cria nem remove spots.
import { FURNITURE, type FurnitureKind } from '../../art/api';
import type { ThemePackDecorSet } from '../../../../shared/theme-packs';
import { TILE } from '../constants';
import { occludesWall } from './room';
import type { AreaLayout, WallSegment } from './types';

interface DecorSpec {
  /** Itens de parede em ordem de prioridade. */
  wall: [FurnitureKind, string][];
  /** Versão de 1 tile, quando nenhum item grande coube na parede. */
  fallback: [FurnitureKind, string];
  mascots: string[];
}

export const DECOR_SPECS: Readonly<Record<ThemePackDecorSet, DecorSpec>> = {
  qode: { wall: [['gig_poster', 'qode_jr'], ['neon_sign', 'qode']], fallback: ['mini_poster', 'qode_jr'], mascots: ['blob', 'tangerine', 'blob'] },
  worktodo: { wall: [['neon_sign', 'worktodo'], ['gig_poster', 'worktodo']], fallback: ['mini_poster', 'worktodo'], mascots: ['check', 'sticky', 'tangerine'] },
};

/** No máximo quantos mascotes por área. */
export const MASCOTS_MAX = 3;

/** Móveis 1x1 baixos que um mascote pode substituir (prioridade: lixeira/caldeirão, vaso, abóbora simples). */
function swapRank(f: { kind: FurnitureKind; variant?: string }): number {
  if (f.kind === 'trash_bin' || f.kind === 'cauldron') return 0;
  if (f.kind === 'plant_small') return 1;
  if (f.kind === 'pumpkin' && f.variant !== 'stack') return 2;
  return -1;
}

/** Itens de parede só decorativos que a decoração da marca pode ocupar (nunca quadro kanban, janela, placa, porta nem o quadro da recepção, que a cena Visita usa). */
export const REPLACEABLE_WALL = new Set<FurnitureKind>(['poster', 'clock', 'dartboard', 'shelf_wall', 'bat_frame']);

/**
 * Melhor centro (px) na face da parede para um item de `wTiles`: o trecho não pode ter passagem, item
 * não substituível nem móvel alto na frente; entre os válidos, o que tira menos itens decorativos.
 * Devolve o centro e os ids a remover, ou undefined.
 */
function bestSpot(area: AreaLayout, face: WallSegment & { kind: 'face' }, wTiles: number, fromRight: boolean): { cx: number; remove: string[] } | undefined {
  const half = (wTiles * TILE) / 2;
  const wallRow = Math.round(face.y / TILE) + 2;
  const baseY = face.y + 2 * TILE;
  const lo = face.x + half;
  const hi = face.x + face.w - half;
  const step = TILE / 4;
  const n = Math.floor((hi - lo) / step);
  let best: { cx: number; remove: string[] } | undefined;
  for (let i = 0; i <= n; i++) {
    const cx = Math.round(fromRight ? hi - i * step : lo + i * step);
    const x0 = cx - half;
    const x1 = cx + half;
    if (face.doorways?.some((d) => x0 < d.x + d.w + 2 && x1 > d.x - 2)) continue;
    let ok = true;
    const remove: string[] = [];
    for (const w of area.wallItems) {
      if (w.on !== 'face' || w.baseY !== baseY || w.kind === 'cobweb') continue;
      const h = (FURNITURE[w.kind].footprint.w * TILE) / 2;
      if (!(w.cx - h < x1 && w.cx + h > x0)) continue;
      if (!REPLACEABLE_WALL.has(w.kind)) {
        ok = false;
        break;
      }
      remove.push(w.id);
    }
    if (!ok) continue;
    for (const f of area.furniture) {
      if (!occludesWall(f) || f.ty !== wallRow) continue;
      const fx0 = f.tx * TILE + (f.dx ?? 0);
      const fx1 = fx0 + FURNITURE[f.kind].footprint.w * TILE;
      if (fx0 < x1 && fx1 > x0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (!best || remove.length < best.remove.length) best = { cx, remove };
    if (best.remove.length === 0) break;
  }
  return best;
}

/** Aplica o conjunto `set` à área (muta). Devolve quantos itens entraram (para testes). */
export function applyBrandDecor(area: AreaLayout, set: ThemePackDecorSet): { wall: number; mascots: number } {
  const spec = DECOR_SPECS[set];
  const faces = area.walls.filter((w): w is WallSegment & { kind: 'face' } => w.kind === 'face' && w.style.pattern !== 'glass');
  let wall = 0;
  const items = [...spec.wall];
  const place = ([kind, variant]: [FurnitureKind, string], i: number) => {
    const wTiles = FURNITURE[kind].footprint.w;
    for (const face of faces) {
      const spot = bestSpot(area, face, wTiles, i % 2 === 1);
      if (!spot) continue;
      const cx = spot.cx;
      area.wallItems = area.wallItems.filter((w) => !spot.remove.includes(w.id));
      area.wallItems.push({ id: `${area.id}#qd${wall}:${kind}`, kind, variant, cx, baseY: face.y + 2 * TILE, on: 'face', order: 0.96 });
      wall++;
      return;
    }
  };
  items.forEach(place);
  if (wall === 0) place(spec.fallback, 0);
  const pool = area.furniture
    .map((f, i) => ({ f, i, r: swapRank(f) }))
    .filter((c) => c.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i);
  let mascots = 0;
  for (const c of pool.slice(0, MASCOTS_MAX)) {
    c.f.kind = 'mascot';
    c.f.variant = spec.mascots[mascots % spec.mascots.length];
    mascots++;
  }
  return { wall, mascots };
}
