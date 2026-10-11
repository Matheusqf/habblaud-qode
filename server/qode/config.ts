// Fork QODE: projetos do Matheus num JSON editado à mão (<dataDir>/qode.config.json ou HABBLAUD_QODE_CONFIG).
// Cada projeto vira uma sala só (o repositório e as worktrees irmãs "repo-*"); os marcados com "privado": true
// só mostram o nome do projeto e o estado dos agentes (server/qode/privacy.ts).
// Arquivo presente mas inválido = tudo privado (fail closed). Sem arquivo = comportamento do upstream.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const QODE_CONFIG_FILE = 'qode.config.json';
export const PRIVATE_ROOM_PREFIX = 'qode-privado:';
const NAME_MAX = 40;

export interface QodeProject {
  nome: string;
  /** Raízes absolutas, em minúsculas; `prefix` = veio de um caminho terminado em "*" (worktrees irmãs). */
  roots: Array<{ path: string; prefix: boolean }>;
  privado: boolean;
  /** Chave da sala: a primeira raiz exata (caminho real) ou, para os privados, um id opaco. */
  roomKey: string;
}

export interface QodeConfig {
  /** De onde veio (para o log). */
  file: string;
  /** Arquivo ilegível ou fora do formato: tudo é tratado como privado. */
  invalid?: string;
  projects: QodeProject[];
  /** Trechos (minúsculos) que denunciam um caminho privado num texto: absoluto, ~/, $HOME/ e o cwd codificado. */
  needles: string[];
}

export function configPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HABBLAUD_QODE_CONFIG?.trim() || join(dataDir, QODE_CONFIG_FILE);
}

function normalize(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return (s.length > 1 ? s.replace(/\/+$/, '') : s).toLowerCase();
}

function expandHome(p: string, home: string): string | undefined {
  const t = p.trim();
  for (const pre of ['~/', '$HOME/', '${HOME}/']) if (t.startsWith(pre)) return `${home}/${t.slice(pre.length)}`;
  if (t === '~' || t === '$HOME') return home;
  return t.startsWith('/') ? t : undefined;
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'projeto'
  );
}

const isComment = (k: string) => k.startsWith('_') || k.startsWith('$');
const PROJECT_KEYS = new Set(['nome', 'caminhos', 'privado', 'nota']);

function needlesOf(path: string, home: string): string[] {
  const out = [path, path.replace(/[^a-z0-9]/g, '-')];
  const h = normalize(home);
  if (path === h || path.startsWith(`${h}/`)) {
    const rest = path.slice(h.length);
    out.push(`~${rest}`, `$home${rest}`, `\${home}${rest}`);
  }
  return out;
}

/** Valida e monta a configuração; lança Error com a explicação em PT-BR. */
export function parseConfig(raw: unknown, home: string, file = QODE_CONFIG_FILE): QodeConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('esperado um objeto {"projetos": [...]}');
  const top = raw as Record<string, unknown>;
  for (const k of Object.keys(top)) if (k !== 'projetos' && !isComment(k)) throw new Error(`chave desconhecida "${k}"`);
  if (!Array.isArray(top.projetos)) throw new Error('"projetos" precisa ser uma lista');
  const projects: QodeProject[] = [];
  const keys = new Set<string>();
  for (const [i, item] of top.projetos.entries()) {
    const where = `projetos[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} precisa ser um objeto`);
    const p = item as Record<string, unknown>;
    for (const k of Object.keys(p)) if (!PROJECT_KEYS.has(k) && !isComment(k)) throw new Error(`${where}: chave desconhecida "${k}"`);
    const nome = typeof p.nome === 'string' ? p.nome.replace(/\s+/g, ' ').trim() : '';
    if (!nome || nome.length > NAME_MAX) throw new Error(`${where}: "nome" precisa ter de 1 a ${NAME_MAX} caracteres`);
    if (p.privado !== undefined && typeof p.privado !== 'boolean') throw new Error(`${where}: "privado" precisa ser true ou false`);
    if (p.nota !== undefined && typeof p.nota !== 'string') throw new Error(`${where}: "nota" precisa ser texto`);
    if (!Array.isArray(p.caminhos) || !p.caminhos.length) throw new Error(`${where}: "caminhos" precisa ser uma lista não vazia`);
    const roots: QodeProject['roots'] = [];
    let first: string | undefined;
    for (const c of p.caminhos) {
      if (typeof c !== 'string') throw new Error(`${where}: cada caminho precisa ser texto`);
      const star = c.trim().endsWith('*');
      const body = star ? c.trim().slice(0, -1) : c;
      if (body.includes('*')) throw new Error(`${where}: "*" só vale no fim do caminho (ex.: "~/Documents/GitHub/repo-*")`);
      const abs = expandHome(body, home);
      if (!abs || normalize(abs) === '/' || normalize(abs) === normalize(home)) {
        throw new Error(`${where}: caminho "${c}" precisa ser absoluto ou começar com ~/ (e não pode ser / nem a home inteira)`);
      }
      const r = star ? undefined : real(abs);
      const variants = new Set([normalize(abs), ...(r ? [normalize(r)] : [])]);
      if (star) roots.push({ path: normalize(abs) + (/[\\/]\s*$/.test(abs) ? '/' : ''), prefix: true });
      else for (const v of variants) roots.push({ path: v, prefix: false });
      if (!star && !first) first = r ?? abs.replace(/\/+$/, '');
    }
    const privado = p.privado === true;
    let roomKey = privado ? `${PRIVATE_ROOM_PREFIX}${slug(nome)}` : (first ?? `qode:${slug(nome)}`);
    while (keys.has(roomKey.toLowerCase())) roomKey = `${roomKey}-${projects.length}`;
    keys.add(roomKey.toLowerCase());
    projects.push({ nome, roots, privado, roomKey });
  }
  const needles = new Set<string>();
  for (const p of projects) if (p.privado) for (const r of p.roots) for (const n of needlesOf(r.path, home)) needles.add(n);
  return { file, projects, needles: [...needles] };
}

/** Lê o arquivo. undefined = não existe (sem QODE); inválido = config com `invalid` (tudo privado). */
export function loadQodeConfig(env: NodeJS.ProcessEnv, dataDir: string, home: string): QodeConfig | undefined {
  const file = configPath(env, dataDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { file, invalid: `não consegui ler (${(err as NodeJS.ErrnoException).code ?? 'erro'})`, projects: [], needles: [] };
  }
  try {
    return parseConfig(JSON.parse(text), home, file);
  } catch (err) {
    return { file, invalid: err instanceof Error ? err.message.slice(0, 200) : 'formato inválido', projects: [], needles: [] };
  }
}

function under(path: string, root: QodeProject['roots'][number]): boolean {
  return root.prefix ? path.startsWith(root.path) : path === root.path || path.startsWith(`${root.path}/`);
}

/** Projeto da pasta (o privado ganha de um público que também a cubra; depois, a raiz mais longa). */
export function projectOf(cfg: QodeConfig, cwd: string): QodeProject | undefined {
  const p = normalize(cwd);
  let best: { project: QodeProject; len: number } | undefined;
  for (const project of cfg.projects) {
    for (const r of project.roots) {
      if (!under(p, r)) continue;
      const better = !best || (project.privado && !best.project.privado) || (project.privado === best.project.privado && r.path.length > best.len);
      if (better) best = { project, len: r.path.length };
    }
  }
  return best?.project;
}

export function isPrivatePath(cfg: QodeConfig, path: string): boolean {
  if (cfg.invalid) return true;
  return projectOf(cfg, path)?.privado === true;
}

export function isPrivateRoom(cfg: QodeConfig, roomId: string): boolean {
  if (cfg.invalid) return true;
  if (roomId.toLowerCase().startsWith(PRIVATE_ROOM_PREFIX)) return true;
  return isPrivatePath(cfg, roomId);
}

/** O texto cita um caminho privado (absoluto, ~/, $HOME/ ou o cwd codificado do Claude Code)? */
export function mentionsPrivate(cfg: QodeConfig, text: string | undefined): boolean {
  if (!text || !cfg.needles.length) return false;
  const t = text.toLowerCase();
  return cfg.needles.some((n) => t.includes(n));
}
