// Ponta a ponta da fonte do OpenCode: fonte → Office → DTO de privacidade → cards/lista. Atividade só inferida nunca
// aparece como "Feito"; falha de leitura e expiração do "ativo" ficam visíveis (texto) e acessíveis (rótulo).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCards } from '../../../client/src/ui/cards-model';
import { activityFallback } from '../../../client/src/ui/model';
import { UNIFIED_LABEL } from '../../../shared/unified-state';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { privateAgent } from '../../qode/privacy';
import { OpenCodeSource } from './source';

setQuiet(true);
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'oc-e2e-')));
const DIR = join(ROOT, 'proj');
mkdirSync(DIR);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('OpenCode ponta a ponta', () => {
  it('ativo → expirado → falha de leitura: nunca "Feito"; texto visível e DTO privado preservam a inferência', async () => {
    let clock = 10_000_000;
    const now = () => clock;
    const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, now, onChange: () => undefined });
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: clock, accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined, now });
    let rows: unknown[] = [];
    let fail: Error | undefined;
    const run = async () => {
      if (fail) throw fail;
      return JSON.stringify(rows);
    };
    const src = new OpenCodeSource({ accounts, office, dataDir: '/tmp/oc', run, now, projects: [DIR] });
    const row = (updated: number) => ({ id: 's1', parent_id: null, directory: DIR, model: null, agent: 'build', cost: 0, tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_created: updated - 1000, time_updated: updated, time_archived: null, last_role: 'user', last_model: null, last_provider: null, last_completed: null, last_error: 0 });
    const view = () => {
      const snap = office.commit().snapshot;
      const dto = { ...snap, agents: snap.agents.map(privateAgent) };
      const card = buildCards(dto).flatMap((r) => r.cards)[0];
      return { agent: dto.agents[0], card, text: activityFallback(dto.agents[0]) };
    };

    rows = [row(clock - 1000)];
    await src.start();
    let v = view();
    expect(v.agent.observed).toMatchObject({ activity: 'active', stale: false });
    expect(v.card.state).toBe('inferred');
    expect(UNIFIED_LABEL[v.card.state]).not.toBe('Feito');
    expect(v.text).toMatch(/^atividade inferida: ativa \(dado das \d\d:\d\d\)$/);

    // expiração: sem gravação há > 5 min
    clock += 6 * 60_000;
    await src.poll();
    v = view();
    expect(v.agent.observed).toMatchObject({ activity: 'unknown', stale: false });
    expect(v.card.state).toBe('inferred');
    expect(v.text).toContain('desconhecida');

    // falha de leitura
    fail = new Error('falha de leitura: disk I/O');
    await src.poll();
    v = view();
    expect(v.agent.observed).toMatchObject({ activity: 'unknown', stale: true });
    expect(v.card.state).toBe('inferred');
    expect(v.text).toContain('leitura desatualizada');
    src.stop();
  });

  it('erro gravado chega como Erro no card e no texto; filha vira sub do principal', async () => {
    const clock = 10_000_000;
    const now = () => clock;
    const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, now, onChange: () => undefined });
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: clock, accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined, now });
    const base = { directory: DIR, model: null, agent: 'build', cost: 0.1, tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_created: clock - 2000, time_updated: clock - 1000, time_archived: null, last_role: 'assistant', last_model: null, last_provider: null, last_completed: clock - 1000 };
    const rows = [{ ...base, id: 'p1', parent_id: null, last_error: 1 }, { ...base, id: 'c1', parent_id: 'p1', last_error: 0 }];
    const src = new OpenCodeSource({ accounts, office, dataDir: '/tmp/oc', run: async () => JSON.stringify(rows), now, projects: [DIR] });
    await src.start();
    const snap = office.commit().snapshot;
    const dto = { ...snap, agents: snap.agents.map(privateAgent) };
    const room = buildCards(dto)[0];
    expect(room.cards).toHaveLength(1);
    expect(room.cards[0].state).toBe('error');
    expect(activityFallback(dto.agents.find((a) => a.kind === 'main')!)).toContain('última resposta com erro');
    expect(room.cards[0].subs.map((c) => [c.agent.kind, c.state])).toEqual([['sub', 'inferred']]);
    src.stop();
  });
});
