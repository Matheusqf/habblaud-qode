// Opções de cenário por URL. Tema sazonal das salas (só decoração): desligado por padrão.
//   ?season=halloween  liga sempre
//   ?season=auto       liga só em outubro (relógio local do navegador)
//   ?season=off / sem parâmetro → desligado
import type { RoomStyle, Season } from './layout/room';

export function resolveSeason(search: string, now: Date = new Date()): Season | undefined {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('season');
  } catch {
    return undefined;
  }
  if (v === 'halloween') return 'halloween';
  if (v === 'auto' && now.getMonth() === 9) return 'halloween';
  return undefined;
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

/**
 * Com ?season=auto, o tema é decidido no carregamento; para não ficar preso ao mês antigo, verifica
 * de hora em hora e recarrega a página quando o resultado muda (virada de 30/09→01/10 e 31/10→01/11).
 */
export function watchAutoSeason(intervalMs = 3_600_000): void {
  if (typeof location === 'undefined' || typeof setInterval === 'undefined') return;
  if (new URLSearchParams(location.search).get('season') !== 'auto') return;
  const initial = resolveSeason(location.search);
  setInterval(() => {
    if (resolveSeason(location.search) !== initial) location.reload();
  }, intervalMs);
}
