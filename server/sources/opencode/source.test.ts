// Integração da fonte do OpenCode: um runner falso (JSON de linhas do banco), o AccountsService e o Office.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpenCodeSource } from './source';

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
    time_created: 1000,
    time_updated: 2000,
    time_archived: null,
    last_role: 'assistant',
    last_model: 'claude-sonnet-4',
    last_provider: 'anthropic',
    last_completed: 1999,
    last_error: 0,
    ...over,
  };
}

function setup() {
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
  const source = new OpenCodeSource({ accounts, office, dataDir: '/tmp/opencode', run, now });
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
  it('sessão ativa aparece como principal, com modelo e números; nada de título ou conteúdo', async () => {
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
      status: 'working',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(a.stats).toMatchObject({ toolCalls: 0, tokensIn: 1300, tokensOut: 50, costUSD: 0.5, subagents: 0 });
    expect(a.tasks).toEqual([]);
    expect(a.title).toBeUndefined();
    expect(ctx.source.sources()).toEqual([{ label: '.opencode', provider: 'opencode', path: '/tmp/opencode', sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.opencode', provider: 'opencode', name: 'OpenCode', short: 'OC' });
  });

  it('a leitura seguinte com a resposta concluída deixa a sessão ociosa', async () => {
    const ctx = setup();
    ctx.setRows([row({ last_role: 'user' })]);
    await ctx.source.start();
    expect(ctx.agent()?.status).toBe('working');

    ctx.advance(1_000);
    ctx.setRows([row({ last_role: 'assistant', last_completed: 1999, time_updated: 3000 })]);
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('sessão que some numa leitura bem-sucedida é encerrada', async () => {
    const ctx = setup();
    ctx.setRows([row()]);
    await ctx.source.start();
    expect(ctx.agent()?.status).not.toBe('offline');

    ctx.setRows([]);
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.source.sources()[0].sessions).toBe(0);
  });

  it('falha na leitura mantém o agente e marca a fonte como não-ok', async () => {
    const ctx = setup();
    ctx.setRows([row({ last_role: 'user' })]);
    await ctx.source.start();
    expect(ctx.agent()?.status).toBe('working');

    ctx.setFailure(new Error('banco indisponível'));
    await ctx.source.poll();
    expect(ctx.agent()?.status).toBe('working');
    const src = ctx.source.sources()[0];
    expect(src.ok).toBe(false);
    expect(src.error).toBe('banco indisponível');
    expect(src.sessions).toBe(1);

    // Recuperou: a leitura volta a valer e a fonte fica ok de novo.
    ctx.setFailure(undefined);
    ctx.setRows([row({ last_role: 'assistant', last_completed: 0 })]);
    await ctx.source.poll();
    expect(ctx.source.sources()[0].ok).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
  });
});
