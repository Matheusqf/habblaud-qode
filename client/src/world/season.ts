// Opções de cenário por URL. Tema sazonal das salas (só decoração): padrão = auto (Halloween em outubro).
//   ?season=halloween  liga sempre
//   ?season=auto       liga só em outubro (relógio local do navegador), avaliado UMA vez ao abrir a
//                      página. Não há recarga automática (preserva rascunhos do MessageComposer e
//                      edições não salvas do CharacterEditor): a virada do mês vale no próximo carregamento.
//   ?season=off        desliga
//   sem parâmetro      = auto
import type { GardenStyle } from './layout/exterior';
import type { RoomStyle, Season } from './layout/room';

export function resolveSeason(search: string, now: Date = new Date()): Season | undefined {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('season');
  } catch {
    return undefined;
  }
  if (v === 'halloween') return 'halloween';
  if (v === 'off') return undefined;
  // padrão = auto: Halloween em outubro
  return now.getMonth() === 9 ? 'halloween' : undefined;
}

export function currentSeason(): Season | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveSeason(location.search);
}

/**
 * G7 — preset do escritório por configuração de build: `VITE_HABBLAUD_OFFICE=gather` (ex.: no
 * build do QODE Office) liga open-space + jardim com rio. Sem a variável, nada muda. A URL
 * (`?office=gather|classic`, `?rooms=...`, `?garden=river|off`) sempre tem precedência.
 */
export type OfficePreset = 'gather' | 'classic';

function param(search: string, key: string): string | null {
  try {
    return new URLSearchParams(search).get(key);
  } catch {
    return null;
  }
}

export function buildOfficePreset(): OfficePreset | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.VITE_HABBLAUD_OFFICE;
  return v === 'gather' || v === 'classic' ? v : undefined;
}

function resolvePreset(search: string, fallback: OfficePreset | undefined): OfficePreset | undefined {
  const v = param(search, 'office');
  return v === 'gather' || v === 'classic' ? v : fallback;
}

/** Presete do escritório pela URL (?office=), com o da build como fallback. Puro. */
export function resolveOfficePreset(search: string, fallback: OfficePreset | undefined): OfficePreset | undefined {
  return resolvePreset(search, fallback);
}

/** Presete em vigor nesta página (?office= vale sobre VITE_HABBLAUD_OFFICE). */
export function currentOfficePreset(): OfficePreset | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolvePreset(location.search, buildOfficePreset());
}

/** ?rooms=gather | island | openspace força o estilo de todas as salas; sem parâmetro (ou mix) a semente sorteia. */
export function resolveRoomStyle(search: string, preset?: OfficePreset): RoomStyle | undefined {
  const v = param(search, 'rooms');
  if (v === 'gather' || v === 'island' || v === 'openspace') return v;
  return resolvePreset(search, preset) === 'gather' ? 'openspace' : undefined;
}

export function currentRoomStyle(): RoomStyle | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveRoomStyle(location.search, buildOfficePreset());
}

/** Jardim decorativo: ?garden=river liga, ?garden=off desliga; senão segue o preset. */
export function resolveGarden(search: string, preset?: OfficePreset): GardenStyle | undefined {
  const v = param(search, 'garden');
  if (v === 'river') return 'river';
  if (v === 'off') return undefined;
  return resolvePreset(search, preset) === 'gather' ? 'river' : undefined;
}

export function currentGarden(): GardenStyle | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveGarden(location.search, buildOfficePreset());
}
