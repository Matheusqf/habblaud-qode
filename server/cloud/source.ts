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
  /** true = a última consulta foi parcial (teto de páginas/limite): ausência NÃO significa encerramento. */
  readonly lastPartial?: boolean;
  /**
   * Ids nativos que vieram na listagem mas foram excluídos por JANELA (ex. IDLE > 24 h): filtro visual, não término.
   * Não contam como ausência num inventário completo.
   */
  readonly lastWindowExcluded?: ReadonlySet<string>;
}

/** O pedaço do Office que a fonte usa (facilita testes). */
export interface CloudOffice {
  addMain(p: MainInput): void;
  /** Só observacional: nunca sintetiza "Concluiu"/aviso de sucesso (Office.setObservedStatus). */
  setObservedStatus(id: string, status: 'working' | 'idle'): void;
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
  /** A última consulta bem-sucedida foi um inventário completo. */
  complete: boolean;
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
    this.states = deps.collectors.map((c) => ({ c, failures: 0, nextAt: 0, seen: new Map(), complete: false }));
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
      // Inventário maior que a sala (teto visual) ou parcial: sinalizado sem expor ids.
      ...(s.seen.size > MAX_AGENTS || !s.complete ? { path: `cloud:${s.c.provider} (vistos ${s.seen.size}${s.complete ? '' : ', parcial'}; sala até ${MAX_AGENTS})` } : {}),
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
        // Relógio PÓS-await só para agendamento/backoff (nextAt). O TTL é POR CONFIRMAÇÃO: cada item vale a partir do
        // instante em que ele próprio foi confirmado (confirmedAt, carimbado pelo coletor), nunca renovado pelo fim
        // do lote. Só limita carimbos no futuro (relógio do coletor adiantado) ao fim do poll.
        const done = this.now();
        for (const o of list) {
          if (!(o.confirmedAt <= done)) {
            const ttl = Math.max(0, o.expiresAt - o.confirmedAt);
            o.confirmedAt = done;
            o.expiresAt = done + ttl;
          }
        }
        // Inventário completo SEM corte (o teto MAX_AGENTS é só visual, aplicado no reconcile).
        const next = new Map(list.map((o) => [o.id, o]));
        s.complete = !s.c.lastPartial;
        // Parcial: quem não veio continua com a observação anterior (vence pelo TTL → stale), nunca fecha.
        if (!s.complete) for (const [id, o] of s.seen) if (!next.has(id)) next.set(id, o);
        // Excluído por janela: mantém a última observação (envelhece para stale), nunca fecha por isso.
        const win = s.c.lastWindowExcluded;
        if (win) for (const id of win) if (!next.has(id) && s.seen.has(id)) next.set(id, s.seen.get(id)!);
        s.seen = next;
        s.failures = 0;
        s.lastOk = now;
        delete s.error;
        s.nextAt = done + (this.deps.pollMs ?? POLL_MS);
      } catch {
        s.failures++;
        // Mensagem genérica: nunca ecoar corpo/headers de resposta (podem conter dados ou tokens).
        s.error = `coletor indisponível (${s.failures}x)`;
        s.nextAt = this.now() + Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(s.failures, 6));
        // Só provedor + categoria controlada: nunca o texto do erro (pode trazer corpo, headers ou tokens).
        log.warnOnce(`cloud:${s.c.provider}:${s.failures > 1}`, `Cloud ${s.c.provider}: coletor indisponível (categoria=poll_failed, falhas=${s.failures}).`);
      } finally {
        this.busy.delete(s);
      }
    }
    this.reconcile(this.now());
  }

  private reconcile(now: number): void {
    const want = new Map<string, CloudObservation>();
    const ended = new Set<string>();
    /** Ids cujo coletor fez um inventário COMPLETO (só aí a ausência fecha). */
    const authoritative = new Set<CloudProvider>();
    for (const s of this.states) {
      if (s.complete) authoritative.add(s.c.provider);
      for (const o of s.seen.values()) {
        if (effectiveState(o, now) === 'ended') ended.add(officeId(o));
        else want.set(officeId(o), o);
      }
    }
    const office = this.deps.office;
    for (const id of [...this.present]) {
      const provider = id.split(':')[1] as CloudProvider;
      // Fecha só: estado terminal observado, ou ausência num inventário completo desse provedor.
      if (ended.has(id) || (!want.has(id) && authoritative.has(provider))) {
        office.closeMain(id);
        this.present.delete(id);
      }
    }
    // Teto visual: quem já está na sala fica (sem piscar); vagas livres vão para os mais recentes (ordem estável,
    // independente da ordem da resposta).
    const ordered = [...want].sort(([a, x], [b, y]) => y.updatedAt - x.updatedAt || (a < b ? -1 : a > b ? 1 : 0));
    let slots = MAX_AGENTS - [...this.present].filter((id) => want.has(id)).length;
    for (const [id] of ordered) {
      if (this.present.has(id)) continue;
      if (slots > 0) slots--;
      else want.delete(id);
    }
    for (const id of [...want.keys()]) if (!this.present.has(id) && !ordered.some(([x]) => x === id)) want.delete(id);
    for (const [id, o] of want) {
      const st = effectiveState(o, now) as 'running' | 'idle' | 'stale' | 'unknown';
      // O personagem só "trabalha" com running; stale/unknown ficam parados MAS o estado real vai para a UI (cloud.state).
      // Mudança só OBSERVACIONAL: perder RUNNING (stale/unknown/IDLE/CREATING) nunca vira "Concluiu" nem aviso success.
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
      } else office.setObservedStatus(id, status);
      office.setCloudMeta?.(id, { provider: o.provider, state: st, nativeState: o.nativeState, updatedAt: o.updatedAt, ...(o.link ? { link: o.link } : {}) }, `${LABEL[o.provider]} · ${STATE_LABEL[st]}`);
    }
  }

  /** Para a UI/health: só os campos do contrato (sem nada do provedor além disso). */
  observations(): CloudObservation[] {
    return this.states.flatMap((s) => [...s.seen.values()]);
  }
}
