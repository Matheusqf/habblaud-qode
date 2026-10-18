// Hit-test do monitor da mesa clicável (world/desks.ts): puro, sem DOM.
import { describe, expect, it } from 'vitest';
import type { FurniturePlacement, SpotDef, SpotKind } from './layout/types';
import { monitorRect, pickDeskMonitor, type DeskRoomLike } from './desks';

let seq = 0;
const furn = (kind: FurniturePlacement['kind'], tx: number, ty: number): FurniturePlacement => ({ kind, tx, ty, id: `f${seq++}`, order: 0 });
const spot = (kind: SpotKind, o: Partial<SpotDef> & Pick<SpotDef, 'id' | 'tx' | 'ty'>): SpotDef =>
  ({ kind, areaId: 'r1', dir: 'down', x: 0, y: 0, ...o });

const room = (layout: { furniture: FurniturePlacement[]; spots: SpotDef[] }, o: Partial<DeskRoomLike> = {}): DeskRoomLike =>
  ({ present: true, ghost: false, layout: { id: 'r1', kind: 'room', rect: { x: 0, y: 0, w: 16, h: 12 }, floors: [], rugs: [], walls: [], wallItems: [], furniture: layout.furniture, spots: layout.spots, walkable: [] }, ...o });

describe('monitorRect', () => {
  it('desk: tela erguida acima do tampo (banda −18..−3 do topo do footprint, largura da mesa)', () => {
    const r = monitorRect({ kind: 'desk', tx: 4, ty: 6 });
    expect(r).toEqual({ x: 64, y: 78, w: 32, h: 15 });
    // tela do monitor (art): y −17..−6 relativo ao topo do footprint (96) = 79..90 de mundo.
    expect(79 >= r.y && 90 <= r.y + r.h).toBe(true);
  });
  it('desk_back: traseira sobre o tampo (banda −8..+4)', () => {
    const r = monitorRect({ kind: 'desk_back', tx: 4, ty: 5 });
    expect(r).toEqual({ x: 64, y: 72, w: 32, h: 12 });
    // traseira (art): y −7..+3 relativo ao topo do footprint (80) = 73..83 de mundo.
    expect(73 >= r.y && 83 <= r.y + r.h).toBe(true);
  });
});

describe('pickDeskMonitor', () => {
  const desk = furn('desk', 2, 6);
  const back = furn('desk_back', 2, 5);
  const sDesk = spot('desk', { id: 'sd', tx: 2, ty: 7, deskId: desk.id });
  const sBack = spot('desk', { id: 'sb', tx: 2, ty: 4, deskId: back.id });

  it('monitor de frente: devolve o lugar que a mesa serve; folga conta', () => {
    const r = pickDeskMonitor([room({ furniture: [desk, back], spots: [sDesk, sBack] })], 48, 85);
    expect(r?.id).toBe('sd');
    // 76 está fora da banda (78..93), mas dentro com a folga de 3
    expect(pickDeskMonitor([room({ furniture: [desk, back], spots: [sDesk, sBack] })], 48, 76, 3)?.id).toBe('sd');
  });

  it('traseira (desk_back): devolve o lugar de quem senta ao norte da mesa', () => {
    const r = pickDeskMonitor([room({ furniture: [desk, back], spots: [sDesk, sBack] })], 48, 74);
    expect(r?.id).toBe('sb');
  });

  it('mesas face a face se sobrepõem: ganha a desenhada por cima (maior ty), nunca a de trás', () => {
    // 78..84 é a faixa em que a tela da mesa sul cobre a traseira da mesa norte.
    expect(pickDeskMonitor([room({ furniture: [desk, back], spots: [sDesk, sBack] })], 48, 82)?.id).toBe('sd');
    // acima da tela da mesa sul (78): só a traseira da mesa norte.
    expect(pickDeskMonitor([room({ furniture: [desk, back], spots: [sDesk, sBack] })], 48, 76)?.id).toBe('sb');
  });

  it('fora de qualquer monitor, mesa sem lugar e outros móveis: null', () => {
    const r = room({ furniture: [desk, back, furn('meeting_table', 8, 5)], spots: [sDesk, sBack] });
    expect(pickDeskMonitor([r], 48, 110)).toBeNull();
    expect(pickDeskMonitor([r], 200, 200)).toBeNull();
    expect(pickDeskMonitor([room({ furniture: [furn('desk', 2, 6)], spots: [spot('stand', { id: 'x', tx: 3, ty: 3 })] })], 48, 85)).toBeNull();
  });

  it('sala fantasma e sala ausente não contam; mais de uma sala é vasculhada', () => {
    const ghost = room({ furniture: [desk], spots: [sDesk] }, { ghost: true });
    expect(pickDeskMonitor([ghost], 48, 85)).toBeNull();
    expect(pickDeskMonitor([room({ furniture: [desk], spots: [sDesk] }, { present: false })], 48, 85)).toBeNull();
    const far = furn('desk', 10, 6);
    const other = room({ furniture: [far], spots: [spot('desk', { id: 'so', tx: 10, ty: 7, deskId: far.id })] });
    expect(pickDeskMonitor([room({ furniture: [desk], spots: [sDesk] }), other], 168, 85)?.id).toBe('so');
  });
});
