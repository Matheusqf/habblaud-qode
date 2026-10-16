// Ponte Codex cloud (fatia 3): `codex cloud list --json` com comando fixo, timeout e saída limitada.
// Usa a autenticação já existente do CLI (nunca a lê nem copia). Observe-only: nenhum outro subcomando.
// Cobertura cloud novo vs Legacy NÃO validada: o Office não promete visibilidade completa das tarefas Codex.
import { execFile } from 'node:child_process';
import { sanitize, type CloudConfig, type CloudObservation } from './contract';
import type { CloudCollector } from './source';

export const CODEX_CLOUD_ARGS = Object.freeze(['cloud', 'list', '--json', '--limit', '20']);
const TIMEOUT_MS = 15_000;
const MAX_OUT = 512 * 1024;

export type RunFixed = (bin: string, args: readonly string[]) => Promise<string>;

export const runFixed: RunFixed = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUT, windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error('codex cloud: falha ao executar')); // stderr não é ecoado
      else resolve(stdout);
    });
  });

export class CodexCloudCollector implements CloudCollector {
  readonly provider = 'codex-cloud' as const;
  private versionOk?: boolean;

  constructor(
    private readonly deps: {
      bin: string;
      cfg: Pick<CloudConfig, 'projects' | 'ttlMs'>;
      /** HABBLAUD_CLOUD_CODEX_VERSION: prefixo exigido de `codex --version` (ex. "codex-cli 0.162."). */
      pinnedVersion?: string;
      run?: RunFixed;
    },
  ) {}

  private run(args: readonly string[]): Promise<string> {
    return (this.deps.run ?? runFixed)(this.deps.bin, args);
  }

  async poll(now: number): Promise<CloudObservation[]> {
    if (this.deps.pinnedVersion && this.versionOk === undefined) {
      const v = (await this.run(['--version'])).trim();
      this.versionOk = v.startsWith(this.deps.pinnedVersion);
    }
    if (this.versionOk === false) throw new Error('codex cloud: versão do CLI fora da fixada');
    const parsed = JSON.parse(await this.run(CODEX_CLOUD_ARGS)) as { tasks?: unknown };
    if (!Array.isArray(parsed?.tasks)) throw new Error('codex cloud: formato inesperado');
    const out: CloudObservation[] = [];
    for (const t of parsed.tasks) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      const o = sanitize(
        'codex-cloud',
        { id: r.id, project: r.environment_label, nativeState: r.status, updatedAt: r.updated_at, link: r.url },
        this.deps.cfg,
        now,
      );
      if (o) out.push(o);
    }
    return out;
  }
}
