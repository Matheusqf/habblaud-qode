// Sessões do OpenCode: a query não lê colunas que versões antigas do banco não têm, sessionsSql
// valida o corte e troca o placeholder, e parseSessions converte as linhas (status, erro,
// modelo, tokens) pulando as que não servem.
import { describe, expect, it } from 'vitest';
import { OPENCODE_SESSIONS_SQL, parseSessions, sessionsSql, type OpenCodeSession } from './sessions';

/** Linha como a query devolve: colunas de session mais os subselects da última mensagem. */
type Row = Record<string, unknown>;

/** Linha válida por completo; `over` sobrepõe campos. */
function row(over: Row = {}): Row {
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

/** parseSessions sobre as linhas serializadas, como o driver do SQLite devolveria. */
const parse = (rows: readonly unknown[]): OpenCodeSession[] => parseSessions(JSON.stringify(rows));

describe('OPENCODE_SESSIONS_SQL', () => {
  it('nunca lê colunas que versões antigas do banco não têm (title, slug, summary...)', () => {
    for (const col of ['title', 'slug', 'summary', 'share_url', 'metadata', 'permission']) {
      expect(OPENCODE_SESSIONS_SQL).not.toContain(col);
    }
  });

  it('sessões raiz não arquivadas, da mais recente, no máximo 50, com o placeholder do corte', () => {
    for (const frag of ['parent_id IS NULL', 'time_archived IS NULL', 'ORDER BY s.time_updated DESC', 'LIMIT 50', '{{SINCE}}']) {
      expect(OPENCODE_SESSIONS_SQL).toContain(frag);
    }
  });
});

describe('sessionsSql', () => {
  it('troca o {{SINCE}} pelo corte truncado para inteiro', () => {
    const sql = sessionsSql(1700000000.9);
    expect(sql).not.toContain('{{SINCE}}');
    expect(sql).toContain('s.time_updated > 1700000000');
  });

  it('rejeita NaN (e infinito, e nem número)', () => {
    expect(() => sessionsSql(Number.NaN)).toThrow();
    expect(() => sessionsSql(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => sessionsSql('1000' as unknown as number)).toThrow();
  });
});

describe('parseSessions', () => {
  it('string vazia vira []', () => {
    expect(parseSessions('')).toEqual([]);
  });

  it('JSON inválido propaga o erro', () => {
    expect(() => parseSessions('[{"id":')).toThrow();
  });

  it('linha válida vira sessão com os campos diretos', () => {
    const s = parse([row()])[0];
    expect(s.id).toBe('ses-1');
    expect(s.directory).toBe('/projetos/loja');
    expect(s.model).toBe('anthropic/claude-sonnet-4');
    expect(s.agent).toBe('build');
    expect(s.startedAt).toBe(1000);
    expect(s.updatedAt).toBe(2000);
    expect(s.costUSD).toBe(0.5);
  });

  it('working: última mensagem do usuário, ou assistente ainda sem completed', () => {
    expect(parse([row({ last_role: 'user' })])[0].inferred).toBe('active');
    // Usuário com completed também: a sessão segue trabalhando.
    expect(parse([row({ last_role: 'user', last_completed: 1999 })])[0].inferred).toBe('active');
    expect(parse([row({ last_role: 'assistant', last_completed: null })])[0].inferred).toBe('active');
  });

  it('idle: assistente com completed, ou sessão sem mensagem', () => {
    expect(parse([row()])[0].inferred).toBe('idle');
    // Completed falsy mas presente (0) não é null: a resposta acabou.
    expect(parse([row({ last_role: 'assistant', last_completed: 0 })])[0].inferred).toBe('idle');
    const semMensagem = row({ last_role: null, last_model: null, last_provider: null, last_completed: null });
    expect(parse([semMensagem])[0].inferred).toBe('idle');
  });

  it('error só quando a última mensagem tem erro (1/true)', () => {
    expect(parse([row({ last_error: 1 })])[0].error).toBe(true);
    expect(parse([row({ last_error: true })])[0].error).toBe(true);
    expect(parse([row({ last_error: 0 })])[0].error).toBe(false);
    expect(parse([row({ last_error: null })])[0].error).toBe(false);
  });

  it('modelo: o da última mensagem vence; senão a coluna, simples ou JSON', () => {
    // Da última mensagem.
    expect(parse([row({ last_provider: 'anthropic', last_model: 'claude-sonnet-4' })])[0].model).toBe('anthropic/claude-sonnet-4');
    // Um dos dois sozinho não basta: cai para a coluna da sessão.
    expect(parse([row({ last_provider: 'anthropic', last_model: null, model: 'gpt-5.2' })])[0].model).toBe('gpt-5.2');
    expect(parse([row({ last_provider: null, last_model: 'claude-sonnet-4', model: 'gpt-5.2' })])[0].model).toBe('gpt-5.2');
    // Coluna com nome simples.
    expect(parse([row({ last_provider: null, last_model: null, model: 'gpt-5.2' })])[0].model).toBe('gpt-5.2');
    // Coluna com JSON: {"providerID","modelID"} ou {"providerID","id"}.
    expect(parse([row({ last_provider: null, last_model: null, model: '{"providerID":"openai","modelID":"gpt-5.2"}' })])[0].model).toBe('openai/gpt-5.2');
    expect(parse([row({ last_provider: null, last_model: null, model: '{"providerID":"openai","id":"gpt-5.2"}' })])[0].model).toBe('openai/gpt-5.2');
    // Sem modelo nenhum.
    expect(parse([row({ last_provider: null, last_model: null, model: null })])[0].model).toBeUndefined();
  });

  it('tokens: entrada soma input+cache_read+cache_write, saída output+reasoning', () => {
    const s = parse([row({ tokens_input: 100, tokens_cache_read: 1000, tokens_cache_write: 200, tokens_output: 40, tokens_reasoning: 10 })])[0];
    expect(s.tokensIn).toBe(1300);
    expect(s.tokensOut).toBe(50);
  });

  it('token ausente conta 0, e custo nulo também', () => {
    const s = parse([
      row({ tokens_input: undefined, tokens_cache_read: undefined, tokens_cache_write: undefined, tokens_output: undefined, tokens_reasoning: undefined, cost: null }),
    ])[0];
    expect(s.tokensIn).toBe(0);
    expect(s.tokensOut).toBe(0);
    expect(s.costUSD).toBe(0);
  });

  it('pula linhas sem id/diretório string ou sem tempos numéricos', () => {
    const bad: unknown[] = [
      null,
      'nem-é-objeto',
      row({ id: 42 }),
      row({ id: null }),
      row({ directory: 7 }),
      row({ directory: undefined }),
      row({ time_created: '1000' }),
      row({ time_created: null }),
      row({ time_updated: '2000' }),
    ];
    const out = parse([row({ id: 'primeira' }), ...bad, row({ id: 'última' })]);
    expect(out.map((s) => s.id)).toEqual(['primeira', 'última']);
  });
});
