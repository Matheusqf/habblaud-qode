// Fork QODE: projetos do Matheus num JSON editado à mão (<dataDir>/qode.config.json ou HABBLAUD_QODE_CONFIG).
// Cada projeto vira uma sala só (o repositório e as worktrees irmãs "repo-*"); os marcados com "privado": true
// só mostram o nome do projeto e o estado dos agentes (server/qode/privacy.ts).
// Arquivo presente mas inválido = tudo privado (fail closed). Sem arquivo = comportamento do upstream.
// Todo caminho é comparado na forma canônica: ~ e $HOME expandidos, "." e ".." resolvidos, barras repetidas juntadas
// e, quando o caminho (ou um ancestral dele) existe, symlinks resolvidos. A comparação ignora maiúsculas (APFS).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';

export const QODE_CONFIG_FILE = 'qode.config.json';
export const PRIVATE_ROOM_PREFIX = 'qode-privado:';
const NAME_MAX = 40;
const TOKEN_MAX = 4_096;
const REAL_CACHE_MAX = 20_000;
const REAL_CACHE_TTL_MS = 2_000;
const WALK_MAX = 16;
/** Acima disso, mentionsPrivate não inspeciona: trata como privado (não trava o event loop). */
export const MENTIONS_BYTES_MAX = 96 * 1024;
export const MENTIONS_TOKENS_MAX = 128;
const PATH_STOP = /[\s"'`<>|;&(){}[\]\\,]/;

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
  /** Caminhos de symlinks que apontam para uma raiz privada (descobertos no disco ou na resolução). */
  privateAliases: Set<string>;
}

export function configPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HABBLAUD_QODE_CONFIG?.trim() || join(dataDir, QODE_CONFIG_FILE);
}

/** "." e "..", barras repetidas e barra final: só texto, sem tocar no disco. */
export function lexical(p: string): string {
  const s = posix.normalize(p.trim().replace(/\\/g, '/'));
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

// Só acertos, e por pouco tempo: um symlink criado ou trocado depois precisa valer na próxima consulta.
const realCache = new Map<string, { real: string; at: number }>();

function realOf(p: string): string | undefined {
  const now = Date.now();
  const hit = realCache.get(p);
  if (hit && now - hit.at < REAL_CACHE_TTL_MS) return hit.real;
  try {
    const real = realpathSync.native(p);
    if (realCache.size >= REAL_CACHE_MAX) realCache.clear();
    realCache.set(p, { real, at: now });
    return real;
  } catch {
    realCache.delete(p);
    return undefined;
  }
}

/**
 * Uma etapa da caminhada: segue cada componente que existe (symlink incluso); ".." vale no alvo já resolvido.
 * Se um componente falha (ENOENT, EACCES, ELOOP…), o resto é colapsado como texto sobre o prefixo resolvido.
 */
function walkGap(p: string, add: (s: string) => void): string {
  const segs = p.split('/').filter((s) => s && s !== '.');
  let cur = '/';
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '..') {
      cur = posix.dirname(cur);
      add(cur);
      continue;
    }
    const next = realOf(posix.join(cur, segs[i]));
    if (next === undefined) {
      const collapsed = lexical(posix.join(cur, ...segs.slice(i)));
      add(collapsed);
      return collapsed;
    }
    cur = next;
    add(cur);
  }
  add(cur);
  return cur;
}

/** Caminha e, depois de um furo, continua a partir do colapso léxico até não haver mais ".." nem symlink resolvível. */
function walkInto(start: string, add: (s: string) => void): void {
  if (!start.startsWith('/')) {
    add(lexical(start));
    return;
  }
  let cur = start;
  for (let n = 0; n < WALK_MAX; n++) {
    add(cur);
    const whole = realOf(cur);
    if (whole !== undefined) {
      add(whole);
      return;
    }
    const next = walkGap(cur, add);
    if (next === cur) return;
    cur = next;
  }
}

/**
 * Leituras candidatas de um caminho: léxica, física estrita (prefixo existente + "..") e léxica+física
 * (colapsa o furo e continua). Qualquer uma privada vence; erro numa leitura não descarta as outras.
 */
function readings(p: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    if (s) found.add(s);
  };
  for (const raw of pathForms(p)) {
    add(lexical(raw));
    walkInto(raw, add);
    walkInto(lexical(raw), add);
  }
  return [...found];
}

/**
 * Caminho físico no estilo realpath -m: ".." vale depois do symlink; se um componente falha, o resto é colapsado
 * como texto e a caminhada continua (nao-existe/../ponte segue a ponte).
 */
export function realish(p: string): string {
  const raw = pathForms(p)[0] ?? p.trim().replace(/\\/g, '/');
  if (!raw.startsWith('/')) return lexical(raw);
  let last = lexical(raw);
  walkInto(raw, (s) => {
    last = s;
  });
  return last;
}

/** Forma canônica (com symlinks resolvidos) de um caminho absoluto. */
export function canonical(p: string): string {
  return realish(p);
}

/**
 * Forma de caminho para a allowlist: tira file://, decodifica %XX e \uXXXX (inclusive espaço) até estabilizar.
 * A forma crua e a decodificada entram nas leituras; o privado ganha se qualquer uma casar.
 */
function decodePath(p: string): string {
  let t = p.trim().replace(/\\/g, '/');
  if (t.slice(0, 16).toLowerCase() === 'file://localhost' && t[16] === '/') t = t.slice(16);
  else if (t.slice(0, 7).toLowerCase() === 'file://' && t[7] === '/') t = t.slice(7);
  for (let n = 0; n < 4; n++) {
    let next = '';
    let i = 0;
    let changed = false;
    while (i < t.length) {
      if (t[i] === '%' && isHexChar(t[i + 1]) && isHexChar(t[i + 2])) {
        next += String.fromCharCode(Number.parseInt(t.slice(i + 1, i + 3), 16));
        i += 3;
        changed = true;
        continue;
      }
      if (t[i] === '\\' && (t[i + 1] === 'u' || t[i + 1] === 'U') && isHexChar(t[i + 2]) && isHexChar(t[i + 3]) && isHexChar(t[i + 4]) && isHexChar(t[i + 5])) {
        next += String.fromCharCode(Number.parseInt(t.slice(i + 2, i + 6), 16));
        i += 6;
        changed = true;
        continue;
      }
      next += t[i];
      i += 1;
    }
    t = next;
    if (!changed) break;
  }
  return t;
}

/** Formas crua e decodificada (cwd, config e allowlist). */
function pathForms(p: string): string[] {
  const raw = p.trim().replace(/\\/g, '/');
  const decoded = decodePath(p);
  return decoded === raw ? [decoded] : [decoded, raw];
}

function expandHome(p: string, home: string): string | undefined {
  const t = decodePath(p);
  for (const pre of ['~/', '$HOME/', '${HOME}/']) if (t.startsWith(pre)) return decodePath(`${home}/${t.slice(pre.length)}`);
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
  for (const k of Object.keys(top)) if (k !== 'projetos' && !isComment(k)) throw new Error('chave desconhecida');
  if (!Array.isArray(top.projetos)) throw new Error('"projetos" precisa ser uma lista');
  const homeLex = lexical(home);
  const projects: QodeProject[] = [];
  const keys = new Set<string>();
  for (const [i, item] of top.projetos.entries()) {
    const where = `projetos[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} precisa ser um objeto`);
    const p = item as Record<string, unknown>;
    for (const k of Object.keys(p)) if (!PROJECT_KEYS.has(k) && !isComment(k)) throw new Error(`${where}: chave desconhecida`);
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
        const real = realish(abs);
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
  const privateAliases = discoverAliases(privateRoots);
  return { file, home, projects, privateRoots, needles, privateAliases };
}

/** Symlinks no diretório pai de cada raiz privada que apontam para ela. */
function discoverAliases(roots: QodeRoot[]): Set<string> {
  const out = new Set<string>();
  const dirs = new Set(roots.filter((r) => r.path.length > 1 && !r.prefix).map((r) => posix.dirname(r.path)));
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = posix.join(dir, name);
      try {
        const real = realpathSync.native(p).toLowerCase();
        if (roots.some((r) => under(real, r))) out.add(p.toLowerCase());
      } catch {
        /* não é symlink resolvível */
      }
    }
  }
  return out;
}

/** Lê o arquivo. undefined = não existe (sem QODE); inválido = config com `invalid` (tudo privado). */
export function loadQodeConfig(env: NodeJS.ProcessEnv, dataDir: string, home: string): QodeConfig | undefined {
  const file = configPath(env, dataDir);
  const broken = (why: string): QodeConfig => ({ file, invalid: why, home, projects: [], privateRoots: [], needles: [], privateAliases: new Set() });
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

/** Projeto da pasta: léxica, física estrita e léxica+física; o privado ganha; depois, a raiz mais longa. */
export function projectOf(cfg: QodeConfig, cwd: string): QodeProject | undefined {
  const abs = expandHome(cwd, cfg.home);
  if (!abs) return undefined;
  let best: { project: QodeProject; len: number } | undefined;
  for (const r of readings(abs)) {
    const hit = bestIn(cfg, r.toLowerCase());
    if (!hit) continue;
    if (hit.project.privado) return hit.project;
    if (!best || hit.len > best.len) best = hit;
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

/** Chave opaca da sala de um cwd quando a config é inválida (agrupa sem publicar o caminho). */
export function opaqueRoomKey(cfg: QodeConfig, cwd: string): string {
  const abs = expandHome(cwd, cfg.home) ?? cwd;
  const h = createHash('sha256').update(canonical(abs).toLowerCase()).digest('hex').slice(0, 12);
  return `${PRIVATE_ROOM_PREFIX}${h}`;
}

function isHexChar(c: string | undefined): boolean {
  if (!c) return false;
  const o = c.charCodeAt(0);
  return (o >= 48 && o <= 57) || (o >= 65 && o <= 70) || (o >= 97 && o <= 102);
}

function isTokenBreaker(code: number): boolean {
  return PATH_STOP.test(String.fromCharCode(code));
}

/** %XX que sobrou (espaço, aspas…) — o token já foi extraído inteiro. */
function decodeToken(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '%' && isHexChar(t[i + 1]) && isHexChar(t[i + 2])) {
      out += String.fromCharCode(Number.parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out += t[i];
  }
  return out;
}

/** %XX, \uXXXX, \/ e file:// — um único passe, sem regex com backtracking. */
function decodeEscapes(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '%' && isHexChar(text[i + 1]) && isHexChar(text[i + 2])) {
      const code = Number.parseInt(text.slice(i + 1, i + 3), 16);
      if (isTokenBreaker(code)) {
        out.push('%', text[i + 1]!, text[i + 2]!);
      } else {
        out.push(String.fromCharCode(code));
      }
      i += 3;
      continue;
    }
    if (c === '\\' && (text[i + 1] === 'u' || text[i + 1] === 'U') && isHexChar(text[i + 2]) && isHexChar(text[i + 3]) && isHexChar(text[i + 4]) && isHexChar(text[i + 5])) {
      const code = Number.parseInt(text.slice(i + 2, i + 6), 16);
      if (isTokenBreaker(code)) {
        const hex = code.toString(16).padStart(2, '0');
        out.push('%', hex[0]!, hex[1]!);
      } else {
        out.push(String.fromCharCode(code));
      }
      i += 6;
      continue;
    }
    if (c === '\\') {
      let j = i;
      while (j < n && text[j] === '\\') j++;
      if (j < n && text[j] === '/') {
        out.push('/');
        i = j + 1;
        continue;
      }
      if (j === i + 1 && (text[j] === '"' || text[j] === "'" || text[j] === '`')) {
        i += 2;
        continue;
      }
      while (i < j) {
        out.push('\\');
        i += 1;
      }
      continue;
    }
    if ((c === 'f' || c === 'F') && n - i >= 7 && text.slice(i, i + 7).toLowerCase() === 'file://') {
      let skip = 7;
      if (text.slice(i + 7, i + 16).toLowerCase() === 'localhost') skip = 16;
      if (text[i + skip] === '/') {
        i += skip;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function expandVars(text: string, home: string): string {
  const users = posix.dirname(lexical(home));
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === '$') {
      if (text.slice(i, i + 7).toLowerCase() === '${home}') {
        out.push(home);
        i += 7;
        continue;
      }
      if (text.slice(i, i + 5).toLowerCase() === '$home' && !/[A-Za-z0-9_]/.test(text[i + 5] ?? '')) {
        out.push(home);
        i += 5;
        continue;
      }
    }
    if (text[i] === '~' && (i === 0 || /[\s=:(,;{[|&>'"`]/.test(text[i - 1]!))) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9._-]/.test(text[j]!)) j++;
      const next = text[j];
      if (next === undefined || next === '/' || /\s/.test(next) || next === '"' || next === "'" || next === '`') {
        const user = text.slice(i + 1, j);
        out.push(user ? posix.join(users, user) : home);
        i = j;
        continue;
      }
    }
    out.push(text[i]!);
    i += 1;
  }
  return out.join('');
}

function stripQuotes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') continue;
    out += c;
  }
  return out;
}

/**
 * Texto com os caminhos na forma em que o shell os veria: %XX e \uXXXX decodificados, aspas e escapes do JSON
 * tirados, $HOME/${HOME}, ~ e ~usuário expandidos. Um único passe linear (sem regex com backtracking).
 */
export function unshell(text: string, home: string): string {
  return stripQuotes(expandVars(decodeEscapes(text), home));
}

const GLOB = /[*?[]/;

function takeQuoted(text: string, start: number): { token: string; next: number } {
  const q = text[start]!;
  let i = start + 1;
  let token = '';
  while (i < text.length && text[i] !== q) {
    if (q !== "'" && text[i] === '\\' && i + 1 < text.length) {
      token += text[i + 1];
      i += 2;
      continue;
    }
    token += text[i];
    i += 1;
  }
  return { token, next: i < text.length ? i + 1 : i };
}

const DASH_C = new Set(['-c', '-lc', '-ic', '-lic']);
const EVAL_LIKE = new Set(['eval']);

function takeShellWord(text: string, start: number): { word: string; next: number } {
  let i = start;
  let word = '';
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const q = takeQuoted(text, i);
      word += q.token;
      i = q.next;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < text.length) {
        word += text[i + 1] === '\n' ? '' : text[i + 1]!;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (/\s/.test(c) || /[;|&<>()]/.test(c)) break;
    word += c;
    i += 1;
  }
  return { word, next: i };
}

function tokenizeShell(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    if (/[;|&<>()]/.test(text[i]!)) {
      i += 1;
      continue;
    }
    const w = takeShellWord(text, i);
    if (w.word) words.push(w.word);
    i = w.next;
  }
  return words;
}

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
    const raw = tok.slice(0, g);
    const cut = raw.lastIndexOf('/');
    const tail = tok[g - 1] === '/' ? '/' : '';
    const bases = new Set<string>([lexical(raw), ...readings(raw.slice(0, cut) || '/').map((b) => posix.join(b, raw.slice(cut + 1)))]);
    for (const lit of [...bases].map((l) => l.toLowerCase() + tail)) {
      if (cfg.privateRoots.some((r) => r.path.startsWith(lit) && lit.length > posix.dirname(r.path).length + 1)) return true;
    }
    tok = tok.slice(0, tok.lastIndexOf('/', g) + 1) || '/';
  }
  const hit = readings(tok).some((r) => privateLower(cfg, r.toLowerCase()));
  if (hit) {
    const lex = lexical(tok).toLowerCase();
    if (lex.length > 3) cfg.privateAliases.add(lex);
  }
  return hit;
}

/** Palavras no estilo do shell: aspas adjacentes e escapes formam um só token; -c/eval são reabertos. */
export function pathTokens(text: string, home?: string, depth = 0): string[] {
  const prepared = home !== undefined ? expandVars(decodeEscapes(text), home) : text;
  const found: string[] = [];
  const add = (raw: string) => {
    const decoded = decodeToken(raw.trim());
    const t = (home ? expandHome(decoded, home) : undefined) ?? decoded;
    if (t.startsWith('/') && t.length >= 2) found.push(t);
  };
  const words = tokenizeShell(prepared);
  for (let i = 0; i < words.length; i++) {
    add(words[i]!);
    if (depth < 2 && i + 1 < words.length && (DASH_C.has(words[i]!) || EVAL_LIKE.has(words[i]!.toLowerCase()))) {
      for (const inner of pathTokens(words[i + 1]!, home, depth + 1)) found.push(inner);
    }
  }
  return found;
}

function walkStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) walkStrings(v, out);
}

/** O texto cita um caminho privado (absoluto, ~/, ~usuário/, $HOME, com aspas, %XX, "..", symlink ou cwd codificado)? */
export function mentionsPrivate(cfg: QodeConfig, text: string | undefined, depth = 0): boolean {
  if (!text || !cfg.privateRoots.length) return false;
  if (text.length > MENTIONS_BYTES_MAX) return true;
  const lower = text.toLowerCase();
  if (cfg.needles.some((n) => lower.includes(n))) return true;
  const tokens = pathTokens(text, cfg.home);
  if (tokens.length > MENTIONS_TOKENS_MAX) return true;
  if (tokens.some((t) => isPrivateToken(cfg, t))) return true;
  const flat = decodeToken(stripQuotes(expandVars(decodeEscapes(text), cfg.home))).toLowerCase();
  const contains = (root: string) => {
    if (root.length <= 3) return false;
    let i = 0;
    while (i < flat.length) {
      const at = flat.indexOf(root, i);
      if (at < 0) return false;
      const after = flat[at + root.length];
      if (after === undefined || after === '/') return true;
      i = at + 1;
    }
    return false;
  };
  if (cfg.privateRoots.some((r) => !r.prefix && contains(r.path))) return true;
  for (const a of cfg.privateAliases) if (contains(a)) return true;
  const trimmed = text.trimStart();
  if (depth < 2 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const inner: string[] = [];
        walkStrings(parsed, inner);
        if (inner.length > MENTIONS_TOKENS_MAX) return true;
        let bytes = 0;
        for (const s of inner) {
          bytes += s.length;
          if (bytes > MENTIONS_BYTES_MAX) return true;
        }
        return inner.some((s) => mentionsPrivate(cfg, s, depth + 1));
      }
    } catch {
      /* texto cru já foi varrido */
    }
  }
  return false;
}
