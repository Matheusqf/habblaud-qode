import { describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import type { MainInput } from '../model/office';
import { sanitize, type CloudObservation } from './contract';
import { FIX_NOW } from './fixtures';
import { CloudSource, officeId, type CloudOffice } from './source';

function fakeOffice() {
  const agents = new Map<string, MainInput & { status: string; cloud?: { state: string } }>();
  const office: CloudOffice = {
    addMain: (p) => void agents.set(p.id, { ...p }),
    setStatus: (id, s) => void (agents.get(id) && (agents.get(id)!.status = s)),
    closeMain: (id) => void agents.delete(id),
    has: (id) => agents.has(id),
    setCloudMeta: (id, meta, role) => void (agents.get(id) && Object.assign(agents.get(id)!, { cloud: meta, role })),
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
  it('log de falha não contém texto bruto do erro (canário)', async () => {
    const lines: string[] = [];
    const a = vi.spyOn(log, 'warnOnce').mockImplementation((_k: string, m: string) => void lines.push(m));
    const b = vi.spyOn(log, 'warn').mockImplementation((m: string) => void lines.push(m));
    const { office } = fakeOffice();
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { throw new Error('HTTP 500 body SECRET-CANARIO token=abc'); } }], now: () => FIX_NOW });
    await s.tick();
    a.mockRestore();
    b.mockRestore();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/SECRET|token=|HTTP 500/);
    expect(lines.join('\n')).toMatch(/categoria=poll_failed/);
  });
  it('stale/unknown chegam à UI como estado próprio (não viram idle no cloud.state)', async () => {
    const { office, agents } = fakeOffice();
    const unk = sanitize('cursor', { id: 'bc-aaaaaa09', project: 'matheusqf/habblaud-qode', nativeState: 'NOVO_ESTADO', updatedAt: FIX_NOW }, cfg, FIX_NOW)!;
    let now = FIX_NOW;
    let fail = false;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('x'); return [obs('bc-aaaaaa01', 'ACTIVE'), unk]; } }], now: () => now });
    await s.tick();
    expect(agents.get('cloud:cursor:bc-aaaaaa09')?.cloud?.state).toBe('unknown');
    expect(agents.get('cloud:cursor:bc-aaaaaa01')?.cloud?.state).toBe('running');
    fail = true;
    now += 200_000;
    await s.tick();
    expect(agents.get('cloud:cursor:bc-aaaaaa01')?.cloud?.state).toBe('stale');
    expect(agents.get('cloud:cursor:bc-aaaaaa01')?.role).toMatch(/sem confirmação/);
  });
  it('poll lento: ticks concorrentes não sobrepõem chamadas ao coletor', async () => {
    const { office } = fakeOffice();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { calls++; await gate; return []; } }], now: () => FIX_NOW + 10 ** 9 * calls });
    const t1 = s.tick();
    const t2 = s.tick();
    const t3 = s.tick();
    release();
    await Promise.all([t1, t2, t3]);
    expect(calls).toBe(1);
  });
  it('56 vistos: inventário completo guardado, sala até 20; mesma lista noutra ordem não fecha nem pisca', async () => {
    const { office, agents } = fakeOffice();
    const closes: string[] = [];
    const adds: string[] = [];
    const o2 = { ...office, closeMain: (id: string) => (closes.push(id), office.closeMain(id)), addMain: (p: MainInput) => (adds.push(p.id), office.addMain(p)) };
    const ids = Array.from({ length: 56 }, (_, i) => `bc-aaaa${String(i).padStart(4, '0')}`);
    let list = ids.map((id, i) => obs(id, 'IDLE', FIX_NOW - i * 1000));
    let now = FIX_NOW;
    const s = new CloudSource({ office: o2, collectors: [{ provider: 'cursor', poll: async () => list }], now: () => now });
    await s.tick();
    expect(agents.size).toBe(20);
    expect(s.observations()).toHaveLength(56);
    expect(s.sources()[0].path).toMatch(/vistos 56/);
    const first = [...agents.keys()].sort();
    list = [...list].reverse();
    now += 31_000;
    await s.tick();
    expect(closes).toEqual([]);
    expect(adds).toHaveLength(20);
    expect([...agents.keys()].sort()).toEqual(first);
  });
  it('página parcial com 20 ids novos: nenhum antigo fecha (nenhum evento de encerramento)', async () => {
    const { office: base, agents } = fakeOffice();
    const closes: string[] = [];
    const office = { ...base, closeMain: (id: string) => (closes.push(id), base.closeMain(id)) };
    const col = { provider: 'cursor' as const, lastPartial: false, poll: async () => list };
    let list = Array.from({ length: 5 }, (_, i) => obs(`bc-old0000${i}`, 'IDLE'));
    let now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [col], now: () => now });
    await s.tick();
    col.lastPartial = true;
    list = Array.from({ length: 20 }, (_, i) => obs(`bc-new${String(i).padStart(4, '0')}`, 'IDLE', FIX_NOW + 31_000));
    now += 31_000;
    await s.tick();
    for (let i = 0; i < 5; i++) expect(agents.has(`cloud:cursor:bc-old0000${i}`)).toBe(true);
    expect(agents.size).toBe(20);
    expect(s.sources()[0].path).toMatch(/parcial/);
    expect(closes).toEqual([]);
  });
  it('falha prolongada de polling: IDLE também envelhece para stale (não fica "parado" como verdade)', async () => {
    const { office, agents } = fakeOffice();
    let fail = false;
    let now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('x'); return [obs('bc-aaaaaa02', 'IDLE')]; } }], now: () => now });
    await s.tick();
    expect(agents.get('cloud:cursor:bc-aaaaaa02')?.cloud?.state).toBe('idle');
    fail = true;
    for (let i = 0; i < 5; i++) {
      now += 15 * 60_000;
      await s.tick();
    }
    expect(agents.get('cloud:cursor:bc-aaaaaa02')?.cloud?.state).toBe('stale');
    expect(agents.has('cloud:cursor:bc-aaaaaa02')).toBe(true);
  });
});
