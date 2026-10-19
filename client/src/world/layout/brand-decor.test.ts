// Decoração da marca por cima dos layouts: só decoração (mesmos spots/caminhos), paredes sem sobreposição,
// itens funcionais intocados e neutro por padrão.
import { describe, expect, it } from 'vitest';
import { FURNITURE, type RoomTheme } from '../../art/api';
import { TILE } from '../constants';
import { applyBrandDecor, MASCOTS_MAX, REPLACEABLE_WALL } from './brand-decor';
import { layoutCafe, layoutLounge, layoutReception } from './core';
import { layoutProjectRoom, type RoomStyle } from './room';
import type { AreaLayout } from './types';
import { resolveDecor } from '../decor';
import { QODE_PACK, HABBLAUD_PACK } from '../../../../shared/theme-packs';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};
const BRAND = new Set(['gig_poster', 'neon_sign', 'mini_poster']);

function overlaps(area: AreaLayout): string[] {
  const bad: string[] = [];
  const items = area.wallItems.filter((w) => w.on === 'face' && w.kind !== 'cobweb');
  for (const a of items) {
    if (!BRAND.has(a.kind)) continue;
    const ha = (FURNITURE[a.kind].footprint.w * TILE) / 2;
    for (const b of items) {
      if (a === b || a.baseY !== b.baseY) continue;
      const hb = (FURNITURE[b.kind].footprint.w * TILE) / 2;
      if (a.cx - ha < b.cx + hb && a.cx + ha > b.cx - hb) bad.push(`${a.kind}×${b.kind}`);
    }
  }
  return bad;
}

const strip = (a: AreaLayout) => a.spots.map((s) => [s.id, s.kind, s.tx, s.ty, s.x, s.y, s.dir]);
const footprint = (a: AreaLayout) => a.furniture.map((f) => [f.id, f.tx, f.ty, FURNITURE[f.kind].footprint.w, FURNITURE[f.kind].footprint.h, FURNITURE[f.kind].blocks]);

describe('decoração da marca', () => {
  it('sem decor, o layout da sala não muda (neutro por padrão)', () => {
    const a = layoutProjectRoom({ id: '/p', slot: 1, seed: 4242 }, theme);
    const b = layoutProjectRoom({ id: '/p', slot: 1, seed: 4242, decor: undefined }, theme);
    expect(b).toEqual(a);
  });

  for (const style of ['gather', 'island', 'openspace'] as RoomStyle[]) {
    for (const season of [undefined, 'halloween'] as const) {
      it(`só decoração em salas ${style}${season ? ' (halloween)' : ''}: mesmos spots e footprints, paredes sem sobreposição`, () => {
        for (let slot = 0; slot < 4; slot++) {
          for (const seed of [11, 977, 31337, 2026]) {
            for (const set of ['qode', 'worktodo'] as const) {
              const plain = layoutProjectRoom({ id: '/p', slot, seed, style, season }, theme);
              const deco = layoutProjectRoom({ id: '/p', slot, seed, style, season, decor: set }, theme);
              expect(strip(deco)).toEqual(strip(plain));
              expect(footprint(deco)).toEqual(footprint(plain));
              expect(overlaps(deco)).toEqual([]);
              const brand = deco.wallItems.filter((w) => BRAND.has(w.kind));
              expect(brand.length).toBeGreaterThanOrEqual(1);
              const mascots = deco.furniture.filter((f) => f.kind === 'mascot');
              expect(mascots.length).toBeGreaterThanOrEqual(2);
              expect(mascots.length).toBeLessThanOrEqual(MASCOTS_MAX);
              // só itens decorativos saem da parede; quadro, janela, placa, porta e interruptor ficam
              const kept = new Set(deco.wallItems.map((w) => w.id));
              for (const w of plain.wallItems) if (!kept.has(w.id)) expect(REPLACEABLE_WALL.has(w.kind), w.kind).toBe(true);
            }
          }
        }
      });
    }
  }

  it('o núcleo recebe a decoração sem perder o quadro da recepção (cena Visita)', () => {
    for (const make of [layoutReception, layoutCafe, layoutLounge]) {
      const plain = make();
      const deco = make();
      applyBrandDecor(deco, 'qode');
      expect(strip(deco)).toEqual(strip(plain));
      expect(overlaps(deco)).toEqual([]);
    }
    const rec = layoutReception();
    const r = applyBrandDecor(rec, 'qode');
    expect(r.wall).toBeGreaterThanOrEqual(1);
    expect(r.mascots).toBeGreaterThanOrEqual(2);
    expect(rec.wallItems.some((w) => w.kind === 'painting')).toBe(true);
  });

  it('é determinística', () => {
    const a = layoutProjectRoom({ id: '/d', slot: 2, seed: 99, decor: 'worktodo' }, theme);
    const b = layoutProjectRoom({ id: '/d', slot: 2, seed: 99, decor: 'worktodo' }, theme);
    expect(b).toEqual(a);
  });

  it('?decor=off desliga; o neutro não tem decor', () => {
    expect(resolveDecor('', QODE_PACK)).toBe(QODE_PACK.decor);
    expect(resolveDecor('?decor=off', QODE_PACK)).toBeUndefined();
    expect(resolveDecor('', HABBLAUD_PACK)).toBeUndefined();
  });
});
