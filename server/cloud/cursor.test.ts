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
});
