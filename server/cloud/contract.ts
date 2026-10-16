// Contrato de observação de agentes cloud (QODE Office, plano ZikaBOT fatia 1). Observe-only.
//
// Regras (docs/QODE-CLOUD-OBSERVE.md):
// - Allowlist de projetos ANTES de guardar/logar/renderizar: observação de projeto fora da lista é descartada inteira.
// - Só guardamos: provedor, id nativo, projeto autorizado, estado nativo + estado normalizado, hora da última
//   atualização, validade e um link validado (https em host conhecido do provedor). Sem prompts, títulos, resumos,
//   transcripts, branches ou qualquer texto livre.
// - Estados distinguem "em execução", "atualização antiga" (stale) e "desconhecido"; IDLE/terminado NÃO é sucesso.
// - Tokens ficam no coletor (servidor); nada disto vai para o browser além do que está em CloudObservation.
import { isTruthy } from '../config';

export type CloudProvider = 'cursor' | 'codex-cloud' | 'claude-web';

/** Estado normalizado (o que dirige o personagem). */
export type CloudState = 'running' | 'idle' | 'ended' | 'stale' | 'unknown';

/** O único formato que sai de um coletor. Nada além destes campos. */
export interface CloudObservation {
  provider: CloudProvider;
  /** Id nativo do provedor (validado por regex). */
  id: string;
  /** Projeto autorizado pela allowlist ("dono/repo" ou rótulo exato). */
  project: string;
  /** Estado nativo, já reduzido a [A-Z_]{1,32}. */
  nativeState: string;
  state: CloudState;
  /** Última atualização reportada pelo provedor (epoch ms). */
  updatedAt: number;
  /** Até quando esta observação vale (epoch ms); depois vira 'stale'. */
  expiresAt: number;
  /** Link validado para abrir o agente no provedor, ou ausente. */
  link?: string;
}

/** Entrada crua (já parseada) de um coletor, antes da sanitização. */
export interface RawCloudItem {
  id: unknown;
  project: unknown;
  nativeState: unknown;
  updatedAt: unknown;
  link?: unknown;
}

export interface CloudConfig {
  /** HABBLAUD_CLOUD=1 liga a observação cloud. Desligado por padrão. */
  enabled: boolean;
  /** HABBLAUD_CLOUD_PROJECTS: "dono/repo,dono/outro" (minúsculas). Vazio = nada passa. */
  projects: ReadonlySet<string>;
  /** HABBLAUD_CLOUD_TTL_MS: validade de uma observação (padrão 3 min). */
  ttlMs: number;
  /** HABBLAUD_CLOUD_CURSOR=1: coletor Cursor (precisa de CURSOR_API_KEY). */
  cursor: boolean;
  /** HABBLAUD_CLOUD_CODEX=1: ponte `codex cloud list --json`. */
  codex: boolean;
}

export const DEFAULT_TTL_MS = 180_000;

export function loadCloudConfig(env: NodeJS.ProcessEnv): CloudConfig {
  const projects = new Set(
    (env.HABBLAUD_CLOUD_PROJECTS ?? '')
      .split(',')
      .map((s) => normalizeProject(s))
      .filter((s): s is string => !!s),
  );
  const ttl = Number(env.HABBLAUD_CLOUD_TTL_MS);
  const enabled = isTruthy(env.HABBLAUD_CLOUD);
  return {
    enabled,
    projects,
    ttlMs: Number.isFinite(ttl) && ttl >= 10_000 && ttl <= 3_600_000 ? ttl : DEFAULT_TTL_MS,
    cursor: enabled && isTruthy(env.HABBLAUD_CLOUD_CURSOR),
    codex: enabled && isTruthy(env.HABBLAUD_CLOUD_CODEX),
  };
}

const ID_RE: Record<CloudProvider, RegExp> = {
  cursor: /^bc-[a-z0-9-]{6,64}$/i,
  'codex-cloud': /^task_[a-z0-9_-]{4,80}$/i,
  'claude-web': /^[a-z0-9_-]{6,80}$/i,
};

const LINK_HOSTS: Record<CloudProvider, readonly string[]> = {
  cursor: ['cursor.com', 'www.cursor.com'],
  'codex-cloud': ['chatgpt.com'],
  'claude-web': ['claude.ai'],
};

/** "https://github.com/Dono/Repo.git" | "github.com/dono/repo" | "dono/repo" | rótulo -> forma canônica minúscula. */
export function normalizeProject(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim().toLowerCase();
  if (!s || s.length > 200) return undefined;
  s = s.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/.test(s) ? s : undefined;
}

/** Estado nativo -> normalizado. Desconhecido nunca vira sucesso nem "trabalhando". */
export function normalizeState(provider: CloudProvider, native: string): CloudState {
  const n = native.toUpperCase();
  if (provider === 'cursor') {
    if (n === 'ACTIVE' || n === 'RUNNING' || n === 'CREATING') return 'running';
    if (n === 'IDLE') return 'idle';
    if (n === 'ARCHIVED' || n === 'FINISHED' || n === 'ERROR' || n === 'CANCELLED' || n === 'EXPIRED') return 'ended';
    return 'unknown';
  }
  if (provider === 'codex-cloud') {
    if (n === 'PENDING' || n === 'RUNNING' || n === 'IN_PROGRESS' || n === 'QUEUED') return 'running';
    if (n === 'READY' || n === 'COMPLETED' || n === 'APPLIED' || n === 'ERROR' || n === 'FAILED' || n === 'CANCELLED')
      return 'ended';
    return 'unknown';
  }
  return 'unknown';
}

function validLink(provider: CloudProvider, v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 300) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
    if (!LINK_HOSTS[provider].includes(u.hostname)) return undefined;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * Sanitiza um item cru. Devolve undefined (descarta) se o projeto não está na allowlist ou o id é inválido.
 * Só os campos de CloudObservation sobrevivem — o resto do item cru é ignorado por construção.
 */
export function sanitize(provider: CloudProvider, raw: RawCloudItem, cfg: Pick<CloudConfig, 'projects' | 'ttlMs'>, now: number): CloudObservation | undefined {
  const project = normalizeProject(raw.project);
  if (!project || !cfg.projects.has(project)) return undefined;
  if (typeof raw.id !== 'string' || !ID_RE[provider].test(raw.id)) return undefined;
  const nativeState = typeof raw.nativeState === 'string' ? raw.nativeState.toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 32) : '';
  const updatedAt = toMs(raw.updatedAt);
  let state: CloudState = nativeState ? normalizeState(provider, nativeState) : 'unknown';
  if (updatedAt === undefined) state = 'unknown';
  else if (state === 'running' && now - updatedAt > cfg.ttlMs * 10) state = 'stale';
  const obs: CloudObservation = {
    provider,
    id: raw.id,
    project,
    nativeState: nativeState || 'UNKNOWN',
    state,
    updatedAt: updatedAt ?? now,
    expiresAt: now + cfg.ttlMs,
  };
  const link = validLink(provider, raw.link);
  if (link) obs.link = link;
  return obs;
}

/** Observação vencida (coletor parou de confirmar) vira 'stale' — nunca continua "trabalhando" para sempre. */
export function effectiveState(o: CloudObservation, now: number): CloudState {
  return now > o.expiresAt && o.state === 'running' ? 'stale' : o.state;
}
