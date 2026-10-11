// Fork QODE: liga a configuração de projetos (config.ts) e o filtro de privacidade (privacy.ts) ao servidor.
// Tudo o que não passa pelo Office (terminal, histórico de sessões, permissões, mensagens e logs) é embrulhado aqui.
// Sem qode.config.json, cada embrulho devolve o original e nada muda.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Activity, AgentInfo, RecentSession } from '../../shared/types';
import { log, setLogFilter } from '../log';
import type { Office } from '../model/office';
import type { RoomAliases } from '../model/room-aliases';
import type { OfficeLike as MessageOffice } from '../messages/registry';
import type { OfficeLike as PermissionOffice, PermissionRegistry, RegisterResult } from '../permissions/registry';
import type { SessionLookup } from '../sources/source';
import { createTerminalParser, type TerminalParser } from '../sources/terminal';
import { isPrivatePath, loadQodeConfig, projectOf, type QodeConfig } from './config';
import { Privacy } from './privacy';

const SCAN_CHUNK = 1 << 20;
const SCAN_CACHE_MAX = 1_000;
export const PRIVATE_SESSION_ERROR = 'sessão de projeto privado: o Habblaud não mostra a conversa';

/** Procura caminhos privados num transcript, só nos bytes novos desde a última vez (o resultado positivo fica). */
export class TranscriptScanner {
  private cache = new Map<string, { offset: number; hit: boolean; carry: string; ino: number }>();
  private readonly needles: string[];
  private readonly keep: number;

  constructor(needles: readonly string[]) {
    this.needles = needles.map((n) => Buffer.from(n, 'utf8').toString('latin1').toLowerCase());
    this.keep = Math.max(0, ...this.needles.map((n) => n.length)) - 1;
  }

  mentions(path: string): boolean {
    if (!this.needles.length) return false;
    let size: number;
    let ino: number;
    try {
      const st = statSync(path);
      size = st.size;
      ino = st.ino;
    } catch {
      return false;
    }
    let e = this.cache.get(path);
    if (!e || size < e.offset || e.ino !== ino) {
      e = { offset: 0, hit: false, carry: '', ino };
      if (this.cache.size >= SCAN_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, e);
    }
    if (e.hit || size === e.offset) return e.hit;
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return false;
    }
    try {
      const buf = Buffer.alloc(SCAN_CHUNK);
      while (e.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(SCAN_CHUNK, size - e.offset), e.offset);
        if (n <= 0) break;
        e.offset += n;
        const text = e.carry + buf.toString('latin1', 0, n).toLowerCase();
        if (this.needles.some((x) => text.includes(x))) {
          e.hit = true;
          break;
        }
        e.carry = this.keep > 0 ? text.slice(-this.keep) : '';
      }
    } catch {
      // Ilegível agora: tenta de novo na próxima chamada.
    } finally {
      closeSync(fd);
    }
    return e.hit;
  }
}

type Routes = Pick<PermissionRegistry, 'register' | 'wait' | 'decide' | 'detail'>;
type OfficeView = PermissionOffice & MessageOffice;

export interface QodeSetup {
  config?: QodeConfig;
  privacy?: Privacy;
  roomOf?: (cwd: string) => string | undefined;
  transcriptPathOf(inner: (id: string) => string | undefined): (id: string) => string | undefined;
  parserFor(inner: (id: string) => TerminalParser | undefined): (id: string) => TerminalParser | undefined;
  history(inner: SessionLookup): SessionLookup;
  officeView(office: Office): OfficeView;
  permissionRoutes(inner: PermissionRegistry): Routes;
}

export interface QodeOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  home: string;
  roomAliases: RoomAliases;
  /** O Office (ligação tardia: ele recebe o filtro no construtor). */
  office: () => Office;
}

/** Parser que some quando a conversa fica privada (ou quando uma linha cita um caminho privado). */
function guardParser(base: TerminalParser, privacy: Privacy, blocked: () => boolean, hit: () => void): TerminalParser {
  return {
    push(line) {
      if (blocked()) return [];
      if (privacy.mentions(line)) {
        hit();
        return [];
      }
      return base.push(line);
    },
  };
}

export function setupQode(o: QodeOptions): QodeSetup {
  const cfg = loadQodeConfig(o.env, o.dataDir, o.home);
  if (!cfg) {
    log.info('QODE: sem qode.config.json; salas e privacidade como no upstream (veja qode/README.md).');
    return {
      transcriptPathOf: (inner) => inner,
      parserFor: (inner) => inner,
      history: (inner) => inner,
      officeView: (office) => office,
      permissionRoutes: (inner) => inner,
    };
  }
  if (cfg.invalid) {
    log.error(`QODE: ${cfg.file} inválido (${cfg.invalid}). Por segurança, TODOS os agentes ficam privados até corrigir.`);
  } else {
    const priv = cfg.projects.filter((p) => p.privado).length;
    log.info(`QODE: ${cfg.projects.length} projeto(s) em ${cfg.file}, ${priv} privado(s).`);
    for (const p of cfg.projects) o.roomAliases.setDefault(p.roomKey, p.nome);
  }

  const agent = (id: string): AgentInfo | undefined => o.office().get(id) ?? o.office().demoAgent(id);
  const privacy = new Privacy(cfg, { agent, agents: () => o.office().list(), changed: () => o.office().markDirty() });
  setLogFilter((msg) => privacy.redact(msg));
  const scanner = new TranscriptScanner(cfg.needles);
  const hasPrivate = cfg.projects.some((p) => p.privado);

  const sessionHidden = (s: RecentSession): boolean => {
    if (cfg.invalid) return true;
    if (s.project ? isPrivatePath(cfg, s.project) : hasPrivate) return true;
    if (privacy.mentions(s.project) || privacy.mentions(s.projectDir) || privacy.mentions(s.title)) return true;
    return !!s.agentId && privacy.isPrivate(s.agentId);
  };

  return {
    config: cfg,
    privacy,
    roomOf: (cwd) => (cfg.invalid ? undefined : projectOf(cfg, cwd)?.roomKey),
    transcriptPathOf: (inner) => (id) => {
      if (privacy.isPrivate(id)) return undefined;
      const path = inner(id);
      if (path && (privacy.mentions(path) || scanner.mentions(path))) {
        privacy.taint(id);
        return undefined;
      }
      return path;
    },
    parserFor: (inner) => (id) =>
      guardParser(
        inner(id) ?? createTerminalParser(),
        privacy,
        () => privacy.isPrivate(id),
        () => privacy.taint(id),
      ),
    history: (inner) => ({
      list: async () => (await inner.list()).filter((s) => !sessionHidden(s)),
      resolve: (account, sessionId) => {
        const r = inner.resolve(account, sessionId);
        if ('error' in r) return r;
        if (cfg.invalid || privacy.mentions(r.path) || scanner.mentions(r.path)) return { status: 404, error: PRIVATE_SESSION_ERROR };
        return {
          path: r.path,
          createParser: () => {
            let blocked = false;
            return guardParser(
              r.createParser(),
              privacy,
              () => blocked,
              () => void (blocked = true),
            );
          },
        };
      },
    }),
    officeView: (office) => ({
      get: (id) => {
        const a = office.get(id);
        return a && !privacy.isPrivate(id) ? a : undefined;
      },
      list: () => office.list().filter((a) => !privacy.isPrivate(a.id)),
      markDirty: () => office.markDirty(),
      addActivity: (id: string, activity: Activity, current: boolean, opts?: { feed?: boolean }) => office.addActivity(id, activity, current, opts),
      noticePermission: (id, what, kind) => office.noticePermission(id, what, kind),
    }),
    permissionRoutes: (inner) => ({
      register: (raw): RegisterResult => {
        let text: string | undefined;
        try {
          text = JSON.stringify(raw);
        } catch {
          text = undefined;
        }
        if (privacy.mentions(text)) {
          const r = raw as { session_id?: unknown; agent_id?: unknown };
          if (typeof r.session_id === 'string') privacy.taintSession(r.session_id, typeof r.agent_id === 'string' ? r.agent_id : undefined);
          return { skip: 'unknown-session' };
        }
        return inner.register(raw);
      },
      wait: (id, ms) => inner.wait(id, ms),
      decide: (id, d) => inner.decide(id, d),
      detail: (id) => {
        const d = inner.detail(id);
        return d && !privacy.mentions(JSON.stringify(d)) ? d : undefined;
      },
    }),
  };
}
