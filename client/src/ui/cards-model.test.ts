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
  it('soma tokens e custo por projeto; misto conhecido/desconhecido = parcial com cobertura', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [ag('a'), ag('b', { kind: 'sub', parentId: 'a', stats: { toolCalls: 0, tokensIn: 1, tokensOut: 1, subagents: 0, costUSD: 0.5 } })] });
    expect(r[0]!.usage).toEqual({ tokens: 17, costUSD: 0.5, costKnown: 1, costTotal: 2 });
    expect(r[0]!.cards[0]!.usage).toEqual({ tokens: 15, costUSD: null, costKnown: 0, costTotal: 1 });
    expect(costLabel(r[0]!.usage, String)).toBe('parcial 0.5 (1/2 agentes)');
    expect(costLabel({ tokens: 0, costUSD: null, costKnown: 0, costTotal: 1 }, String)).toBe('indisponível');
    expect(sumUsage([{ tokens: 1, costUSD: null, costKnown: 0, costTotal: 1 }, { tokens: 2, costUSD: 0.5, costKnown: 1, costTotal: 1 }])).toEqual({ tokens: 3, costUSD: 0.5, costKnown: 1, costTotal: 2 });
  });
  it('todos sem custo = indisponível (não zero)', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [ag('a'), ag('b', { kind: 'sub', parentId: 'a' })] });
    expect(r[0]!.usage).toEqual({ tokens: 30, costUSD: null, costKnown: 0, costTotal: 2 });
    expect(costLabel(r[0]!.usage, String)).toBe('indisponível');
  });
  it('custo real zero em todos = fmt(0), não indisponível', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [
      ag('a', { stats: { toolCalls: 0, tokensIn: 1, tokensOut: 1, subagents: 0, costUSD: 0 } }),
      ag('b', { kind: 'sub', parentId: 'a', stats: { toolCalls: 0, tokensIn: 1, tokensOut: 1, subagents: 0, costUSD: 0 } }),
    ] });
    expect(r[0]!.usage).toEqual({ tokens: 4, costUSD: 0, costKnown: 2, costTotal: 2 });
    expect(costLabel(r[0]!.usage, String)).toBe('0');
  });
  it('snapshot nulo', () => expect(buildCards(null)).toEqual([]));
});
