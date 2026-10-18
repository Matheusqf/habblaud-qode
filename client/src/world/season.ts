// Opções de cenário por URL. Tema sazonal das salas (só decoração): padrão = auto (Halloween em outubro).
//   ?season=halloween  liga sempre
//   ?season=auto       liga só em outubro (relógio local do navegador), avaliado UMA vez ao abrir a
//                      página. Não há recarga automática (preserva rascunhos do MessageComposer e
//                      edições não salvas do CharacterEditor): a virada do mês vale no próximo carregamento.
//   ?season=off        desliga
//   ?season=auto       auto mesmo com `seasonal: false` no pacote de tema
//   sem parâmetro      = auto (a menos que o pacote de tema em vigor diga `seasonal: false`)
import type { ThemePackGardenStyle, ThemePackOfficePreset, ThemePackRoomStyle } from '../../../shared/theme-packs';
import { currentThemePack } from '../../../shared/theme-packs';
import type { GardenStyle } from './layout/exterior';
import type { RoomStyle, Season } from './layout/room';

/** Sem parâmetro, o pacote de tema (seasonal: true|false) decide; ?season=halloween|off vale sempre. Puro. */
export function resolveSeason(search: string, now: Date = new Date(), seasonalDefault = true): Season | undefined {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('season');
  } catch {
    return undefined;
  }
  if (v === 'halloween') return 'halloween';
  if (v === 'off') return undefined;
  // ?season=auto explícito vence `seasonal: false` do pacote (a URL é sempre a última palavra)
  if (v === 'auto') return now.getMonth() === 9 ? 'halloween' : undefined;
  // padrão = auto: Halloween em outubro
  return seasonalDefault && now.getMonth() === 9 ? 'halloween' : undefined;
}

export function currentSeason(): Season | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveSeason(location.search, new Date(), currentThemePack().seasonal);
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

/** Presete em vigor nesta página: ?office= > VITE_HABBLAUD_OFFICE > office do pacote de tema. */
export function currentOfficePreset(): OfficePreset | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveOfficePresetWithPack(location.search, buildOfficePreset(), currentThemePack().scenery.office);
}

/** Cadeia completa (pura): URL > var de build > padrão do pacote. */
export function resolveOfficePresetWithPack(search: string, envPreset: OfficePreset | undefined, packOffice: OfficePreset | undefined): OfficePreset | undefined {
  return resolvePreset(search, envPreset ?? packOffice);
}

/** ?rooms=gather | island | openspace força o estilo de todas as salas; sem parâmetro (ou mix) a semente sorteia. */
export function resolveRoomStyle(search: string, preset?: OfficePreset): RoomStyle | undefined {
  const v = param(search, 'rooms');
  if (v === 'gather' || v === 'island' || v === 'openspace') return v;
  return resolvePreset(search, preset) === 'gather' ? 'openspace' : undefined;
}

/** Cadeia completa (pura): ?rooms= > var de build > URL ?office= > rooms do pacote > office do pacote. */
export function resolveRoomStyleWithPack(search: string, envPreset: OfficePreset | undefined, pack: { rooms?: RoomStyle; office?: OfficePreset }): RoomStyle | undefined {
  // ?rooms= presente (mesmo vazio/inválido): resolve com o preset da build (VITE_HABBLAUD_OFFICE) como fallback
  if (param(search, 'rooms') !== null) return resolveRoomStyle(search, envPreset);
  // ?office= explícito na URL decide o estilo (o rooms do pacote é só padrão do preset do pacote)
  if (param(search, 'office') !== null) return resolveRoomStyle(search, envPreset);
  if (envPreset !== undefined) return resolveRoomStyle(search, envPreset);
  if (pack.rooms !== undefined) return pack.rooms;
  return resolvePreset(search, pack.office) === 'gather' ? 'openspace' : undefined;
}

export function currentRoomStyle(): RoomStyle | undefined {
  if (typeof location === 'undefined') return undefined;
  const scenery = currentThemePack().scenery;
  return resolveRoomStyleWithPack(location.search, buildOfficePreset(), { rooms: scenery.rooms, office: scenery.office });
}

/** Jardim decorativo: ?garden=river liga, ?garden=off desliga; senão segue o preset. */
export function resolveGarden(search: string, preset?: OfficePreset): GardenStyle | undefined {
  const v = param(search, 'garden');
  if (v === 'river') return 'river';
  if (v === 'off') return undefined;
  return resolvePreset(search, preset) === 'gather' ? 'river' : undefined;
}

/** Cadeia completa (pura): ?garden= > var de build > URL ?office= > garden do pacote > office do pacote. */
export function resolveGardenWithPack(search: string, envPreset: OfficePreset | undefined, pack: { garden?: GardenStyle | 'off'; office?: OfficePreset }): GardenStyle | undefined {
  if (param(search, 'garden') !== null) return resolveGarden(search, envPreset);
  if (param(search, 'office') !== null) return resolveGarden(search, envPreset);
  if (envPreset !== undefined) return resolveGarden(search, envPreset);
  if (pack.garden === 'off') return undefined; // o pacote desliga o rio mesmo com preset gather
  if (pack.garden !== undefined) return pack.garden;
  return resolvePreset(search, pack.office) === 'gather' ? 'river' : undefined;
}

export function currentGarden(): GardenStyle | undefined {
  if (typeof location === 'undefined') return undefined;
  const scenery = currentThemePack().scenery;
  return resolveGardenWithPack(location.search, buildOfficePreset(), { garden: scenery.garden, office: scenery.office });
}
