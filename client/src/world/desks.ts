// Monitor da mesa clicável: hit-test puro do monitor de uma mesa (desk/desk_back) e do lugar
// (spot) que a mesa serve. Computado SÓ no clique (nada disto roda no laço de desenho por quadro).
// A arte dos móveis (art/furniture/office.ts): coordenadas de desenho = footprint, monitor de
// frente erguido acima do tampo (y −17..−3) e traseira sobre o tampo (y −7..+5).
import { TILE } from './constants';
import type { AreaLayout, FurniturePlacement, SpotDef } from './layout/types';

/** Sala como o hit-test do monitor a vê (present/ghost filtrados dentro). */
export interface DeskRoomLike {
  present: boolean;
  ghost: boolean;
  layout: AreaLayout;
}

/** Retângulo clicável do monitor da mesa, em px de mundo (largura da mesa + folga acima/abaixo). */
export function monitorRect(f: Pick<FurniturePlacement, 'kind' | 'tx' | 'ty'>): { x: number; y: number; w: number; h: number } {
  // desk: tela erguida acima do tampo; desk_back: traseira do monitor atravessando o topo do tampo.
  const y = f.kind === 'desk' ? f.ty * TILE - 18 : f.ty * TILE - 8;
  return { x: f.tx * TILE, y, w: 2 * TILE, h: f.kind === 'desk' ? 15 : 12 };
}

/** Lugar (spot desk) que serve a mesa deste móvel (o monitor mostra a atividade de quem senta ali). */
export function deskSpotOf(spots: readonly SpotDef[], furnitureId: string): SpotDef | undefined {
  for (const s of spots) if (s.kind === 'desk' && s.deskId === furnitureId) return s;
  return undefined;
}

/**
 * Monitor de mesa sob o ponto (px de mundo): o lugar que a mesa serve, ou null. Computado só no
 * clique. Mesas face a face se sobrepõem: entre monitores empilhados, ganha o desenhado por cima
 * (maior ty, a ordem de profundidade do render). Salas fantasma (endereço antigo de uma mudança)
 * não contam: ninguém pertence a elas.
 */
export function pickDeskMonitor(rooms: Iterable<DeskRoomLike>, x: number, y: number, slack = 0): SpotDef | null {
  let best: SpotDef | null = null;
  let bestTy = -Infinity;
  for (const room of rooms) {
    if (!room.present || room.ghost) continue;
    for (const f of room.layout.furniture) {
      if (f.kind !== 'desk' && f.kind !== 'desk_back') continue;
      if (f.ty <= bestTy) continue;
      const r = monitorRect(f);
      if (x < r.x - slack || x > r.x + r.w + slack || y < r.y - slack || y > r.y + r.h + slack) continue;
      const spot = deskSpotOf(room.layout.spots, f.id);
      if (!spot) continue;
      bestTy = f.ty;
      best = spot;
    }
  }
  return best;
}
