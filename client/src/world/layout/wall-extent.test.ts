/// <reference types="node" />
// Os limites desenhados que a decoração reserva (wall-extent) têm de cobrir o que o renderer realmente
// desenha: sprites procedurais (renderFurniture) e os PNGs distribuídos (lidos do disco, não do catálogo).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FURNITURE, type FurnitureKind } from '../../art/api';
import { renderFurniture, SEED_VARIATIONS } from '../../art/furniture/index';
import { SIGNAGE_ASSET, signageDrawSize, WALL_ART_ASSET_W, wallItemOffsets } from './wall-extent';

const ASSETS = fileURLToPath(new URL('../../../public/assets/', import.meta.url));

/** Largura × altura do cabeçalho IHDR de um PNG. */
function pngSize(rel: string): { w: number; h: number } {
  const b = readFileSync(ASSETS + rel);
  expect(b.subarray(1, 4).toString('latin1'), rel).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

interface ManifestFile { file: string; w: number; h: number }
const manifest = JSON.parse(readFileSync(ASSETS + 'manifest.json', 'utf8')) as {
  brand: { signage: ManifestFile };
  wallArt: (ManifestFile & { kind: string; tiles: number; framed?: ManifestFile })[];
};

const wallKinds = (Object.keys(FURNITURE) as FurnitureKind[]).filter((k) => FURNITURE[k].mount === 'wall');

describe('limites desenhados dos itens de parede', () => {
  it('a placa da recepção usa o tamanho real de brand/signage.png (maior que o footprint do sign)', () => {
    const png = pngSize(manifest.brand.signage.file);
    expect(png).toEqual({ w: SIGNAGE_ASSET.w, h: SIGNAGE_ASSET.h });
    expect({ w: manifest.brand.signage.w, h: manifest.brand.signage.h }).toEqual(png);
    const drawn = signageDrawSize(png.w, png.h).w;
    const [lo, hi] = wallItemOffsets('sign', undefined, 'core:recepcao');
    expect(hi - lo).toBeGreaterThanOrEqual(drawn);
    expect(drawn).toBeGreaterThan(FURNITURE.sign.footprint.w * 16);
  });

  it('artes prontas (quadros/pôsteres) cabem nos limites reservados, conferidas pelo PNG', () => {
    for (const a of manifest.wallArt) {
      const img = a.framed ?? a;
      const png = pngSize(img.file);
      expect({ w: img.w, h: img.h }, img.file).toEqual(png);
      if (!a.framed && a.kind !== 'poster') continue; // pintura sem moldura: recortada dentro do procedural
      const max = a.kind === 'poster' ? WALL_ART_ASSET_W.poster : a.tiles === 4 ? WALL_ART_ASSET_W.paintingWide : WALL_ART_ASSET_W.painting;
      expect(png.w, img.file).toBeLessThanOrEqual(max);
      const [lo, hi] = wallItemOffsets(a.kind as FurnitureKind, a.tiles === 4 ? 'wide' : undefined);
      expect(lo, img.file).toBeLessThanOrEqual(-png.w / 2);
      expect(hi, img.file).toBeGreaterThanOrEqual(png.w / 2 + 1); // + sombra de 1px
    }
  });

  it('todo sprite procedural de parede fica dentro dos limites reservados (todas as variantes, seeds e estados)', () => {
    for (const kind of wallKinds) {
      const def = FURNITURE[kind];
      for (const variant of def.variants ?? [undefined]) {
        for (let seed = 0; seed < (SEED_VARIATIONS[kind] ?? 1); seed++) {
          for (let state = 0; state < (def.states ?? 1); state++) {
            const s = renderFurniture(kind, variant, state, seed).base;
            const [lo, hi] = wallItemOffsets(kind, variant);
            expect(-s.ax, `${kind}/${variant}/${seed}/${state}`).toBeGreaterThanOrEqual(lo);
            expect(s.buf.w - s.ax, `${kind}/${variant}/${seed}/${state}`).toBeLessThanOrEqual(hi);
          }
        }
      }
    }
  });
});
