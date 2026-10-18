import { describe, expect, it } from 'vitest';
import type { Activity, AgentInfo, PermissionRequestInfo, RoomInfo } from '../../../shared/types';
import { attentionCount, buildCards, costLabel, needsAttention, sumUsage } from './cards-model';

const ag = (id: string, o: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id, kind: 'main', roomId: 'r1', name: id, look: 'f', role: 'x', sessionId: 's', account: '.claude', status: 'working', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, seed: 1, stats: { toolCalls: 0, tokensIn: 10, tokensOut: 5, subagents: 0 }, ...o }) as AgentInfo;
const room = (id: string, slot: number): RoomInfo => ({ id, name: id.toUpperCase(), path: id, slot, seed: 1, createdAt: 0 });
const act = (o: Partial<Activity> = {}): Activity => ({ id: 'a1', at: 0, kind: 'run', icon: '💻', text: 'Rodando', ...o });
const perm = (o: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo => ({ id: 'p1', tool: 'Bash', title: 'Bash(npm test)', text: 'Rodar testes', icon: '💻', createdAt: 0, expiresAt: 60_000, ...o });

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

describe('precisa de atenção (needsAttention)', () => {
  it('pedido de permissão pendente de verdade conta; espera genérica, não', () => {
    expect(needsAttention(ag('a', { status: 'waiting', waitingFor: 'aprovar uma permissão', permission: perm() }))).toBe(true);
    // sem pedido no escritório: espera genérica (ex.: pergunta respondida só no terminal) não conta
    expect(needsAttention(ag('a', { status: 'waiting', waitingFor: 'escolher uma opção' }))).toBe(false);
    // pedido resolvido (agentId off/done não mostra pedido pendente)
    expect(needsAttention(ag('a', { status: 'offline', permission: perm() }))).toBe(false);
    expect(needsAttention(ag('a', { status: 'done', permission: perm() }))).toBe(false);
  });

  it('erro com evidência válida conta; velho/stale e inferido não', () => {
    expect(needsAttention(ag('a', { activity: act({ kind: 'error', error: true, text: 'Falhou' }) }))).toBe(true);
    // erro gravado e leitura em dia (OpenCode sem estado ao vivo)
    expect(needsAttention(ag('a', { observed: { basis: 'inferred', activity: 'active', at: 0, stale: false, error: true } }))).toBe(true);
    // leitura desatualizada: o erro é velho/stale, não conta
    expect(needsAttention(ag('a', { observed: { basis: 'inferred', activity: 'active', at: 0, stale: true, error: true } }))).toBe(false);
    // inferido (desconhecido) sem erro: não conta — e segue distinguível à vista (is-inferred)
    expect(needsAttention(ag('a', { observed: { basis: 'inferred', activity: 'unknown', at: 0, stale: false } }))).toBe(false);
    expect(needsAttention(ag('a', { observed: { basis: 'inferred', activity: 'active', at: 0, stale: true } }))).toBe(false);
    // trabalhando sem erro: não conta
    expect(needsAttention(ag('a'))).toBe(false);
    // erro antigo na atividade recente não conta: só a atividade atual é evidência
    expect(needsAttention(ag('a', { activity: act({ kind: 'done', text: 'Concluiu' }), recent: [act({ kind: 'error', error: true, text: 'Falhou antes' })] }))).toBe(false);
  });

  it('attentionCount conta presentes que precisam (offline fora)', () => {
    const agents = [
      ag('a', { status: 'waiting', permission: perm() }),
      ag('b', { activity: act({ kind: 'error', error: true }) }),
      ag('c'),
      ag('off', { status: 'offline', permission: perm() }),
    ];
    expect(attentionCount(agents)).toBe(2);
    expect(attentionCount([])).toBe(0);
  });
});

describe('filtro "precisa de atenção" em buildCards (no modelo, não no DOM)', () => {
  const agents = () => [
    ag('saudável'),
    ag('pedido', { status: 'waiting', permission: perm(), name: 'Pedro' }),
    ag('erro', { activity: act({ kind: 'error', error: true }), name: 'Ester' }),
    ag('sub-erro', { kind: 'sub', parentId: 'saudável', name: 'Sub', activity: act({ kind: 'error', error: true }) }),
    ag('sub-ok', { kind: 'sub', parentId: 'pedido', name: 'SubOk' }),
  ];

  it('sem o filtro: tudo como antes (inferido/desconhecido segue distinguível à vista)', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: [ag('inf', { observed: { basis: 'inferred', activity: 'unknown', at: 0, stale: true } })] });
    expect(r[0]!.cards.map((c) => c.agent.id)).toEqual(['inf']);
    expect(r[0]!.cards[0]!.state).toBe('inferred');
  });

  it('com o filtro: só quem precisa; sub que precisa vira raiz no lugar do principal que não precisa', () => {
    const r = buildCards({ rooms: [room('r1', 0), room('r2', 1)], agents: [...agents(), ag('outra-sala', { roomId: 'r2', name: 'Ana' })] }, { attentionOnly: true });
    expect(r.map((x) => x.id)).toEqual(['r1']);
    // saudável saiu (não precisa); seu sub com erro virou raiz; pedido entra sem o sub que não precisa
    expect(r[0]!.cards.map((c) => [c.agent.id, c.subs.map((s) => s.agent.id)])).toEqual([
      ['sub-erro', []],
      ['pedido', []],
      ['erro', []],
    ]);
    // r2 sumiu: ninguém lá precisa
  });

  it('com o filtro: uso da sala é o dos cartões que ficaram', () => {
    const r = buildCards({ rooms: [room('r1', 0)], agents: agents() }, { attentionOnly: true });
    // pedido (15) + erro (15) + sub-erro (15) = 45 tokens
    expect(r[0]!.usage.tokens).toBe(45);
    expect(r[0]!.cards[1]!.usage.tokens).toBe(15);
  });

  it('com o filtro e ninguém precisando: lista vazia (chip segue visível para desligar)', () => {
    expect(buildCards({ rooms: [room('r1', 0)], agents: [ag('a')] }, { attentionOnly: true })).toEqual([]);
    expect(buildCards(null, { attentionOnly: true })).toEqual([]);
  });
});
