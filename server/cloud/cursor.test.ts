import { describe, expect, it } from 'vitest';
import { buildCloudCollectors } from './collectors';
import { loadCloudConfig } from './contract';
import { CursorCollector, type FetchLike } from './cursor';
import { CANARY, cursorDetails, cursorListFixture, cursorListPage2, FIX_NOW } from './fixtures';

const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };

function fakeFetch() {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const u = new URL(url);
    let body: unknown;
    if (u.pathname === '/v1/agents') body = u.searchParams.get('cursor') ? cursorListPage2 : cursorListFixture;
    else body = cursorDetails[u.pathname.split('/').pop()!] ?? {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { f, calls };
}

describe('CursorCollector', () => {
  it('só GET em api.cursor.com, pagina, filtra allowlist e não vaza texto livre', async () => {
    const { f, calls } = fakeFetch();
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    const out = await c.poll(FIX_NOW);
    expect(calls.every((x) => x.method === 'GET' && x.url.startsWith('https://api.cursor.com/v1/agents'))).toBe(true);
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('k:').toString('base64')}`);
    expect(out.map((o) => [o.id, o.state, !!o.link])).toEqual([
      ['bc-00000000-0000-0000-0000-000000000001', 'running', true],
      ['bc-00000000-0000-0000-0000-000000000002', 'idle', false],
    ]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    // detalhe em cache: segundo ciclo não repete GET de detalhe
    const n = calls.length;
    await c.poll(FIX_NOW);
    expect(calls.length - n).toBe(2);
  });
  it('erro HTTP não ecoa corpo', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 401, text: async () => `token ${CANARY}` });
    await expect(new CursorCollector({ apiKey: 'k', cfg, fetch: f }).poll(FIX_NOW)).rejects.toThrow(/^cursor HTTP 401$/);
  });
  it('sem chave não liga; sem interruptor não liga', () => {
    expect(buildCloudCollectors(loadCloudConfig({ HABBLAUD_CLOUD: '1', HABBLAUD_CLOUD_CURSOR: '1' }), {})).toEqual([]);
    expect(buildCloudCollectors(loadCloudConfig({ HABBLAUD_CLOUD: '1' }), { CURSOR_API_KEY: 'k' })).toEqual([]);
    expect(buildCloudCollectors(loadCloudConfig({ HABBLAUD_CLOUD: '1', HABBLAUD_CLOUD_CURSOR: '1' }), { CURSOR_API_KEY: 'k' })).toHaveLength(1);
  });
  it('fora de ordem: item antigo no fim da página 1 não interrompe a paginação', async () => {
    const p1 = { items: [{ id: 'bc-old0000001', status: 'IDLE', updatedAt: '2026-10-01T00:00:00Z' }], nextCursor: 'c2' };
    const p2 = { items: [{ id: 'bc-new0000001', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z', url: 'https://cursor.com/agents/bc-new0000001' }] };
    const f: FetchLike = async (url) => {
      const u = new URL(url);
      const body = u.pathname === '/v1/agents' ? (u.searchParams.get('cursor') ? p2 : p1) : { repos: [{ url: 'https://github.com/Matheusqf/habblaud-qode' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    expect((await c.poll(FIX_NOW)).map((o) => o.id)).toEqual(['bc-new0000001']);
    expect(c.lastPartial).toBe(false);
  });
  it('teto de páginas sinaliza inventário parcial', async () => {
    let n = 0;
    const f: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: [], nextCursor: `c${++n}` }) });
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    await c.poll(FIX_NOW);
    expect(c.lastPartial).toBe(true);
    expect(n).toBe(10);
  });
  it('redirect é recusado e a chave não segue', async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url, init) => (seen.push(`${url} ${init.redirect}`), { ok: false, status: 302, text: async () => '' });
    await expect(new CursorCollector({ apiKey: 'k', cfg, fetch: f }).poll(FIX_NOW)).rejects.toThrow(/redirect/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/ manual$/);
  });
  it('limite de bytes durante a leitura (cancela o stream)', async () => {
    let cancelled = false;
    let reads = 0;
    const chunk = new Uint8Array(200 * 1024);
    const f: FetchLike = async () => ({
      ok: true, status: 200, text: async () => { throw new Error('não devia ler tudo'); },
      body: { getReader: () => ({ read: async () => (reads++ < 100 ? { done: false, value: chunk } : { done: true }), cancel: async () => void (cancelled = true) }) },
    });
    await expect(new CursorCollector({ apiKey: 'k', cfg, fetch: f }).poll(FIX_NOW)).rejects.toThrow(/grande/);
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(5);
  });
  it('cache guarda só o projeto permitido, nunca a URL do repo', async () => {
    const { f } = fakeFetch();
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    await c.poll(FIX_NOW);
    const cache = [...(c as unknown as { projectOf: Map<string, string | null> }).projectOf.values()];
    expect(cache.some((v) => v && /https?:|github\.com/.test(v))).toBe(false);
    expect(cache).toContain(null); // repo fora da allowlist
  });
});
