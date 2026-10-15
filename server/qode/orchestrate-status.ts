/** B1: estado observe-only do coordenador floating-flow (dev-flow). QODE não despacha. */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export interface OrchestrateStatus {
  /** Único coordenador autorizado neste ciclo. */
  coordinator: 'floating-flow';
  /** QODE só observa; nunca plan/run/review. */
  role: 'observe-only';
  /** true se o clone RO do dev-flow está acessível (AGENTS.md + skill orchestrate). */
  ready: boolean;
  /** Raiz resolvida só quando ready; omitida se ausente/ilegível. */
  root?: string;
  note: string;
}

const MARKER = join('plugin', 'skills', 'flow-orchestrate', 'SKILL.md');

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve raiz do floating-flow: env QODE_DEVFLOW_ROOT, senão ~/Documents/GitHub/dev-flow. */
export function resolveDevflowRoot(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const fromEnv = env.QODE_DEVFLOW_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const fallback = join(home, 'Documents', 'GitHub', 'dev-flow');
  return fallback;
}

export function isDevflowReady(root: string): boolean {
  return readable(join(root, 'AGENTS.md')) && readable(join(root, MARKER));
}

/**
 * Status para /api/health. Sem side-effects de dispatch.
 * ready=false → UI não deve fingir orquestração live.
 */
export function qodeOrchestrateStatus(env: NodeJS.ProcessEnv, home: string): OrchestrateStatus {
  const root = resolveDevflowRoot(env, home);
  if (!root) {
    return {
      coordinator: 'floating-flow',
      role: 'observe-only',
      ready: false,
      note: 'sem raiz; defina QODE_DEVFLOW_ROOT ou clone em Documents/GitHub/dev-flow',
    };
  }
  if (!isDevflowReady(root)) {
    const explicit = !!env.QODE_DEVFLOW_ROOT?.trim();
    return {
      coordinator: 'floating-flow',
      role: 'observe-only',
      ready: false,
      ...(explicit ? { root } : {}),
      note: explicit
        ? 'raiz apontada mas AGENTS.md/flow-orchestrate ilegíveis — QODE não despacha'
        : 'clone padrão ausente; defina QODE_DEVFLOW_ROOT ou clone Documents/GitHub/dev-flow',
    };
  }
  return {
    coordinator: 'floating-flow',
    role: 'observe-only',
    ready: true,
    root,
    note: 'coordenador = floating-flow; QODE só observa (sem dispatch run/review)',
  };
}
