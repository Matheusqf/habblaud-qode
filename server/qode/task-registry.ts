/** HB-INT-01 — registo mínimo de tarefas (cooperativo, local, opt-in).
 * Um owner por tarefa, versão monotónica, transições rastreáveis e idempotência por message_id.
 * Não executa nada: `start` apenas regista UMA execução autorizada por tarefa/versão; quem executa é o owner.
 * Não lê hubs, transcripts, snapshots nem conteúdo de mensagens: só metadados nominais abaixo.
 */
import {closeSync, constants, fstatSync, openSync, readSync, renameSync, writeFileSync} from 'node:fs';

export type TaskStatus = 'open' | 'claimed' | 'running' | 'submitted' | 'blocked' | 'done';
export type ApprovalState = 'none' | 'pending_review' | 'approved' | 'changes_requested';
export type Origin = 'manual' | 'automated';
/** Identidade imutável da candidata: head (commit) e/ou patch_sha256 (delta sem commit). Pelo menos um é obrigatório. */
export interface Evidence {head: string | null; patch_sha256: string | null; ref: string}
export interface Review {reviewer: string; verdict: 'approved' | 'changes_requested'; head: string | null; patch_sha256: string | null; ref: string}
export interface Task {
  task_id: string; project: string; owner: string | null; status: TaskStatus; blocker: string | null;
  approval_state: ApprovalState; version: number; updated_at: string; evidence: Evidence | null; review: Review | null; origin: Origin;
  /** Estado antes do bloqueio; o desbloqueio repõe-no (nunca salta para running). */
  blocked_from?: 'claimed' | 'running' | null;
}
export interface Transition {message_id: string; task_id: string; version: number; op: Op; actor: string; at: string; outcome: 'applied'}
export interface Execution {task_id: string; version: number; message_id: string; executor: string; at: string}
export interface RegistryState {schema_version: 1; tasks: Record<string, Task>; seen: Record<string, string>; transitions: Transition[]; executions: Execution[]}
export type Op = 'create' | 'claim' | 'start' | 'submit' | 'block' | 'unblock' | 'review' | 'complete';
export interface Message {
  message_id: string; task_id: string; op: Op; actor: string; at: string; origin: Origin;
  /** Versão que o remetente observou. Diferente da atual => stale, nada é aplicado. */
  expected_version: number;
  project?: string; owner?: string; blocker?: string; evidence?: Evidence; verdict?: Review['verdict']; ref?: string;
}
export type Outcome =
  | {outcome: 'applied'; task: Task; execution: Execution | null}
  | {outcome: 'duplicate'; previous: string}
  | {outcome: 'rejected'; reason: string};

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TASK = /^[A-Z][A-Z0-9]{1,15}-[A-Z0-9]{1,15}-\d{2,4}$/;
const MSG = /^[a-z0-9][a-z0-9:._/-]{0,127}$/;
const HEAD = /^[0-9a-f]{7,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const validEvidence = (e: unknown): e is Evidence => !!e && typeof e === 'object' && !Array.isArray(e)
  && typeof (e as Evidence).ref === 'string' && REF.test((e as Evidence).ref)
  && ((e as Evidence).head === null || (typeof (e as Evidence).head === 'string' && HEAD.test((e as Evidence).head!)))
  && ((e as Evidence).patch_sha256 === null || (typeof (e as Evidence).patch_sha256 === 'string' && SHA256.test((e as Evidence).patch_sha256!)))
  && ((e as Evidence).head !== null || (e as Evidence).patch_sha256 !== null);
const sameCandidate = (a: Evidence, b: Evidence) => a.head === b.head && a.patch_sha256 === b.patch_sha256;
/** Referências permitidas: thread/mensagem Slack por ID ou PR GitHub. Nada de URL livre/caminho local. */
const REF = /^(slack:C[A-Z0-9]{5,15}\/\d{10}\.\d{6}|github:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#\d{1,7})$/;
const BLOCKER = /^[a-z][a-z0-9_]{0,47}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Data inválida (ex.: mês 13) dá NaN: rejeita ANTES de toISOString (que lançaria RangeError). */
const okAt = (v: unknown): v is string => {
  if (typeof v !== 'string' || !AT.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v.replace('Z', '.000Z');
};
export const emptyRegistry = (): RegistryState => ({schema_version: 1, tasks: {}, seen: {}, transitions: [], executions: []});

function validMessage(m: Message): string | null {
  if (!m || typeof m !== 'object') return 'malformed';
  if (typeof m.message_id !== 'string' || !MSG.test(m.message_id)) return 'message_id';
  if (typeof m.task_id !== 'string' || !TASK.test(m.task_id)) return 'task_id';
  if (typeof m.actor !== 'string' || !ID.test(m.actor)) return 'actor';
  if (!okAt(m.at)) return 'at';
  if (m.origin !== 'manual' && m.origin !== 'automated') return 'origin';
  if (!Number.isInteger(m.expected_version) || m.expected_version < 0) return 'expected_version';
  if (m.evidence !== undefined && !validEvidence(m.evidence)) return 'evidence';
  if (m.ref !== undefined && !REF.test(m.ref)) return 'ref';
  return null;
}

/** Há uma execução registada (via start) para esta tarefa no ciclo atual (versão ≤ atual). */
const hasExecution = (s: RegistryState, task: string, version: number) => s.executions.some(e => e.task_id === task && e.version <= version);

/** Pura: devolve novo estado; o original nunca é mutado. */
export function applyMessage(state: RegistryState, m: Message): {state: RegistryState; result: Outcome} {
  const bad = validMessage(m);
  if (bad) return {state, result: {outcome: 'rejected', reason: `invalid:${bad}`}};
  if (Object.hasOwn(state.seen, m.message_id)) return {state, result: {outcome: 'duplicate', previous: state.seen[m.message_id]}};
  const cur = state.tasks[m.task_id];
  const reject = (reason: string) => ({state, result: {outcome: 'rejected', reason} as Outcome});
  if (m.op === 'create') { if (cur) return reject('exists'); }
  else if (!cur) return reject('unknown_task');
  const version = cur ? cur.version : 0;
  if (m.expected_version !== version) return reject(`stale:expected=${m.expected_version},current=${version}`);
  if (cur && Date.parse(m.at) < Date.parse(cur.updated_at)) return reject('stale:older_than_task');
  let next: Task; let execution: Execution | null = null;
  const base = (t: Task): Task => ({...t, version: version + 1, updated_at: m.at, origin: m.origin});
  switch (m.op) {
    case 'create':
      if (typeof m.project !== 'string' || !ID.test(m.project)) return reject('project');
      next = {task_id: m.task_id, project: m.project, owner: null, status: 'open', blocker: null, approval_state: 'none', version: 1, updated_at: m.at, evidence: null, review: null, origin: m.origin};
      break;
    case 'claim':
      if (typeof m.owner !== 'string' || !ID.test(m.owner)) return reject('owner');
      if (cur!.owner && cur!.owner !== m.owner) return reject('owned_by_other'); // sem takeover implícito
      if (cur!.status !== 'open') return reject('not_open');
      next = {...base(cur!), owner: m.owner, status: 'claimed'}; break;
    case 'start':
      if (m.actor !== cur!.owner) return reject('not_owner');
      if (cur!.status !== 'claimed' && !(cur!.status === 'submitted' && cur!.approval_state === 'changes_requested')) return reject('not_startable');
      next = {...base(cur!), status: 'running', approval_state: 'none'};
      execution = {task_id: m.task_id, version: next.version, message_id: m.message_id, executor: m.actor, at: m.at};
      break;
    case 'submit':
      if (m.actor !== cur!.owner) return reject('not_owner');
      if (cur!.status !== 'running' || !m.evidence) return reject('not_running_or_no_evidence');
      if (!hasExecution(state, m.task_id, version)) return reject('no_tracked_execution');
      next = {...base(cur!), status: 'submitted', approval_state: 'pending_review', evidence: {head: m.evidence.head, patch_sha256: m.evidence.patch_sha256, ref: m.evidence.ref}, review: null}; break;
    case 'block':
      if (m.actor !== cur!.owner || typeof m.blocker !== 'string' || !BLOCKER.test(m.blocker)) return reject('block');
      if (cur!.status !== 'claimed' && cur!.status !== 'running') return reject('not_blockable');
      next = {...base(cur!), status: 'blocked', blocker: m.blocker, blocked_from: cur!.status}; break;
    case 'unblock': {
      if (m.actor !== cur!.owner || cur!.status !== 'blocked') return reject('unblock');
      const prev = cur!.blocked_from;
      if (prev !== 'claimed' && prev !== 'running') return reject('unknown_blocked_from');
      next = {...base(cur!), status: prev, blocker: null, blocked_from: null}; break;
    }
    case 'review': // revisão separada: revisor ≠ owner e vinculada ao head submetido
      if (cur!.status !== 'submitted' || cur!.approval_state !== 'pending_review') return reject('not_pending_review');
      if (m.actor === cur!.owner) return reject('self_review');
      if (m.verdict !== 'approved' && m.verdict !== 'changes_requested') return reject('verdict');
      if (!m.ref) return reject('ref');
      // A revisão tem de nomear exatamente a mesma candidata imutável submetida (head E patch_sha256).
      if (!cur!.evidence || !validEvidence(cur!.evidence)) return reject('no_submitted_candidate');
      if (!m.evidence || !sameCandidate(m.evidence, cur!.evidence)) return reject('candidate_mismatch');
      next = {...base(cur!), approval_state: m.verdict, review: {reviewer: m.actor, verdict: m.verdict, head: cur!.evidence.head, patch_sha256: cur!.evidence.patch_sha256, ref: m.ref}}; break;
    case 'complete':
      if (cur!.approval_state !== 'approved' || cur!.status !== 'submitted') return reject('not_approved');
      if (!cur!.review || cur!.review.verdict !== 'approved' || cur!.review.reviewer === cur!.owner) return reject('no_separate_review');
      if (!cur!.evidence || cur!.review.head !== cur!.evidence.head || cur!.review.patch_sha256 !== cur!.evidence.patch_sha256) return reject('candidate_mismatch');
      if (!hasExecution(state, m.task_id, version)) return reject('no_tracked_execution');
      if (m.actor !== cur!.review.reviewer) return reject('not_reviewer');
      next = {...base(cur!), status: 'done'}; break;
    default: return reject('op');
  }
  const transition: Transition = {message_id: m.message_id, task_id: m.task_id, version: next.version, op: m.op, actor: m.actor, at: m.at, outcome: 'applied'};
  return {
    state: {schema_version: 1, tasks: {...state.tasks, [m.task_id]: next}, seen: {...state.seen, [m.message_id]: `${m.task_id}@${next.version}`},
      transitions: [...state.transitions, transition], executions: execution ? [...state.executions, execution] : state.executions},
    result: {outcome: 'applied', task: next, execution},
  };
}

/** DTO do painel: allowlist explícita; nada do estado interno (seen/executions/actors) sai. */
export interface TaskCard {
  task_id: string; project: string; owner: string | null; status: TaskStatus; blocker: string | null; approval_state: ApprovalState;
  version: number; updated_at: string; head: string | null; patch_sha256: string | null; evidence_ref: string | null; reviewer: string | null; review_ref: string | null;
  origin: Origin; executions: number;
}
/** Identidades conhecidas da POC. Valores de owner/reviewer fora desta lista não são projetados (fail closed). */
export const DEFAULT_IDENTITIES = ['grok-bot', 'socio-bot', 'zikabot', 'matheus'] as const;
/** Bloqueios conhecidos; valor fora da lista é mostrado como 'other' (não ecoa texto livre). */
export const BLOCKERS = ['needs_permission', 'needs_review', 'needs_human', 'policy_denied', 'upstream_flaky', 'other'] as const;
/** Regex só em string de verdade (sem coerção: ['HB-INT-01'] não passa). */
const str = (re: RegExp, v: unknown): v is string => typeof v === 'string' && re.test(v);
export function projectTasks(state: unknown, allow: {projects: readonly string[]; identities?: readonly string[]}): TaskCard[] | null {
  const ids = allow.identities ?? DEFAULT_IDENTITIES;
  if (!state || typeof state !== 'object' || (state as RegistryState).schema_version !== 1) return null;
  const s = state as RegistryState; const out: TaskCard[] = [];
  for (const t of Object.values(s.tasks ?? {})) {
    if (!t || !str(TASK, t.task_id) || !str(ID, t.project) || !allow.projects.includes(t.project)) continue;
    if (!(t.owner === null || (typeof t.owner === 'string' && ids.includes(t.owner))) || !(t.blocker === null || (str(BLOCKER, t.blocker))) || !okAt(t.updated_at) || !Number.isInteger(t.version)) continue;
    if (!['open','claimed','running','submitted','blocked','done'].includes(t.status) || !['none','pending_review','approved','changes_requested'].includes(t.approval_state)) continue;
    const head = t.evidence && str(HEAD, t.evidence.head) ? t.evidence.head : null;
    out.push({task_id: t.task_id, project: t.project, owner: t.owner, status: t.status, blocker: t.blocker === null ? null : ((BLOCKERS as readonly string[]).includes(t.blocker) ? t.blocker : 'other'), approval_state: t.approval_state,
      version: t.version, updated_at: t.updated_at, head, patch_sha256: t.evidence && str(SHA256, t.evidence.patch_sha256) ? t.evidence.patch_sha256 : null, evidence_ref: t.evidence && str(REF, t.evidence.ref) ? t.evidence.ref : null,
      reviewer: t.review && typeof t.review.reviewer === 'string' && ids.includes(t.review.reviewer) ? t.review.reviewer : null, review_ref: t.review && str(REF, t.review.ref) ? t.review.ref : null,
      // Não existe prova verificável de ingestão automática nesta POC: a origem projetada é SEMPRE 'manual',
      // independentemente da string de entrada. Mudar isto exige um verificador (ex.: assinatura do evento), não um campo.
      origin: 'manual', executions: (s.executions ?? []).filter(e => e.task_id === t.task_id).length});
  }
  return out.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

const MAX = 64 * 1024;
export function readRegistry(file: string): RegistryState {
  let fd: number;
  // O_NONBLOCK: uma FIFO/dispositivo no caminho não bloqueia o open; o tipo é validado logo a seguir.
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry(); throw e; }
  try {
    const st = fstatSync(fd); if (!st.isFile()) throw Error('registry not a regular file'); if (st.size > MAX) throw Error('registry too large');
    const buf = Buffer.alloc(st.size); const n = readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buf.subarray(0, n)));
    if (v?.schema_version !== 1) throw Error('schema'); return v as RegistryState;
  } finally { closeSync(fd); }
}
/** Escrita atómica (tmp + rename). Cooperativo: não protege contra escritor fora do protocolo. */
export function writeRegistry(file: string, state: RegistryState): void {
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 1), {mode: 0o600, flag: 'wx'}); renameSync(tmp, file);
}
