// Fork QODE: liga a configuração de projetos (config.ts) e o filtro de privacidade (privacy.ts) ao servidor.
// Tudo o que não passa pelo Office (terminal, histórico de sessões, permissões, mensagens e logs) é embrulhado aqui.
// Sem qode.config.json, cada embrulho devolve o original e nada muda.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Activity, AgentInfo, PtyInfo, RecentSession } from '../../shared/types';
import type { DeliveryIndexOptions } from '../deliveries/deliveries';
import { log, setLogFilter } from '../log';
import type { Office } from '../model/office';
import type { RoomAliases } from '../model/room-aliases';
import type { OfficeLike as MessageOffice } from '../messages/registry';
import type { OfficeLike as PermissionOffice, PermissionRegistry, RegisterResult } from '../permissions/registry';
import type { SessionLookup } from '../sources/source';
import { createTerminalParser, type TerminalParser } from '../sources/terminal';
import { isPrivatePath, loadQodeConfig, MENTIONS_BYTES_MAX, opaqueRoomKey, PRIVATE_ROOM_PREFIX, projectOf, type QodeConfig } from './config';
import { Privacy } from './privacy';
import { qodeCapabilities, type SourceCapability } from './capabilities';
import { qodeOrchestrateStatus, type OrchestrateStatus } from './orchestrate-status';
import { qodeOpsRoomStatus, type OpsRoomStatus } from './ops-room-status';

const SCAN_CHUNK = 1 << 20;
const SCAN_LINE_MAX = 1 << 20;
const SCAN_CACHE_MAX = 1_000;
/** Bloco da prova de continuidade. O prefixo é revalidado sem reexecutar a inspeção JSON. */
const INTEGRITY_CHUNK = SCAN_CHUNK;
export const PRIVATE_SESSION_ERROR = 'sessão de projeto privado: o QODE Office não mostra a conversa';

/** Linha do transcript: JSON já decodificado; se não parseia, o texto cru; `{`/`[` duvidoso = fechado. */
export function inspectTranscriptLine(line: string, mentions: (text: string) => boolean): boolean {
  if (line.length > MENTIONS_BYTES_MAX) return true;
  const t = line.trim();
  if (!t) return false;
  try {
    const parsed = JSON.parse(t) as unknown;
    const payload = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    if (payload.length > MENTIONS_BYTES_MAX) return true;
    return mentions(payload) || mentions(t);
  } catch {
    if (t.startsWith('{') || t.startsWith('[')) return true;
    return mentions(t);
  }
}

/** Resultado da varredura: 'error' = não deu para ler (quem chama trata como privado, sem contaminar ninguém). */
export type ScanResult = 'hit' | 'clean' | 'error';

interface ScannerEntry {
  offset: number;
  hit: boolean;
  pending: boolean;
  carry: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  decoder: StringDecoder;
  chunks: Map<number, string>;
  hashOffset: number;
  /** Estado incremental do último bloco incompleto; o conteúdo não fica retido no cache. */
  hashPartial?: Hash;
  hashPartialLength: number;
  utf8Pending: Buffer;
}

/** Inspeciona bytes novos após validar a continuidade do prefixo; o resultado positivo fica. */
export class TranscriptScanner {
  private cache = new Map<string, ScannerEntry>();

  constructor(private readonly mentions: (text: string) => boolean) {}

  private static hash(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private static readExact(fd: number, position: number, length: number): Buffer | undefined {
    const out = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, out, got, length - got, position + got);
      if (n <= 0) return undefined;
      got += n;
    }
    return out;
  }

  private static recordHash(e: ScannerEntry, data: Buffer): void {
    let start = 0;
    while (start < data.length) {
      const need = INTEGRITY_CHUNK - e.hashPartialLength;
      const take = Math.min(need, data.length - start);
      if (e.hashPartialLength === 0 && take === INTEGRITY_CHUNK) {
        e.chunks.set(e.hashOffset, TranscriptScanner.hash(data.subarray(start, start + take)));
        e.hashOffset += take;
      } else {
        e.hashPartial ??= createHash('sha256');
        e.hashPartial.update(data.subarray(start, start + take));
        e.hashPartialLength += take;
        if (e.hashPartialLength === INTEGRITY_CHUNK) {
          e.chunks.set(e.hashOffset, e.hashPartial.digest('hex'));
          e.hashOffset += INTEGRITY_CHUNK;
          e.hashPartial = undefined;
          e.hashPartialLength = 0;
        }
      }
      start += take;
    }
  }

  /** Bytes finais que o StringDecoder ainda precisa para fechar um caractere UTF-8. */
  private static utf8Tail(data: Buffer): Buffer {
    if (data.length === 0) return Buffer.alloc(0);
    let i = data.length - 1;
    while (i >= 0 && (data[i]! & 0xc0) === 0x80) i--;
    if (i < 0) return Buffer.alloc(0);
    const lead = data[i]!;
    const need = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
    return data.length - i < need ? Buffer.from(data.subarray(i)) : Buffer.alloc(0);
  }

  private static verifyPrefix(fd: number, e: { chunks: Map<number, string>; hashOffset: number; hashPartial?: Hash; hashPartialLength: number; offset: number }): 'match' | 'mismatch' | 'error' {
    for (const [position, expected] of e.chunks) {
      const block = TranscriptScanner.readExact(fd, position, INTEGRITY_CHUNK);
      if (!block) return 'error';
      if (TranscriptScanner.hash(block) !== expected) return 'mismatch';
    }
    if (e.hashOffset + e.hashPartialLength !== e.offset) return 'error';
    if (e.hashPartialLength > 0) {
      if (!e.hashPartial) return 'error';
      const tail = TranscriptScanner.readExact(fd, e.hashOffset, e.hashPartialLength);
      if (!tail) return 'error';
      if (TranscriptScanner.hash(tail) !== e.hashPartial.copy().digest('hex')) return 'mismatch';
    }
    return 'match';
  }

  scan(path: string): ScanResult {
    let current: ReturnType<typeof statSync>;
    try {
      current = statSync(path);
    } catch {
      return 'error';
    }
    let e = this.cache.get(path);
    if (e?.hit) return 'hit';
    if (!e) {
      e = {
        offset: 0,
        hit: false,
        pending: false,
        carry: '',
        ino: current.ino,
        mtimeMs: current.mtimeMs,
        ctimeMs: current.ctimeMs,
        decoder: new StringDecoder('utf8'),
        chunks: new Map(),
        hashOffset: 0,
        hashPartialLength: 0,
        utf8Pending: Buffer.alloc(0),
      };
      if (!this.cache.has(path) && this.cache.size >= SCAN_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, e);
    }
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return 'error';
    }
    try {
      const snapshot = fstatSync(fd);
      // O stat e o fd precisam representar o mesmo arquivo; não liberar uma leitura corrida.
      if (snapshot.ino !== current.ino || snapshot.size !== current.size || snapshot.mtimeMs !== current.mtimeMs || snapshot.ctimeMs !== current.ctimeMs) {
        return 'error';
      }
      const size = snapshot.size;
      const changed = e.offset > 0 && (size !== e.offset || e.ino !== snapshot.ino || e.mtimeMs !== snapshot.mtimeMs || e.ctimeMs !== snapshot.ctimeMs);
      if (size < e.offset || e.ino !== snapshot.ino) {
        e.offset = 0;
        e.pending = false;
        e.carry = '';
        e.decoder = new StringDecoder('utf8');
        e.chunks.clear();
        e.hashOffset = 0;
        e.hashPartial = undefined;
        e.hashPartialLength = 0;
        e.utf8Pending = Buffer.alloc(0);
      } else if (changed) {
        const verified = TranscriptScanner.verifyPrefix(fd, e);
        if (verified === 'error') return 'error';
        if (verified === 'mismatch') {
          e.offset = 0;
          e.pending = false;
          e.carry = '';
          e.decoder = new StringDecoder('utf8');
          e.chunks.clear();
          e.hashOffset = 0;
          e.hashPartial = undefined;
          e.hashPartialLength = 0;
          e.utf8Pending = Buffer.alloc(0);
        }
      }
      e.ino = snapshot.ino;
      e.mtimeMs = snapshot.mtimeMs;
      e.ctimeMs = snapshot.ctimeMs;
      if (size === e.offset) return e.pending ? 'error' : 'clean';
      const buf = Buffer.alloc(SCAN_CHUNK);
      let incomplete = false;
      while (e.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(SCAN_CHUNK, size - e.offset), e.offset);
        if (n <= 0) {
          incomplete = true;
          break;
        }
        TranscriptScanner.recordHash(e, buf.subarray(0, n));
        e.offset += n;
        const bytes = buf.subarray(0, n);
        e.utf8Pending = TranscriptScanner.utf8Tail(Buffer.concat([e.utf8Pending, bytes]));
        const text = e.carry + e.decoder.write(bytes);
        let start = 0;
        for (let i = 0; i < text.length; i++) {
          if (text[i] !== '\n') continue;
          if (inspectTranscriptLine(text.slice(start, i), this.mentions)) {
            e.hit = true;
            break;
          }
          start = i + 1;
        }
        if (e.hit) break;
        e.carry = text.slice(start);
        if (e.carry.length > SCAN_LINE_MAX) {
          e.hit = true;
          e.carry = '';
          break;
        }
      }
      if (e.hit) return 'hit';
      if (incomplete || e.offset < size) return 'error';
      const end = fstatSync(fd);
      if (end.ino !== snapshot.ino || end.size !== snapshot.size || end.mtimeMs !== snapshot.mtimeMs || end.ctimeMs !== snapshot.ctimeMs) return 'error';
      if (e.offset >= size) {
        // Não finalize um code point que pode continuar no próximo poll: end() emitiria U+FFFD e
        // resetaria o decoder, quebrando a continuidade de caminhos UTF-8 divididos entre writes.
        if (e.utf8Pending.length > 0) {
          e.pending = true;
          return 'error';
        }
        const tail = e.carry + e.decoder.end();
        e.decoder = new StringDecoder('utf8');
        e.carry = tail;
        e.pending = false;
        if (tail) {
          const t = tail.trim();
          if (t.startsWith('{') || t.startsWith('[')) {
            try {
              JSON.parse(t);
              if (inspectTranscriptLine(t, this.mentions)) e.hit = true;
            } catch {
              e.pending = true;
            }
          } else if (inspectTranscriptLine(t, this.mentions)) {
            e.hit = true;
          }
        }
      }
    } catch {
      this.cache.delete(path);
      return 'error';
    } finally {
      closeSync(fd);
    }
    return e.hit ? 'hit' : e.pending ? 'error' : 'clean';
  }
}

type Routes = Pick<PermissionRegistry, 'register' | 'wait' | 'decide' | 'detail'>;
type OfficeView = PermissionOffice & MessageOffice;

export interface QodeHealth {
  config: 'ausente' | 'ok' | 'invalida';
  projetos: number;
  privados: number;
  erro?: string;
  /** Q3: origem/capacidade explícitas (Manual≠live; OpenCode/Cursor=unavailable). */
  capabilities: SourceCapability[];
  /** B1: coordenador = floating-flow; QODE só observa (nunca despacha). */
  orchestrate: OrchestrateStatus;
  /** B2: ops room stub — bot OpenCode proposto; api unavailable até adaptador. */
  opsRoom: OpsRoomStatus;
}

export interface QodeSetup {
  config?: QodeConfig;
  privacy?: Privacy;
  roomOf?: (cwd: string) => string | undefined;
  health(): QodeHealth;
  transcriptPathOf(inner: (id: string) => string | undefined): (id: string) => string | undefined;
  parserFor(inner: (id: string) => TerminalParser | undefined): (id: string) => TerminalParser | undefined;
  history(inner: SessionLookup): SessionLookup;
  /** Filtro das entregas: sessão, texto e caminho passam pela mesma política do histórico. */
  deliveries(inner: DeliveryIndexOptions): DeliveryIndexOptions;
  officeView(office: Office): OfficeView;
  permissionRoutes(inner: PermissionRegistry): Routes;
  /** Pasta em que o PTY não pode abrir (projeto privado ou config inválida). */
  blockedCwd(cwd: string): boolean;
  /** Terminal que não lista nem transmite (agente, origem ou cwd privado). */
  hiddenPty(info: PtyInfo): boolean;
}

export interface QodeOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  home: string;
  inDocker?: boolean;
  roomAliases: RoomAliases;
  /** O Office (ligação tardia: ele recebe o filtro no construtor). */
  office: () => Office;
}

/** Parser que some quando a conversa fica privada (ou quando uma linha cita um caminho privado). */
function guardParser(base: TerminalParser, privacy: Privacy, blocked: () => boolean, hit: () => void): TerminalParser {
  return {
    push(line) {
      if (blocked()) return [];
      if (inspectTranscriptLine(line, (t) => privacy.mentions(t))) {
        hit();
        return [];
      }
      return base.push(line);
    },
  };
}

function safeJson(raw: unknown): string | undefined {
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

export function setupQode(o: QodeOptions): QodeSetup {
  const cfg = loadQodeConfig(o.env, o.dataDir, o.home);
  if (!cfg) {
    const msg = 'QODE: sem qode.config.json; salas e privacidade como no upstream (veja qode/README.md).';
    if (o.inDocker) log.warn(`${msg} No Docker, o arquivo precisa estar no volume /data.`);
    else log.info(msg);
    return {
      health: () => {
        const orchestrate = qodeOrchestrateStatus(o.env, o.home);
        return {
          config: 'ausente',
          projetos: 0,
          privados: 0,
          capabilities: qodeCapabilities({ orchestrate }),
          orchestrate,
          opsRoom: qodeOpsRoomStatus(),
        };
      },
      transcriptPathOf: (inner) => inner,
      parserFor: (inner) => inner,
      history: (inner) => inner,
      deliveries: (inner) => inner,
      officeView: (office) => office,
      permissionRoutes: (inner) => inner,
      blockedCwd: () => false,
      hiddenPty: () => false,
    };
  }

  const agent = (id: string): AgentInfo | undefined => o.office().get(id) ?? o.office().demoAgent(id);
  const privacy = new Privacy(cfg, { agent, agents: () => o.office().list(), changed: () => o.office().markDirty() });
  setLogFilter((msg) => privacy.redact(msg));
  const privados = cfg.projects.filter((p) => p.privado).length;
  if (cfg.invalid) {
    log.error(`QODE: qode.config.json inválido (${cfg.invalid}). Por segurança, TODOS os agentes ficam privados até corrigir.`);
  } else {
    log.info(`QODE: ${cfg.projects.length} projeto(s) no qode.config.json, ${privados} privado(s).`);
    for (const p of cfg.projects) o.roomAliases.setDefault(p.roomKey, p.nome);
  }
  const scanner = new TranscriptScanner((text) => privacy.mentions(text));
  /** Transcript limpo? Ilegível conta como não (sem contaminar: pode ser só um arquivo que ainda não existe). */
  const transcriptClean = (path: string): boolean => {
    if (!privacy.active) return true;
    if (privacy.mentions(path)) return false;
    return scanner.scan(path) === 'clean';
  };
  const hasPrivate = privados > 0;

  const sessionHidden = (s: RecentSession): boolean => {
    if (!privacy.active) return false;
    if (cfg.invalid) return true;
    if (s.project ? isPrivatePath(cfg, s.project) : hasPrivate) return true;
    if (privacy.mentions(s.project) || privacy.mentions(s.projectDir) || privacy.mentions(s.title)) return true;
    if (privacy.sessionPrivate(s.sessionId)) return true;
    return !!s.agentId && privacy.isPrivate(s.agentId);
  };

  /** Pedido de permissão -> sessão de quem pediu (para esconder o que foi registrado antes da contaminação). */
  const requests = new Map<string, { sessionId?: string; hookAgentId?: string }>();
  const requestPrivate = (id: string): boolean => {
    if (!privacy.active) return false;
    const r = requests.get(id);
    if (!r?.sessionId) return true;
    if (privacy.sessionPrivate(r.sessionId)) return true;
    return !!r.hookAgentId && (privacy.sessionPrivate(r.hookAgentId) || privacy.isPrivate(`${r.sessionId}:${r.hookAgentId}`, (x) => o.office().get(x)));
  };

  return {
    config: cfg,
    privacy,
    health: () => {
      const orchestrate = qodeOrchestrateStatus(o.env, o.home);
      const capabilities = qodeCapabilities({ orchestrate });
      const opsRoom = qodeOpsRoomStatus();
      return cfg.invalid
        ? { config: 'invalida', projetos: 0, privados: 0, erro: privacy.redact(cfg.invalid), capabilities, orchestrate, opsRoom }
        : { config: 'ok', projetos: cfg.projects.length, privados, capabilities, orchestrate, opsRoom };
    },
    roomOf: (cwd) => {
      if (!cfg.invalid) return projectOf(cfg, cwd)?.roomKey;
      const key = opaqueRoomKey(cfg, cwd);
      o.roomAliases.setDefault(key, `Privado ${key.slice(PRIVATE_ROOM_PREFIX.length, PRIVATE_ROOM_PREFIX.length + 4)}`);
      return key;
    },
    transcriptPathOf: (inner) => (id) => {
      if (privacy.isPrivate(id)) return undefined;
      const path = inner(id);
      if (!path || !privacy.active) return path;
      const scan = privacy.mentions(path) ? 'hit' : scanner.scan(path);
      if (scan === 'hit') privacy.taint(id);
      return scan === 'clean' ? path : undefined;
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
        if ('error' in r || !privacy.active) return r;
        if (cfg.invalid || privacy.sessionPrivate(sessionId) || !transcriptClean(r.path)) return { status: 404, error: PRIVATE_SESSION_ERROR };
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
    deliveries: (inner) => ({
      ...inner,
      sessions: async () => (await inner.sessions()).filter((s) => !sessionHidden(s)),
      resolve: (account, sessionId) => {
        if (!privacy.active) return inner.resolve(account, sessionId);
        if (cfg.invalid || privacy.sessionPrivate(sessionId)) return undefined;
        const src = inner.resolve(account, sessionId);
        if (!src || !transcriptClean(src.path)) return undefined;
        return {
          path: src.path,
          createParser: () => {
            let blocked = false;
            return guardParser(
              src.createParser(),
              privacy,
              () => blocked,
              () => void (blocked = true),
            );
          },
        };
      },
      hideSession: (s) => sessionHidden(s),
      hideText: (text) => privacy.mentions(text),
      hidePath: (path) => privacy.mentions(path) || isPrivatePath(cfg, path),
    }),
    blockedCwd: (cwd) => {
      if (!privacy.active) return false;
      if (cfg.invalid) return true;
      return isPrivatePath(cfg, cwd) || privacy.mentions(cwd);
    },
    hiddenPty: (info) => {
      if (!privacy.active) return false;
      if (cfg.invalid) return true;
      if (privacy.mentions(info.cwd) || isPrivatePath(cfg, info.cwd)) return true;
      if (info.resumed && privacy.sessionPrivate(info.resumed)) return true;
      // Agente vivo: classificação atual. Ausente: origem/sessão já vistas, senão fail-closed.
      if (privacy.originPrivate(info.agentId)) return true;
      if (info.fromAgent && privacy.originPrivate(info.fromAgent)) return true;
      return false;
    },
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
        const r = (raw && typeof raw === 'object' ? raw : {}) as { session_id?: unknown; agent_id?: unknown };
        const sessionId = typeof r.session_id === 'string' ? r.session_id : undefined;
        const hookAgentId = typeof r.agent_id === 'string' ? r.agent_id : undefined;
        if (privacy.mentions(safeJson(raw))) {
          if (sessionId) privacy.taintSession(sessionId, hookAgentId);
          return { skip: 'unknown-session' };
        }
        if (sessionId && privacy.sessionPrivate(sessionId)) return { skip: 'unknown-session' };
        const out = inner.register(raw);
        if ('id' in out) requests.set(out.id, { sessionId, hookAgentId });
        return out;
      },
      wait: (id, ms) => inner.wait(id, ms),
      decide: (id, d) => (requestPrivate(id) ? 'not-found' : inner.decide(id, d)),
      detail: (id) => {
        if (requestPrivate(id)) return undefined;
        const d = inner.detail(id);
        return d && !privacy.mentions(JSON.stringify(d)) ? d : undefined;
      },
    }),
  };
}
