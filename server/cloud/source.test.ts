import { describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import { NameStore } from '../model/names';
import { Office, type MainInput } from '../model/office';
import { sanitize, type CloudObservation } from './contract';
import { FIX_NOW } from './fixtures';
import { CloudSource, officeId, type CloudOffice } from './source';

function fakeOffice() {
  const agents = new Map<string, MainInput & { status: string; cloud?: { state: string } }>();
  const office: CloudOffice = {
    addMain: (p) => void agents.set(p.id, { ...p }),
    setObservedStatus: (id, s) => void (agents.get(id) && (agents.get(id)!.status = s)),
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
    let list = [obs('bc-aaaaaa01', 'RUNNING'), obs('bc-aaaaaa02', 'IDLE')];
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
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('HTTP 500 body SECRET'); return [obs('bc-aaaaaa01', 'RUNNING')]; } }], now: () => now });
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
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('x'); return [obs('bc-aaaaaa01', 'RUNNING'), unk]; } }], now: () => now });
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
  it('relógio pós-await só agenda: poll de 165 s, item confirmado no fim vale TTL a partir da SUA confirmação; nextAt/backoff usam o fim', async () => {
    const { office, agents } = fakeOffice();
    let now = FIX_NOW;
    let fail = false;
    const s = new CloudSource({
      office,
      // O coletor carimba cada item quando a resposta DELE chega (aqui: no fim da consulta de 165 s).
      collectors: [{ provider: 'cursor', poll: async () => { now += 165_000; if (fail) throw new Error('x'); return [sanitize('cursor', { id: 'bc-aaaaaa03', project: 'matheusqf/habblaud-qode', nativeState: 'RUNNING', updatedAt: now }, cfg, now)!]; } }],
      now: () => now,
    });
    await s.tick();
    expect(s.observations()[0].confirmedAt).toBe(FIX_NOW + 165_000);
    expect(s.observations()[0].expiresAt).toBe(FIX_NOW + 165_000 + 180_000);
    expect(agents.get('cloud:cursor:bc-aaaaaa03')?.cloud?.state).toBe('running');
    // próximo poll agenda a partir do fim: um tick logo a seguir não chama de novo
    const before = now;
    now = before + 10_000;
    fail = true;
    await s.tick();
    expect(now).toBe(before + 10_000); // não chamou poll (senão avançaria 165 s)
    now = before + 31_000;
    await s.tick(); // chama e falha; backoff a partir do fim da falha
    const failedAt = now;
    now = failedAt + 30_000;
    await s.tick();
    expect(now).toBe(failedAt + 30_000);
  });
  it('TTL por confirmação individual: o fim do lote não renova evidência antiga (5 agentes, 1.º confirmado há 240 s)', async () => {
    const { office, agents } = fakeOffice();
    let now = FIX_NOW;
    const ids = Array.from({ length: 5 }, (_, i) => `bc-ttl0000${i}`);
    const s = new CloudSource({
      office,
      collectors: [{
        provider: 'cursor',
        // Consulta lenta, um item de cada vez: cada um é carimbado quando chega (60 s entre eles).
        poll: async () => ids.map((id) => { now += 60_000; return sanitize('cursor', { id, project: 'matheusqf/habblaud-qode', nativeState: 'RUNNING', updatedAt: now }, cfg, now)!; }),
      }],
      now: () => now,
    });
    await s.tick();
    // fim do lote = FIX_NOW+300 s; o 1.º foi confirmado em FIX_NOW+60 s (há 240 s > TTL 180 s): já é stale.
    expect(now).toBe(FIX_NOW + 300_000);
    const o0 = s.observations().find((o) => o.id === ids[0])!;
    expect(o0.expiresAt).toBe(FIX_NOW + 60_000 + 180_000);
    expect(agents.get(`cloud:cursor:${ids[0]}`)?.cloud?.state).toBe('stale');
    expect(agents.get(`cloud:cursor:${ids[0]}`)?.status).toBe('idle');
    // os recentes (confirmados há ≤ 180 s) continuam running
    expect(agents.get(`cloud:cursor:${ids[4]}`)?.cloud?.state).toBe('running');
    expect(agents.get(`cloud:cursor:${ids[2]}`)?.cloud?.state).toBe('running');
  });
  it('carimbo de confirmação no futuro é limitado ao fim do poll (sem TTL inflado)', async () => {
    const { office } = fakeOffice();
    const now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => [sanitize('cursor', { id: 'bc-aaaaaa07', project: 'matheusqf/habblaud-qode', nativeState: 'RUNNING', updatedAt: now }, cfg, now + 3_600_000)!] }], now: () => now });
    await s.tick();
    expect(s.observations()[0].confirmedAt).toBe(FIX_NOW);
    expect(s.observations()[0].expiresAt).toBe(FIX_NOW + 180_000);
  });
  it('excluído por janela (IDLE > 24 h) num inventário completo não fecha', async () => {
    const { office: base, agents } = fakeOffice();
    const closes: string[] = [];
    const office = { ...base, closeMain: (id: string) => (closes.push(id), base.closeMain(id)) };
    const col: { provider: 'cursor'; lastPartial: boolean; lastWindowExcluded?: Set<string>; poll: () => Promise<CloudObservation[]> } = { provider: 'cursor', lastPartial: false, poll: async () => list };
    let list = [obs('bc-aaaaaa01', 'IDLE'), obs('bc-aaaaaa02', 'IDLE')];
    let now = FIX_NOW;
    const s = new CloudSource({ office, collectors: [col], now: () => now });
    await s.tick();
    list = [obs('bc-aaaaaa01', 'IDLE', FIX_NOW + 31_000)];
    col.lastWindowExcluded = new Set(['bc-aaaaaa02']);
    now += 31_000;
    await s.tick();
    expect(closes).toEqual([]);
    expect(agents.has('cloud:cursor:bc-aaaaaa02')).toBe(true);
    // ausência verdadeira (nem na listagem) num inventário completo fecha
    col.lastWindowExcluded = new Set();
    now += 31_000;
    await s.tick();
    expect(closes).toEqual(['cloud:cursor:bc-aaaaaa02']);
  });
});

// Regressão com o Office REAL (snapshot/feed/avisos): o fakeOffice não apanha a síntese de "Concluiu".
describe('CloudSource + Office real: perder RUNNING não é sucesso', () => {
  function realOffice(clock: { t: number }) {
    return new Office({ names: new NameStore(null), version: 't', startedAt: clock.t, accounts: () => [], sources: () => [], accountName: () => undefined, now: () => clock.t });
  }
  const id = 'cloud:cursor:bc-real0001';
  const run = (st: string, t: number) => sanitize('cursor', { id: 'bc-real0001', project: 'matheusqf/habblaud-qode', nativeState: st, updatedAt: t }, cfg, t)!;
  function noSuccess(office: Office, r: ReturnType<Office['commit']>) {
    const feedText = r.feed.map((f) => JSON.stringify(f)).join('\n');
    expect(feedText).not.toMatch(/Concluiu|concluiu/);
    expect(r.notices.filter((n) => n.level === 'success')).toEqual([]);
    expect(r.notices.map((n) => n.text).join('\n')).not.toMatch(/concluiu/);
    const a = r.snapshot.agents.find((x) => x.id === id)!;
    expect(a.activity?.kind).not.toBe('done');
    expect(JSON.stringify(office.get(id))).not.toMatch(/Concluiu/);
    return a;
  }
  it('falha de polling após TTL: cloud.state=stale, personagem parado, sem "Concluiu" nem aviso success', async () => {
    const clock = { t: FIX_NOW };
    const office = realOffice(clock);
    let fail = false;
    const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => { if (fail) throw new Error('x'); return [run('RUNNING', clock.t)]; } }], now: () => clock.t });
    await s.tick();
    let r = office.commit();
    expect(r.snapshot.agents.find((x) => x.id === id)?.status).toBe('working');
    fail = true;
    clock.t += 200_000; // > TTL 180 s sem confirmação
    await s.tick();
    r = office.commit();
    const a = noSuccess(office, r);
    expect(a.status).toBe('idle');
    expect(a.cloud?.state).toBe('stale');
  });
  for (const next of ['IDLE', 'CREATING', 'NOVO_ESTADO']) {
    it(`RUNNING → ${next}: atualização só observacional (sem síntese de conclusão)`, async () => {
      const clock = { t: FIX_NOW };
      const office = realOffice(clock);
      let st = 'RUNNING';
      const s = new CloudSource({ office, collectors: [{ provider: 'cursor', poll: async () => [run(st, clock.t)] }], now: () => clock.t });
      await s.tick();
      office.commit();
      st = next;
      clock.t += 31_000;
      await s.tick();
      const a = noSuccess(office, office.commit());
      expect(a.status).toBe('idle');
      expect(a.cloud?.state).toBe(next === 'IDLE' ? 'idle' : 'unknown');
    });
  }
});
