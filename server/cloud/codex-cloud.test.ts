import { describe, expect, it } from 'vitest';
import { buildCloudCollectors } from './collectors';
import { loadCloudConfig } from './contract';
import { CODEX_CLOUD_ARGS, CodexCloudCollector, parseCodexEnvMap } from './codex-cloud';
import { CANARY, codexCloudFixture, FIX_NOW } from './fixtures';

const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };
const envs = parseCodexEnvMap('env1=Matheusqf/habblaud-qode, bad id=x');
const PIN = 'codex-cli 0.162.0-alpha.17.2';
/** run falso: responde ao --version com o pin e delega o resto. */
const pinned = (fn: (b: string, a: readonly string[]) => Promise<string>) => async (b: string, a: readonly string[]) => (a[0] === '--version' ? PIN : fn(b, a));

describe('CodexCloudCollector', () => {
  it('comando fixo, mapeamento explícito environment_id (label ignorado), sem texto livre', async () => {
    const calls: string[][] = [];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async (_b, a) => (calls.push([...a]), JSON.stringify(codexCloudFixture))) });
    const out = await c.poll(FIX_NOW);
    expect(calls).toEqual([[...CODEX_CLOUD_ARGS]]); // --version tratado pelo wrapper
    expect(envs.size).toBe(1);
    // env2 tem label "Matheusqf/habblaud-qode" mas não está mapeado: descartado.
    expect(out.map((o) => o.id)).toEqual(['task_e_abc123']);
    expect(out[0]).toMatchObject({ state: 'running', project: 'matheusqf/habblaud-qode', link: 'https://chatgpt.com/codex/tasks/task_e_abc123' });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
  it('usa o cursor: tarefa permitida na página 2 não fica escondida por 20 de outros projetos', async () => {
    const other = Array.from({ length: 20 }, (_, i) => ({ id: `task_e_o${i}xx`, status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: 'envX' }));
    const pages: Record<string, unknown> = {
      '': { tasks: other, cursor: 'p2' },
      p2: { tasks: [{ id: 'task_e_mine01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: 'env1' }], cursor: null },
    };
    const calls: string[][] = [];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async (_b, a) => { calls.push([...a]); const i = a.indexOf('--cursor'); return JSON.stringify(pages[i < 0 ? '' : a[i + 1]]); }) });
    expect((await c.poll(FIX_NOW)).map((o) => o.id)).toEqual(['task_e_mine01']);
    expect(calls[1]).toEqual([...CODEX_CLOUD_ARGS, '--cursor', 'p2']);
    expect(c.lastPartial).toBe(false);
  });
  it('teto de páginas => inventário parcial', async () => {
    let n = 0;
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async () => JSON.stringify({ tasks: [], cursor: `c${++n}` })) });
    await c.poll(FIX_NOW);
    expect(c.lastPartial).toBe(true);
  });
  it('versão: comparação exata', async () => {
    const mk = (v: string) => new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: 'codex-cli 0.162.0', run: async (_b, a) => (a[0] === '--version' ? v : '{"tasks":[]}') });
    await expect(mk('codex-cli 0.162.0-evil').poll(FIX_NOW)).rejects.toThrow(/versão/);
    await expect(mk('codex-cli 0.162.0\n').poll(FIX_NOW)).resolves.toEqual([]); // trim: newline final aceite
  });
  it('lista vazia real ({"tasks":[],"cursor":null}) é ok', async () => {
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async () => '{"tasks":[],"cursor":null}') });
    expect(await c.poll(FIX_NOW)).toEqual([]);
  });
  it('environment_id null/ausente/não mapeado: falha fechada (não mostra), mesmo com label permitido', async () => {
    const tasks = [
      { id: 'task_e_null01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: null, environment_label: 'Matheusqf/habblaud-qode' },
      { id: 'task_e_none01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_label: 'Matheusqf/habblaud-qode' },
      { id: 'task_e_unmp01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: 'env-desconhecido' },
    ];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async () => JSON.stringify({ tasks, cursor: null })) });
    expect(await c.poll(FIX_NOW)).toEqual([]);
  });
  it('pin obrigatório e verificado em CADA execução (troca de binário entre ciclos falha fechada)', async () => {
    expect(() => new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: '' })).toThrow(/obrigatório/);
    expect(buildCloudCollectors(loadCloudConfig({ HABBLAUD_CLOUD: '1', HABBLAUD_CLOUD_CODEX: '1' }), { HABBLAUD_CODEX_BIN: '/bin/sh' })).toEqual([]);
    let v = PIN;
    let versionCalls = 0;
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: async (_b, a) => (a[0] === '--version' ? (versionCalls++, v) : '{"tasks":[],"cursor":null}') });
    await c.poll(FIX_NOW);
    await c.poll(FIX_NOW);
    expect(versionCalls).toBe(2);
    v = 'codex-cli 0.163.0';
    await expect(c.poll(FIX_NOW)).rejects.toThrow(/versão/);
  });
  it('cursor ausente ou inválido ≠ inventário completo; null = completo', async () => {
    const mk = (body: unknown) => new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: PIN, run: pinned(async () => JSON.stringify(body)) });
    const a = mk({ tasks: [] });
    await a.poll(FIX_NOW);
    expect(a.lastPartial).toBe(true);
    const b = mk({ tasks: [], cursor: 'inválido com espaços' });
    await b.poll(FIX_NOW);
    expect(b.lastPartial).toBe(true);
    const c = mk({ tasks: [], cursor: null });
    await c.poll(FIX_NOW);
    expect(c.lastPartial).toBe(false);
  });
});
