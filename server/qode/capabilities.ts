// Fork QODE (Q3): origem e capacidade explícitas das fontes.
// Manual continua Manual; OpenCode/Cursor ficam "unavailable" até existir adaptador;
// fonte ligada com erro fica "unknown" (não aparenta live).
// B1: floating-flow = coordenador único (observe); QODE não despacha.
import type { SourceInfo } from '../../shared/types';
import { qodeOrchestrateStatus, type OrchestrateStatus } from './orchestrate-status';

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
  | 'floating-flow';

export interface SourceCapability {
  id: CapabilitySourceId;
  label: string;
  origin: CapabilityOrigin;
  capabilities: readonly CapabilityKind[];
  note?: string;
}

const CLAUDE_CAPS: readonly CapabilityKind[] = ['observe', 'message', 'approve', 'history'];
const CODEX_CAPS: readonly CapabilityKind[] = ['observe', 'message', 'approve', 'history'];
const FLOW_OBSERVE: readonly CapabilityKind[] = ['observe'];

function connectedOrigin(sources: readonly SourceInfo[] | undefined, provider: 'claude' | 'codex'): CapabilityOrigin {
  if (!sources || sources.length === 0) return 'unknown';
  const mine = sources.filter((s) => (s.provider ?? 'claude') === provider);
  if (mine.length === 0) return 'unknown';
  // Qualquer conta ok = live; só erros = unknown (não vender como live).
  if (mine.some((s) => s.ok)) return 'live';
  return 'unknown';
}

/** Capability do coordenador: never live (sem adapter de sessão no QODE). */
export function floatingFlowCapability(status: OrchestrateStatus): SourceCapability {
  // observe só com ready (configured && artifactsPresent). Sem root no DTO.
  if (!status.ready) {
    return {
      id: 'floating-flow',
      label: 'floating-flow (dev-flow)',
      origin: status.configured ? 'unknown' : 'unavailable',
      capabilities: [],
      note: status.note,
    };
  }
  return {
    id: 'floating-flow',
    label: 'floating-flow (dev-flow)',
    origin: 'manual',
    capabilities: FLOW_OBSERVE,
    note: status.note,
  };
}

export interface QodeCapabilitiesOptions {
  connected?: readonly SourceInfo[];
  /** Quando omitido, floating-flow fica unavailable (sem fingir ready). */
  orchestrate?: OrchestrateStatus;
}

/**
 * Catálogo estático + estado das fontes ligadas.
 * OpenCode e Cursor NÃO entram como live enquanto não houver adaptador em server/sources/.
 * floating-flow NUNCA é live neste ciclo (só observe via artefactos em disco).
 */
export function qodeCapabilities(opts: QodeCapabilitiesOptions = {}): SourceCapability[] {
  const connected = opts.connected;
  const flow =
    opts.orchestrate ??
    ({
      coordinator: 'floating-flow',
      role: 'observe-only',
      ready: false,
      configured: false,
      artifactsPresent: false,
      note: 'status não passado; trate como unavailable',
    } satisfies OrchestrateStatus);

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
    floatingFlowCapability(flow),
  ];
}

/** Helper de teste/produção: capabilities + status a partir de env/home. */
export function qodeCapabilitiesWithEnv(
  env: NodeJS.ProcessEnv,
  home: string,
  connected?: readonly SourceInfo[],
): { capabilities: SourceCapability[]; orchestrate: OrchestrateStatus } {
  const orchestrate = qodeOrchestrateStatus(env, home);
  return { capabilities: qodeCapabilities({ connected, orchestrate }), orchestrate };
}

/** True se alguma entrada alega live sem estar no catálogo de fontes ligadas comprovadas. */
export function hasMisleadingLive(caps: readonly SourceCapability[]): boolean {
  return caps.some(
    (c) =>
      (c.id === 'opencode' || c.id === 'cursor' || c.id === 'manual-registry' || c.id === 'floating-flow') &&
      c.origin === 'live',
  );
}
