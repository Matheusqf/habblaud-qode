// ZikaBOT #26: filha de projeto PRIVADO sob pai público (ambos na allowlist) não pode vazar papel/modelo/uso; e
// filha descoberta/reativada não dispara «Concluiu»/aviso falso; filha removida tem observed invalidado.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office, type CommitResult } from '../../model/office';
import { RoomAliases } from '../../model/room-aliases';
import { setupQode } from '../../qode/index';
import { tempDir } from '../../test/fixtures';
import { OpenCodeSource } from './source';

setQuiet(true);
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup() {
  const tmp = tempDir('oc-priv-');
  cleanups.push(tmp.cleanup);
  const root = realpathSync(tmp.dir);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const pub = join(home, 'pub');
  const priv = join(home, 'cofre');
  const priv2 = join(home, 'cofre2');
  for (const d of [pub, priv, priv2, dataDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dataDir, 'qode.config.json'), JSON.stringify({ projetos: [{ nome: 'Pub', caminhos: [pub] }, { nome: 'Cofre', caminhos: [priv], privado: true }, { nome: 'Cofre2', caminhos: [priv2], privado: true }] }));
  let clock = 50_000_000;
  const now = () => clock;
  let office!: Office;
  const qode = setupQode({ env: {}, dataDir, home, roomAliases: new RoomAliases(null), office: () => office });
  const accounts = new AccountsService({ dirs: [], home, env: {}, now, onChange: () => undefined });
  office = new Office({ names: new NameStore(null), version: 't', startedAt: clock, accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined, now, roomOf: qode.roomOf, privacy: qode.privacy });
  let rows: unknown[] = [];
  const src = new OpenCodeSource({ accounts, office, dataDir: '/tmp/oc', run: async () => JSON.stringify(rows), now, projects: [pub, priv, priv2] });
  cleanups.unshift(() => src.stop());
  const base = { model: null, cost: 0.123456, tokens_input: 777001, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_archived: null, last_role: 'assistant', last_completed: 1, last_error: 0 };
  const parent = { ...base, id: 'p1', parent_id: null, directory: pub, agent: 'build', last_model: 'pub-model', last_provider: 'opencode', time_created: clock - 5000, time_updated: clock - 1000 };
  const child = { ...base, id: 'c1', parent_id: 'p1', directory: priv, agent: 'CANARIO-ROLE', last_model: 'CANARIO-MODEL', last_provider: 'opencode', cost: 9.87654, tokens_input: 424242, time_created: clock - 4000, time_updated: clock - 1000, last_error: 1 };
  return { office, src, pub, priv, parent, child, set: (r: unknown[]) => (rows = r), advance: (ms: number) => (clock += ms) };
}

const dump = (c: CommitResult) => JSON.stringify([c.snapshot, c.feed, c.notices]);

describe('OpenCode: subagentes e privacidade', () => {
  it('pai público + filha privada (ambos permitidos): família inteira privada; canários fora de DTO/feed/avisos/estatísticas', async () => {
    const e = setup();
    e.set([e.parent]);
    await e.src.start();
    e.office.commit();
    e.advance(1000);
    e.set([e.parent, e.child]);
    await e.src.poll();
    const c = e.office.commit();
    const out = dump(c);
    for (const canary of ['CANARIO-ROLE', 'CANARIO-MODEL', 'cofre', e.priv, '424242', '9.87654', 'pub-model']) expect(out).not.toContain(canary);
    const sub = c.snapshot.agents.find((a) => a.kind === 'sub');
    expect(sub).toBeDefined();
    expect(sub!.model).toBeUndefined();
  });

  it('filha descoberta depois do start e ausente→volta: sem «Concluiu»/entrega falsos; observed instalado; removida fica stale sem erro', async () => {
    const e = setup();
    const pubChild = { ...e.child, directory: e.pub, agent: 'helper', last_model: 'm' };
    e.set([e.parent]);
    await e.src.start();
    e.office.commit();
    e.advance(1000);
    e.set([e.parent, pubChild]);
    await e.src.poll();
    let c = e.office.commit();
    let sub = c.snapshot.agents.find((a) => a.kind === 'sub')!;
    expect(sub.status).toBe('idle');
    expect(sub.observed).toMatchObject({ basis: 'inferred', error: true, stale: false });
    expect(c.notices.filter((n) => n.level === 'success')).toEqual([]);
    expect(c.feed.some((f) => f.agentId === sub.id && f.activity.kind === 'done')).toBe(false);

    // ausente: sai em silêncio, observed invalidado (stale, sem o erro antigo)
    e.set([e.parent]);
    await e.src.poll();
    c = e.office.commit();
    sub = c.snapshot.agents.find((a) => a.kind === 'sub')!;
    expect(sub.observed).toEqual({ basis: 'inferred', activity: 'unknown', at: pubChild.time_updated, stale: true });
    expect(c.notices.filter((n) => n.level === 'success')).toEqual([]);
    expect(c.feed.some((f) => f.agentId === sub.id && f.activity.kind === 'done')).toBe(false);

    // volta: reativa idle com observed novo, sem working nem conclusão
    e.advance(1000);
    e.set([e.parent, { ...pubChild, last_error: 0 }]);
    await e.src.poll();
    c = e.office.commit();
    sub = c.snapshot.agents.find((a) => a.kind === 'sub')!;
    expect(sub.status).toBe('idle');
    expect(sub.observed).toMatchObject({ stale: false, activity: 'idle' });
    expect(sub.observed?.error).toBeUndefined();
    expect(c.notices.filter((n) => n.level === 'success')).toEqual([]);
  });

  describe('transições de pasta com o mesmo id (todas as saídas)', () => {
    const CANARIES = (e: ReturnType<typeof setup>) => ['CANARIO-ROLE', 'CANARIO-MODEL', e.priv, join(e.priv, '..', 'cofre2'), '424242', '9.87654', 'pub-model'] // o nome/slug do projeto privado pode aparecer (política: só nome e estado);
    async function run(steps: Array<(e: ReturnType<typeof setup>) => unknown[]>, mustBePrivateFrom: number) {
      const e = setup();
      mkdirSync(join(e.priv, '..', 'cofre2'), { recursive: true });
      const outputs: string[] = [];
      for (const [n, rows] of steps.entries()) {
        e.set(rows(e));
        if (n === 0) await e.src.start();
        else await e.src.poll();
        const c = e.office.commit();
        outputs.push(dump(c));
        if (n >= mustBePrivateFrom) for (const k of CANARIES(e)) expect(outputs[n], `passo ${n}: ${k}`).not.toContain(k);
        e.advance(1000);
      }
      return outputs;
    }
    const pubChild = (e: ReturnType<typeof setup>, dir = e.pub) => ({ ...e.child, directory: dir });
    const cofre2 = (e: ReturnType<typeof setup>) => join(e.priv, '..', 'cofre2');

    it('filha público → privado: reclassificada na hora, pai e filha sem canários', async () => {
      const out = await run([(e) => [e.parent, pubChild(e)], (e) => [e.parent, pubChild(e, e.priv)]], 1);
      expect(out[0]).toContain('CANARIO-ROLE'); // antes de mudar era público de verdade
    });

    it('filha privado → público: continua privada (contaminação pegajosa)', async () => {
      await run([(e) => [e.parent, pubChild(e, e.priv)], (e) => [e.parent, pubChild(e)]], 0);
    });

    it('filha privado → outro privado: segue privada', async () => {
      await run([(e) => [e.parent, pubChild(e, e.priv)], (e) => [e.parent, pubChild(e, cofre2(e))]], 0);
    });

    it('raiz muda de pasta pública → privada com o mesmo id: família privada', async () => {
      await run([(e) => [e.parent, pubChild(e)], (e) => [{ ...e.parent, directory: e.priv }, pubChild(e)]], 1);
    });

    it('pai privado → filha pública herda a privacidade', async () => {
      await run([(e) => [{ ...e.parent, directory: e.priv }, pubChild(e)], (e) => [{ ...e.parent, directory: e.priv }, pubChild(e)]], 0);
    });
  });
});
