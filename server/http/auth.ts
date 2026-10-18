// Fork QODE — B4 Fase L1: autenticação local opt-in (HABBLAUD_AUTH=1). Sem a variável nada muda.
//
// - Senha do operador: hash scrypt em <dataDir>/auth.json (0600). Nunca é logada.
// - Sessão: token CSPRNG de 256 bits no cookie HttpOnly; SameSite=Strict; Path=/ (`__Host-` + Secure quando o perfil
//   canónico pede HTTPS — NÃO se confia em X-Forwarded-Proto arbitrário).
//   O servidor guarda só o SHA-256 do token. Idle 8h, absoluto 7d. Logout/revogação/rotação/expiração fecham SSE.
// - Rate-limit de login por endereço (5 falhas / 15 min → 429). Mensagem de erro genérica.
// - Hooks locais: `Authorization: Bearer <token>` (HABBLAUD_HOOKS_TOKEN ou <dataDir>/hooks.token), aceito SÓ quando
//   (a) remoteAddress é loopback e (b) a rota+método é de hook (register/wait, codex events, inbox/bridge).
//   Host nunca é identidade. Bearer NÃO abre UI/operate: snapshot, stream, terminal, permissions detail/decision, messages.
// - Todos os SSE da sessão (/api/stream e */terminal) são rastreados; fecho por timer/evento sem esperar o próximo pedido.
// - Rotação de senha (auth.json.generation) invalida sessões e streams na hora. Cada sessão guarda o epoch sob que
//   foi emitida; login reconcilia o epoch DEPOIS do body e antes de emitir. auth.json ausente/corrompido/inválido
//   = fail-closed (revoga tudo, recusa login). Escrita atómica (tmp+rename).
// - Rate-limit conta falhas + logins em curso (reserva antes do await readBody).
// - Matriz por principal: cookie (operador) → UI/operate; Bearer (máquina) → SÓ ingest. Cookie NÃO abre ingest.
// - Confiança local: o token de hooks vale para a máquina inteira (qualquer processo do user que o leia), sem
//   vínculo a account/session/task. NÃO é identidade e NUNCA é reutilizado como credencial do B2/cloudbot.
// - Token de sessão em query string é ignorado (só cookie).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

export const MIN_PASSWORD = 12;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const IDLE_MS = 8 * 3600_000;
const ABSOLUTE_MS = 7 * 24 * 3600_000;
const RL_MAX = 5;
const RL_WINDOW_MS = 15 * 60_000;
const COOKIE = 'qode_session';
const COOKIE_SECURE = '__Host-qode_session';
/** Intervalo máximo entre reavaliações de idle/absoluto com SSE aberto. */
const EXPIRY_TICK_MS = 5_000;
/** Poll da geração da senha (rotação fora do processo). */
const GENERATION_POLL_MS = 2_000;

export function authEnabled(env: NodeJS.ProcessEnv): boolean {
  const on = (v?: string) => ['1', 'true', 'sim', 'on'].includes(v?.trim().toLowerCase() ?? '');
  return on(env.HABBLAUD_AUTH) || on(env.HABBLAUD_REMOTE);
}

export function remoteEnabled(env: NodeJS.ProcessEnv): boolean {
  return ['1', 'true', 'sim', 'on'].includes(env.HABBLAUD_REMOTE?.trim().toLowerCase() ?? '');
}

export interface PasswordRecord {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export interface AuthFile {
  password: PasswordRecord;
  /** Muda a cada writePasswordFile — o servidor vivo revoga sessões ao detectar. */
  generation: string;
}

export function hashPassword(password: string): PasswordRecord {
  if (password.length < MIN_PASSWORD) throw new Error(`senha precisa de pelo menos ${MIN_PASSWORD} caracteres`);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(password: string, rec: PasswordRecord): boolean {
  if (rec.algo !== 'scrypt') return false;
  const expected = Buffer.from(rec.hash, 'base64');
  const got = scryptSync(password, Buffer.from(rec.salt, 'base64'), expected.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 256 * rec.N * rec.r });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function authFile(dataDir: string): string {
  return join(dataDir, 'auth.json');
}

export function writePasswordFile(dataDir: string, password: string): AuthFile {
  const file = authFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const body: AuthFile = { password: hashPassword(password), generation: randomBytes(16).toString('hex') };
  // Escrita atómica: tmp exclusivo (0600) + rename — o leitor nunca vê um auth.json pela metade.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return body;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Valida o registo de auth.json (algo, parâmetros scrypt, salt/hash, generation). undefined = inválido. */
export function validateAuthFile(raw: unknown): AuthFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { password?: Partial<PasswordRecord>; generation?: unknown };
  const pw = r.password;
  if (!pw || typeof pw !== 'object' || pw.algo !== 'scrypt') return undefined;
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(pw.N, 16384, 1 << 20) || (pw.N! & (pw.N! - 1)) !== 0) return undefined;
  if (!int(pw.r, 8, 32) || !int(pw.p, 1, 16)) return undefined;
  if (typeof pw.salt !== 'string' || !B64.test(pw.salt) || Buffer.from(pw.salt, 'base64').length < 16) return undefined;
  if (typeof pw.hash !== 'string' || !B64.test(pw.hash) || Buffer.from(pw.hash, 'base64').length < 32) return undefined;
  if (typeof r.generation !== 'string' || !/^[0-9a-f]{16,128}$/.test(r.generation)) return undefined;
  return { password: { algo: 'scrypt', N: pw.N!, r: pw.r!, p: pw.p!, salt: pw.salt, hash: pw.hash }, generation: r.generation };
}

/** Lê e valida auth.json; exige ficheiro regular (sem symlink). undefined = ausente/corrompido/inválido. */
export function loadAuthFile(dataDir: string): AuthFile | undefined {
  try {
    const st = lstatSync(authFile(dataDir));
    if (!st.isFile()) return undefined;
    return validateAuthFile(JSON.parse(readFileSync(authFile(dataDir), 'utf8')));
  } catch {
    return undefined;
  }
}

/** Token Bearer dos hooks: env ou <dataDir>/hooks.token (ficheiro regular, ≥32 chars). */
export function resolveHooksToken(dataDir: string, envToken?: string): string | undefined {
  const env = envToken?.trim();
  if (env) return env.length >= 32 ? env : undefined;
  const file = join(dataDir, 'hooks.token');
  try {
    if (!lstatSync(file).isFile()) return undefined;
    const t = readFileSync(file, 'utf8').trim();
    return t.length >= 32 ? t : undefined;
  } catch {
    return undefined;
  }
}

const readAuthFile = loadAuthFile;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Capacidade do principal Bearer (hooks/mod/bridge). UI/operate fica de fora —
 * token de máquina via proxy local NÃO alcança snapshot, terminal nem decision.
 */
export function hooksBearerAllowed(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (path === '/api/codex/events' && m === 'POST') return true;
  if (path === '/api/mod/inbox' && m === 'POST') return true;
  if (path === '/api/mod/inbox/ack' && m === 'POST') return true;
  if (path === '/api/codex/bridge/poll' && m === 'POST') return true;
  if (path === '/api/codex/bridge/ack' && m === 'POST') return true;
  if (path === '/api/permissions' && m === 'POST') return true;
  if (m === 'GET' && /^\/api\/permissions\/[^/]+\/wait$/.test(path)) return true;
  // Mod do Claude Code (register.ts) — resumo só-leitura; principal de máquina, não UI.
  if (path === '/api/mod/summary' && m === 'GET') return true;
  return false;
}

/** Rotas SSE da sessão do operador — todas rastreadas para fecho na revogação/expiração. */
export function isSessionSsePath(path: string): boolean {
  return path === '/api/stream' || path.endsWith('/terminal');
}

interface Session {
  /** Epoch (generation de auth.json) sob a qual a sessão foi emitida. */
  generation: string;
  created: number;
  last: number;
  streams: Set<ServerResponse>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface AuthOptions {
  enabled: boolean;
  dataDir: string;
  /** Token Bearer dos hooks (HABBLAUD_HOOKS_TOKEN); senão lê <dataDir>/hooks.token. */
  hooksToken?: string;
  now?: () => number;
  /**
   * Perfil canónico: cookies Secure + nome `__Host-`.
   * Remoto (HABBLAUD_REMOTE) deve passar true. NÃO derivado de X-Forwarded-Proto.
   * Em local HTTP fica false (cookie sem Secure); em HTTPS real do socket ainda se pode forçar true.
   */
  secureCookies?: boolean;
  /** Injecção de timers (testes). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Auth {
  readonly enabled: boolean;
  /** Atende /api/auth/* e barra /api/* sem credencial. true = já respondeu. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** Revoga todas as sessões (fecha SSE). Devolve quantas. */
  revokeAll(): number;
  /** Para testes/admin: revoga pelo token em claro. */
  revokeToken(token: string): boolean;
  /** Fecha sessões idle/absolutas já vencidas (também corre por timer). Devolve quantas. */
  sweepExpired(): number;
  /** Relê auth.json; se a generation mudou, revoga tudo. Devolve true se rodou. */
  checkPasswordRotation(): boolean;
  sessionCount(): number;
  /** Para testes: para timers internos. */
  dispose(): void;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isTlsSocket(req: IncomingMessage): boolean {
  return !!(req.socket as { encrypted?: boolean }).encrypted;
}

export function createAuth(opts: AuthOptions): Auth {
  const now = opts.now ?? Date.now;
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const sessions = new Map<string, Session>();
  const failures = new Map<string, number[]>();
  /** Logins com body ainda a chegar, por IP — contam para o rate-limit (reserva antes do await). */
  const inflight = new Map<string, number>();
  /** Epoch corrente; '' = auth.json ausente/inválido → fail-closed (sem sessões, sem login). */
  let knownGeneration = readAuthFile(opts.dataDir)?.generation ?? '';

  const hooksToken = (): string | undefined => resolveHooksToken(opts.dataDir, opts.hooksToken);

  const clearExpiry = (s: Session) => {
    if (s.expiryTimer) {
      clearTimeoutFn(s.expiryTimer);
      s.expiryTimer = undefined;
    }
  };

  const drop = (key: string) => {
    const s = sessions.get(key);
    if (!s) return false;
    clearExpiry(s);
    sessions.delete(key);
    for (const r of s.streams) {
      try {
        r.end();
      } catch {
        /* já fechado */
      }
    }
    s.streams.clear();
    return true;
  };

  const scheduleExpiry = (key: string) => {
    const s = sessions.get(key);
    if (!s) return;
    clearExpiry(s);
    const t = now();
    const remaining = Math.min(IDLE_MS - (t - s.last), ABSOLUTE_MS - (t - s.created));
    if (remaining <= 0) {
      drop(key);
      return;
    }
    const wait = Math.max(50, Math.min(remaining, EXPIRY_TICK_MS));
    s.expiryTimer = setTimeoutFn(() => {
      const cur = sessions.get(key);
      if (!cur) return;
      const n = now();
      if (n - cur.last > IDLE_MS || n - cur.created > ABSOLUTE_MS) drop(key);
      else scheduleExpiry(key);
    }, wait);
  };

  const attachStream = (key: string, res: ServerResponse) => {
    const s = sessions.get(key);
    if (!s) return;
    s.streams.add(res);
    res.on('close', () => s.streams.delete(res));
    scheduleExpiry(key);
  };

  const sessionKey = (req: IncomingMessage, touch = true): string | undefined => {
    checkPasswordRotation();
    const c = parseCookies(req.headers.cookie);
    const token = c.get(COOKIE_SECURE) ?? c.get(COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return undefined;
    const key = sha256(token);
    const s = sessions.get(key);
    if (!s) return undefined;
    if (!knownGeneration || s.generation !== knownGeneration) {
      drop(key);
      return undefined;
    }
    const t = now();
    if (t - s.last > IDLE_MS || t - s.created > ABSOLUTE_MS) {
      drop(key);
      return undefined;
    }
    if (touch) {
      s.last = t;
      scheduleExpiry(key);
    }
    return key;
  };

  const bearerTokenOk = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization;
    if (!h || !/^Bearer\s+/i.test(h)) return false;
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    const expected = hooksToken();
    return !!expected && safeEqual(h.replace(/^Bearer\s+/i, '').trim(), expected);
  };

  /** Falhas recentes + logins em curso: N bodies suspensos não passam juntos. */
  const limited = (ip: string): boolean => {
    const t = now();
    const list = (failures.get(ip) ?? []).filter((x) => t - x < RL_WINDOW_MS);
    failures.set(ip, list);
    return list.length + (inflight.get(ip) ?? 0) >= RL_MAX;
  };

  /** Secure/__Host só com perfil canónico ou TLS real do socket — nunca X-Forwarded-Proto. */
  const useSecureCookie = (req: IncomingMessage): boolean => !!(opts.secureCookies || isTlsSocket(req));

  const cookieFor = (req: IncomingMessage, token: string, maxAge: number): string => {
    const secure = useSecureCookie(req);
    const name = secure ? COOKIE_SECURE : COOKIE;
    return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  /**
   * Reconcilia o epoch com auth.json. Mudou, sumiu ou ficou inválido → revoga TUDO (fail-closed).
   * Sessões com epoch ≠ corrente também morrem no sessionKey (defesa em profundidade).
   */
  function checkPasswordRotation(): boolean {
    const gen = readAuthFile(opts.dataDir)?.generation ?? '';
    if (gen === knownGeneration) return false;
    knownGeneration = gen;
    const had = sessions.size > 0;
    for (const k of [...sessions.keys()]) drop(k);
    return had || !gen;
  }

  function sweepExpired(): number {
    checkPasswordRotation();
    const t = now();
    let n = 0;
    for (const [key, s] of [...sessions.entries()]) {
      if (t - s.last > IDLE_MS || t - s.created > ABSOLUTE_MS) {
        drop(key);
        n++;
      }
    }
    return n;
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkPasswordRotation();
    const ip = req.socket.remoteAddress ?? '?';
    if (limited(ip)) return json(res, 429, { error: 'muitas tentativas; tente mais tarde' }, { 'Retry-After': String(RL_WINDOW_MS / 1000) });
    // Reserva a tentativa ANTES do await: bodies suspensos contam para o limite.
    inflight.set(ip, (inflight.get(ip) ?? 0) + 1);
    let password = '';
    try {
      try {
        const body = JSON.parse(await readBody(req)) as { password?: unknown };
        if (typeof body.password === 'string') password = body.password;
      } catch {
        /* cai no erro genérico */
      }
    } finally {
      const n = (inflight.get(ip) ?? 1) - 1;
      if (n > 0) inflight.set(ip, n);
      else inflight.delete(ip);
    }
    // Reconcilia o epoch DEPOIS do body: rotação durante a espera revoga as sessões antigas antes de emitir.
    checkPasswordRotation();
    const file = readAuthFile(opts.dataDir);
    const ok = !!file && file.generation === knownGeneration && password.length > 0 && verifyPassword(password, file.password);
    if (!ok) {
      failures.get(ip)?.push(now()) ?? failures.set(ip, [now()]);
      return json(res, 401, { error: 'credenciais inválidas' });
    }
    // Revalida após o scrypt: se rodou entretanto, não emite sob epoch velho.
    if (checkPasswordRotation() || knownGeneration !== file!.generation) return json(res, 401, { error: 'credenciais inválidas' });
    failures.delete(ip);
    // Regenera: qualquer sessão trazida no pedido morre.
    const old = sessionKey(req, false);
    if (old) drop(old);
    const token = randomBytes(32).toString('base64url');
    const t = now();
    const key = sha256(token);
    sessions.set(key, { generation: file!.generation, created: t, last: t, streams: new Set() });
    scheduleExpiry(key);
    json(res, 200, { ok: true, authenticated: true }, { 'Set-Cookie': cookieFor(req, token, ABSOLUTE_MS / 1000) });
  }

  const generationTimer = opts.enabled
    ? setIntervalFn(() => {
        checkPasswordRotation();
        sweepExpired();
      }, GENERATION_POLL_MS)
    : undefined;
  if (generationTimer && typeof generationTimer === 'object' && 'unref' in generationTimer) {
    (generationTimer as NodeJS.Timeout).unref?.();
  }

  return {
    enabled: opts.enabled,
    sessionCount: () => sessions.size,
    revokeAll() {
      const n = sessions.size;
      for (const k of [...sessions.keys()]) drop(k);
      return n;
    },
    revokeToken: (token) => drop(sha256(token)),
    sweepExpired,
    checkPasswordRotation,
    dispose() {
      if (generationTimer) clearIntervalFn(generationTimer as never);
      for (const k of [...sessions.keys()]) drop(k);
    },
    handle(req, res, path) {
      if (!opts.enabled) {
        // Auth desligada: responde 200 em vez de 404 para não sujar a consola do browser (o gate trata ambos).
        if (path === '/api/auth/status') {
          json(res, 200, { authRequired: false, authenticated: true });
          return true;
        }
        return false;
      }
      if (!path.startsWith('/api/')) return false;
      const method = req.method ?? 'GET';
      if (path === '/api/auth/status') {
        // authenticated = sessão do operador; Bearer é principal de máquina, não UI.
        json(res, 200, { authRequired: true, authenticated: !!sessionKey(req, false) });
        return true;
      }
      if (path === '/api/auth/login') {
        if (method !== 'POST') json(res, 405, { error: 'método não permitido' });
        else void login(req, res).catch(() => !res.headersSent && json(res, 400, { error: 'pedido inválido' }));
        return true;
      }
      if (path === '/api/auth/logout') {
        if (method !== 'POST') {
          json(res, 405, { error: 'método não permitido' });
          return true;
        }
        const key = sessionKey(req, false);
        if (key) drop(key);
        json(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, '', 0) });
        return true;
      }
      // Matriz por principal: rotas de ingest (hooks/mod/bridge) são SÓ Bearer — cookie de browser não as abre.
      if (hooksBearerAllowed(path, method)) {
        if (bearerTokenOk(req)) return false;
        json(res, 401, { error: 'autenticação necessária' });
        return true;
      }
      const key = sessionKey(req);
      if (key) {
        if (isSessionSsePath(path)) attachStream(key, res);
        return false;
      }
      json(res, 401, { error: 'autenticação necessária' });
      return true;
    },
  };
}
