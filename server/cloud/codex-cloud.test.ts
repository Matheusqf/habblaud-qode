import { describe, expect, it } from 'vitest';
import { CODEX_CLOUD_ARGS, CodexCloudCollector } from './codex-cloud';
import { CANARY, codexCloudFixture, FIX_NOW } from './fixtures';

const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };

describe('CodexCloudCollector', () => {
  it('comando fixo, allowlist, sem texto livre', async () => {
    const calls: string[][] = [];
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, run: async (_b, a) => (calls.push([...a]), JSON.stringify(codexCloudFixture)) });
    const out = await c.poll(FIX_NOW);
    expect(calls).toEqual([[...CODEX_CLOUD_ARGS]]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'task_e_abc123', state: 'running', project: 'matheusqf/habblaud-qode', link: 'https://chatgpt.com/codex/tasks/task_e_abc123' });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
  it('versão fixada fora do prefixo recusa', async () => {
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, pinnedVersion: 'codex-cli 0.162.', run: async (_b, a) => (a[0] === '--version' ? 'codex-cli 0.200.0' : '{"tasks":[]}') });
    await expect(c.poll(FIX_NOW)).rejects.toThrow(/versão/);
  });
  it('lista vazia real ({"tasks":[],"cursor":null}) é ok', async () => {
    const c = new CodexCloudCollector({ bin: '/x/codex', cfg, run: async () => '{"tasks":[],"cursor":null}' });
    expect(await c.poll(FIX_NOW)).toEqual([]);
  });
});
