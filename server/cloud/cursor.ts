// Coletor Cursor Cloud Agents API v1 (fatia 2). Observe-only: SÓ GET em caminhos permitidos de api.cursor.com.
// Polling (webhooks v1 ainda "coming soon"); não usa o stream (contém mensagens/código/ferramentas).
// A chave (CURSOR_API_KEY) fica no servidor; restringir a GET é defesa extra — não torna a chave read-only.
import { sanitize, type CloudConfig, type CloudObservation } from './contract';
import type { CloudCollector } from './source';

export const CURSOR_API = 'https://api.cursor.com';
export const CURSOR_KEY_ENV = 'CURSOR_API_KEY';
const ALLOWED_PATHS = [/^\/v1\/agents$/, /^\/v1\/agents\/bc-[A-Za-z0-9-]{6,64}$/];
const MAX_PAGES = 3;
const PAGE_LIMIT = 50;
const RECENT_MS = 24 * 3_600_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 512 * 1024;

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class CursorCollector implements CloudCollector {
  readonly provider = 'cursor' as const;
  /** id -> projeto (repos de um agente não mudam): evita um GET de detalhe por ciclo. */
  private readonly projectOf = new Map<string, string | null>();

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
    });
    if (!res.ok) throw new Error(`cursor HTTP ${res.status}`); // sem corpo: pode ter dados
    const body = await res.text();
    if (body.length > MAX_BODY) throw new Error('cursor: resposta grande demais');
    return JSON.parse(body);
  }

  async poll(now: number): Promise<CloudObservation[]> {
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: Record<string, string> = { limit: String(PAGE_LIMIT), includeArchived: 'false' };
      if (cursor) q.cursor = cursor;
      const r = (await this.get('/v1/agents', q)) as { items?: unknown; nextCursor?: unknown };
      if (!Array.isArray(r?.items)) throw new Error('cursor: formato inesperado');
      for (const it of r.items) if (it && typeof it === 'object') items.push(it as Record<string, unknown>);
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
      // Lista vem da mais nova para a mais antiga: parar quando a página já é toda antiga.
      const last = items[items.length - 1];
      if (last && now - Date.parse(String(last.updatedAt)) > RECENT_MS) break;
    }
    const out: CloudObservation[] = [];
    for (const it of items) {
      const id = typeof it.id === 'string' ? it.id : undefined;
      if (!id) continue;
      const status = typeof it.status === 'string' ? it.status : '';
      const updated = Date.parse(String(it.updatedAt));
      if (status !== 'ACTIVE' && !(now - updated <= RECENT_MS)) continue;
      const project = await this.project(id);
      if (!project) continue;
      const o = sanitize('cursor', { id, project, nativeState: status, updatedAt: it.updatedAt, link: it.url }, this.deps.cfg, now);
      if (o) out.push(o);
    }
    return out;
  }

  private async project(id: string): Promise<string | undefined> {
    if (this.projectOf.has(id)) return this.projectOf.get(id) ?? undefined;
    if (!/^bc-[A-Za-z0-9-]{6,64}$/.test(id)) return undefined;
    const d = (await this.get(`/v1/agents/${id}`)) as { repos?: Array<{ url?: unknown }> };
    const url = Array.isArray(d?.repos) && typeof d.repos[0]?.url === 'string' ? d.repos[0].url : null;
    this.projectOf.set(id, url);
    if (this.projectOf.size > 500) this.projectOf.delete(this.projectOf.keys().next().value!);
    return url ?? undefined;
  }
}
