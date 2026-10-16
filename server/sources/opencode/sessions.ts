// Sessões do OpenCode: a query lê o banco local (tabelas session e message) usando só colunas
// que existem em qualquer versão do banco, e parseSessions lapida as linhas em OpenCodeSession.

/** Corte temporal da query, trocado pelo valor real em sessionsSql(). */
const SINCE_PLACEHOLDER = '{{SINCE}}';

/**
 * Sessões raiz (sem pai) não arquivadas mexidas desde o corte, da mais recente para a mais
 * antiga. O que a última mensagem diz (papel, modelo, erro...) vem de subselects escalares.
 */
export const OPENCODE_SESSIONS_SQL: string = `
  SELECT
    s.id, s.parent_id, s.directory, s.model, s.agent, s.cost,
    s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
    s.time_created, s.time_updated, s.time_archived,
    (SELECT json_extract(m.data, '$.role') FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_role,
    (SELECT json_extract(m.data, '$.modelID') FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_model,
    (SELECT json_extract(m.data, '$.providerID') FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_provider,
    (SELECT json_extract(m.data, '$.time.completed') FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_completed,
    (SELECT json_type(m.data, '$.error') IS NOT NULL FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_error
  FROM session s
  WHERE s.parent_id IS NULL AND s.time_archived IS NULL AND s.time_updated > ${SINCE_PLACEHOLDER}
  ORDER BY s.time_updated DESC
  LIMIT 50
`;

/** OPENCODE_SESSIONS_SQL com o corte em ms (truncado para inteiro) no lugar do placeholder. */
export function sessionsSql(sinceMs: number): string {
  if (!Number.isFinite(sinceMs)) {
    throw new Error(`sessionsSql: sinceMs precisa ser um número finito (recebi ${String(sinceMs)})`);
  }
  return OPENCODE_SESSIONS_SQL.replace(SINCE_PLACEHOLDER, String(Math.floor(sinceMs)));
}

/** Uma sessão do OpenCode já lapidada (tempos em ms de época). */
export interface OpenCodeSession {
  id: string;
  /** Pasta do projeto onde a sessão roda. */
  directory: string;
  /** 'provedor/modelo' (da última mensagem ou da própria sessão). */
  model?: string;
  agent?: string;
  /**
   * Atividade INFERIDA do que está gravado (última mensagem do usuário ou resposta sem fim = 'active'). O banco não
   * prova que o processo dono está vivo: nunca vira 'working' no Office (revisão ZikaBOT #24, P2).
   */
  inferred: 'active' | 'idle';
  /** A última mensagem terminou em erro? */
  error: boolean;
  startedAt: number;
  updatedAt: number;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
}

/** O que não é número conta 0 (colunas de custo/tokens podem vir nulas do banco). */
const numOrZero = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * A coluna s.model pode ser um nome simples ('gpt-5.2') ou um JSON {"providerID","modelID"/"id"}
 * ('{"providerID":"openai","id":"gpt-5.2"}' → 'openai/gpt-5.2').
 */
function sessionModel(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // nome simples, nem é JSON
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const o = parsed as Record<string, unknown>;
  if (typeof o.providerID !== 'string') return raw;
  const model = typeof o.modelID === 'string' ? o.modelID : typeof o.id === 'string' ? o.id : '';
  return model ? `${o.providerID}/${model}` : raw;
}

/**
 * Converte as linhas da query em sessões, pulando as sem id/diretório string ou sem tempos
 * numéricos. String vazia vira []; JSON inválido propaga o erro.
 */
export function parseSessions(json: string): OpenCodeSession[] {
  if (json === '') return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: OpenCodeSession[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.directory !== 'string') continue;
    if (typeof r.time_created !== 'number' || typeof r.time_updated !== 'number') continue;
    // active (inferido): a última mensagem é do usuário, ou a resposta do assistente ainda não acabou.
    const active = r.last_role === 'user' || (r.last_role === 'assistant' && (r.last_completed === null || r.last_completed === undefined));
    const s: OpenCodeSession = {
      id: r.id,
      directory: r.directory,
      inferred: active ? 'active' : 'idle',
      error: !!r.last_error,
      startedAt: r.time_created,
      updatedAt: r.time_updated,
      tokensIn: numOrZero(r.tokens_input) + numOrZero(r.tokens_cache_read) + numOrZero(r.tokens_cache_write),
      tokensOut: numOrZero(r.tokens_output) + numOrZero(r.tokens_reasoning),
      costUSD: numOrZero(r.cost),
    };
    if (typeof r.last_provider === 'string' && typeof r.last_model === 'string') {
      s.model = `${r.last_provider}/${r.last_model}`;
    } else if (typeof r.model === 'string') {
      s.model = sessionModel(r.model);
    }
    if (typeof r.agent === 'string') s.agent = r.agent;
    out.push(s);
  }
  return out;
}
