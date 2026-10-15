// Fork QODE — B4 Fase L1: autenticação local opt-in (HABBLAUD_AUTH=1). Sem a variável nada muda.
//
// - Senha do operador: hash scrypt em <dataDir>/auth.json (0600). Nunca é logada.
// - Sessão: token CSPRNG de 256 bits no cookie HttpOnly; SameSite=Strict; Path=/ (`__Host-` + Secure quando HTTPS).
//   O servidor guarda só o SHA-256 do token. Idle 8h, absoluto 7d. Logout invalida no servidor e fecha streams SSE.
// - Rate-limit de login por endereço (5 falhas / 15 min → 429). Mensagem de erro genérica.
// - Hooks locais: `Authorization: Bearer <token>` (HABBLAUD_HOOKS_TOKEN ou <dataDir>/hooks.token), aceito SÓ quando
//   a conexão vem do loopback (remoteAddress). Host nunca é identidade (achado Zika: proxy reescreve Host).
// - Token de sessão em query string é ignorado (só cookie).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function authEnabled(env: NodeJS.ProcessEnv): boolean {
  const on = (v?: string) => ['1', 'true', 'sim', 'on'].includes(v?.trim().toLowerCase() ?? '');
  return on(env.HABBLAUD_AUTH) || on(env.HABBLAUD_REMOTE);
}

export interface PasswordRecord {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
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

export function writePasswordFile(dataDir: string, password: string): void {
  const file = authFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ password: hashPassword(password) }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readPasswordFile(dataDir: string): PasswordRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(authFile(dataDir), 'utf8')) as { password?: PasswordRecord };
    return raw.password && typeof raw.password.hash === 'string' ? raw.password : undefined;
  } catch {
    return undefined;
  }
}

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

interface Session {
  created: number;
  last: number;
  streams: Set<ServerResponse>;
}

export interface AuthOptions {
  enabled: boolean;
  dataDir: string;
  /** Token Bearer dos hooks (HABBLAUD_HOOKS_TOKEN); senão lê <dataDir>/hooks.token. */
  hooksToken?: string;
  now?: () => number;
}

export interface Auth {
  readonly enabled: boolean;
  /** Atende /api/auth/* e barra /api/* sem credencial. true = já respondeu. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** Revoga todas as sessões (fecha SSE). Devolve quantas. */
  revokeAll(): number;
  /** Para testes/admin: revoga pelo token em claro. */
  revokeToken(token: string): boolean;
  sessionCount(): number;
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

function isHttps(req: IncomingMessage): boolean {
  return !!(req.socket as { encrypted?: boolean }).encrypted;
}

export function createAuth(opts: AuthOptions): Auth {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const failures = new Map<string, number[]>();

  const hooksToken = (): string | undefined => {
    const env = opts.hooksToken?.trim();
    if (env) return env;
    const file = join(opts.dataDir, 'hooks.token');
    if (!existsSync(file)) return undefined;
    try {
      const t = readFileSync(file, 'utf8').trim();
      return t.length >= 32 ? t : undefined;
    } catch {
      return undefined;
    }
  };

  const drop = (key: string) => {
    const s = sessions.get(key);
    if (!s) return false;
    sessions.delete(key);
    for (const r of s.streams) r.end();
    return true;
  };

  const sessionKey = (req: IncomingMessage): string | undefined => {
    const c = parseCookies(req.headers.cookie);
    const token = c.get(COOKIE_SECURE) ?? c.get(COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return undefined;
    const key = sha256(token);
    const s = sessions.get(key);
    if (!s) return undefined;
    const t = now();
    if (t - s.last > IDLE_MS || t - s.created > ABSOLUTE_MS) {
      drop(key);
      return undefined;
    }
    s.last = t;
    return key;
  };

  const bearerOk = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization;
    if (!h || !/^Bearer\s+/i.test(h)) return false;
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    const expected = hooksToken();
    return !!expected && safeEqual(h.replace(/^Bearer\s+/i, '').trim(), expected);
  };

  const limited = (ip: string): boolean => {
    const t = now();
    const list = (failures.get(ip) ?? []).filter((x) => t - x < RL_WINDOW_MS);
    failures.set(ip, list);
    return list.length >= RL_MAX;
  };

  const cookieFor = (req: IncomingMessage, token: string, maxAge: number): string => {
    const secure = isHttps(req) || req.headers['x-forwarded-proto'] === 'https';
    const name = secure ? COOKIE_SECURE : COOKIE;
    return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '?';
    if (limited(ip)) return json(res, 429, { error: 'muitas tentativas; tente mais tarde' }, { 'Retry-After': String(RL_WINDOW_MS / 1000) });
    let password = '';
    try {
      const body = JSON.parse(await readBody(req)) as { password?: unknown };
      if (typeof body.password === 'string') password = body.password;
    } catch {
      /* cai no erro genérico */
    }
    const rec = readPasswordFile(opts.dataDir);
    const ok = !!rec && password.length > 0 && verifyPassword(password, rec);
    if (!ok) {
      failures.get(ip)?.push(now()) ?? failures.set(ip, [now()]);
      return json(res, 401, { error: 'credenciais inválidas' });
    }
    failures.delete(ip);
    // Regenera: qualquer sessão trazida no pedido morre.
    const old = sessionKey(req);
    if (old) drop(old);
    const token = randomBytes(32).toString('base64url');
    const t = now();
    sessions.set(sha256(token), { created: t, last: t, streams: new Set() });
    json(res, 200, { ok: true, authenticated: true }, { 'Set-Cookie': cookieFor(req, token, ABSOLUTE_MS / 1000) });
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
    handle(req, res, path) {
      if (!opts.enabled || !path.startsWith('/api/')) return false;
      const method = req.method ?? 'GET';
      if (path === '/api/auth/status') {
        json(res, 200, { authRequired: true, authenticated: !!sessionKey(req) || bearerOk(req) });
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
        const key = sessionKey(req);
        if (key) drop(key);
        json(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, '', 0) });
        return true;
      }
      const key = sessionKey(req);
      if (key) {
        if (path === '/api/stream') {
          const s = sessions.get(key)!;
          s.streams.add(res);
          res.on('close', () => s.streams.delete(res));
        }
        return false;
      }
      if (bearerOk(req)) return false;
      json(res, 401, { error: 'autenticação necessária' });
      return true;
    },
  };
}
