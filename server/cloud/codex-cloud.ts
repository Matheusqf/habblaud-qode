// Ponte Codex cloud (fatia 3): `codex cloud list --json` com comando fixo, timeout e saída limitada.
// Usa a autenticação já existente do CLI (nunca a lê nem copia). Observe-only: nenhum outro subcomando.
// Cobertura cloud novo vs Legacy NÃO validada: o Office não promete visibilidade completa das tarefas Codex.
import { execFile } from 'node:child_process';
import { sanitize, type CloudConfig, type CloudObservation } from './contract';
import type { CloudCollector } from './source';

export const CODEX_CLOUD_ARGS = Object.freeze(['cloud', 'list', '--json', '--limit', '20']);
const MAX_PAGES = 10;
const CURSOR_RE = /^[A-Za-z0-9._~=+/-]{1,512}$/;

/** HABBLAUD_CLOUD_CODEX_ENVS="env_id=dono/repo,..." — mapeamento EXPLÍCITO ambiente→projeto (environment_label não é usado). */
export function parseCodexEnvMap(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const [id, proj] = part.split('=').map((x) => x?.trim());
    if (id && proj && /^[A-Za-z0-9_-]{1,80}$/.test(id)) m.set(id, proj);
  }
  return m;
}
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
  /** Última consulta bateu no teto de páginas: inventário parcial (ausência ≠ encerramento). */
  lastPartial = false;

  constructor(
    private readonly deps: {
      bin: string;
      cfg: Pick<CloudConfig, 'projects' | 'ttlMs'>;
      /** HABBLAUD_CLOUD_CODEX_VERSION (OBRIGATÓRIO): saída EXATA de `codex --version`, verificada em cada execução. */
      pinnedVersion: string;
      /** environment_id -> projeto (HABBLAUD_CLOUD_CODEX_ENVS). Sem entrada = tarefa descartada. */
      envs: ReadonlyMap<string, string>;
      run?: RunFixed;
      /** Relógio local (testes); confirmedAt = `now` do poll + tempo decorrido até a página chegar. */
      clock?: () => number;
    },
  ) {
    if (!deps.pinnedVersion?.trim()) throw new Error('codex cloud: HABBLAUD_CLOUD_CODEX_VERSION obrigatório');
  }

  private run(args: readonly string[]): Promise<string> {
    return (this.deps.run ?? runFixed)(this.deps.bin, args);
  }

  async poll(now: number): Promise<CloudObservation[]> {
    // Cada tarefa é carimbada quando a página DELA chega (TTL por confirmação individual, ver CloudSource).
    const clock = this.deps.clock ?? Date.now;
    const t0 = clock();
    // Pin verificado em CADA execução (o binário pode ser trocado entre ciclos): diverge => falha fechada.
    const v = (await this.run(['--version'])).trim();
    this.versionOk = v === this.deps.pinnedVersion.trim();
    if (!this.versionOk) throw new Error('codex cloud: versão do CLI fora da fixada');
    const out: CloudObservation[] = [];
    let cursor: string | undefined;
    let page = 0;
    do {
      const args = cursor ? [...CODEX_CLOUD_ARGS, '--cursor', cursor] : CODEX_CLOUD_ARGS;
      const parsed = JSON.parse(await this.run(args)) as { tasks?: unknown; cursor?: unknown };
      const confirmedAt = now + Math.max(0, clock() - t0);
      if (!Array.isArray(parsed?.tasks)) throw new Error('codex cloud: formato inesperado');
      for (const t of parsed.tasks) {
        if (!t || typeof t !== 'object') continue;
        const r = t as Record<string, unknown>;
        const project = typeof r.environment_id === 'string' ? this.deps.envs.get(r.environment_id) : undefined;
        if (!project) continue;
        const o = sanitize('codex-cloud', { id: r.id, project, nativeState: r.status, updatedAt: r.updated_at, link: r.url }, this.deps.cfg, confirmedAt);
        if (o) out.push(o);
      }
      page++;
      if (parsed.cursor === null) {
        cursor = undefined; // fim explícito: inventário completo
        this.lastPartial = false;
      } else if (typeof parsed.cursor === 'string' && CURSOR_RE.test(parsed.cursor)) {
        cursor = parsed.cursor;
        this.lastPartial = true; // até chegar ao fim
      } else {
        cursor = undefined; // ausente/inválido: não dá para provar que acabou => parcial
        this.lastPartial = true;
      }
    } while (cursor && page < MAX_PAGES);
    return out;
  }
}
