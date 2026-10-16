/** B1: estado observe-only do coordenador floating-flow (dev-flow). QODE não despacha.
 *  DTO público: opaco — sem root, sem valor de QODE_DEVFLOW_ROOT, sem paths absolutos.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface OrchestrateStatus {
  /** Único coordenador autorizado neste ciclo. */
  coordinator: 'floating-flow';
  /** QODE só observa; nunca plan/run/review. */
  role: 'observe-only';
  /**
   * true só com configured && artifactsPresent (contrato mínimo de observe).
   * Não anuncia observe só porque dois nomes existem em disco.
   */
  ready: boolean;
  /** Marcadores estruturais existem como ficheiros regulares (não dirs). */
  configured: boolean;
  /** Conteúdo mínimo legível que justifica observe (não só accessSync). */
  artifactsPresent: boolean;
  note: string;
}

/** Evidência interna (nunca serializada no health). */
export interface DevflowProbe {
  configured: boolean;
  artifactsPresent: boolean;
}

const AGENTS = 'AGENTS.md';
const FLOW_CONFIG = 'flow.config.json';
const SKILL = join('plugin', 'skills', 'flow-orchestrate', 'SKILL.md');

function isNonEmptyFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function readText(path: string, max = 64_000): string | undefined {
  try {
    return readFileSync(path, { encoding: 'utf8' }).slice(0, max);
  } catch {
    return undefined;
  }
}

/** Resolve raiz do floating-flow: env QODE_DEVFLOW_ROOT, senão ~/Documents/GitHub/dev-flow.
 *  Uso interno apenas — NÃO expor no DTO /api/health.
 */
export function resolveDevflowRoot(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = env.QODE_DEVFLOW_ROOT?.trim();
  if (fromEnv) return fromEnv;
  return join(home, 'Documents', 'GitHub', 'dev-flow');
}

/**
 * Contrato mínimo que justifica observe:
 * - configured: AGENTS.md, flow.config.json e SKILL.md são ficheiros (dirs com esses nomes falham)
 * - artifactsPresent: AGENTS não vazio; SKILL menciona flow-orchestrate; flow.config.json
 *   é JSON object com project ou $schema
 */
export function probeDevflow(root: string): DevflowProbe {
  const agentsPath = join(root, AGENTS);
  const configPath = join(root, FLOW_CONFIG);
  const skillPath = join(root, SKILL);

  const configured =
    isNonEmptyFile(agentsPath) && isNonEmptyFile(configPath) && isNonEmptyFile(skillPath);

  if (!configured) {
    return { configured: false, artifactsPresent: false };
  }

  const agents = readText(agentsPath);
  const skill = readText(skillPath);
  const rawConfig = readText(configPath);

  let configOk = false;
  if (rawConfig) {
    try {
      const parsed: unknown = JSON.parse(rawConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        configOk = 'project' in o || '$schema' in o;
      }
    } catch {
      configOk = false;
    }
  }

  const artifactsPresent =
    !!agents &&
    agents.trim().length > 0 &&
    !!skill &&
    /flow-orchestrate/i.test(skill) &&
    configOk;

  return { configured: true, artifactsPresent };
}

/** @deprecated Prefer probeDevflow; mantido para testes unitários do contrato. */
export function isDevflowReady(root: string): boolean {
  const p = probeDevflow(root);
  return p.configured && p.artifactsPresent;
}

function opaqueNote(configured: boolean, artifactsPresent: boolean): string {
  if (configured && artifactsPresent) {
    return 'coordenador = floating-flow; QODE só observa (sem dispatch run/review)';
  }
  if (configured && !artifactsPresent) {
    return 'marcadores presentes mas artefactos incompletos — observe não comprovado';
  }
  return 'clone não configurado ou ilegível — QODE não despacha';
}

/**
 * Status para /api/health. Sem side-effects de dispatch.
 * Sem paths, sem valor de env, sem root — só estado opaco + evidência booleana.
 */
export function qodeOrchestrateStatus(env: NodeJS.ProcessEnv, home: string): OrchestrateStatus {
  const root = resolveDevflowRoot(env, home);
  const probe = probeDevflow(root);
  const ready = probe.configured && probe.artifactsPresent;
  return {
    coordinator: 'floating-flow',
    role: 'observe-only',
    ready,
    configured: probe.configured,
    artifactsPresent: probe.artifactsPresent,
    note: opaqueNote(probe.configured, probe.artifactsPresent),
  };
}

