// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts): observa as sessões ABERTAS do banco
// local do OpenCode e alimenta o Office. Só metadados: a fonte nunca lê título nem conteúdo de mensagem.
//
// Presença: o próprio banco diz quais sessões raiz não arquivadas foram mexidas na janela (sessionsSql) e qual o
// status de cada uma (última mensagem do usuário ou resposta ainda em andamento = 'working'; senão 'idle'). Uma
// sessão que estava sendo acompanhada e some de uma leitura BEM-SUCEDIDA é encerrada (closeMain); uma leitura que
// falha só marca a fonte como não-ok e mantém os agentes como estavam (nada de sumiço por erro de leitura).
//
// Filhas (parent_id preenchido) cujo pai foi acompanhado NESTA leitura viram subagentes (addSub/completeSub); filha
// órfã é pulada, e filha que some de uma leitura bem-sucedida é concluída. Mesma allowlist de pasta das raízes.
//
// A leitura do banco é injetada (run); em produção é readOnlyRunner (reader.ts): SQLite somente leitura, sem o
// inicializador/migrações do OpenCode. Estado: o banco não prova processo vivo, então o personagem fica 'idle' e a
// atividade sai como INFERIDA (AgentInfo.observed, com horário; stale quando a leitura falha). Só entram sessões de
// projetos da allowlist (`projects`, caminhos canônicos). Limite: a seleção acontece ANTES de inserir no Office, mas
// DEPOIS da consulta de metadados ao banco (o SELECT traz as sessões da janela de todos os projetos; as de fora da
// allowlist são descartadas em memória, sem ir para Office, snapshot, cache ou log). Boot assíncrono: beginBoot antes e endBoot num `finally`.
import { realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { ObservedActivity, SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import type { AccountsService } from '../../accounts/service';
import { errMsg } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { parseSessions, sessionsSql, type OpenCodeSession } from './sessions';

const PROVIDER = 'opencode' as const;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WINDOW_MS = 30 * 60_000;
const DEFAULT_ACTIVE_STALE_MS = 5 * 60_000;

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta do OpenCode lida por este processo (no Docker, a montada). */
  dataDir: string;
  /** Roda uma query no banco local do OpenCode e devolve a saída crua (JSON). */
  run: (sql: string) => Promise<string>;
  now?: () => number;
  pollMs?: number;
  /** Janela de sessões mexidas que a query considera (padrão 30 min). */
  windowMs?: number;
  /** Allowlist de projetos (pastas absolutas): só sessões nelas ou abaixo delas entram. Vazia = nada entra. */
  projects: readonly string[];
  /** 'active' inferido mais velho que isto (desde a última gravação) vira 'unknown' (padrão 5 min). */
  activeStaleMs?: number;
}

/** Caminho canônico (symlinks resolvidos); undefined se não existe ou não dá para resolver (= fora da allowlist). */
function canonical(p: string): string | undefined {
  try {
    // .native = realpath(3): '..' depois de symlink segue o destino (o realpathSync em JS resolve '..' lexicalmente).
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * A pasta está na allowlist (igual ou abaixo de uma das pastas), comparando caminhos CANÔNICOS (realpath): um
 * /permitido/link que aponta para fora não passa. Pasta que não existe mais não passa.
 */
export function inAllowlist(dir: string, projects: readonly string[]): boolean {
  // realpath direto (sem path.resolve antes): '..' depois de um symlink sobe a partir do DESTINO, como o kernel faz.
  // path.resolve('/permitido/link/../x') daria '/permitido/x' (lexical) e deixaria passar o que fica fora.
  if (!isAbsolute(dir)) return false;
  const d = canonical(dir);
  if (!d) return false;
  return projects.some((p) => {
    const root = isAbsolute(p) ? canonical(p) : undefined;
    if (!root) return false;
    return d === root || d.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export class OpenCodeSource implements AgentSource {
  readonly provider = PROVIDER;
  /** Id final da conta no AccountsService (setProviderAccounts pode desambiguar). */
  private account = '.opencode';
  /** Sessões raiz acompanhadas (chave = conta:sessão). */
  private readonly tracked = new Set<string>();
  /** Sessões filhas acompanhadas (subagentes; chave = conta:sessão). */
  private readonly children = new Set<string>();
  private ok = true;
  private busy = false;
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly windowMs: number;
  private readonly activeStaleMs: number;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.activeStaleMs = opts.activeStaleMs ?? DEFAULT_ACTIVE_STALE_MS;
  }

  async start(): Promise<void> {
    const entries = this.opts.accounts.setProviderAccounts(PROVIDER, [
      {
        dir: this.opts.dataDir,
        detected: { id: '.opencode', configDir: this.opts.dataDir, short: 'OC', name: 'OpenCode', color: ACCOUNT_COLORS[3] },
      },
    ]);
    this.account = entries[0]?.id ?? '.opencode';
    this.opts.office.beginBoot();
    try {
      await this.poll();
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Um ciclo de leitura: as sessões da janela viram (ou atualizam) agentes principais. Falha de leitura marca a
   * fonte como não-ok e mantém os agentes atuais; uma leitura bem-sucedida encerra quem sumiu.
   */
  async poll(): Promise<void> {
    // Um ciclo por vez: `opencode db` lento não empilha leituras.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.cycle();
    } finally {
      this.busy = false;
    }
  }

  private async cycle(): Promise<void> {
    const office = this.opts.office;
    let sessions: OpenCodeSession[];
    try {
      sessions = parseSessions(await this.opts.run(sessionsSql(this.now() - this.windowMs)));
      this.ok = true;
      delete this.error;
    } catch (err) {
      this.ok = false;
      this.error = errMsg(err).slice(0, 200);
      // Leitura falhou: o que se sabe é velho. Marca stale (mantém o horário do último dado) e atividade unknown.
      for (const key of [...this.tracked, ...this.children]) {
        const prev = office.get(key)?.observed;
        office.setObserved(key, { basis: 'inferred', activity: 'unknown', at: prev?.at ?? this.now(), stale: true });
      }
      return;
    }
    const now = this.now();
    const seen = new Set<string>();
    for (const session of sessions) {
      if (session.parentId !== undefined) continue; // filhas tratadas depois das raízes
      // Allowlist antes de inserir no Office (depois da consulta ao banco; ver o topo).
      if (!inAllowlist(session.directory, this.opts.projects)) continue;
      const key = `${this.account}:${session.id}`;
      seen.add(key);
      // addMain também é o caminho de volta (revival): limpa o removeAt de um closeMain recente (ZikaBOT #24, P2).
      office.addMain({
        id: key,
        provider: PROVIDER,
        account: this.account,
        sessionId: session.id,
        cwd: session.directory,
        role: session.agent ?? PROVIDER,
        startedAt: session.startedAt,
        status: 'idle',
      });
      office.observePrivacy(key, [canonical(session.directory) ?? session.directory]);
      const summary: TranscriptSummary = {
        tasks: [],
        stats: { toolCalls: 0, tokensIn: session.tokensIn, tokensOut: session.tokensOut, costUSD: session.costUSD, subagents: 0 },
        lastAt: session.updatedAt,
      };
      if (session.model) summary.model = session.model;
      office.applyTranscript(key, summary);
      const activity: ObservedActivity['activity'] =
        session.inferred === 'active' && now - session.updatedAt > this.activeStaleMs ? 'unknown' : session.inferred;
      office.setObserved(key, { basis: 'inferred', activity, at: session.updatedAt, stale: false, ...(session.error ? { error: true } : {}) });
      this.tracked.add(key);
    }
    for (const key of [...this.tracked]) {
      if (seen.has(key)) continue;
      office.closeMain(key);
      this.tracked.delete(key);
    }
    // Filhas (subagentes): só entram se o pai foi acompanhado NESTA leitura (mesma allowlist de pasta).
    const seenChildren = new Set<string>();
    for (const session of sessions) {
      if (session.parentId === undefined) continue;
      const parentKey = `${this.account}:${session.parentId}`;
      if (!this.tracked.has(parentKey)) continue; // pai ausente/fora da allowlist: filha pulada
      if (!inAllowlist(session.directory, this.opts.projects)) continue;
      const key = `${this.account}:${session.id}`;
      seenChildren.add(key);
      const activity: ObservedActivity['activity'] =
        session.inferred === 'active' && now - session.updatedAt > this.activeStaleMs ? 'unknown' : session.inferred;
      const observed: ObservedActivity = { basis: 'inferred', activity, at: session.updatedAt, stale: false, ...(session.error ? { error: true } : {}) };
      // Privacidade (ZikaBOT #26 P1): a filha herda a sala do pai, mas a pasta REAL dela vai ao filtro na criação;
      // pasta privada contamina a família inteira antes de qualquer publicação (snapshot, feed, avisos, estatísticas).
      // Status 'idle' + observed já na criação/reativação: sem 'working' nem «Concluiu» falsos (P2).
      if (!office.has(key) || office.isSubDone(key)) {
        office.addSub({
          id: key,
          parentId: parentKey,
          sessionId: session.id,
          role: session.agent ?? PROVIDER,
          background: false,
          startedAt: session.startedAt,
          status: 'idle',
          observed,
          privacyTexts: [canonical(session.directory) ?? session.directory],
        });
      }
      // A CADA leitura (não só na criação): filha que muda de pasta com o mesmo id é reclassificada antes de publicar.
      // Contaminação é pegajosa: privado → público continua privado (lado seguro).
      office.observePrivacy(key, [canonical(session.directory) ?? session.directory]);
      const summary: TranscriptSummary = {
        tasks: [],
        stats: { toolCalls: 0, tokensIn: session.tokensIn, tokensOut: session.tokensOut, costUSD: session.costUSD, subagents: 0 },
        lastAt: session.updatedAt,
      };
      if (session.model) summary.model = session.model;
      office.applyTranscript(key, summary);
      office.setObserved(key, observed);
      this.children.add(key);
    }
    for (const key of [...this.children]) {
      if (seenChildren.has(key)) continue;
      // Sumiu da janela: não prova entrega. Sai em silêncio e invalida a observação (sem erro antigo, stale).
      const prev = office.get(key)?.observed;
      office.setObserved(key, { basis: 'inferred', activity: 'unknown', at: prev?.at ?? now, stale: true });
      if (!office.isSubDone(key)) office.completeSub(key, { silent: true });
      this.children.delete(key);
    }
  }

  sources(): SourceInfo[] {
    const info: SourceInfo = { label: '.opencode', provider: PROVIDER, path: this.opts.dataDir, sessions: this.tracked.size, ok: this.ok };
    if (this.error) info.error = this.error;
    return [info];
  }

  /** O OpenCode não expõe a conversa em arquivo por aqui: nunca há transcript desta fonte. */
  transcriptPathOf(_agentId: string): string | undefined {
    return undefined;
  }
}
