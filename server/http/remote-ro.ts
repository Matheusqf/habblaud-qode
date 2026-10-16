// Entrada remota SÓ-LEITURA (plano ZikaBOT fatia 4). Desligada por padrão; pensada para ficar atrás de um proxy
// privado (Tailscale Serve, sem Funnel) numa porta própria em loopback — nunca 0.0.0.0.
//
// - Sessão própria: cookie `qode_ro` assinado (HMAC) com audiência 'qode-ro', validade curta e geração de revogação.
//   O cookie do operador (B4) NÃO vale aqui e este cookie não vale na entrada do operador.
// - Token de hooks / Authorization nunca atravessa: qualquer Authorization é recusado.
// - Só GET/HEAD em caminhos da allowlist; hooks, terminal, mensagens, permissões, decisões, ops → 403.
// - Headers X-Forwarded-* ignorados (o proxy local chega como loopback; não confiar neles).
// - SSE aberto é encerrado na expiração da sessão e na revogação (limite verificável na app, não só no proxy).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isTruthy } from '../config';
import { parseCookies, verifyPassword, type PasswordRecord } from './auth';

export const RO_COOKIE = 'qode_ro';
export const RO_AUD = 'qode-ro';
export const RO_TTL_MS = 12 * 3_600_000;
const MAX_LOGIN_BODY = 4096;

const READ_API = [/^\/api\/snapshot$/, /^\/api\/stream$/, /^\/api\/updates$/, /^\/api\/stats(\/[a-z0-9-]+)?$/];

export interface RemoteRoConfig {
  enabled: boolean;
  port?: number;
}

/** HABBLAUD_REMOTE_RO=1 + HABBLAUD_REMOTE_RO_PORT. Sem as duas, desligado. Host é sempre 127.0.0.1. */
export function loadRemoteRoConfig(env: NodeJS.ProcessEnv): RemoteRoConfig {
  const port = Number(env.HABBLAUD_REMOTE_RO_PORT);
  const okPort = Number.isInteger(port) && port > 1024 && port < 65536;
  return { enabled: isTruthy(env.HABBLAUD_REMOTE_RO) && okPort, ...(okPort ? { port } : {}) };
}
export const RO_HOST = '127.0.0.1';

/** Caminho que a entrada só-leitura aceita (GET/HEAD). Tudo o que não é /api é o cliente estático. */
export function roPathAllowed(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return READ_API.some((re) => re.test(path));
  if (path.startsWith('/ro/')) return false;
  return !path.includes('..');
}

export interface RoRouterOptions {
  /** Senha do B4 (auth.json); undefined = login recusado (fail-closed). */
  password: () => PasswordRecord | undefined;
  /** O handler interno (api + estáticos) para pedidos já autorizados. */
  inner: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
  /** Host:porta públicos esperados no Origin do login (ex. "office.tailnet.ts.net"); undefined = só mesmo Host. */
  expectedOrigin?: string;
  ttlMs?: number;
  now?: () => number;
  secret?: Buffer;
  secureCookie?: boolean;
}

export interface RoRouter {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Revoga todas as sessões e fecha os streams abertos. */
  revokeAll(): void;
  openStreams(): number;
}

function b64(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

export function createReadOnlyRouter(opts: RoRouterOptions): RoRouter {
  const secret = opts.secret ?? randomBytes(32);
  const ttl = opts.ttlMs ?? RO_TTL_MS;
  const now = () => opts.now?.() ?? Date.now();
  let gen = 1;
  const streams = new Set<{ res: ServerResponse; timer: NodeJS.Timeout }>();

  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  const mint = (): { value: string; exp: number } => {
    const exp = now() + ttl;
    const body = b64(JSON.stringify({ aud: RO_AUD, exp, gen, n: randomBytes(8).toString('hex') }));
    return { value: `${body}.${sign(body)}`, exp };
  };
  const verify = (v: string | undefined): { exp: number } | undefined => {
    if (!v) return undefined;
    const [body, mac] = v.split('.');
    if (!body || !mac) return undefined;
    const want = Buffer.from(sign(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { aud?: unknown; exp?: unknown; gen?: unknown };
      if (p.aud !== RO_AUD || p.gen !== gen || typeof p.exp !== 'number' || p.exp <= now()) return undefined;
      return { exp: p.exp };
    } catch {
      return undefined;
    }
  };
  const deny = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  const closeStream = (s: { res: ServerResponse; timer: NodeJS.Timeout }) => {
    clearTimeout(s.timer);
    streams.delete(s);
    s.res.end();
    s.res.destroy();
  };

  function login(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const host = req.headers.host;
    let okOrigin = false;
    try {
      okOrigin = !!origin && (opts.expectedOrigin ? origin === `https://${opts.expectedOrigin}` : !!host && new URL(origin).host === host);
    } catch {
      okOrigin = false;
    }
    if (!okOrigin) return deny(res, 403, 'origem recusada');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return deny(res, 415, 'json');
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_LOGIN_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const rec = opts.password();
      let pw: unknown;
      try {
        pw = (JSON.parse(Buffer.concat(chunks).toString()) as { password?: unknown }).password;
      } catch {
        /* inválido */
      }
      if (!rec || typeof pw !== 'string' || !verifyPassword(pw, rec)) return deny(res, 401, 'credenciais inválidas');
      const { value } = mint();
      const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(ttl / 1000)}`];
      if (opts.secureCookie) attrs.push('Secure');
      res.writeHead(204, { 'Set-Cookie': `${RO_COOKIE}=${value}; ${attrs.join('; ')}`, 'Cache-Control': 'no-store' });
      res.end();
    });
  }

  return {
    handle(req, res) {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://ro.invalid');
      } catch {
        return deny(res, 400, 'url');
      }
      const path = url.pathname;
      if (req.headers.authorization) return deny(res, 401, 'authorization não aceito nesta entrada');
      if (path === '/ro/login' && req.method === 'POST') return login(req, res);
      if (path === '/ro/logout' && req.method === 'POST') {
        res.writeHead(204, { 'Set-Cookie': `${RO_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict` });
        return void res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405, 'só leitura');
      const session = verify(parseCookies(req.headers.cookie).get(RO_COOKIE));
      if (!session) return deny(res, 401, 'login necessário');
      if (!roPathAllowed(path)) return deny(res, 403, 'fora da entrada só-leitura');
      // Nada do proxy chega ao handler interno como identidade.
      for (const h of Object.keys(req.headers)) if (h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip') delete req.headers[h];
      if (path === '/api/stream') {
        const s = { res, timer: setTimeout(() => closeStream(s), Math.max(0, session.exp - now())) };
        s.timer.unref?.();
        streams.add(s);
        res.on('close', () => {
          clearTimeout(s.timer);
          streams.delete(s);
        });
      }
      opts.inner(req, res, url);
    },
    revokeAll() {
      gen++;
      for (const s of [...streams]) closeStream(s);
    },
    openStreams: () => streams.size,
  };
}
