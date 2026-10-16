import { describe, expect, it } from 'vitest';
import type { MainInput } from '../model/office';
import { sanitize, type CloudObservation } from './contract';
import { FIX_NOW } from './fixtures';
import { CloudSource, officeId, type CloudOffice } from './source';

function fakeOffice() {
  const agents = new Map<string, MainInput & { status: string }>();
  const office: CloudOffice = {
    addMain: (p) => void agents.set(p.id, { ...p }),
    setStatus: (id, s) => void (agents.get(id) && (agents.get(id)!.status = s)),
    closeMain: (id) => void agents.delete(id),
    has: (id) => agents.has(id),
  };
  return { office, agents };
}
const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };
const obs = (id: string, st: string, now = FIX_NOW): CloudObservation => sanitize('cursor', { id, project: 'matheusqf/habblaud-qode', nativeState: st, updatedAt: now, link: `https://cursor.com/agents/${id}` }, cfg, now)!;

describe('CloudSource', () => {
  it('sem coletores é inerte', async () => {
    const { office, agents } = fakeOffice();
    const s = new CloudSource({ office, collectors: [], now: () => FIX_NOW });
    s.start();
    await s.tick();
    expect(agents.size).toBe(0);
    expect(s.sources()).toEqual([]);
  });
  it('running -> working, idle -> idle, ended sai da sala', async () => {
    const { office, agents } = fakeOffice();
    let list = [obs('bc-aaaaaa01', 'ACTIVE'), obs('bc-aaaaaa02', 'IDLE')];
    let now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => list }], now: () => now });
    await s.tick();
    expect(agents.get(officeId(list[0]))?.status).toBe('working');
    expect(agents.get(officeId(list[1]))?.status).toBe('idle');
    expect(agents.get(officeId(list[0]))?.cwd).toBe('/cloud/cursor/matheusqf/habblaud-qode');
    list = [obs('bc-aaaaaa01', 'IDLE', FIX_NOW + 40_000), obs('bc-aaaaaa02', 'ARCHIVED', FIX_NOW + 40_000)];
    now = FIX_NOW + 40_000;
    await s.tick();
    expect(agents.get('cloud:cursor:bc-aaaaaa01')?.status).toBe('idle');
    expect(agents.has('cloud:cursor:bc-aaaaaa02')).toBe(false);
  });
  it('falha do coletor: backoff, erro genérico e running vencido vira stale (idle)', async () => {
    const { office, agents } = fakeOffice();
    let fail = false;
    let now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('HTTP 500 body SECRET'); return [obs('bc-aaaaaa01', 'ACTIVE')]; } }], now: () => now });
    await s.tick();
    fail = true;
    now += 31_000;
    await s.tick();
    expect(s.sources()[0].ok).toBe(false);
    expect(s.sources()[0].error).not.toContain('SECRET');
    now += 200_000;
    await s.tick();
    expect(agents.get('cloud:cursor:bc-aaaaaa01')?.status).toBe('idle');
  });
});
