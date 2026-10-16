import { describe, expect, it } from 'vitest';
import { CODEX_CLOUD_ARGS, CodexCloudCollector, parseCodexEnvMap } from './codex-cloud';
import { CANARY, codexCloudFixture, FIX_NOW } from './fixtures';

const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };
const envs = parseCodexEnvMap('env1=Matheusqf/habblaud-qode, bad id=x');

describe('CodexCloudCollector', () => {
  it('comando fixo, mapeamento explícito environment_id (label ignorado), sem texto livre', async () => {
    const calls: string[][] = [];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, run: async (_b, a) => (calls.push([...a]), JSON.stringify(codexCloudFixture)) });
    const out = await c.poll(FIX_NOW);
    expect(calls).toEqual([[...CODEX_CLOUD_ARGS]]);
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
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, run: async (_b, a) => { calls.push([...a]); const i = a.indexOf('--cursor'); return JSON.stringify(pages[i < 0 ? '' : a[i + 1]]); } });
    expect((await c.poll(FIX_NOW)).map((o) => o.id)).toEqual(['task_e_mine01']);
    expect(calls[1]).toEqual([...CODEX_CLOUD_ARGS, '--cursor', 'p2']);
    expect(c.lastPartial).toBe(false);
  });
  it('teto de páginas => inventário parcial', async () => {
    let n = 0;
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, run: async () => JSON.stringify({ tasks: [], cursor: `c${++n}` }) });
    await c.poll(FIX_NOW);
    expect(c.lastPartial).toBe(true);
  });
  it('versão: comparação exata', async () => {
    const mk = (v: string) => new CodexCloudCollector({ bin: '/x/codex', cfg, envs, pinnedVersion: 'codex-cli 0.162.0', run: async (_b, a) => (a[0] === '--version' ? v : '{"tasks":[]}') });
    await expect(mk('codex-cli 0.162.0-evil').poll(FIX_NOW)).rejects.toThrow(/versão/);
    await expect(mk('codex-cli 0.162.0\n').poll(FIX_NOW)).resolves.toEqual([]);
  });
  it('lista vazia real ({"tasks":[],"cursor":null}) é ok', async () => {
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, run: async () => '{"tasks":[],"cursor":null}' });
    expect(await c.poll(FIX_NOW)).toEqual([]);
  });
  it('environment_id null/ausente/não mapeado: falha fechada (não mostra), mesmo com label permitido', async () => {
    const tasks = [
      { id: 'task_e_null01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: null, environment_label: 'Matheusqf/habblaud-qode' },
      { id: 'task_e_none01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_label: 'Matheusqf/habblaud-qode' },
      { id: 'task_e_unmp01', status: 'in_progress', updated_at: '2026-10-16T12:59:00Z', environment_id: 'env-desconhecido' },
    ];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, envs, run: async () => JSON.stringify({ tasks, cursor: null }) });
    expect(await c.poll(FIX_NOW)).toEqual([]);
  });
});
