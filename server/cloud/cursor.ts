// Coletor Cursor Cloud Agents API v1 (fatia 2). Observe-only: SÓ GET em caminhos permitidos de api.cursor.com.
// Polling (webhooks v1 ainda "coming soon"); não usa o stream (contém mensagens/código/ferramentas).
// A chave (CURSOR_API_KEY) fica no servidor; restringir a GET é defesa extra — não torna a chave read-only.
import { normalizeProject, sanitize, type CloudConfig, type CloudObservation } from './contract';
import type { CloudCollector } from './source';

export const CURSOR_API = 'https://api.cursor.com';
export const CURSOR_KEY_ENV = 'CURSOR_API_KEY';
const ALLOWED_PATHS = [/^\/v1\/agents$/, /^\/v1\/agents\/bc-[A-Za-z0-9-]{6,64}$/, /^\/v1\/agents\/bc-[A-Za-z0-9-]{6,64}\/runs\/run-[A-Za-z0-9-]{1,64}$/];
const MAX_PAGES = 10;
const DETAIL_CONCURRENCY = 4;
const PAGE_LIMIT = 50;
const RECENT_MS = 24 * 3_600_000;
// Medido no :4320 (16/10): pedidos reais à API até ~27 s até aos headers → poll_failed=TimeoutError com 10 s/30 s. 60 s por pedido.
const TIMEOUT_MS = 60_000;
const MAX_BODY = 512 * 1024;
const ID_RE = /^bc-[A-Za-z0-9-]{6,64}$/;
const PROJECT_CACHE_MAX = 2 * MAX_PAGES * PAGE_LIMIT;
const RUN_STATES = new Set(['CREATING', 'RUNNING', 'FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);
/** Estado nativo + horário nativo + instante local de confirmação, guardados separados. */
interface Native {
  state: unknown;
  updatedAt: unknown;
  confirmedAt: number;
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal; redirect: 'manual' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}>;

/** Lê o corpo contando bytes DURANTE a leitura; acima do teto cancela (não carrega tudo para depois medir). */
async function readCapped(res: Awaited<ReturnType<FetchLike>>, max: number): Promise<string> {
  if (!res.body?.getReader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new Error('cursor: resposta grande demais');
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('cursor: resposta grande demais');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class CursorCollector implements CloudCollector {
  readonly provider = 'cursor' as const;
  /**
   * id -> projeto JÁ normalizado e permitido, ou null (fora da allowlist / sem repo). Nunca guarda a URL do repo.
   */
  private readonly projectOf = new Map<string, string | null>();
  /** Última consulta bateu no teto de páginas: inventário parcial (ausência ≠ encerramento). */
  lastPartial = false;
  /** Ids listados mas fora da janela (IDLE > 24 h): filtro visual, não término (ver CloudSource). */
  lastWindowExcluded: ReadonlySet<string> = new Set();

  constructor(
    private readonly deps: { apiKey: string; cfg: Pick<CloudConfig, 'projects' | 'ttlMs'>; fetch?: FetchLike; clock?: () => number },
  ) {
    if (!deps.apiKey) throw new Error(`${CURSOR_KEY_ENV} ausente`);
  }

  /** Único ponto de rede: GET, host fixo, caminho na allowlist, timeout, corpo limitado. */
  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!ALLOWED_PATHS.some((re) => re.test(path))) throw new Error('caminho não permitido');
    const url = new URL(path, CURSOR_API);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const f = this.deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${this.deps.apiKey}:`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual', // nunca seguir redirects (a chave iria para outro destino)
    });
    if (res.status >= 300 && res.status < 400) throw new Error('cursor: redirect recusado');
    if (!res.ok) throw new Error(`cursor HTTP ${res.status}`); // sem corpo: pode ter dados
    return JSON.parse(await readCapped(res, MAX_BODY));
  }

  async poll(now: number): Promise<CloudObservation[]> {
    // Instante LOCAL de cada confirmação, na escala de `now` (início do poll) + tempo decorrido: cada item é carimbado
    // quando a resposta DELE chega (página da listagem ou GET do run), nunca no fim do lote (CloudSource).
    const clock = this.deps.clock ?? Date.now;
    const t0 = clock();
    const at = () => now + Math.max(0, clock() - t0);
    const items: Array<{ it: Record<string, unknown>; seenAt: number }> = [];
    let cursor: string | undefined;
    let page = 0;
    // Pagina até ao fim (sem parar por item antigo: a ordem pode não ser estrita). Teto => inventário parcial.
    do {
      const q: Record<string, string> = { limit: String(PAGE_LIMIT), includeArchived: 'false' };
      if (cursor) q.cursor = cursor;
      const r = (await this.get('/v1/agents', q)) as { items?: unknown; nextCursor?: unknown };
      const seenAt = at();
      if (!Array.isArray(r?.items)) throw new Error('cursor: formato inesperado');
      for (const it of r.items) if (it && typeof it === 'object') items.push({ it: it as Record<string, unknown>, seenAt });
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      page++;
    } while (cursor && page < MAX_PAGES);
    this.lastPartial = !!cursor;
    const excluded = new Set<string>();
    const old: string[] = [];
    const candidates = items.filter(({ it }) => {
      if (typeof it.id !== 'string') return false;
      const updated = Date.parse(String(it.updatedAt));
      const keep = it.status === 'ACTIVE' || now - updated <= RECENT_MS;
      if (!keep && ID_RE.test(it.id)) old.push(it.id);
      return keep;
    });
    // Exclusão por janela: projeto/multirepo REVALIDADO agora (cache ou GET de detalhe), nunca dependente de o id
    // ainda estar no cache (pode ter sido expulso). Allowlist ANTES de reter: id inválido ou fora da allowlist nunca
    // entra no Set. Se não der para autorizar (detalhe falhou), a incerteza NÃO vira ausência: inventário parcial.
    for (let i = 0; i < old.length; i += DETAIL_CONCURRENCY) {
      const batch = old.slice(i, i + DETAIL_CONCURRENCY);
      const res = await Promise.all(batch.map((id) => this.project(id).then((p) => ({ ok: true as const, p }), () => ({ ok: false as const, p: undefined }))));
      res.forEach((r, k) => {
        if (!r.ok) this.lastPartial = true;
        else if (r.p) excluded.add(batch[k]!);
      });
    }
    this.lastWindowExcluded = excluded;
    const out: CloudObservation[] = [];
    for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
      const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
      const projects = await Promise.all(batch.map(({ it }) => this.project(it.id as string)));
      // ACTIVE (agente) não é execução: o estado e o horário vêm do RUN mais recente (GET do run; só status/updatedAt).
      const native = await Promise.all(
        batch.map(({ it, seenAt }, k): Promise<Native> =>
          projects[k] && it.status === 'ACTIVE' ? this.runState(it, at) : Promise.resolve({ state: it.status, updatedAt: it.updatedAt, confirmedAt: seenAt }),
        ),
      );
      batch.forEach(({ it }, k) => {
        const project = projects[k];
        if (!project) return;
        const n = native[k];
        const o = sanitize('cursor', { id: it.id, project, nativeState: n.state, updatedAt: n.updatedAt, link: it.url }, this.deps.cfg, n.confirmedAt);
        if (o) out.push(o);
      });
    }
    return out;
  }

  /**
   * Estado do RUN preservado (prefixo RUN_: RUN_RUNNING, RUN_CREATING, RUN_FINISHED, RUN_ERROR, RUN_CANCELLED,
   * RUN_EXPIRED — run terminal ≠ fim do agente ≠ sucesso, ver normalizeState), com o horário NATIVO do run
   * (run.updatedAt; nunca o do agente) e o instante local da confirmação. Sem run → ACTIVE (unknown) com o horário
   * do agente (é o estado do agente que se reporta).
   */
  private async runState(it: Record<string, unknown>, at: () => number): Promise<Native> {
    const run = typeof it.latestRunId === 'string' && /^run-[A-Za-z0-9-]{1,64}$/.test(it.latestRunId) ? it.latestRunId : undefined;
    if (!run) return { state: 'ACTIVE', updatedAt: it.updatedAt, confirmedAt: at() };
    const r = (await this.get(`/v1/agents/${it.id as string}/runs/${run}`)) as { status?: unknown; updatedAt?: unknown };
    const confirmedAt = at();
    const st = typeof r?.status === 'string' ? r.status.toUpperCase() : '';
    const state = RUN_STATES.has(st) ? `RUN_${st}` : 'RUN_UNKNOWN';
    // Sem horário do run → sanitize marca unknown (não cai para o updatedAt do agente).
    return { state, updatedAt: typeof r?.updatedAt === 'string' || typeof r?.updatedAt === 'number' ? r.updatedAt : undefined, confirmedAt };
  }

  private async project(id: string): Promise<string | undefined> {
    if (this.projectOf.has(id)) return this.projectOf.get(id) ?? undefined;
    if (!ID_RE.test(id)) return undefined;
    const d = (await this.get(`/v1/agents/${id}`)) as { repos?: Array<{ url?: unknown }> };
    // Multirepo: verifica TODOS os repos; o agente só passa se TODOS estiverem na allowlist (um repo privado fora
    // dela basta para o esconder). Projeto mostrado = o primeiro. Allowlist ANTES do cache; nunca guarda URLs.
    const repos = Array.isArray(d?.repos) ? d.repos : [];
    const ps = repos.map((r) => normalizeProject(typeof r?.url === 'string' ? r.url : undefined));
    const allowed = ps.length > 0 && ps.every((p) => !!p && this.deps.cfg.projects.has(p)) ? ps[0]! : null;
    this.projectOf.set(id, allowed);
    // Teto acima do inventário máximo de um poll (MAX_PAGES × PAGE_LIMIT): uma página cheia não expulsa o resto.
    if (this.projectOf.size > PROJECT_CACHE_MAX) this.projectOf.delete(this.projectOf.keys().next().value!);
    return allowed ?? undefined;
  }
}
