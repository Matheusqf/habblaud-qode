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
      ['bc-00000000-0000-0000-0000-000000000001', 'unknown', true],
      ['bc-00000000-0000-0000-0000-000000000002', 'idle', false],
    ]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    // detalhe em cache: segundo ciclo não repete GET de detalhe
    const n = calls.length;
    await c.poll(FIX_NOW);
    expect(calls.length - n).toBe(3); // 2 páginas + 1 GET de run (ACTIVE); detalhes em cache
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
  it('ACTIVE só é execução se o run estiver RUNNING; horário = o do RUN (nunca o do agente)', async () => {
    const list = { items: [
      { id: 'bc-act0000001', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z', latestRunId: 'run-r1' },
      { id: 'bc-act0000002', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z', latestRunId: 'run-r2' },
      { id: 'bc-act0000003', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z' },
      { id: 'bc-act0000004', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z', latestRunId: 'run-r4' },
    ] };
    const runs: Record<string, unknown> = {
      'run-r1': { status: 'RUNNING', updatedAt: '2026-10-16T12:58:30Z', result: CANARY },
      'run-r2': { status: 'CREATING', updatedAt: '2026-10-16T12:58:00Z' },
      'run-r4': { status: 'RUNNING' }, // sem horário do run: unknown, não herda o do agente
    };
    const f: FetchLike = async (url, init) => {
      expect(init.method).toBe('GET');
      const p = new URL(url).pathname.split('/');
      const body = p.length === 3 ? list : p[4] === 'runs' ? runs[p[5]] : { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    const out = await c.poll(FIX_NOW);
    expect(out.map((o) => [o.id, o.state, o.nativeState])).toEqual([
      ['bc-act0000001', 'running', 'RUN_RUNNING'],
      ['bc-act0000002', 'unknown', 'RUN_CREATING'],
      ['bc-act0000003', 'unknown', 'ACTIVE'],
      ['bc-act0000004', 'unknown', 'RUN_RUNNING'],
    ]);
    expect(out[0].updatedAt).toBe(Date.parse('2026-10-16T12:58:30Z'));
    expect(out[1].updatedAt).toBe(Date.parse('2026-10-16T12:58:00Z'));
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
  it('run terminal (ERROR/FINISHED/CANCELLED/EXPIRED): estado do run preservado, NÃO vira IDLE genérico nem encerra o agente', async () => {
    const st = ['ERROR', 'FINISHED', 'CANCELLED', 'EXPIRED'];
    const list = { items: st.map((_, i) => ({ id: `bc-term000000${i}`, status: 'ACTIVE', updatedAt: '2026-10-16T12:59:59Z', latestRunId: `run-t${i}` })) };
    const f: FetchLike = async (url) => {
      const p = new URL(url).pathname.split('/');
      const body = p.length === 3 ? list : p[4] === 'runs' ? { status: st[Number(p[5].slice(5))], updatedAt: '2026-10-16T12:40:00Z' } : { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const out = await new CursorCollector({ apiKey: 'k', cfg, fetch: f }).poll(FIX_NOW);
    expect(out.map((o) => o.nativeState)).toEqual(st.map((x) => `RUN_${x}`));
    // run terminal ≠ fim do agente (não 'ended', não sai da sala) ≠ sucesso; horário = o do run
    expect(out.every((o) => o.state === 'idle' && o.updatedAt === Date.parse('2026-10-16T12:40:00Z'))).toBe(true);
  });
  it('estado do run, horário nativo do run e instante local de confirmação ficam separados (carimbo por item)', async () => {
    let clock = 5_000_000;
    const list = { items: [
      { id: 'bc-conf000001', status: 'ACTIVE', updatedAt: '2026-10-16T12:59:00Z', latestRunId: 'run-c1' },
      { id: 'bc-conf000002', status: 'IDLE', updatedAt: '2026-10-16T12:30:00Z' },
    ] };
    const f: FetchLike = async (url) => {
      const p = new URL(url).pathname.split('/');
      clock += p[4] === 'runs' ? 40_000 : 1_000; // GET do run demora 40 s
      const body = p.length === 3 ? list : p[4] === 'runs' ? { status: 'RUNNING', updatedAt: '2026-10-16T12:55:00Z' } : { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const out = await new CursorCollector({ apiKey: 'k', cfg, fetch: f, clock: () => clock }).poll(FIX_NOW);
    const run = out.find((o) => o.id === 'bc-conf000001')!;
    const idle = out.find((o) => o.id === 'bc-conf000002')!;
    expect(run.updatedAt).toBe(Date.parse('2026-10-16T12:55:00Z')); // horário nativo do run
    expect(idle.confirmedAt).toBe(FIX_NOW + 1_000); // confirmado quando a página chegou
    expect(run.confirmedAt).toBeGreaterThanOrEqual(FIX_NOW + 41_000); // confirmado quando o GET do run chegou
    expect(run.expiresAt).toBe(run.confirmedAt + cfg.ttlMs);
    expect(idle.expiresAt).toBe(idle.confirmedAt + cfg.ttlMs);
  });
  it('lastWindowExcluded: allowlist ANTES de reter (canário fora da allowlist / id inválido / desconhecido não fica no Set)', async () => {
    let old = false;
    const ts = () => (old ? '2026-10-01T00:00:00Z' : '2026-10-16T12:30:00Z');
    const list = () => ({ items: [
      { id: 'bc-okay000001', status: 'IDLE', updatedAt: ts() },
      { id: 'bc-priv000001', status: 'IDLE', updatedAt: ts(), name: CANARY },
      { id: '../CANARIO', status: 'IDLE', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'bc-nunca00001', status: 'IDLE', updatedAt: '2026-10-01T00:00:00Z' },
    ] });
    const det: Record<string, unknown> = {
      'bc-okay000001': { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] },
      'bc-priv000001': { repos: [{ url: 'https://github.com/alguem/privado' }] },
    };
    const f: FetchLike = async (url) => {
      const p = new URL(url).pathname.split('/');
      return { ok: true, status: 200, text: async () => JSON.stringify(p.length === 3 ? list() : det[p[3]] ?? {}) };
    };
    const c = new CursorCollector({ apiKey: 'k', cfg, fetch: f });
    expect((await c.poll(FIX_NOW)).map((o) => o.id)).toEqual(['bc-okay000001']);
    expect([...c.lastWindowExcluded]).toEqual([]); // os antigos nunca autorizados não entram
    old = true;
    await c.poll(FIX_NOW);
    expect([...c.lastWindowExcluded]).toEqual(['bc-okay000001']);
    expect(JSON.stringify([...c.lastWindowExcluded])).not.toMatch(/priv|CANARIO|nunca/);
  });
  it('multirepo: todos os repos têm de estar na allowlist', async () => {
    const list = { items: [
      { id: 'bc-multi00001', status: 'IDLE', updatedAt: '2026-10-16T12:59:00Z' },
      { id: 'bc-multi00002', status: 'IDLE', updatedAt: '2026-10-16T12:59:00Z' },
      { id: 'bc-multi00003', status: 'IDLE', updatedAt: '2026-10-16T12:59:00Z' },
    ] };
    const det: Record<string, unknown> = {
      'bc-multi00001': { repos: [{ url: 'https://github.com/alguem/privado' }, { url: 'https://github.com/matheusqf/habblaud-qode' }] },
      'bc-multi00002': { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }, { url: 'https://github.com/alguem/privado' }] },
      'bc-multi00003': { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }, { url: 'https://github.com/matheusqf/habblaud-qode.git' }] },
    };
    const f: FetchLike = async (url) => {
      const p = new URL(url).pathname.split('/');
      return { ok: true, status: 200, text: async () => JSON.stringify(p.length === 3 ? list : det[p[3]]) };
    };
    const out = await new CursorCollector({ apiKey: 'k', cfg, fetch: f }).poll(FIX_NOW);
    expect(out.map((o) => o.id)).toEqual(['bc-multi00003']);
  });
});
