// Coletor Cursor Cloud Agents API v1 (fatia 2). Observe-only: SÓ GET em caminhos permitidos de api.cursor.com.
// Polling (webhooks v1 ainda "coming soon"); não usa o stream (contém mensagens/código/ferramentas).
// A chave (CURSOR_API_KEY) fica no servidor; restringir a GET é defesa extra — não torna a chave read-only.
import { normalizeProject, sanitize, type CloudConfig, type CloudObservation } from './contract';
import type { CloudCollector } from './source';

export const CURSOR_API = 'https://api.cursor.com';
export const CURSOR_KEY_ENV = 'CURSOR_API_KEY';
const ALLOWED_PATHS = [/^\/v1\/agents$/, /^\/v1\/agents\/bc-[A-Za-z0-9-]{6,64}$/];
const MAX_PAGES = 10;
const DETAIL_CONCURRENCY = 4;
const PAGE_LIMIT = 50;
const RECENT_MS = 24 * 3_600_000;
// A API real chega a demorar >10 s numa página (poll_failed=TimeoutError no :4320); 30 s por pedido.
const TIMEOUT_MS = 30_000;
const MAX_BODY = 512 * 1024;

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

  constructor(
    private readonly deps: { apiKey: string; cfg: Pick<CloudConfig, 'projects' | 'ttlMs'>; fetch?: FetchLike },
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
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let page = 0;
    // Pagina até ao fim (sem parar por item antigo: a ordem pode não ser estrita). Teto => inventário parcial.
    do {
      const q: Record<string, string> = { limit: String(PAGE_LIMIT), includeArchived: 'false' };
      if (cursor) q.cursor = cursor;
      const r = (await this.get('/v1/agents', q)) as { items?: unknown; nextCursor?: unknown };
      if (!Array.isArray(r?.items)) throw new Error('cursor: formato inesperado');
      for (const it of r.items) if (it && typeof it === 'object') items.push(it as Record<string, unknown>);
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      page++;
    } while (cursor && page < MAX_PAGES);
    this.lastPartial = !!cursor;
    const candidates = items.filter((it) => {
      if (typeof it.id !== 'string') return false;
      const updated = Date.parse(String(it.updatedAt));
      return it.status === 'ACTIVE' || now - updated <= RECENT_MS;
    });
    const out: CloudObservation[] = [];
    for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
      const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
      const projects = await Promise.all(batch.map((it) => this.project(it.id as string)));
      batch.forEach((it, k) => {
        const project = projects[k];
        if (!project) return;
        const o = sanitize('cursor', { id: it.id, project, nativeState: it.status, updatedAt: it.updatedAt, link: it.url }, this.deps.cfg, now);
        if (o) out.push(o);
      });
    }
    return out;
  }

  private async project(id: string): Promise<string | undefined> {
    if (this.projectOf.has(id)) return this.projectOf.get(id) ?? undefined;
    if (!/^bc-[A-Za-z0-9-]{6,64}$/.test(id)) return undefined;
    const d = (await this.get(`/v1/agents/${id}`)) as { repos?: Array<{ url?: unknown }> };
    const raw = Array.isArray(d?.repos) && typeof d.repos[0]?.url === 'string' ? d.repos[0].url : undefined;
    // Allowlist ANTES do cache: só o projeto canónico permitido é guardado; o resto vira null.
    const p = normalizeProject(raw);
    const allowed = p && this.deps.cfg.projects.has(p) ? p : null;
    this.projectOf.set(id, allowed);
    if (this.projectOf.size > 500) this.projectOf.delete(this.projectOf.keys().next().value!);
    return allowed ?? undefined;
  }
}
