// Fork QODE: filtro de privacidade por allowlist. Agente privado (sala de projeto privado, contaminado por citar um
// caminho privado, ou subagente sem principal conhecido) só sai com os campos marcados 'keep' abaixo; o resto some ou
// vira texto genérico. As tabelas são Record<keyof Tipo, ...>: um campo novo do upstream quebra o typecheck até alguém
// decidir se ele pode passar.
import type { Activity, ActivityKind, AgentDetail, AgentInfo, AgentStats, FeedItem, Notice, OfficeSnapshot, RoomInfo } from '../../shared/types';
import type { OfficePrivacy } from '../model/office';
import { isPrivateRoom, lexical, mentionsPrivate, type QodeConfig } from './config';

type Rule = 'keep' | 'drop' | 'generic';

export const AGENT_RULES: Record<keyof AgentInfo, Rule> = {
  id: 'keep',
  kind: 'keep',
  provider: 'keep',
  parentId: 'keep',
  roomId: 'keep',
  name: 'keep',
  look: 'keep',
  role: 'generic',
  title: 'drop',
  // Agente cloud: já sanitizado pelo contrato server/cloud (allowlist + só id/estado/hora/link validado).
  cloud: 'keep',
  sessionId: 'keep',
  account: 'keep',
  status: 'keep',
  waitingFor: 'generic',
  activity: 'generic',
  recent: 'generic',
  tasks: 'generic',
  shells: 'drop',
  model: 'drop',
  gitBranch: 'drop',
  permissionMode: 'drop',
  startedAt: 'keep',
  lastEventAt: 'keep',
  statusSince: 'keep',
  stats: 'generic',
  seed: 'keep',
  parts: 'keep',
  custom: 'keep',
  background: 'keep',
  permission: 'drop',
  canMessage: 'drop',
  observed: 'keep',
};

export const ACTIVITY_RULES: Record<keyof Activity, Rule> = {
  id: 'keep',
  kind: 'keep',
  icon: 'keep',
  text: 'generic',
  detail: 'drop',
  tool: 'drop',
  at: 'keep',
  durationMs: 'keep',
  error: 'keep',
  questions: 'drop',
};

export const ROOM_RULES: Record<keyof RoomInfo, Rule> = {
  id: 'keep',
  name: 'keep',
  path: 'generic',
  slot: 'keep',
  seed: 'keep',
  createdAt: 'keep',
  effect: 'drop',
};

export const FEED_RULES: Record<keyof FeedItem, Rule> = {
  id: 'keep',
  agentId: 'keep',
  roomId: 'keep',
  agentName: 'keep',
  roomName: 'keep',
  account: 'keep',
  activity: 'generic',
};

export const NOTICE_RULES: Record<keyof Notice, Rule> = {
  id: 'keep',
  level: 'keep',
  text: 'generic',
  agentId: 'keep',
  roomId: 'keep',
  at: 'keep',
};

/** Campos do snapshot e do meta: não carregam conteúdo de agente, mas um campo novo precisa ser revisto aqui. */
export const SNAPSHOT_RULES: Record<keyof OfficeSnapshot, 'keep' | 'filter'> = {
  rev: 'keep',
  serverTime: 'keep',
  rooms: 'filter',
  agents: 'filter',
  ptys: 'filter',
  accounts: 'keep',
  meta: 'keep',
};

export const META_RULES: Record<keyof OfficeSnapshot['meta'], 'keep'> = {
  demo: 'keep',
  sources: 'keep',
  startedAt: 'keep',
  version: 'keep',
  build: 'keep',
  terminal: 'keep',
  messages: 'keep',
  pty: 'keep',
  updates: 'keep',
  world: 'keep',
};

const KIND_TEXT: Record<ActivityKind, string> = {
  prompt: 'Recebeu uma instrução',
  think: 'Pensando',
  respond: 'Respondendo',
  read: 'Lendo',
  search: 'Buscando',
  edit: 'Editando',
  write: 'Escrevendo',
  run: 'Rodando um comando',
  test: 'Rodando testes',
  git: 'Usando o git',
  web: 'Na web',
  browser: 'No navegador',
  plan: 'Planejando',
  delegate: 'Delegando',
  communicate: 'Comunicando',
  ask: 'Pergunta no terminal',
  mcp: 'Usando uma ferramenta',
  skill: 'Usando uma skill',
  wait: 'Esperando',
  error: 'Erro',
  compact: 'Compactando o contexto',
  done: 'Concluiu',
  other: 'Trabalhando',
};

export const PRIVATE_TEXT = '🔒 Atividade em projeto privado';
export const PRIVATE_WAITING = 'responder no terminal';

const ZERO_STATS: AgentStats = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };

function pick<T extends object>(src: T, rules: Record<keyof T, Rule | 'filter'>, generic: (k: keyof T, v: T[keyof T]) => unknown): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rules) as Array<keyof T>) {
    const rule = rules[k];
    const v = src[k];
    if (v === undefined || rule === 'drop') continue;
    out[k as string] = rule === 'keep' ? v : generic(k, v);
  }
  return out as T;
}

export function privateActivity(a: Activity): Activity {
  return pick(a, ACTIVITY_RULES, () => KIND_TEXT[a.kind] ?? KIND_TEXT.other);
}

export function privateAgent(a: AgentInfo): AgentInfo {
  const out = pick(a, AGENT_RULES, (k, v) => {
    switch (k) {
      case 'waitingFor':
        return PRIVATE_WAITING;
      case 'activity':
        return privateActivity(v as Activity);
      case 'recent':
        return (v as Activity[]).map(privateActivity);
      case 'tasks':
        return [];
      case 'stats':
        return { ...ZERO_STATS };
      case 'role':
        return a.kind === 'main' ? 'Agente principal' : 'Subagente';
      default:
        return undefined;
    }
  });
  out.tasks ??= [];
  out.recent ??= [];
  out.stats ??= { ...ZERO_STATS };
  return out;
}

export function privateRoom(r: RoomInfo): RoomInfo {
  return pick(r, ROOM_RULES, () => r.name);
}

export function privateFeed(f: FeedItem): FeedItem {
  return pick(f, FEED_RULES, () => privateActivity(f.activity));
}

export function privateNotice(n: Notice): Notice {
  return pick(n, NOTICE_RULES, () => PRIVATE_TEXT);
}

export interface PrivacyDeps {
  /** Agente real ou do demo pelo id. */
  agent: (id: string) => AgentInfo | undefined;
  /** Agentes reais presentes (para contaminar a família inteira). */
  agents: () => AgentInfo[];
  /** Algo ficou privado: o snapshot precisa ser refeito. */
  changed: () => void;
}

const MAX_HOPS = 16;

export class Privacy implements OfficePrivacy {
  /** Agentes que citaram um caminho privado, e as famílias deles (pegajoso: não volta a ser público). */
  private tainted = new Set<string>();
  /** Quem já foi visto como privado (vale para o feed e os avisos de quem já saiu). */
  private seen = new Set<string>();
  /** Sessões que citaram um caminho privado, mesmo antes de o agente delas aparecer no escritório. */
  private taintedSessions = new Set<string>();
  /** Agentes já classificados como públicos enquanto presentes, com a sessão deles (F6: quem nunca foi visto é privado). */
  private publicSeen = new Map<string, string | undefined>();
  /** Há o que esconder: algum projeto privado, ou a config inválida (tudo privado). */
  readonly active: boolean;
  private readonly homeLower: string;

  constructor(
    readonly cfg: QodeConfig,
    private readonly deps: PrivacyDeps,
  ) {
    this.active = !!cfg.invalid || cfg.privateRoots.length > 0;
    this.homeLower = lexical(cfg.home).toLowerCase();
  }

  mentions(text: string | undefined): boolean {
    return mentionsPrivate(this.cfg, text);
  }

  roomPrivate(roomId: string): boolean {
    return isPrivateRoom(this.cfg, roomId);
  }

  /** Privado: sala privada, família contaminada, config inválida ou cadeia de pais quebrada (na dúvida, privado). */
  isPrivate(id: string, lookup: (id: string) => AgentInfo | undefined = this.deps.agent): boolean {
    if (!this.active) return false;
    if (this.cfg.invalid || this.tainted.has(id) || this.seen.has(id)) return this.mark(id);
    let cur = lookup(id);
    if (!cur) return true;
    for (let hops = 0; hops <= MAX_HOPS; hops++) {
      // F8: um ancestral já visto como privado (p.ex. órfão que depois ganhou pai) continua a contaminar.
      if (this.tainted.has(cur.id) || this.seen.has(cur.id) || this.taintedSessions.has(cur.sessionId) || this.roomPrivate(cur.roomId)) return this.mark(id);
      if (cur.kind === 'main') {
        const self = lookup(id);
        this.publicSeen.set(id, self?.sessionId);
        return false;
      }
      if (!cur.parentId) return this.mark(id);
      const parent: AgentInfo | undefined = lookup(cur.parentId);
      if (!parent) return this.mark(id);
      cur = parent;
    }
    return this.mark(id);
  }

  private mark(id: string): true {
    this.seen.add(id);
    return true;
  }

  /** Agente que já saiu do escritório: vale o que se sabia dele e a sala. */
  private refPrivate(agentId: string | undefined, roomId: string | undefined): boolean {
    if (!this.active) return false;
    if (this.cfg.invalid) return true;
    if (roomId && this.roomPrivate(roomId)) return true;
    if (!agentId) return false;
    if (this.deps.agent(agentId)) return this.isPrivate(agentId);
    if (this.tainted.has(agentId) || this.seen.has(agentId)) return true;
    // F6: agente ausente nunca classificado como público, ou cuja sessão foi contaminada depois: na dúvida, privado.
    if (!this.publicSeen.has(agentId)) return true;
    const session = this.publicSeen.get(agentId);
    return !!session && this.taintedSessions.has(session);
  }

  /** Contamina o agente e a família toda (do principal aos subagentes). */
  taint(id: string): void {
    let root = id;
    let cur = this.deps.agent(id);
    for (let hops = 0; cur?.parentId && hops <= MAX_HOPS; hops++) {
      root = cur.parentId;
      cur = this.deps.agent(cur.parentId);
    }
    const before = this.tainted.size + this.taintedSessions.size;
    this.tainted.add(id).add(root);
    // P1-b: a marca também fica presa à sessão (vida do servidor). Remover o agente e recriá-lo
    // com a mesma sessão (troca de processo no watcher) não pode torná-lo público de novo.
    const own = this.deps.agent(id);
    if (own?.sessionId) this.taintedSessions.add(own.sessionId);
    const all = this.deps.agents();
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const a of all) {
      let p: AgentInfo | undefined = a;
      for (let hops = 0; p && hops <= MAX_HOPS; hops++) {
        if (p.id === root) {
          this.tainted.add(a.id);
          if (a.sessionId) this.taintedSessions.add(a.sessionId);
          break;
        }
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
    }
    if (this.tainted.size + this.taintedSessions.size !== before) this.deps.changed();
  }

  /** Pedido de permissão ou sessão que citou um caminho privado: contamina os agentes da sessão. */
  taintSession(sessionId: string, hookAgentId?: string): void {
    this.taintedSessions.add(sessionId);
    if (hookAgentId) {
      this.taintedSessions.add(hookAgentId);
      this.tainted.add(`${sessionId}:${hookAgentId}`);
    }
    for (const a of this.deps.agents()) {
      if (a.sessionId === sessionId || (hookAgentId && (a.id === `${sessionId}:${hookAgentId}` || a.sessionId === hookAgentId))) this.taint(a.id);
    }
    this.deps.changed();
  }

  /** A sessão foi contaminada ou tem algum agente privado presente. */
  sessionPrivate(sessionId: string): boolean {
    if (!this.active) return false;
    if (this.cfg.invalid || this.taintedSessions.has(sessionId)) return true;
    return this.deps.agents().some((a) => a.sessionId === sessionId && this.isPrivate(a.id));
  }

  observe(agentId: string, texts: ReadonlyArray<string | undefined>): void {
    if (this.tainted.has(agentId)) return;
    if (texts.some((t) => this.mentions(t))) this.taint(agentId);
  }

  snapshot(s: OfficeSnapshot): OfficeSnapshot {
    const byId = new Map(s.agents.map((a) => [a.id, a]));
    const lookup = (id: string) => byId.get(id) ?? this.deps.agent(id);
    const priv = new Set(s.agents.filter((a) => this.isPrivate(a.id, lookup)).map((a) => a.id));
    const hidesEffect = new Set(s.agents.filter((a) => priv.has(a.id)).map((a) => a.roomId));
    const rooms = s.rooms.map((r) => {
      if (this.roomPrivate(r.id)) return privateRoom(r);
      if (r.effect && hidesEffect.has(r.id)) {
        const { effect: _effect, ...rest } = r;
        return rest;
      }
      return r;
    });
    const agents = s.agents.map((a) => (priv.has(a.id) ? privateAgent(a) : a));
    const ptys = this.cfg.invalid
      ? []
      : (s.ptys ?? []).filter((p) => !priv.has(p.agentId) && !(p.fromAgent && priv.has(p.fromAgent)) && !this.mentions(p.cwd));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(SNAPSHOT_RULES) as Array<keyof OfficeSnapshot>) {
      out[k] = k === 'rooms' ? rooms : k === 'agents' ? agents : k === 'ptys' ? ptys : s[k];
    }
    return out as unknown as OfficeSnapshot;
  }

  feed(items: FeedItem[]): FeedItem[] {
    return items.map((f) => (this.refPrivate(f.agentId, f.roomId) ? privateFeed(f) : f));
  }

  notices(items: Notice[]): Notice[] {
    return items.map((n) => (this.refPrivate(n.agentId, n.roomId) ? privateNotice(n) : n));
  }

  detail(d: AgentDetail): AgentDetail {
    if (!this.isPrivate(d.agent.id)) return d;
    return { agent: privateAgent(d.agent), history: d.history.map(privateActivity) };
  }

  /**
   * Tira os caminhos privados de uma linha de log: do primeiro trecho que cita um deles até o fim da linha (o resto
   * do caminho, com espaços ou não, também some). Com a config inválida, vale para qualquer caminho dentro da home.
   */
  redact(msg: string): string {
    if (!this.active) return msg;
    const re = /\S+/g;
    for (let m = re.exec(msg); m; m = re.exec(msg)) {
      if (this.redactChunk(m[0])) return `${msg.slice(0, m.index)}[privado]`;
    }
    return this.cfg.invalid || !this.mentions(msg) ? msg : '[privado: linha de log omitida]';
  }

  private redactChunk(chunk: string): boolean {
    if (!this.cfg.invalid) return this.mentions(chunk);
    const lower = chunk.toLowerCase();
    return lower.includes(this.homeLower) || /(^|[^\w])~|\$\{?home/.test(lower) || lower.includes('/volumes/');
  }
}
