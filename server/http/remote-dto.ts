// DTO da entrada remota só-leitura (review ZikaBOT #13/#14): allowlist explícita para TODOS os agentes — locais,
// subagentes e cloud —, aplicada POR CIMA do filtro de privacidade QODE (que já correu no Office.commit).
//
// - Tabelas Record<keyof Tipo, ...>: um campo novo do upstream quebra o typecheck até alguém decidir aqui.
// - Ids (agente, sala, sessão, conta, atividade) viram opacos (HMAC com segredo do processo): caminhos locais que
//   servem de id/path de sala (roomKey de projeto público ou cwd fora do qode.config) e ids de sessão não saem.
// - Texto livre nunca sai: atividade = texto genérico do tipo (privateActivity), aviso = texto genérico do nível,
//   sem títulos, tarefas, histórico, shells, modelo, branch, permissões, e-mails, configDir nem fontes.
// - meta.terminal/messages = false: o cliente remoto não oferece ações operacionais.
import { createHmac, randomBytes } from 'node:crypto';
import type { AccountInfo, Activity, AgentInfo, FeedItem, Notice, NoticeLevel, OfficeSnapshot, RoomInfo } from '../../shared/types';
import { privateActivity } from '../qode/privacy';

type Rule<T, K extends keyof T> = 'keep' | 'drop' | ((v: T[K], o: T) => T[K] | undefined);
type Rules<T> = { [K in keyof T]-?: Rule<T, K> };

const ZERO_STATS: AgentInfo['stats'] = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };

const NOTICE_TEXT: Record<NoticeLevel, string> = {
  info: 'Atualização no escritório',
  success: 'Um agente terminou um turno',
  warn: 'Aviso no escritório',
  alert: 'Um agente precisa de atenção no computador local',
};

function pick<T extends object>(o: T, rules: Rules<T>): T {
  const out: Partial<T> = {};
  for (const k of Object.keys(rules) as Array<keyof T>) {
    const r = rules[k];
    if (r === 'drop' || o[k] === undefined) continue;
    const v = r === 'keep' ? o[k] : (r as (v: T[keyof T], o: T) => T[keyof T] | undefined)(o[k], o);
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export interface RemoteDto {
  snapshot(s: OfficeSnapshot): OfficeSnapshot;
  feed(items: readonly FeedItem[]): FeedItem[];
  notice(n: Notice): Notice;
}

export function createRemoteDto(secret: Buffer = randomBytes(32)): RemoteDto {
  const opaque = (prefix: string, v: string) => `${prefix}-${createHmac('sha256', secret).update(`${prefix}\0${v}`).digest('base64url').slice(0, 16)}`;
  const agentId = (v: string) => opaque('a', v);
  const roomId = (v: string) => opaque('s', v);

  const activity = (a: Activity): Activity => {
    const g = privateActivity(a);
    return pick({ ...g, id: opaque('t', a.id) }, ACTIVITY);
  };
  const ACTIVITY: Rules<Activity> = { id: 'keep', kind: 'keep', icon: 'keep', text: 'keep', detail: 'drop', tool: 'drop', at: 'keep', durationMs: 'keep', error: 'keep', questions: 'drop' };

  const AGENT: Rules<AgentInfo> = {
    id: (v) => agentId(v),
    kind: 'keep',
    provider: 'keep',
    parentId: (v) => (v ? agentId(v) : undefined),
    roomId: (v) => roomId(v),
    name: 'keep',
    look: 'keep',
    // Papel: só o genérico (agente cloud mostra o rótulo do contrato, sem texto livre).
    role: (v, a) => (a.cloud ? v : a.kind === 'main' ? 'Agente principal' : 'Subagente'),
    title: 'drop',
    cloud: (v) => (v ? { provider: v.provider, state: v.state, nativeState: v.nativeState, updatedAt: v.updatedAt } : undefined),
    sessionId: (v) => opaque('k', v),
    account: (v) => opaque('c', v),
    status: 'keep',
    waitingFor: (v) => (v ? 'responder no computador local' : undefined),
    activity: (v) => (v ? activity(v) : undefined),
    recent: () => [],
    tasks: () => [],
    shells: 'drop',
    model: 'drop',
    gitBranch: 'drop',
    permissionMode: 'drop',
    startedAt: 'keep',
    lastEventAt: 'keep',
    statusSince: 'keep',
    stats: () => ({ ...ZERO_STATS }),
    seed: 'keep',
    parts: 'keep',
    custom: 'keep',
    background: 'keep',
    permission: 'drop',
    canMessage: 'drop',
    observed: 'drop',
  };
  const ROOM: Rules<RoomInfo> = {
    id: (v) => roomId(v),
    // Nome já decidido pelo filtro QODE (sala privada = genérico). O caminho local NUNCA sai: vira o nome.
    name: 'keep',
    path: (_v, r) => r.name,
    slot: 'keep',
    seed: 'keep',
    createdAt: 'keep',
    effect: 'drop',
  };
  const ACCOUNT: Rules<AccountInfo> = {
    id: (v) => opaque('c', v),
    provider: 'keep',
    short: 'keep',
    name: 'keep',
    email: 'drop',
    organization: 'drop',
    plan: 'drop',
    color: 'keep',
    configDir: () => '',
    sessions: 'keep',
    usage: 'drop',
    usageStatus: () => 'disabled',
  };
  const META: Rules<OfficeSnapshot['meta']> = {
    demo: 'keep',
    sources: () => [],
    startedAt: 'keep',
    version: 'keep',
    build: 'keep',
    terminal: () => false,
    messages: () => false,
    updates: 'keep',
  };
  const SNAPSHOT: Rules<OfficeSnapshot> = {
    rev: 'keep',
    serverTime: 'keep',
    rooms: (v) => v.map((r) => pick(r, ROOM)),
    agents: (v) => v.map((a) => pick(a, AGENT)),
    accounts: (v) => v.map((a) => pick(a, ACCOUNT)),
    meta: (v) => pick(v, META),
  };
  const FEED: Rules<FeedItem> = {
    id: (v) => opaque('f', v),
    agentId: (v) => agentId(v),
    roomId: (v) => roomId(v),
    agentName: 'keep',
    roomName: 'keep',
    account: 'drop',
    activity: (v) => activity(v),
  };
  const NOTICE: Rules<Notice> = {
    id: (v) => opaque('n', v),
    level: 'keep',
    text: (_v, n) => NOTICE_TEXT[n.level] ?? NOTICE_TEXT.info,
    agentId: (v) => (v ? agentId(v) : undefined),
    roomId: (v) => (v ? roomId(v) : undefined),
    at: 'keep',
  };
  return {
    snapshot: (s) => pick(s, SNAPSHOT),
    feed: (items) => items.map((f) => pick(f, FEED)),
    notice: (n) => pick(n, NOTICE),
  };
}
