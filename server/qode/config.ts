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
/** Formas extras só para comparação (NFC/NFD); nunca substituem o caminho antes do realpath. */
function compareForms(s: string): string[] {
  return [...new Set([s, s.normalize('NFC'), s.normalize('NFD')])];
}

function readings(p: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    if (s) for (const f of compareForms(s)) found.add(f);
  };
  for (const raw of pathForms(p)) {
    add(lexical(raw));
    walkInto(raw, add);
    walkInto(lexical(raw), add);
  }
  return [...found];
}

/** Caminha no estilo realpath -m usando exatamente a grafia recebida, sem transformar `%XX` em outro nome. */
function realishLiteral(p: string): string {
  const raw = p.trim().replace(/\\/g, '/');
  if (!raw.startsWith('/')) return lexical(raw);
  let last = lexical(raw);
  walkInto(raw, (s) => {
    last = s;
  });
  return last;
}

/** Forma física preferencial; entradas codificadas tentam primeiro a forma decodificada. */
export function realish(p: string): string {
  const raw = pathForms(p)[0] ?? p.trim().replace(/\\/g, '/');
  return realishLiteral(raw);
}

/** Forma canônica (com symlinks resolvidos) de um caminho absoluto. */
export function canonical(p: string): string {
  return realish(p);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decodifica uma corrida de %XX consecutivos a partir de `i` como bytes UTF-8 (P1-a).
 * Sequência UTF-8 inválida cai no comportamento antigo (um caractere por byte), sem lançar.
 * `keep(byte)` devolve true para bytes que devem ficar literais ("%XX"), p.ex. separadores de token.
 */
function decodePercentRun(t: string, i: number, keep?: (byte: number) => boolean): { text: string; next: number } {
  const bytes: number[] = [];
  const raw: string[] = [];
  let j = i;
  while (t[j] === '%' && isHexChar(t[j + 1]) && isHexChar(t[j + 2])) {
    bytes.push(Number.parseInt(t.slice(j + 1, j + 3), 16));
    raw.push(t.slice(j, j + 3));
    j += 3;
  }
  let text = '';
  let group: number[] = [];
  const flush = () => {
    if (!group.length) return;
    try {
      text += UTF8.decode(Uint8Array.from(group));
    } catch {
      for (const b of group) text += String.fromCharCode(b);
    }
    group = [];
  };
  bytes.forEach((b, k) => {
    if (keep?.(b)) {
      flush();
      text += raw[k]; // forma original, mesma caixa do hex
    } else group.push(b);
  });
  flush();
  return { text, next: j };
}

/**
 * Forma de caminho para a allowlist: tira file://, decodifica %XX e \uXXXX (inclusive espaço) até estabilizar.
 * A forma crua e a decodificada entram nas leituras; o privado ganha se qualquer uma casar.
 */
function decodePath(p: string): string {
  // \uXXXX antes de trocar \ por / (antes o \ virava / e o escape nunca era decodificado).
  let t = p.trim().replace(/\\[uU]([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))).replace(/\\/g, '/');
  if (t.slice(0, 16).toLowerCase() === 'file://localhost' && t[16] === '/') t = t.slice(16);
  else if (t.slice(0, 7).toLowerCase() === 'file://' && t[7] === '/') t = t.slice(7);
  for (let n = 0; n < 4; n++) {
    let next = '';
    let i = 0;
    let changed = false;
    while (i < t.length) {
      if (t[i] === '%' && isHexChar(t[i + 1]) && isHexChar(t[i + 2])) {
        const run = decodePercentRun(t, i);
        next += run.text;
        i = run.next;
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
  // Sem normalizar: no Linux "café" NFC e NFD são caminhos físicos distintos. O NFC entra só como forma extra (pathForms).
  return t;
}

/** Formas crua e decodificada (cwd, config e allowlist). */
function pathForms(p: string): string[] {
  const raw = p.trim().replace(/\\/g, '/');
  const decoded = decodePath(p);
  // Só as grafias recebida e decodificada (UTF-8, sem normalizar): são estas que vão ao realpath.
  return decoded === raw ? [decoded] : [decoded, raw];
}

/** Absolutos candidatos: ~/$HOME já expandidos, forma crua e decodificada. */
function absoluteForms(p: string, home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const form of pathForms(p)) {
    let abs: string | undefined;
    for (const pre of ['~/', '$HOME/', '${HOME}/']) {
      if (form.startsWith(pre)) {
        abs = `${home}/${form.slice(pre.length)}`;
        break;
      }
    }
    if (form === '~' || form === '$HOME') abs = home;
    else if (!abs && form.startsWith('/')) abs = form;
    if (!abs) continue;
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function expandHome(p: string, home: string): string | undefined {
  return absoluteForms(p, home)[0];
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
      const forms = absoluteForms(body, home);
      const abs = forms[0];
      const lex = abs ? lexical(abs) : undefined;
      if (!abs || !lex || lex === '/' || lex === homeLex) {
        throw new Error(`${at} precisa ser absoluto ou começar com ~/ (e não pode ser / nem a home inteira)`);
      }
      if (star) {
        // "repo-*": o prefixo vale no diretório pai (canônico) mais o começo
        // do nome. Cada grafia é resolvida literalmente; caso contrário um
        // alias físico chamado literalmente `qode%20alias` seria perdido.
        for (const form of forms) {
          const formLex = lexical(form);
          const slash = /\/\s*$/.test(form);
          const dir = slash ? formLex : posix.dirname(formLex);
          const base = slash ? '' : posix.basename(formLex);
          for (const d of new Set([dir, realishLiteral(dir)])) {
            for (const f of compareForms(posix.join(d, base).toLowerCase() + (slash ? '/' : ''))) roots.push({ path: f, prefix: true });
          }
        }
      } else {
        const variants = new Set<string>();
        for (const form of forms) {
          variants.add(lexical(form));
          variants.add(realishLiteral(form));
        }
        for (const v of variants) for (const f of compareForms(v.toLowerCase())) roots.push({ path: f, prefix: false });
        first ??= realishLiteral(abs);
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
  let best: { project: QodeProject; len: number } | undefined;
  for (const abs of absoluteForms(cwd, cfg.home)) {
    for (const r of readings(abs)) {
      const hit = bestIn(cfg, r.toLowerCase());
      if (!hit) continue;
      if (hit.project.privado) return hit.project;
      if (!best || hit.len > best.len) best = hit;
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
      const run = decodePercentRun(t, i);
      out += run.text;
      i = run.next - 1;
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
      // Bytes < 0x80 que partem token ficam literais; o resto decodifica como UTF-8 (P1-a).
      const run = decodePercentRun(text, i, (b) => b < 0x80 && isTokenBreaker(b));
      out.push(run.text);
      i = run.next;
      continue;
    }
    if (c === '\\' && (text[i + 1] === 'u' || text[i + 1] === 'U')) {
      const width = text[i + 1] === 'U' ? 8 : 4;
      let valid = true;
      for (let j = 0; j < width; j++) if (!isHexChar(text[i + 2 + j])) valid = false;
      if (valid) {
        const code = Number.parseInt(text.slice(i + 2, i + 2 + width), 16);
        if (isTokenBreaker(code)) {
          const hex = code.toString(16).padStart(2, '0');
          out.push('%', hex.slice(-2, -1), hex.slice(-1));
        } else {
          try {
            out.push(width === 8 ? String.fromCodePoint(code) : String.fromCharCode(code));
          } catch {
            out.push('\\', text[i + 1]!);
            i += 1;
          }
        }
        i += 2 + width;
        continue;
      }
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

const SHELL_DEPTH_MAX = 2;

interface ShellScan {
  /** Palavras no nível atual; aspas e escapes já foram interpretados. */
  words: string[];
  /** Palavras encontradas em substituições neste nível ou abaixo dele. */
  nested: string[];
  /** A construção não pôde ser interpretada com os limites seguros. */
  unsafe: boolean;
}

function isShellSeparator(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c) || /[;|&<>()]/.test(c);
}

function backtickEnd(text: string, start: number): number | undefined {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '`') return i;
  }
  return undefined;
}

/** Fim de $(...), respeitando aspas, escapes e substituições aninhadas. */
function commandSubstitutionEnd(text: string, start: number, depth = 0): number | undefined {
  // A long input must not turn nested $() syntax into unbounded call-stack work.
  if (depth > SHELL_DEPTH_MAX + 2) return -1;
  let level = 1;
  let quote: 'single' | 'double' | undefined;
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i]!;
    if (quote === 'single') {
      if (c === "'") quote = undefined;
      continue;
    }
    if (quote === 'double') {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') {
        quote = undefined;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        const end = commandSubstitutionEnd(text, i, depth + 1);
        if (end === undefined) return undefined;
        if (end < 0) return -1;
        i = end;
      }
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === "'") {
      quote = 'single';
      continue;
    }
    if (c === '"') {
      quote = 'double';
      continue;
    }
    if (c === '`') {
      const end = backtickEnd(text, i);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = commandSubstitutionEnd(text, i, depth + 1);
      if (end === undefined) return undefined;
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '(') {
      level += 1;
      continue;
    }
    if (c === ')') {
      level -= 1;
      if (level === 0) return i;
    }
  }
  return undefined;
}

function ansiHex(text: string, start: number, max: number): { value: number; next: number } | undefined {
  let end = start;
  while (end < text.length && end - start < max && isHexChar(text[end])) end += 1;
  if (end === start) return undefined;
  return { value: Number.parseInt(text.slice(start, end), 16), next: end };
}

/** Interpreta só a forma ANSI-C de uma palavra $'...'; nunca executa o conteúdo. */
function ansiCWord(text: string, start: number): { value: string; next: number; unsafe: boolean } {
  let out = '';
  const bytes: number[] = [];
  let unsafe = false;
  const flushBytes = (): boolean => {
    if (!bytes.length) return true;
    try {
      out += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      bytes.length = 0;
      return true;
    } catch {
      return false;
    }
  };
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\0') unsafe = true;
    if (c === "'") {
      if (!flushBytes()) return { value: out, next: i, unsafe: true };
      return { value: out, next: i + 1, unsafe };
    }
    if (c !== '\\') {
      if (!flushBytes()) return { value: out, next: i, unsafe: true };
      out += c;
      continue;
    }
    const next = text[++i];
    if (next === undefined) return { value: out, next: i, unsafe: true };
    const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"' };
    if (simple[next] !== undefined) {
      if (!flushBytes()) return { value: out, next: i, unsafe: true };
      out += simple[next]!;
      continue;
    }
    if (next === 'x') {
      const hex = ansiHex(text, i + 1, 2);
      if (!hex) return { value: out, next: i + 1, unsafe: true };
      bytes.push(hex.value);
      unsafe ||= hex.value === 0;
      i = hex.next - 1;
      continue;
    }
    if (next === 'u' || next === 'U') {
      const hex = ansiHex(text, i + 1, next === 'u' ? 4 : 8);
      const required = next === 'u' ? 4 : 8;
      if (!hex || hex.next - (i + 1) !== required) return { value: out, next: i + 1, unsafe: true };
      if (!flushBytes()) return { value: out, next: i, unsafe: true };
      try {
        out += String.fromCodePoint(hex.value);
        unsafe ||= hex.value === 0;
      } catch {
        return { value: out, next: i + 1, unsafe: true };
      }
      i = hex.next - 1;
      continue;
    }
    if (next >= '0' && next <= '7') {
      let end = i;
      while (end < text.length && end - i < 3 && text[end]! >= '0' && text[end]! <= '7') end += 1;
      const value = Number.parseInt(text.slice(i, end), 8);
      bytes.push(value);
      // Uint8Array conversion truncates octal values modulo 256; zero and
      // overflow are ambiguous for shell paths, so keep both fail-closed.
      unsafe ||= value === 0 || value > 0xff;
      i = end - 1;
      continue;
    }
    // Keep unsupported ANSI-C controls conservative: dropping the backslash can
    // turn an unknown escape into a different path, so fail closed instead.
    if (!flushBytes()) return { value: out, next: i, unsafe: true };
    unsafe = true;
    out += `\\${next}`;
  }
  if (!flushBytes()) return { value: out, next: text.length, unsafe: true };
  return { value: out, next: text.length, unsafe: true };
}

function scanShell(text: string, depth: number): ShellScan {
  const words: string[] = [];
  const nested: string[] = [];
  let unsafe = false;
  let i = 0;

  const sub = (body: string) => {
    if (depth >= SHELL_DEPTH_MAX) {
      unsafe = true;
      return;
    }
    const parsed = scanShell(body, depth + 1);
    nested.push(...parsed.words, ...parsed.nested);
    unsafe ||= parsed.unsafe;
  };

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    if (isShellSeparator(text[i])) {
      i += 1;
      continue;
    }
    const start = i;
    let word = '';
    let wordUnsafe = false;
    while (i < text.length && !isShellSeparator(text[i])) {
      const c = text[i]!;
      // An apostrophe between letters is prose (I'm, don't), not an opening
      // shell quote. Keeping it literal also lets the following absolute path
      // remain its own token and preserves private-path detection in prose.
      if (
        c === "'" &&
        i > start &&
        /[A-Za-z0-9]/.test(text[i - 1]!) &&
        /[A-Za-z0-9]/.test(text[i + 1] ?? '') &&
        text.indexOf("'", i + 1) < 0
      ) {
        word += c;
        i += 1;
        continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) {
          word += text.slice(i + 1);
          wordUnsafe = word.includes('/');
          i = text.length;
          break;
        }
        word += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (c === '"') {
        i += 1;
        let closed = false;
        while (i < text.length) {
          const q = text[i]!;
          if (q === '"') {
            i += 1;
            closed = true;
            break;
          }
          if (q === '\\') {
            const escaped = text[i + 1];
            if (escaped === undefined) {
              i += 1;
              break;
            }
            if (escaped === '\n') i += 2;
            else if ('$`"\\'.includes(escaped)) {
              word += escaped;
              i += 2;
            } else {
              word += '\\' + escaped;
              i += 2;
            }
            continue;
          }
          if (q === '$' && text[i + 1] === '(') {
            const end = commandSubstitutionEnd(text, i);
            if (end === undefined) {
              wordUnsafe = text.slice(i + 2).includes('/');
              i = text.length;
              break;
            }
            if (end < 0) {
              wordUnsafe = true;
              i = text.length;
              break;
            }
            sub(text.slice(i + 2, end));
            i = end + 1;
            continue;
          }
          if (q === '`') {
            const end = backtickEnd(text, i);
            if (end === undefined) {
              wordUnsafe = text.slice(i + 1).includes('/');
              i = text.length;
              break;
            }
            sub(text.slice(i + 1, end));
            i = end + 1;
            continue;
          }
          word += q;
          i += 1;
        }
        if (!closed && word.includes('/')) wordUnsafe = true;
        continue;
      }
      if (c === '$' && text[i + 1] === "'") {
        const ansi = ansiCWord(text, i);
        word += ansi.value;
        wordUnsafe ||= ansi.unsafe && word.includes('/');
        i = ansi.next;
        continue;
      }
      if (c === '$' && text[i + 1] === '(') {
        const end = commandSubstitutionEnd(text, i);
        if (end === undefined) {
          wordUnsafe = text.slice(i + 2).includes('/');
          i = text.length;
          break;
        }
        if (end < 0) {
          wordUnsafe = true;
          i = text.length;
          break;
        }
        sub(text.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      if (c === '`') {
        const end = backtickEnd(text, i);
        if (end === undefined) {
          wordUnsafe = text.slice(i + 1).includes('/');
          i = text.length;
          break;
        }
        sub(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      if (c === '\\') {
        const escaped = text[i + 1];
        if (escaped === undefined) {
          i += 1;
          wordUnsafe = word.includes('/');
        } else {
          word += escaped === '\n' ? '' : escaped;
          i += 2;
        }
        continue;
      }
      word += c;
      i += 1;
    }
    if (word) words.push(word);
    unsafe ||= wordUnsafe;
    if (i === start) i += 1;
  }
  // bash/sh/zsh -c and eval receive a new shell program in their next word.
  // Re-open it at every parsed level, including inside command substitutions.
  for (let j = 0; j + 1 < words.length; j++) {
    const word = words[j]!;
    if (!DASH_C.has(word) && !EVAL_LIKE.has(word.toLowerCase())) continue;
    if (depth >= SHELL_DEPTH_MAX) {
      unsafe = true;
      continue;
    }
    const inner = scanShell(words[j + 1]!, depth + 1);
    nested.push(...inner.words, ...inner.nested);
    unsafe ||= inner.unsafe;
  }
  return { words, nested, unsafe };
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

interface ShellPathAnalysis {
  tokens: string[];
  unsafe: boolean;
}

function shellPathAnalysis(text: string, home?: string): ShellPathAnalysis {
  const prepared = home !== undefined ? expandVars(decodeEscapes(text), home) : text;
  const primary = scanShell(prepared, 0);
  // decodeEscapes is needed for JSON/URL forms, but an escaped quote inside a
  // -c payload belongs to the nested shell. Scan the source spelling too so
  // that `bash -c 'bash -c "cat \\\"/private path\\\""'` keeps its grouping.
  const secondary = /\\["'`]|\$\(|`/.test(text) ? scanShell(home !== undefined ? expandVars(text, home) : text, 0) : undefined;
  const roots = secondary ? [primary, secondary] : [primary];
  const unsafe = roots.some((r) => r.unsafe);
  const tokensFromWord = (raw: string): string[] => {
    const decoded = decodeToken(raw.trim());
    const values = [decoded];
    const equal = decoded.indexOf('=');
    if (equal > 0) values.push(decoded.slice(equal + 1));
    // Short options may be glued directly to an absolute argument, e.g.
    // `grep -f/private/path`. Restrict this extraction to option-looking
    // prefixes so ordinary public `name/path` words remain unchanged.
    const slash = decoded.indexOf('/');
    if (slash > 1 && /^-{1,2}[A-Za-z0-9_-]+$/.test(decoded.slice(0, slash))) {
      values.push(decoded.slice(slash));
    }
    return values
      .map((value) => (home ? expandHome(value, home) : undefined) ?? value)
      .filter((value) => value.startsWith('/') && value.length >= 2);
  };
  const words = (r: ShellScan) => [...r.words, ...r.nested];
  const primaryTokens = words(primary).flatMap(tokensFromWord);
  const primarySet = new Set(primaryTokens);
  const secondaryTokens = secondary
    ? words(secondary).flatMap(tokensFromWord).filter((t) => !primarySet.has(t))
    : [];
  return { tokens: [...primaryTokens, ...secondaryTokens], unsafe };
}

/** Palavras no estilo do shell: substituições são lidas, nunca executadas; -c/eval são reabertos. */
export function pathTokens(text: string, home?: string, _depth = 0): string[] {
  return shellPathAnalysis(text, home).tokens;
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
  const shell = shellPathAnalysis(text, cfg.home);
  if (shell.unsafe) return true;
  const tokens = shell.tokens;
  if (tokens.length > MENTIONS_TOKENS_MAX) return true;
  if (tokens.some((t) => isPrivateToken(cfg, t))) return true;
  // Prose can mention an unquoted path whose alias contains spaces. Try only
  // a small bounded window after each absolute-looking fragment; this keeps
  // `I'm reading /tmp/qode alias/secret.txt` observable without treating every
  // apostrophe as a shell error.
  const fragments = text.split(/\s+/);
  let absoluteFragments = 0;
  for (let i = 0; i < fragments.length; i++) {
    const first = fragments[i]!.replace(/^["'`]+/, '');
    if (!first.startsWith('/')) continue;
    absoluteFragments += 1;
    if (absoluteFragments > MENTIONS_TOKENS_MAX) return true;
    for (let width = 1; width <= 4 && i + width <= fragments.length; width++) {
      const candidate = [first, ...fragments.slice(i + 1, i + width).map((part) => part.replace(/["'`]+$/g, ''))].join(' ');
      if (isPrivateToken(cfg, candidate)) return true;
    }
  }
  const flatRaw = decodeToken(stripQuotes(expandVars(decodeEscapes(text), cfg.home))).toLowerCase();
  // Grafia recebida + NFC/NFD apenas como formas extras de comparação.
  const flats = compareForms(flatRaw);
  const contains = (root: string) => flats.some((flat) => containsIn(flat, root));
  const containsIn = (flat: string, root: string) => {
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
