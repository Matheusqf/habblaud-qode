// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts): observa as sessões ABERTAS do banco
// local do OpenCode e alimenta o Office. Só metadados: a fonte nunca lê título nem conteúdo de mensagem.
//
// Presença: o próprio banco diz quais sessões raiz não arquivadas foram mexidas na janela (sessionsSql) e qual o
// status de cada uma (última mensagem do usuário ou resposta ainda em andamento = 'working'; senão 'idle'). Uma
// sessão que estava sendo acompanhada e some de uma leitura BEM-SUCEDIDA é encerrada (closeMain); uma leitura que
// falha só marca a fonte como não-ok e mantém os agentes como estavam (nada de sumiço por erro de leitura).
//
// A leitura do banco é injetada (run) e, por padrão, sai de `opencode db <sql> --format json` via execFile, sem
// shell e sem nunca registrar a saída. Boot assíncrono: beginBoot antes e endBoot num `finally`.
import { execFile } from 'node:child_process';
import type { SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import type { AccountsService } from '../../accounts/service';
import { errMsg } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { parseSessions, sessionsSql, type OpenCodeSession } from './sessions';

const PROVIDER = 'opencode' as const;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WINDOW_MS = 30 * 60_000;

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
}

/**
 * Runner padrão: `opencode db <sql> --format json`, sem shell, com prazo e teto de saída. Nunca registra a saída.
 */
export function defaultRunner(bin: string): (sql: string) => Promise<string> {
  return (sql: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        ['db', sql, '--format', 'json'],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
}

export class OpenCodeSource implements AgentSource {
  readonly provider = PROVIDER;
  /** Id final da conta no AccountsService (setProviderAccounts pode desambiguar). */
  private account = '.opencode';
  /** Sessões acompanhadas (chave = conta:sessão). */
  private readonly tracked = new Set<string>();
  private ok = true;
  private busy = false;
  private error: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly windowMs: number;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
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
    let sessions: OpenCodeSession[];
    try {
      sessions = parseSessions(await this.opts.run(sessionsSql(this.now() - this.windowMs)));
      this.ok = true;
      delete this.error;
    } catch (err) {
      this.ok = false;
      this.error = errMsg(err).slice(0, 200);
      return;
    }
    const seen = new Set<string>();
    for (const session of sessions) {
      const key = `${this.account}:${session.id}`;
      seen.add(key);
      if (!this.opts.office.has(key)) {
        this.opts.office.addMain({
          id: key,
          provider: PROVIDER,
          account: this.account,
          sessionId: session.id,
          cwd: session.directory,
          role: session.agent ?? PROVIDER,
          startedAt: session.startedAt,
          status: session.status,
        });
      } else {
        this.opts.office.setStatus(key, session.status);
      }
      const summary: TranscriptSummary = {
        tasks: [],
        stats: { toolCalls: 0, tokensIn: session.tokensIn, tokensOut: session.tokensOut, costUSD: session.costUSD, subagents: 0 },
        lastAt: session.updatedAt,
      };
      if (session.model) summary.model = session.model;
      this.opts.office.applyTranscript(key, summary);
      this.tracked.add(key);
    }
    for (const key of [...this.tracked]) {
      if (seen.has(key)) continue;
      this.opts.office.closeMain(key);
      this.tracked.delete(key);
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
