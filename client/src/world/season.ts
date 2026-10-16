// Opções de cenário por URL. Tema sazonal das salas (só decoração): padrão = auto (Halloween em outubro).
//   ?season=halloween  liga sempre
//   ?season=auto       liga só em outubro (relógio local do navegador), avaliado UMA vez ao abrir a
//                      página. Não há recarga automática (preserva rascunhos do MessageComposer e
//                      edições não salvas do CharacterEditor): a virada do mês vale no próximo carregamento.
//   ?season=off        desliga
//   sem parâmetro      = auto
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

/** ?rooms=gather | island força o estilo de todas as salas; sem parâmetro (ou mix) a semente sorteia. */
export function resolveRoomStyle(search: string): RoomStyle | undefined {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('rooms');
  } catch {
    return undefined;
  }
  return v === 'gather' || v === 'island' ? v : undefined;
}

export function currentRoomStyle(): RoomStyle | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveRoomStyle(location.search);
}

