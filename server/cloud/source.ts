// Fonte "cloud" do Office: junta coletores observe-only (Cursor, Codex cloud) e põe os agentes nas salas.
// Desligada por padrão (HABBLAUD_CLOUD). Nunca despacha, responde ou opera nada nos provedores.
import type { SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import type { MainInput } from '../model/office';
import { effectiveState, type CloudObservation, type CloudProvider } from './contract';

/** Um coletor: devolve observações JÁ sanitizadas (contract.sanitize). */
export interface CloudCollector {
  readonly provider: CloudProvider;
  poll(now: number): Promise<CloudObservation[]>;
}

/** O pedaço do Office que a fonte usa (facilita testes). */
export interface CloudOffice {
  addMain(p: MainInput): void;
  setStatus(id: string, status: 'working' | 'idle'): void;
  closeMain(id: string): void;
  has(id: string): boolean;
}

export const POLL_MS = 30_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const MAX_AGENTS = 20;

const LABEL: Record<CloudProvider, string> = { cursor: 'Cursor Cloud', 'codex-cloud': 'Codex Cloud', 'claude-web': 'Claude web' };

export function officeId(o: Pick<CloudObservation, 'provider' | 'id'>): string {
  return `cloud:${o.provider}:${o.id}`;
}
export function cloudCwd(o: Pick<CloudObservation, 'provider' | 'project'>): string {
  return `/cloud/${o.provider}/${o.project}`;
}

interface CollectorState {
  c: CloudCollector;
  failures: number;
  nextAt: number;
  lastOk?: number;
  error?: string;
  seen: Map<string, CloudObservation>;
}

export class CloudSource {
  readonly provider = 'claude' as const; // AgentSource exige um Provider; cloud não tem transcript nem terminal.
  private readonly states: CollectorState[];
  private timer?: NodeJS.Timeout;
  private readonly present = new Set<string>();

  constructor(
    private readonly deps: { office: CloudOffice; collectors: readonly CloudCollector[]; now?: () => number; pollMs?: number },
  ) {
    this.states = deps.collectors.map((c) => ({ c, failures: 0, nextAt: 0, seen: new Map() }));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (!this.states.length) return;
    const tick = () => void this.tick().catch((err) => log.warn(`Cloud: tick falhou (${errMsg(err)}).`));
    tick();
    this.timer = setInterval(tick, this.deps.pollMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  sources(): SourceInfo[] {
    return this.states.map((s) => ({
      label: `cloud-${s.c.provider}`,
      path: `cloud:${s.c.provider}`,
      sessions: [...s.seen.values()].filter((o) => this.present.has(officeId(o))).length,
      ok: !s.error,
      ...(s.error ? { error: s.error } : {}),
    }));
  }

  transcriptPathOf(): undefined {
    return undefined;
  }

  /** Um ciclo: consulta os coletores vencidos (com backoff exponencial) e reconcilia o Office. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const s of this.states) {
      if (now < s.nextAt) continue;
      try {
        const list = await s.c.poll(now);
        s.seen = new Map(list.slice(0, MAX_AGENTS).map((o) => [o.id, o]));
        s.failures = 0;
        s.lastOk = now;
        delete s.error;
        s.nextAt = now + (this.deps.pollMs ?? POLL_MS);
      } catch (err) {
        s.failures++;
        // Mensagem genérica: nunca ecoar corpo/headers de resposta (podem conter dados ou tokens).
        s.error = `coletor indisponível (${s.failures}x)`;
        s.nextAt = now + Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(s.failures, 6));
        log.warnOnce(`cloud:${s.c.provider}:${s.failures > 1}`, `Cloud ${s.c.provider}: ${s.error}; ${errMsg(err).slice(0, 80)}`);
      }
    }
    this.reconcile(now);
  }

  private reconcile(now: number): void {
    const want = new Map<string, CloudObservation>();
    for (const s of this.states) for (const o of s.seen.values()) {
      const st = effectiveState(o, now);
      if (st === 'ended') continue;
      want.set(officeId(o), o);
    }
    const office = this.deps.office;
    for (const id of [...this.present]) {
      if (!want.has(id)) {
        office.closeMain(id);
        this.present.delete(id);
      }
    }
    for (const [id, o] of want) {
      const status = effectiveState(o, now) === 'running' ? 'working' : 'idle';
      if (!this.present.has(id) || !office.has(id)) {
        office.addMain({
          id,
          account: `cloud-${o.provider}`,
          sessionId: id,
          cwd: cloudCwd(o),
          role: LABEL[o.provider],
          startedAt: o.updatedAt,
          status,
        });
        this.present.add(id);
      } else office.setStatus(id, status);
    }
  }

  /** Para a UI/health: só os campos do contrato (sem nada do provedor além disso). */
  observations(): CloudObservation[] {
    return this.states.flatMap((s) => [...s.seen.values()]);
  }
}
