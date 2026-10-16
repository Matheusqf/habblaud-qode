// G1 — esquema de zonas de uma área (ilha de projeto, reunião, sofás, entrada...).
// Puro (sem DOM). Zonas são só metadados de planta: não criam paredes nem bloqueios; servem para
// o render rotular o chão e para testes/presets validarem a planta (dentro da área, sem
// sobreposição, alcançáveis a partir da porta). Formato próprio, serializável em JSON.
import type { WalkGrid } from '../path/grid';
import type { AreaLayout, TileRect } from './types';

export type ZoneKind = 'island' | 'meeting' | 'lounge' | 'entry' | 'corridor' | 'garden';

export interface ZoneDef {
  id: string;
  kind: ZoneKind;
  /** Retângulo em tiles absolutos. */
  rect: TileRect;
  /** Rótulo pintado no chão: 'project' = nome da sala/projeto (resolvido no render). */
  label?: 'project' | string;
}

/** Faixa (px de mundo) onde o rótulo da zona é pintado no chão. */
export interface FloorLabel {
  zoneId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Texto fixo; sem ele, o render usa o nome do projeto. */
  text?: string;
}

const inside = (a: TileRect, b: TileRect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const overlap = (a: TileRect, b: TileRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Problemas da planta de zonas (lista vazia = válida). Com `grid`, exige também que cada zona
 * tenha pelo menos um tile caminhável alcançável a partir da porta.
 */
export function validateZones(area: AreaLayout, grid?: WalkGrid): string[] {
  const zones = area.zones ?? [];
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const z of zones) {
    if (ids.has(z.id)) errs.push(`${z.id}: id repetido`);
    ids.add(z.id);
    if (z.rect.w <= 0 || z.rect.h <= 0) errs.push(`${z.id}: retângulo vazio`);
    if (!inside(z.rect, area.rect)) errs.push(`${z.id}: fora da área`);
  }
  for (let i = 0; i < zones.length; i++)
    for (let j = i + 1; j < zones.length; j++) if (overlap(zones[i].rect, zones[j].rect)) errs.push(`${zones[i].id} sobrepõe ${zones[j].id}`);
  for (const l of area.floorLabels ?? []) if (!ids.has(l.zoneId)) errs.push(`rótulo de zona inexistente ${l.zoneId}`);
  if (grid && area.door) {
    const reach = grid.reachableFrom(area.door.x, area.door.y);
    for (const z of zones) {
      let ok = false;
      for (let y = z.rect.y; y < z.rect.y + z.rect.h && !ok; y++)
        for (let x = z.rect.x; x < z.rect.x + z.rect.w && !ok; x++) if (reach[y * grid.w + x]) ok = true;
      if (!ok) errs.push(`${z.id}: inalcançável a partir da porta`);
    }
  }
  return errs;
}
