// Painel do monitor da mesa (PR2): apresentação SÓ LEITURA de quem está sentado ali (modelo puro,
// sem DOM). Nada de aprovar/recusar/responder/terminal: esse caminho é da gaveta do agente
// (drawer.ts + permission.ts), que segue operacional e intocado. O modelo descreve TUDO que o
// painel materializa (peças e textos), então a garantia de "só leitura" vale para o DOM dele.
import type { AgentInfo } from '../../../shared/types';
import { UNIFIED_ICON, UNIFIED_LABEL, currentFile, unifiedState, type UnifiedState } from '../../../shared/unified-state';
import { formatTokens, formatUSD, prettyModel } from './format';
import { activityFallback, roleLabel, statusLabel } from './model';

/** Linhas do painel (uma por rótulo; valor null oculta a linha). */
export type DeskRowKey = 'state' | 'model' | 'file' | 'activity' | 'tokens' | 'cost';

export const DESK_ROW_LABELS: Readonly<Record<DeskRowKey, string>> = {
  state: 'Estado',
  model: 'Modelo',
  file: 'Ficheiro atual',
  activity: 'Atividade',
  tokens: 'Tokens',
  cost: 'Custo estimado',
};

export const DESK_ROW_KEYS: readonly DeskRowKey[] = ['state', 'model', 'file', 'activity', 'tokens', 'cost'];

/** Peças estáticas do diálogo: tudo que o painel materializa. Um ÚNICO botão, o de fechar. */
export type DeskPart =
  | { kind: 'title' }
  | { kind: 'readonly'; label: 'só leitura' }
  | { kind: 'close'; label: string }
  | { kind: 'role' }
  | { kind: 'status' }
  | { kind: 'row'; row: DeskRowKey; label: string };

export const DESK_PARTS: readonly DeskPart[] = [
  { kind: 'title' },
  { kind: 'readonly', label: 'só leitura' },
  { kind: 'close', label: 'Fechar (Esc)' },
  { kind: 'role' },
  { kind: 'status' },
  ...DESK_ROW_KEYS.map((row): DeskPart => ({ kind: 'row', row, label: DESK_ROW_LABELS[row] })),
];

export interface DeskPanelView {
  name: string;
  role: string;
  status: AgentInfo['status'];
  /** Status de alto nível, com o motivo da espera quando há ("Precisa de você: aprovar uma permissão"). */
  statusText: string;
  /** Estado unificado (para a cor) e o texto com ícone. */
  state: UnifiedState;
  rows: Readonly<Record<DeskRowKey, string | null>>;
}

/** Vista só leitura do agente sentado na mesa: só estado, modelo, ficheiro/atividade e tokens/custo. */
export function deskPanelView(a: AgentInfo): DeskPanelView {
  const us = unifiedState(a);
  return {
    name: a.name,
    role: roleLabel(a),
    status: a.status,
    statusText: a.status === 'waiting' && a.waitingFor ? `${statusLabel(a.status)}: ${a.waitingFor}` : statusLabel(a.status),
    state: us,
    rows: {
      state: `${UNIFIED_ICON[us]} ${UNIFIED_LABEL[us]}`,
      model: prettyModel(a.model),
      file: currentFile(a),
      activity: a.activity?.text ?? activityFallback(a),
      tokens: `${formatTokens(a.stats.tokensIn)} entrada + ${formatTokens(a.stats.tokensOut)} saída`,
      cost: a.stats.costUSD !== undefined ? formatUSD(a.stats.costUSD) : 'indisponível',
    },
  };
}

// ------------------------------------------------------------------ ciclo de vida (puro)

export interface DeskPanelState {
  open: boolean;
  /** Agente mostrado, resolvido pelo id no clique (o dono do lugar no estado das mesas). */
  agentId: string | null;
}

export const DESK_PANEL_CLOSED: DeskPanelState = { open: false, agentId: null };

/** Efeitos que o componente executa no DOM (foco e dica); descritos aqui para o teste do ciclo. */
export interface DeskPanelEffect {
  /** Para onde o foco do teclado volta ao fechar. */
  focus: 'canvas' | null;
  /** Dica curta no ponto do clique (mesa livre); null = nenhuma. */
  tooltip: string | null;
}

const NO_EFFECT: DeskPanelEffect = { focus: null, tooltip: null };

/**
 * Clique no monitor de uma mesa: com agente sentado, abre nele (resolvido por id; trocar de mesa
 * não troca o agente mostrado). Mesa livre: fecha e só a dica "Mesa livre" no ponto do clique.
 */
export function deskClick(s: DeskPanelState, agentId: string | null): { state: DeskPanelState; effect: DeskPanelEffect } {
  if (agentId === null) return { state: DESK_PANEL_CLOSED, effect: { focus: s.open ? 'canvas' : null, tooltip: 'Mesa livre' } };
  return { state: { open: true, agentId }, effect: NO_EFFECT };
}

/** Fechar (Esc, botão Fechar ou agente que saiu do escritório): fecha e devolve o foco ao canvas. */
export function deskClose(s: DeskPanelState): { state: DeskPanelState; effect: DeskPanelEffect } {
  if (!s.open) return { state: s, effect: NO_EFFECT };
  return { state: DESK_PANEL_CLOSED, effect: { focus: 'canvas', tooltip: null } };
}

/** Agente mostrado, resolvido pelo id no snapshot; null = saiu do escritório (o painel fecha). */
export function deskPanelAgent(s: DeskPanelState, agents: readonly AgentInfo[]): AgentInfo | null {
  if (!s.open || s.agentId === null) return null;
  for (const a of agents) if (a.id === s.agentId) return a;
  return null;
}
