// Integração da fonte do OpenCode: um runner falso (JSON de linhas do banco), o AccountsService e o Office.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { inAllowlist, OpenCodeSource } from './source';

setQuiet(true);

const KEY = '.opencode:ses-1';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Linha como a query do banco devolve (sessions.ts). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses-1',
    parent_id: null,
    directory: '/projetos/loja',
    model: 'claude-sonnet-4',
    agent: 'build',
    cost: 0.5,
    tokens_input: 100,
    tokens_output: 40,
    tokens_reasoning: 10,
    tokens_cache_read: 1000,
    tokens_cache_write: 200,
    time_created: 990_000,
    time_updated: 999_000,
    time_archived: null,
    last_role: 'assistant',
    last_model: 'claude-sonnet-4',
    last_provider: 'anthropic',
    last_completed: 1999,
    last_error: 0,
    ...over,
  };
}

function setup(opts: { projects?: string[] } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  let output = '[]';
  let failure: Error | undefined;
  const run = async (): Promise<string> => {
    if (failure) throw failure;
    return output;
  };
  const source = new OpenCodeSource({ accounts, office, dataDir: '/tmp/opencode', run, now, projects: opts.projects ?? ['/projetos'] });
  // Para o ciclo agendado pelo start() antes de qualquer limpeza.
  cleanups.unshift(() => source.stop());
  return {
    accounts,
    office,
    source,
    now,
    setRows(rows: readonly unknown[]) {
      output = JSON.stringify(rows);
    },
    setFailure(err: Error | undefined) {
      failure = err;
    },
    advance(ms: number) {
      clock += ms;
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
}

describe('fonte do OpenCode', () => {
  it('sessão aparece como principal ociosa, com atividade INFERIDA, modelo e números; sem título', async () => {
    const ctx = setup();
    ctx.setRows([row({ last_role: 'user' })]);
    await ctx.source.start();

    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'opencode',
      account: '.opencode',
      sessionId: 'ses-1',
      roomId: '/projetos/loja',
      role: 'build',
      // O banco não prova processo vivo: nunca 'working'.
      status: 'idle',
      model: 'anthropic/claude-sonnet-4',
      observed: { basis: 'inferred', activity: 'active', at: 999_000, stale: false },
    });
    expect(a.stats).toMatchObject({ toolCalls: 0, tokensIn: 1300, tokensOut: 50, costUSD: 0.5, subagents: 0 });
    expect(a.title).toBeUndefined();
    expect(ctx.source.sources()).toEqual([{ label: '.opencode', provider: 'opencode', path: '/tmp/opencode', sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.opencode', provider: 'opencode', name: 'OpenCode', short: 'OC' });
  });

  it('resposta concluída = inferido idle; "ativo" velho (> 5 min sem gravação) vira unknown', async () => {
    const ctx = setup();
    ctx.setRows([row({ last_role: 'assistant', last_completed: 1999 })]);
    await ctx.source.start();
    expect(ctx.agent()?.observed?.activity).toBe('idle');

    ctx.setRows([row({ last_role: 'user', time_updated: 1_000_000 - 6 * 60_000 })]);
    await ctx.source.poll();
    expect(ctx.agent()?.observed).toMatchObject({ activity: 'unknown', stale: false });
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('falha de leitura: fonte não-ok e atividade unknown/stale com o horário do último dado', async () => {
    const ctx = setup();
    ctx.setRows([row({ last_role: 'user' })]);
    await ctx.source.start();

    ctx.advance(5_000);
    ctx.setFailure(new Error('banco do OpenCode ausente'));
    await ctx.source.poll();
    expect(ctx.agent()?.observed).toEqual({ basis: 'inferred', activity: 'unknown', at: 999_000, stale: true });
    expect(ctx.source.sources()[0]).toMatchObject({ ok: false, error: 'banco do OpenCode ausente', sessions: 1 });

    ctx.setFailure(undefined);
    ctx.setRows([row({ last_role: 'assistant', last_completed: 1, time_updated: 1_004_000 })]);
    await ctx.source.poll();
    expect(ctx.source.sources()[0].ok).toBe(true);
    expect(ctx.agent()?.observed).toMatchObject({ activity: 'idle', stale: false, at: 1_004_000 });
  });

  it('sessão que some numa leitura bem-sucedida é encerrada', async () => {
    const ctx = setup();
    ctx.setRows([row()]);
    await ctx.source.start();
    ctx.setRows([]);
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.source.sources()[0].sessions).toBe(0);
  });

  it('revival: presente → ausente → volta antes de 20 s → tick depois do prazo original → continua presente', async () => {
    const ctx = setup();
    ctx.setRows([row()]);
    await ctx.source.start();
    ctx.setRows([]);
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('offline');

    ctx.advance(5_000);
    ctx.setRows([row()]);
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('idle');

    const name = ctx.agent()?.name;
    ctx.advance(30_000); // passou do prazo do closeMain (20 s)
    ctx.office.tick();
    // Sem nova leitura: o tick sozinho não pode remover quem voltou.
    expect(ctx.agent()).toBeDefined();
    expect(ctx.agent()?.name).toBe(name);
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('allowlist: só sessões dentro dos projetos permitidos entram; allowlist vazia = nada entra', async () => {
    const ctx = setup({ projects: ['/projetos/loja'] });
    ctx.setRows([row(), row({ id: 'ses-2', directory: '/projetos/lojaX' }), row({ id: 'ses-3', directory: '/outro' })]);
    await ctx.source.start();
    expect(ctx.office.commit().snapshot.agents.map((a) => a.id)).toEqual([KEY]);

    const empty = setup({ projects: [] });
    empty.setRows([row()]);
    await empty.source.start();
    expect(empty.office.commit().snapshot.agents).toEqual([]);
  });
});

describe('inAllowlist', () => {
  it('igual ou abaixo; prefixo de nome não conta', () => {
    expect(inAllowlist('/a/b', ['/a/b'])).toBe(true);
    expect(inAllowlist('/a/b/c', ['/a/b/'])).toBe(true);
    expect(inAllowlist('/a/bc', ['/a/b'])).toBe(false);
    expect(inAllowlist('/a/b/../x', ['/a/b'])).toBe(false);
  });
});
