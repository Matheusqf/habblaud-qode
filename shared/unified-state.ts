// Estados unificados (observe-only): uma taxonomia comum para Claude Code, Codex e Cursor.
// Ideia inspirada no ClaudeVille (honorstudio/claude-ville, sem LICENSE no repo: nenhum código copiado).
// Código puro: cada ferramenta tem um adaptador que traduz o que a fonte expõe para os 6 estados.
import type { ActivityKind, AgentInfo } from './types';

/** 'inferred' = fonte sem estado ao vivo (AgentInfo.observed): nunca vira 'done' por falta de evidência. */
export type UnifiedState = 'reading' | 'editing' | 'command' | 'waiting' | 'error' | 'done' | 'inferred';

export const UNIFIED_STATES: readonly UnifiedState[] = ['reading', 'editing', 'command', 'waiting', 'error', 'done', 'inferred'];

export const UNIFIED_LABEL: Readonly<Record<UnifiedState, string>> = {
  reading: 'Lendo',
  editing: 'Editando',
  command: 'Rodando comando',
  waiting: 'Esperando',
  error: 'Erro',
  done: 'Feito',
  inferred: 'Inferido (sem estado ao vivo)',
};

export const UNIFIED_ICON: Readonly<Record<UnifiedState, string>> = {
  reading: '📖',
  editing: '✏️',
  command: '⌨️',
  waiting: '✋',
  error: '⚠️',
  done: '✅',
  inferred: '❔',
};

type AgentLike = Pick<AgentInfo, 'status' | 'activity'> & { provider?: string; observed?: AgentInfo['observed'] };
type Adapter = (a: AgentLike) => UnifiedState;

const KIND_TO_STATE: Partial<Record<ActivityKind, UnifiedState>> = {
  read: 'reading',
  search: 'reading',
  web: 'reading',
  browser: 'reading',
  think: 'reading',
  prompt: 'reading',
  plan: 'editing',
  edit: 'editing',
  write: 'editing',
  respond: 'editing',
  run: 'command',
  test: 'command',
  git: 'command',
  mcp: 'command',
  skill: 'command',
  delegate: 'command',
  ask: 'waiting',
  wait: 'waiting',
  error: 'error',
  done: 'done',
};

/** Base comum: status de alto nível primeiro, depois o tipo da atividade atual. */
function base(a: AgentLike): UnifiedState {
  // Atividade só inferida (ativa, desconhecida, ociosa ou leitura desatualizada): nunca 'Feito'.
  // Erro só com evidência explícita gravada e leitura em dia; stale volta a 'inferred'.
  if (a.observed) return a.observed.error && !a.observed.stale ? 'error' : 'inferred';
  if (a.status === 'waiting') return 'waiting';
  if (a.status === 'shell') return 'command';
  if (a.status === 'done' || a.status === 'offline' || a.status === 'idle') return a.activity?.error ? 'error' : 'done';
  const act = a.activity;
  if (!act) return 'reading';
  if (act.error) return 'error';
  return KIND_TO_STATE[act.kind] ?? 'reading';
}

/** Codex: as chamadas de shell chegam como "exec"/"shell" mesmo quando editam (apply_patch). */
const codex: Adapter = (a) => {
  const tool = a.activity?.tool ?? '';
  if (a.status === 'working' && /apply_patch/i.test(tool)) return 'editing';
  return base(a);
};

/** Cursor: ainda não há fonte no servidor; quando houver, os nomes das ferramentas do agente do Cursor mapeiam assim. */
const cursor: Adapter = (a) => {
  const tool = a.activity?.tool ?? '';
  if (a.status === 'working') {
    if (/^(edit_file|search_replace|write|apply_patch|delete_file)$/i.test(tool)) return 'editing';
    if (/^(run_terminal_cmd|shell)$/i.test(tool)) return 'command';
    if (/^(read_file|codebase_search|grep|list_dir|file_search|web_search)$/i.test(tool)) return 'reading';
  }
  return base(a);
};

const ADAPTERS: Record<string, Adapter> = { claude: base, codex, cursor };

export function unifiedState(a: AgentLike): UnifiedState {
  return (ADAPTERS[a.provider ?? 'claude'] ?? base)(a);
}

/** Ficheiro que o agente lê/edita agora (o detalhe já vem mascarado pelo servidor e pelo filtro de privacidade QODE). */
export function currentFile(a: Pick<AgentInfo, 'activity'>): string | null {
  const act = a.activity;
  if (!act?.detail) return null;
  if (act.kind !== 'read' && act.kind !== 'edit' && act.kind !== 'write') return null;
  return act.detail.split('\n')[0]!.slice(0, 120);
}
