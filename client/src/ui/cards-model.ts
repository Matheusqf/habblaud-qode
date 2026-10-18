// Vista em cartões (opt-in ?view=cards): modelo puro. Ideia do ClaudeVille (sem LICENSE: código próprio).
// Agrupa por projeto (sala), sub-agentes dentro do principal e soma tokens/custo quando a fonte os fornece.
// Filtro "precisa de atenção": pedido de permissão pendente de verdade ou erro com evidência válida.
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { unifiedState, type UnifiedState } from '../../../shared/unified-state';

export interface Usage {
  tokens: number;
  /** null = a fonte não fornece custo (mostrar "indisponível"). */
  costUSD: number | null;
  /** Agentes que informam custo (0 quando nenhum informa). */
  costKnown: number;
  /** Agentes contados na soma (cobertura = costKnown/costTotal). */
  costTotal: number;
}

/** Agente como a política de atenção o vê (o resto é da política do unifiedState). */
type AttentionLike = Pick<AgentInfo, 'status' | 'activity' | 'permission'> & { provider?: string; observed?: AgentInfo['observed'] };

/**
 * Precisa de atenção: pedido de permissão PENDENTE de verdade (a mesma política da gaveta,
 * ui/permission.ts `permissionAgents`) ou erro com evidência válida (a política do unifiedState:
 * inferido/stale não vira erro). Espera genérica (sem pedido), erro velho/desatualizado e estado
 * inferido (desconhecido) NÃO contam — e continuam distinguíveis à vista no cartão.
 */
export function needsAttention(a: AttentionLike): boolean {
  const pending = !!a.permission && a.status !== 'offline' && a.status !== 'done';
  return pending || unifiedState(a) === 'error';
}

/** Quantos agentes presentes precisam de atenção (o contador do chip do filtro). */
export function attentionCount(agents: readonly AgentInfo[]): number {
  let n = 0;
  for (const a of agents) if (a.status !== 'offline' && needsAttention(a)) n++;
  return n;
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
  // Um agente informa custo (1/1) ou não (0/1).
  const costUSD = a.stats?.costUSD ?? null;
  return { tokens: (a.stats?.tokensIn ?? 0) + (a.stats?.tokensOut ?? 0), costUSD, costKnown: costUSD === null ? 0 : 1, costTotal: 1 };
}

export function sumUsage(list: readonly Usage[]): Usage {
  let tokens = 0;
  let cost: number | null = null;
  // Cobertura de custo: quantos agentes informam vs. quantos foram contados.
  let costKnown = 0;
  let costTotal = 0;
  for (const u of list) {
    tokens += u.tokens;
    costKnown += u.costKnown;
    costTotal += u.costTotal;
    if (u.costUSD !== null) cost = (cost ?? 0) + u.costUSD;
  }
  return { tokens, costUSD: cost, costKnown, costTotal };
}

export function costLabel(u: Usage, fmt: (n: number) => string): string {
  // Nenhum agente informa custo.
  if (u.costKnown === 0) return 'indisponível';
  // Todos informam (zero real continua fmt(0), não "indisponível").
  if (u.costKnown === u.costTotal) return fmt(u.costUSD ?? 0);
  // Parte informa: soma só dos conhecidos, com a cobertura entre parênteses.
  return `parcial ${fmt(u.costUSD ?? 0)} (${u.costKnown}/${u.costTotal} agentes)`;
}

/** Cartões que precisam de atenção: só quem precisa; sub que precisa vira raiz no lugar do principal que não precisa. */
function attentionCards(cards: readonly AgentCard[]): AgentCard[] {
  const out: AgentCard[] = [];
  for (const c of cards) {
    if (needsAttention(c.agent)) out.push({ ...c, subs: attentionCards(c.subs) });
    else out.push(...attentionCards(c.subs));
  }
  return out;
}

export function buildCards(snap: Pick<OfficeSnapshot, 'agents' | 'rooms'> | null, opts: { attentionOnly?: boolean } = {}): RoomCards[] {
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
    let roots = live.filter((a) => a.roomId === r.id && (!a.parentId || !ids.has(a.parentId))).map(card);
    // filtro no modelo (não no DOM): só quem precisa de atenção
    if (opts.attentionOnly) roots = attentionCards(roots);
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
