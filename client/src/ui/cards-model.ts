// Vista em cartões (opt-in ?view=cards): modelo puro. Ideia do ClaudeVille (sem LICENSE: código próprio).
// Agrupa por projeto (sala), sub-agentes dentro do principal e soma tokens/custo quando a fonte os fornece.
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { unifiedState, type UnifiedState } from '../../../shared/unified-state';

export interface Usage {
  tokens: number;
  /** null = a fonte não fornece custo (mostrar "indisponível"). */
  costUSD: number | null;
}

export interface AgentCard {
  agent: AgentInfo;
  state: UnifiedState;
  usage: Usage;
  subs: AgentCard[];
}

export interface RoomCards {
  id: string;
  name: string;
  cards: AgentCard[];
  usage: Usage;
}

export function agentUsage(a: Pick<AgentInfo, 'stats'>): Usage {
  return { tokens: (a.stats?.tokensIn ?? 0) + (a.stats?.tokensOut ?? 0), costUSD: a.stats?.costUSD ?? null };
}

export function sumUsage(list: readonly Usage[]): Usage {
  let tokens = 0;
  let cost: number | null = null;
  for (const u of list) {
    tokens += u.tokens;
    if (u.costUSD !== null) cost = (cost ?? 0) + u.costUSD;
  }
  return { tokens, costUSD: cost };
}

export function costLabel(c: number | null, fmt: (n: number) => string): string {
  return c === null ? 'indisponível' : fmt(c);
}

export function buildCards(snap: Pick<OfficeSnapshot, 'agents' | 'rooms'> | null): RoomCards[] {
  if (!snap) return [];
  const live = snap.agents.filter((a) => a.status !== 'offline');
  const ids = new Set(live.map((a) => a.id));
  const card = (a: AgentInfo): AgentCard => ({
    agent: a,
    state: unifiedState(a),
    usage: agentUsage(a),
    subs: live.filter((s) => s.parentId === a.id).map(card),
  });
  const out: RoomCards[] = [];
  for (const r of [...snap.rooms].sort((x, y) => x.slot - y.slot)) {
    // raiz = principal, ou sub cujo pai não está no escritório
    const roots = live.filter((a) => a.roomId === r.id && (!a.parentId || !ids.has(a.parentId))).map(card);
    if (!roots.length) continue;
    const flat: Usage[] = [];
    const walk = (c: AgentCard): void => {
      flat.push(c.usage);
      c.subs.forEach(walk);
    };
    roots.forEach(walk);
    out.push({ id: r.id, name: r.name, cards: roots, usage: sumUsage(flat) });
  }
  return out;
}
