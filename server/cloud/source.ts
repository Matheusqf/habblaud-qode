// Fonte "cloud" do Office: junta coletores observe-only (Cursor, Codex cloud) e põe os agentes nas salas.
// Desligada por padrão (HABBLAUD_CLOUD). Nunca despacha, responde ou opera nada nos provedores.
import type { AgentInfo, SourceInfo } from '../../shared/types';
import { log } from '../log';
import type { MainInput } from '../model/office';
import { effectiveState, type CloudObservation, type CloudProvider } from './contract';

/** Um coletor: devolve observações JÁ sanitizadas (contract.sanitize). */
export interface CloudCollector {
  readonly provider: CloudProvider;
  poll(now: number): Promise<CloudObservation[]>;
  /** true = a última consulta foi parcial (teto de páginas): ausência não significa encerramento. */
  readonly lastPartial?: boolean;
}

/** O pedaço do Office que a fonte usa (facilita testes). */
export interface CloudOffice {
  addMain(p: MainInput): void;
  setStatus(id: string, status: 'working' | 'idle'): void;
  closeMain(id: string): void;
  has(id: string): boolean;
  setCloudMeta?(id: string, meta: NonNullable<AgentInfo['cloud']>, role: string): void;
}

const STATE_LABEL: Record<string, string> = { running: 'em execução', idle: 'parado (IDLE ≠ sucesso)', stale: 'sem confirmação recente', unknown: 'estado desconhecido' };

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
  /** Coletor com poll em curso: um tick novo não o chama de novo (sem polls sobrepostos). */
  private readonly busy = new Set<CollectorState>();

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
    const tick = () => void this.tick().catch(() => log.warn('Cloud: tick falhou (categoria=tick_failed).'));
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
      if (now < s.nextAt || this.busy.has(s)) continue;
      // Reserva ANTES do await: ticks concorrentes (setInterval + coletor lento) não sobrepõem polls.
      this.busy.add(s);
      try {
        const list = await s.c.poll(now);
        const next = new Map(list.map((o) => [o.id, o]));
        // Inventário parcial: quem não veio nesta página continua com a observação anterior (vence pelo TTL → stale).
        if (s.c.lastPartial) for (const [id, o] of s.seen) if (!next.has(id)) next.set(id, o);
        s.seen = new Map([...next].slice(0, MAX_AGENTS));
        s.failures = 0;
        s.lastOk = now;
        delete s.error;
        s.nextAt = now + (this.deps.pollMs ?? POLL_MS);
      } catch {
        s.failures++;
        // Mensagem genérica: nunca ecoar corpo/headers de resposta (podem conter dados ou tokens).
        s.error = `coletor indisponível (${s.failures}x)`;
        s.nextAt = now + Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(s.failures, 6));
        // Só provedor + categoria controlada: nunca o texto do erro (pode trazer corpo, headers ou tokens).
        log.warnOnce(`cloud:${s.c.provider}:${s.failures > 1}`, `Cloud ${s.c.provider}: coletor indisponível (categoria=poll_failed, falhas=${s.failures}).`);
      } finally {
        this.busy.delete(s);
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
      const st = effectiveState(o, now) as 'running' | 'idle' | 'stale' | 'unknown';
      // O personagem só "trabalha" com running; stale/unknown ficam parados MAS o estado real vai para a UI (cloud.state).
      const status = st === 'running' ? 'working' : 'idle';
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
      office.setCloudMeta?.(id, { provider: o.provider, state: st, nativeState: o.nativeState, updatedAt: o.updatedAt, ...(o.link ? { link: o.link } : {}) }, `${LABEL[o.provider]} · ${STATE_LABEL[st]}`);
    }
  }

  /** Para a UI/health: só os campos do contrato (sem nada do provedor além disso). */
  observations(): CloudObservation[] {
    return this.states.flatMap((s) => [...s.seen.values()]);
  }
}
