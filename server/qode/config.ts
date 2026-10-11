// Fork QODE: projetos do Matheus num JSON editado à mão (<dataDir>/qode.config.json ou HABBLAUD_QODE_CONFIG).
// Cada projeto vira uma sala só (o repositório e as worktrees irmãs "repo-*"); os marcados com "privado": true
// só mostram o nome do projeto e o estado dos agentes (server/qode/privacy.ts).
// Arquivo presente mas inválido = tudo privado (fail closed). Sem arquivo = comportamento do upstream.
// Todo caminho é comparado na forma canônica: ~ e $HOME expandidos, "." e ".." resolvidos, barras repetidas juntadas
// e, quando o caminho (ou um ancestral dele) existe, symlinks resolvidos. A comparação ignora maiúsculas (APFS).
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';

export const QODE_CONFIG_FILE = 'qode.config.json';
export const PRIVATE_ROOM_PREFIX = 'qode-privado:';
const NAME_MAX = 40;
const TOKEN_MAX = 4_096;
const REAL_CACHE_MAX = 20_000;

export interface QodeRoot {
  /** Caminho canônico em minúsculas. */
  path: string;
  /** Veio de um caminho terminado em "*": vale como prefixo (worktrees irmãs). */
  prefix: boolean;
}

export interface QodeProject {
  nome: string;
  roots: QodeRoot[];
  privado: boolean;
  /** Chave da sala: a primeira raiz exata (caminho real) ou, para os privados, um id opaco. */
  roomKey: string;
}

export interface QodeConfig {
  /** De onde veio (para o log). */
  file: string;
  /** Arquivo ilegível ou fora do formato: tudo é tratado como privado. */
  invalid?: string;
  home: string;
  projects: QodeProject[];
  /** Raízes dos projetos privados (para procurar caminhos citados em textos). */
  privateRoots: QodeRoot[];
  /** Trechos (minúsculos) que denunciam um caminho privado mesmo fora de um caminho: o cwd codificado do Claude Code. */
  needles: string[];
}

export function configPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HABBLAUD_QODE_CONFIG?.trim() || join(dataDir, QODE_CONFIG_FILE);
}

/** "." e "..", barras repetidas e barra final: só texto, sem tocar no disco. */
export function lexical(p: string): string {
  const s = posix.normalize(p.trim().replace(/\\/g, '/'));
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

const realCache = new Map<string, string>();

/** realpath do caminho ou, se ele não existe, do ancestral mais próximo que existe (com o resto colado). */
export function realish(p: string): string {
  const hit = realCache.get(p);
  if (hit !== undefined) return hit;
  let out: string;
  try {
    out = realpathSync.native(p);
  } catch {
    const parent = posix.dirname(p);
    out = parent === p ? p : posix.join(realish(parent), posix.basename(p));
  }
  if (realCache.size >= REAL_CACHE_MAX) realCache.clear();
  realCache.set(p, out);
  return out;
}

/** Forma canônica (com symlinks resolvidos) de um caminho absoluto. */
export function canonical(p: string): string {
  return realish(lexical(p));
}

function expandHome(p: string, home: string): string | undefined {
  const t = p.trim();
  for (const pre of ['~/', '$HOME/', '${HOME}/']) if (t.startsWith(pre)) return `${home}/${t.slice(pre.length)}`;
  if (t === '~' || t === '$HOME') return home;
  return t.startsWith('/') ? t : undefined;
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

/** Valida e monta a configuração; lança Error com a explicação em PT-BR (sem repetir os caminhos). */
export function parseConfig(raw: unknown, home: string, file = QODE_CONFIG_FILE): QodeConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('esperado um objeto {"projetos": [...]}');
  const top = raw as Record<string, unknown>;
  for (const k of Object.keys(top)) if (k !== 'projetos' && !isComment(k)) throw new Error(`chave desconhecida "${k.slice(0, 40)}"`);
  if (!Array.isArray(top.projetos)) throw new Error('"projetos" precisa ser uma lista');
  const homeLex = lexical(home);
  const projects: QodeProject[] = [];
  const keys = new Set<string>();
  for (const [i, item] of top.projetos.entries()) {
    const where = `projetos[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} precisa ser um objeto`);
    const p = item as Record<string, unknown>;
    for (const k of Object.keys(p)) if (!PROJECT_KEYS.has(k) && !isComment(k)) throw new Error(`${where}: chave desconhecida "${k.slice(0, 40)}"`);
    const nome = typeof p.nome === 'string' ? p.nome.replace(/\s+/g, ' ').trim() : '';
    if (!nome || nome.length > NAME_MAX) throw new Error(`${where}: "nome" precisa ter de 1 a ${NAME_MAX} caracteres`);
    if (p.privado !== undefined && typeof p.privado !== 'boolean') throw new Error(`${where}: "privado" precisa ser true ou false`);
    if (p.nota !== undefined && typeof p.nota !== 'string') throw new Error(`${where}: "nota" precisa ser texto`);
    if (!Array.isArray(p.caminhos) || !p.caminhos.length) throw new Error(`${where}: "caminhos" precisa ser uma lista não vazia`);
    const roots: QodeRoot[] = [];
    let first: string | undefined;
    for (const [j, c] of p.caminhos.entries()) {
      const at = `${where}.caminhos[${j}]`;
      if (typeof c !== 'string') throw new Error(`${at} precisa ser texto`);
      const star = c.trim().endsWith('*');
      const body = star ? c.trim().slice(0, -1) : c;
      if (body.includes('*')) throw new Error(`${at}: "*" só vale no fim do caminho (ex.: "~/Documents/GitHub/repo-*")`);
      const abs = expandHome(body, home);
      const lex = abs ? lexical(abs) : undefined;
      if (!abs || !lex || lex === '/' || lex === homeLex) {
        throw new Error(`${at} precisa ser absoluto ou começar com ~/ (e não pode ser / nem a home inteira)`);
      }
      if (star) {
        // "repo-*": o prefixo vale no diretório pai (canônico) mais o começo do nome.
        const slash = /\/\s*$/.test(body);
        const dir = slash ? lex : posix.dirname(lex);
        const base = slash ? '' : posix.basename(lex);
        for (const d of new Set([dir, realish(dir)])) roots.push({ path: posix.join(d, base).toLowerCase() + (slash ? '/' : ''), prefix: true });
      } else {
        const real = realish(lex);
        for (const v of new Set([lex, real])) roots.push({ path: v.toLowerCase(), prefix: false });
        first ??= real;
      }
    }
    const privado = p.privado === true;
    let roomKey = privado ? `${PRIVATE_ROOM_PREFIX}${slug(nome)}` : (first ?? `qode:${slug(nome)}`);
    while (keys.has(roomKey.toLowerCase())) roomKey = `${roomKey}-${projects.length}`;
    keys.add(roomKey.toLowerCase());
    projects.push({ nome, roots, privado, roomKey });
  }
  const privateRoots = projects.filter((p) => p.privado).flatMap((p) => p.roots);
  const needles = [...new Set(privateRoots.filter((r) => r.path.length > 1).map((r) => r.path.replace(/[^a-z0-9]/g, '-')))];
  return { file, home, projects, privateRoots, needles };
}

/** Lê o arquivo. undefined = não existe (sem QODE); inválido = config com `invalid` (tudo privado). */
export function loadQodeConfig(env: NodeJS.ProcessEnv, dataDir: string, home: string): QodeConfig | undefined {
  const file = configPath(env, dataDir);
  const broken = (why: string): QodeConfig => ({ file, invalid: why, home, projects: [], privateRoots: [], needles: [] });
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return broken(`não consegui ler (${(err as NodeJS.ErrnoException).code ?? 'erro'})`);
  }
  try {
    return parseConfig(JSON.parse(text), home, file);
  } catch (err) {
    return broken(err instanceof Error ? err.message.slice(0, 200) : 'formato inválido');
  }
}

function under(path: string, root: QodeRoot): boolean {
  return root.prefix ? path.startsWith(root.path) : path === root.path || path.startsWith(`${root.path}/`);
}

function bestIn(cfg: QodeConfig, lower: string): { project: QodeProject; len: number } | undefined {
  let best: { project: QodeProject; len: number } | undefined;
  for (const project of cfg.projects) {
    for (const r of project.roots) {
      if (!under(lower, r)) continue;
      const better = !best || (project.privado && !best.project.privado) || (project.privado === best.project.privado && r.path.length > best.len);
      if (better) best = { project, len: r.path.length };
    }
  }
  return best;
}

/** Projeto da pasta, pela forma do texto e pela canônica (o privado ganha; depois, a raiz mais longa). */
export function projectOf(cfg: QodeConfig, cwd: string): QodeProject | undefined {
  const abs = expandHome(cwd, cfg.home);
  if (!abs) return undefined;
  const lex = lexical(abs);
  const a = bestIn(cfg, lex.toLowerCase());
  if (a?.project.privado) return a.project;
  const b = bestIn(cfg, realish(lex).toLowerCase());
  if (b?.project.privado) return b.project;
  return a?.project ?? b?.project;
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

/** Chave opaca da sala de um cwd quando a config é inválida (agrupa sem publicar o caminho). */
export function opaqueRoomKey(cfg: QodeConfig, cwd: string): string {
  const abs = expandHome(cwd, cfg.home) ?? cwd;
  const h = createHash('sha256').update(canonical(abs).toLowerCase()).digest('hex').slice(0, 12);
  return `${PRIVATE_ROOM_PREFIX}${h}`;
}

/**
 * Texto com os caminhos na forma em que o shell os veria: %XX decodificado, aspas e escapes do JSON tirados,
 * $HOME/${HOME}, ~ e ~usuário expandidos.
 */
export function unshell(text: string, home: string): string {
  let t = text;
  if (t.includes('%')) t = t.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  t = t.replace(/\\+\//g, '/').replace(/\\+["'`]|["'`]/g, '');
  t = t.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/gi, home);
  const users = posix.dirname(lexical(home));
  t = t.replace(/(^|[\s=:(,;{[|&>])~([A-Za-z0-9._-]*)(?=\/|\s|$)/g, (_m, pre: string, user: string) => `${pre}${user ? posix.join(users, user) : home}`);
  return t;
}

const PATH_TOKEN = /(?<![\w.~+-])\/[^\s"'`<>|;&(){}[\]\\,]*/g;
const GLOB = /[*?[]/;

function privateLower(cfg: QodeConfig, lower: string): boolean {
  return cfg.privateRoots.some((r) => under(lower, r));
}

/** Caminho absoluto (já sem aspas nem ~) que cai num projeto privado, inclusive por symlink ou "..". */
export function isPrivateToken(cfg: QodeConfig, token: string): boolean {
  let tok = token.slice(0, TOKEN_MAX).replace(/[.,:;!?]+$/, '');
  if (tok.length < 2) return false;
  const g = tok.search(GLOB);
  if (g >= 0) {
    // Glob que começa com parte do nome da pasta privada (ex.: ~/Documents/Vi*) pode casar com ela.
    const lit = lexical(tok.slice(0, g)).toLowerCase() + (tok[g - 1] === '/' ? '/' : '');
    if (cfg.privateRoots.some((r) => r.path.startsWith(lit) && lit.length > posix.dirname(r.path).length + 1)) return true;
    tok = tok.slice(0, tok.lastIndexOf('/', g) + 1) || '/';
  }
  const lex = lexical(tok);
  if (privateLower(cfg, lex.toLowerCase())) return true;
  return privateLower(cfg, realish(lex).toLowerCase());
}

/** Os caminhos absolutos de um texto (depois de unshell). */
export function pathTokens(text: string): string[] {
  return text.match(PATH_TOKEN) ?? [];
}

/** O texto cita um caminho privado (absoluto, ~/, ~usuário/, $HOME, com aspas, %XX, "..", symlink ou cwd codificado)? */
export function mentionsPrivate(cfg: QodeConfig, text: string | undefined): boolean {
  if (!text || !cfg.privateRoots.length) return false;
  const lower = text.toLowerCase();
  if (cfg.needles.some((n) => lower.includes(n))) return true;
  return pathTokens(unshell(text, cfg.home)).some((t) => isPrivateToken(cfg, t));
}
