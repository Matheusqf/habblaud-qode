/// <reference types="node" />
// Decoração da marca por cima dos layouts: só decoração (mesmos spots/caminhos), paredes sem sobreposição,
// itens funcionais intocados e neutro por padrão.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FURNITURE, type RoomTheme } from '../../art/api';
import { renderFurniture } from '../../art/furniture/index';
import { TILE } from '../constants';
import { applyBrandDecor, MASCOTS_MAX, REPLACEABLE_WALL } from './brand-decor';
import { layoutCafe, layoutLounge, layoutReception } from './core';
import { layoutProjectRoom, type RoomStyle } from './room';
import type { AreaLayout, WallItemPlacement } from './types';
import { signageDrawSize } from './wall-extent';
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

// Limites desenhados calculados aqui, independentes do catálogo e de wall-extent: sprite procedural real
// (renderFurniture, com a mesma origem arredondada do renderer), arte pronta pelo PNG e a placa da recepção
// pelo tamanho real de brand/signage.png (renderer.drawSign).
const ASSETS = fileURLToPath(new URL('../../../public/assets/', import.meta.url));
const pngW = (rel: string) => readFileSync(ASSETS + rel).readUInt32BE(16);
const pngH = (rel: string) => readFileSync(ASSETS + rel).readUInt32BE(20);
const manifest = JSON.parse(readFileSync(ASSETS + 'manifest.json', 'utf8')) as {
  brand: { signage: { file: string } };
  wallArt: { kind: string; tiles: number; file: string; framed?: { file: string } }[];
};
const SIGNAGE_W = signageDrawSize(pngW(manifest.brand.signage.file), pngH(manifest.brand.signage.file)).w;
const artW = (kind: string, tiles: number) =>
  Math.max(0, ...manifest.wallArt.filter((a) => a.kind === kind && a.tiles === tiles && (a.framed || kind === 'poster')).map((a) => pngW((a.framed ?? a).file)));

function rendered(w: WallItemPlacement, areaId: string): [number, number] {
  const spans: [number, number][] = [];
  for (let seed = 0; seed < 6; seed++) {
    const s = renderFurniture(w.kind, w.variant === 'wide' ? undefined : w.variant, 0, seed).base;
    const x0 = Math.round(w.cx - s.ax);
    spans.push([x0, x0 + s.buf.w]);
  }
  if (w.kind === 'sign' && areaId === 'core:recepcao') {
    const x0 = Math.round(w.cx - SIGNAGE_W / 2);
    spans.push([x0, x0 + SIGNAGE_W]);
  }
  if (w.kind === 'painting' || w.kind === 'poster') {
    const aw = artW(w.kind, w.kind === 'poster' ? 1 : w.variant === 'wide' ? 4 : 2);
    if (aw > 0) {
      const x0 = Math.round(w.cx - aw / 2);
      spans.push([x0, x0 + aw + 1]); // + sombra de 1px
    }
  }
  return [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))];
}

/** Pares (item da marca × outro item da mesma face) cujos limites DESENHADOS se sobrepõem. */
function overlaps(area: AreaLayout): string[] {
  const bad: string[] = [];
  const items = area.wallItems.filter((w) => w.on === 'face' && w.kind !== 'cobweb');
  for (const a of items) {
    if (!BRAND.has(a.kind)) continue;
    const [a0, a1] = rendered(a, area.id);
    for (const b of items) {
      if (a === b || a.baseY !== b.baseY) continue;
      const [b0, b1] = rendered(b, area.id);
      if (a0 < b1 && a1 > b0) bad.push(`${a.kind}@${a.cx}[${a0},${a1})×${b.kind}@${b.cx}[${b0},${b1})`);
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
    for (const set of ['qode', 'worktodo'] as const) {
      for (const make of [layoutReception, layoutCafe, layoutLounge]) {
        const plain = make();
        const deco = make();
        applyBrandDecor(deco, set);
        expect(strip(deco)).toEqual(strip(plain));
        expect(overlaps(deco), `${set} ${deco.id}`).toEqual([]);
      }
    }
    const rec = layoutReception();
    const r = applyBrandDecor(rec, 'qode');
    expect(r.wall).toBeGreaterThanOrEqual(1);
    expect(r.mascots).toBeGreaterThanOrEqual(2);
    expect(rec.wallItems.some((w) => w.kind === 'painting')).toBe(true);
  });

  it('regressão: nada da decoração cobre/é coberto pela placa da recepção no tamanho real do asset', () => {
    const base = layoutReception();
    const sign = base.wallItems.find((w) => w.kind === 'sign')!;
    const [s0, s1] = rendered(sign, base.id);
    // a placa desenhada (PNG nativo) é mais larga que o footprint do catálogo: era isso que escapava
    expect(s1 - s0).toBe(SIGNAGE_W);
    expect(SIGNAGE_W).toBeGreaterThan(FURNITURE.sign.footprint.w * TILE);
    for (const set of ['qode', 'worktodo'] as const) {
      const rec = layoutReception();
      const r = applyBrandDecor(rec, set);
      expect(r.wall, set).toBeGreaterThanOrEqual(1);
      expect(rec.wallItems.some((w) => w.kind === 'sign'), set).toBe(true);
      for (const w of rec.wallItems.filter((x) => BRAND.has(x.kind))) {
        const [a0, a1] = rendered(w, rec.id);
        expect(a0 < s1 && a1 > s0, `${set}: ${w.kind}@${w.cx} [${a0},${a1}) × placa [${s0},${s1})`).toBe(false);
      }
    }
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
