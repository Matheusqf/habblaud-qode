// Fork QODE (Q3): origem e capacidade explícitas das fontes.
// Manual continua Manual; OpenCode/Cursor ficam "unavailable" até existir adaptador;
// fonte ligada com erro fica "unknown" (não aparenta live).
// B2: ops-room = 1 bot OpenCode proposto; sempre unavailable neste stub (sem API live).
import type { SourceInfo } from '../../shared/types';
import { qodeOpsRoomStatus, type OpsRoomStatus } from './ops-room-status';

/** Origem declarada: o que a UI/health pode alegar sem mentir. */
export type CapabilityOrigin = 'live' | 'manual' | 'unavailable' | 'unknown';

/** Capacidades comprovadas nesta versão do fork (não aspiracionais). */
export type CapabilityKind = 'observe' | 'message' | 'approve' | 'history';

export type CapabilitySourceId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'manual-registry'
  | 'ops-room';

export interface SourceCapability {
  id: CapabilitySourceId;
  label: string;
  origin: CapabilityOrigin;
  capabilities: readonly CapabilityKind[];
  note?: string;
}

const CLAUDE_CAPS: readonly CapabilityKind[] = ['observe', 'message', 'approve', 'history'];
const CODEX_CAPS: readonly CapabilityKind[] = ['observe', 'message', 'approve', 'history'];

function connectedOrigin(sources: readonly SourceInfo[] | undefined, provider: 'claude' | 'codex'): CapabilityOrigin {
  if (!sources || sources.length === 0) return 'unknown';
  const mine = sources.filter((s) => (s.provider ?? 'claude') === provider);
  if (mine.length === 0) return 'unknown';
  // Qualquer conta ok = live; só erros = unknown (não vender como live).
  if (mine.some((s) => s.ok)) return 'live';
  return 'unknown';
}

/** Capability da ops room: never live neste stub. */
export function opsRoomCapability(status: OpsRoomStatus = qodeOpsRoomStatus()): SourceCapability {
  return {
    id: 'ops-room',
    label: 'Ops room (OpenCode)',
    origin: 'unavailable',
    capabilities: [],
    note: status.note,
  };
}

/**
 * Catálogo estático + estado das fontes ligadas.
 * OpenCode e Cursor NÃO entram como live enquanto não houver adaptador em server/sources/.
 * ops-room NUNCA é live neste ciclo (API unavailable; ver docs/qode-b2-ops-room.md).
 */
export function qodeCapabilities(connected?: readonly SourceInfo[]): SourceCapability[] {
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      origin: connectedOrigin(connected, 'claude'),
      capabilities: CLAUDE_CAPS,
    },
    {
      id: 'codex',
      label: 'Codex',
      origin: connectedOrigin(connected, 'codex'),
      capabilities: CODEX_CAPS,
      note: 'live só com pastas Codex e/ou hooks; sem isso, unknown',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      origin: 'unavailable',
      capabilities: [],
      note: 'não integrado neste ciclo (adaptador pendente; não aparece como live)',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      origin: 'unavailable',
      capabilities: [],
      note: 'não integrado neste ciclo (hooks pendentes; conversa do IDE não aparece)',
    },
    {
      id: 'manual-registry',
      label: 'Registro manual',
      origin: 'manual',
      capabilities: [],
      note: 'tarefas/entradas manuais não são trabalho live',
    },
    opsRoomCapability(),
  ];
}

/** True se alguma entrada alega live sem estar no catálogo de fontes ligadas comprovadas. */
export function hasMisleadingLive(caps: readonly SourceCapability[]): boolean {
  return caps.some(
    (c) =>
      (c.id === 'opencode' || c.id === 'cursor' || c.id === 'manual-registry' || c.id === 'ops-room') &&
      c.origin === 'live',
  );
}
