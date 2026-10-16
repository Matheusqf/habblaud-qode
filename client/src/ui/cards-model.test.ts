import { describe, expect, it } from 'vitest';
import type { AgentInfo, RoomInfo } from '../../../shared/types';
import { buildCards, costLabel, sumUsage } from './cards-model';

const ag = (id: string, o: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, kind: 'main', roomId: 'r1', name: id, look: 'f', role: 'x', sessionId: 's', account: '.claude', status: 'working', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, seed: 1, stats: { toolCalls: 0, tokensIn: 10, tokensOut: 5, subagents: 0 }, ...o }) as AgentInfo;
const room = (id: string, slot: number): RoomInfo => ({ id, name: id.toUpperCase(), path: id, slot, seed: 1, createdAt: 0 });

describe('buildCards', () => {
  it('agrupa por sala e aninha sub-agentes no principal', () => {
    const r = buildCards({
      rooms: [room('r2', 1), room('r1', 0)],
      agents: [ag('m'), ag('s', { kind: 'sub', parentId: 'm' }), ag('x', { roomId: 'r2' }), ag('off', { status: 'offline' })],
    });
    expect(r.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(r[0]!.cards).toHaveLength(1);
    expect(r[0]!.cards[0]!.subs.map((c) => c.agent.id)).toEqual(['s']);
  });
  it('sub órfão vira raiz', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [ag('s', { kind: 'sub', parentId: 'sumiu' })] });
    expect(r[0]!.cards[0]!.agent.id).toBe('s');
  });
  it('soma tokens e custo por projeto; sem custo = indisponível', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [ag('a'), ag('b', { kind: 'sub', parentId: 'a', stats: { toolCalls: 0, tokensIn: 1, tokensOut: 1, subagents: 0, costUSD: 0.5 } })] });
    expect(r[0]!.usage).toEqual({ tokens: 17, costUSD: 0.5 });
    expect(r[0]!.cards[0]!.usage.costUSD).toBeNull();
    expect(costLabel(null, String)).toBe('indisponível');
    expect(sumUsage([{ tokens: 1, costUSD: null }])).toEqual({ tokens: 1, costUSD: null });
  });
  it('snapshot nulo', () => expect(buildCards(null)).toEqual([]));
});
