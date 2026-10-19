// Entrada remota SÓ-LEITURA (plano ZikaBOT fatia 4). Desligada por padrão; pensada para ficar atrás de um proxy
// privado (Tailscale Serve, sem Funnel) numa porta própria em loopback — nunca 0.0.0.0.
//
// - Sessão própria: cookie `qode_ro` assinado (HMAC) com audiência 'qode-ro', validade curta, geração de revogação e
//   a `generation` do auth.json: trocar a senha ou o auth.json ficar ausente/inválido invalida a sessão no PRÓPRIO
//   pedido (e os SSE abertos no sweep). O cookie do operador (B4) NÃO vale aqui e este cookie não vale no operador.
// - Privacidade QODE obrigatória: com HABBLAUD_REMOTE_RO ligado, o preflight exige qode.config.json válido
//   (independente de HABBLAUD_QODE_REQUIRED) antes de fontes/listeners.
// - Dados só pelo DTO remoto (remote-dto.ts) e por uma vista própria (remote-view.ts): o viewer remoto não é cliente
//   do Hub (não desvia permissões) e nunca recebe o snapshot do operador cru.
// - Shell/login no navegador: o cliente estático (sem dados) é servido sem sessão; /api/auth/status|login|logout
//   respondem aqui no formato do gate do cliente (auth-gate.ts), com readOnly: true.
// - Token de hooks / Authorization nunca atravessa: qualquer Authorization é recusado.
// - Só GET/HEAD em caminhos da allowlist; hooks, terminal, mensagens, permissões, decisões, ops → 403.
// - Headers X-Forwarded-* ignorados (o proxy local chega como loopback; não confiar neles).
// - SSE aberto é encerrado na expiração da sessão e na revogação (limite verificável na app, não só no proxy).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isTruthy } from '../config';
import { qodePreflight } from '../qode/preflight';
import { parseCookies, verifyPassword, type PasswordRecord } from './auth';
import type { RemoteView } from './remote-view';

export const RO_COOKIE = 'qode_ro';
export const RO_AUD = 'qode-ro';
export const RO_TTL_MS = 12 * 3_600_000;
const MAX_LOGIN_BODY = 4096;
/** Mesmos limites do B4 (auth.ts): 5 falhas / 15 min; logins em curso contam (reserva antes de ler o body). */
export const RO_RL_MAX = 5;
export const RO_RL_WINDOW_MS = 15 * 60_000;

// Só o que passa pelo DTO remoto (snapshot/stream) e a versão. /api/stats ("Meu dia") não passa pelo DTO: fica fora.
const READ_API = [/^\/api\/snapshot$/, /^\/api\/stream$/, /^\/api\/updates$/];

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

/**
 * Preflight real com HABBLAUD_REMOTE_RO ligado (fail-closed): produção (não --dev/demo), origem HTTPS canónica
 * (HABBLAUD_REMOTE_RO_ORIGIN = só hostname, sem esquema/porta/caminho) e bind do operador em loopback.
 */
export interface RemoteRoPreflightInput {
  env: NodeJS.ProcessEnv;
  dev: boolean;
  demo?: boolean;
  host: string;
  /** Para validar a privacidade QODE (obrigatória com o RO ligado, independente de HABBLAUD_QODE_REQUIRED). */
  qode: { dataDir: string; home: string; inDocker: boolean; allowedHosts: ReadonlySet<string> };
}

export function remoteRoPreflight(o: RemoteRoPreflightInput): string[] {
  if (!isTruthy(o.env.HABBLAUD_REMOTE_RO)) return [];
  const p: string[] = [];
  // P1: sem qode.config.json válido o Office emite sem filtro de privacidade — o RO não arranca.
  for (const e of qodePreflight({ env: o.env, dataDir: o.qode.dataDir, home: o.qode.home, host: o.host, inDocker: o.qode.inDocker, allowedHosts: o.qode.allowedHosts }))
    p.push(`HABBLAUD_REMOTE_RO exige privacidade QODE válida: ${e}`);
  if (!loadRemoteRoConfig(o.env).enabled) p.push('HABBLAUD_REMOTE_RO=1 exige HABBLAUD_REMOTE_RO_PORT válida (1025-65535).');
  if (o.dev || o.demo) p.push('HABBLAUD_REMOTE_RO só em produção (sem --dev/demo).');
  const origin = o.env.HABBLAUD_REMOTE_RO_ORIGIN?.trim() ?? '';
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin))
    p.push('HABBLAUD_REMOTE_RO_ORIGIN tem de ser o hostname HTTPS canónico (ex. office.<tailnet>.ts.net), sem esquema/porta.');
  if (o.host !== '127.0.0.1' && o.host !== '::1' && o.host !== 'localhost') p.push('Com HABBLAUD_REMOTE_RO o bind do operador tem de ser loopback (HABBLAUD_HOST=127.0.0.1).');
  if (o.env.HABBLAUD_REMOTE_RO_PORT && o.env.HABBLAUD_REMOTE_RO_PORT === o.env.HABBLAUD_PORT) p.push('A porta só-leitura não pode ser a do operador.');
  return p;
}

/** Caminho que a entrada só-leitura aceita (GET/HEAD). Tudo o que não é /api é o cliente estático. */
export function roPathAllowed(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return READ_API.some((re) => re.test(path));
  if (path.startsWith('/ro/')) return false;
  return !path.includes('..');
}

export interface RoRouterOptions {
  /** Senha do B4 (auth.json); undefined = login recusado (fail-closed). */
  password: () => PasswordRecord | undefined;
  /**
   * `generation` ATUAL do auth.json (lida a cada pedido). A sessão guarda a do login: diferente (senha trocada) ou
   * ausente (auth.json removido/inválido) = sessão inválida e login recusado.
   */
  authGeneration: () => string | undefined;
  /** Snapshot/SSE remotos (DTO + vista própria, fora do Hub). */
  view: Pick<RemoteView, 'snapshot' | 'attach'>;
  /** Cliente estático (dist/client; sem dados), servido mesmo sem sessão para o login funcionar no navegador. */
  shell: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
  /** Corpo de GET /api/updates (versão). */
  updates?: () => unknown;
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
  /** Fecha os streams cuja sessão deixou de valer (expirou, revogada, auth.json trocado/ausente). */
  sweep(): void;
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
  type Stream = { res: ServerResponse; timer: NodeJS.Timeout; sid: string; cookie: string };
  const streams = new Set<Stream>();
  /** Sessões vivas no servidor (nonce -> exp): logout/revogação apagam aqui, cookie copiado deixa de valer. */
  const live = new Map<string, number>();
  // Limitador (semântica B4). Atrás do proxy todos chegam como loopback: o limite é efetivamente global.
  const failures = new Map<string, number[]>();
  const inflight = new Map<string, number>();
  const limited = (ip: string): boolean => {
    const t = now();
    const list = (failures.get(ip) ?? []).filter((x) => t - x < RO_RL_WINDOW_MS);
    failures.set(ip, list);
    return list.length + (inflight.get(ip) ?? 0) >= RO_RL_MAX;
  };

  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  const mint = (ag: string): { value: string; exp: number } => {
    const exp = now() + ttl;
    const n = randomBytes(16).toString('hex');
    for (const [k, e] of live) if (e <= now()) live.delete(k);
    live.set(n, exp);
    const body = b64(JSON.stringify({ aud: RO_AUD, exp, gen, ag, n }));
    return { value: `${body}.${sign(body)}`, exp };
  };
  const verify = (v: string | undefined): { exp: number; sid: string } | undefined => {
    if (!v) return undefined;
    const [body, mac] = v.split('.');
    if (!body || !mac) return undefined;
    const want = Buffer.from(sign(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { aud?: unknown; exp?: unknown; gen?: unknown; ag?: unknown; n?: unknown };
      if (p.aud !== RO_AUD || p.gen !== gen || typeof p.exp !== 'number' || p.exp <= now()) return undefined;
      // Ligada ao auth.json: generation tem de existir e ser a mesma do login.
      const ag = opts.authGeneration();
      if (!ag || typeof p.ag !== 'string' || p.ag !== ag) return undefined;
      if (typeof p.n !== 'string' || !live.has(p.n)) return undefined;
      return { exp: p.exp, sid: p.n };
    } catch {
      return undefined;
    }
  };
  const deny = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  const closeStream = (s: Stream) => {
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
    const ip = req.socket.remoteAddress ?? '?';
    // Limitador ANTES de ler o body ou correr scrypt; reserva a tentativa (bodies suspensos contam).
    if (limited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(RO_RL_WINDOW_MS / 1000), 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({ error: 'muitas tentativas; tente mais tarde' }));
    }
    inflight.set(ip, (inflight.get(ip) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const k = (inflight.get(ip) ?? 1) - 1;
      if (k > 0) inflight.set(ip, k);
      else inflight.delete(ip);
    };
    req.on('close', release);
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_LOGIN_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      release();
      const rec = opts.password();
      const ag = opts.authGeneration();
      let pw: unknown;
      try {
        pw = (JSON.parse(Buffer.concat(chunks).toString()) as { password?: unknown }).password;
      } catch {
        /* inválido */
      }
      if (!rec || !ag || typeof pw !== 'string' || !verifyPassword(pw, rec)) {
        const l = failures.get(ip);
        if (l) l.push(now());
        else failures.set(ip, [now()]);
        return deny(res, 401, 'credenciais inválidas');
      }
      failures.delete(ip);
      const { value } = mint(ag);
      const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(ttl / 1000)}`];
      if (opts.secureCookie) attrs.push('Secure');
      res.writeHead(204, { 'Set-Cookie': `${RO_COOKIE}=${value}; ${attrs.join('; ')}`, 'Cache-Control': 'no-store' });
      res.end();
    });
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    // Revoga no servidor: o nonce sai de `live` e os streams desta sessão fecham.
    const sess = verify(parseCookies(req.headers.cookie).get(RO_COOKIE));
    if (sess) {
      live.delete(sess.sid);
      for (const st of [...streams]) if (st.sid === sess.sid) closeStream(st);
    }
    req.resume();
    res.writeHead(204, { 'Set-Cookie': `${RO_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`, 'Cache-Control': 'no-store' });
    res.end();
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
      const method = req.method ?? 'GET';
      if (req.headers.authorization) return deny(res, 401, 'authorization não aceito nesta entrada');
      // Login/logout: as rotas próprias e as do gate do cliente (/api/auth/*) com a MESMA semântica (Origin, JSON,
      // limitador antes do scrypt, sessão qode_ro). Nunca a sessão do operador.
      if (path === '/ro/login' || path === '/api/auth/login') return method === 'POST' ? login(req, res) : deny(res, 405, 'método não permitido');
      if (path === '/ro/logout' || path === '/api/auth/logout') return method === 'POST' ? logout(req, res) : deny(res, 405, 'método não permitido');
      if (method !== 'GET' && method !== 'HEAD') return deny(res, 405, 'só leitura');
      // Nada do proxy chega a quem atende como identidade.
      for (const h of Object.keys(req.headers)) if (h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip') delete req.headers[h];
      const session = verify(parseCookies(req.headers.cookie).get(RO_COOKIE));
      if (path === '/api/auth/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return void res.end(JSON.stringify({ authRequired: true, authenticated: !!session, readOnly: true }));
      }
      const isApi = path === '/api' || path.startsWith('/api/');
      if (!roPathAllowed(path)) return deny(res, isApi || session ? 403 : 401, isApi || session ? 'fora da entrada só-leitura' : 'login necessário');
      // Shell (cliente estático, sem dados): sem sessão, para o gate de login do navegador poder arrancar.
      if (!isApi) return opts.shell(req, res, url);
      if (!session) return deny(res, 401, 'login necessário');
      if (path === '/api/stream') {
        const cookie = parseCookies(req.headers.cookie).get(RO_COOKIE) ?? '';
        const s: Stream = { res, sid: session.sid, cookie, timer: setTimeout(() => closeStream(s), Math.max(0, session.exp - now())) };
        s.timer.unref?.();
        streams.add(s);
        res.on('close', () => {
          clearTimeout(s.timer);
          streams.delete(s);
        });
        return opts.view.attach(req, res);
      }
      if (path === '/api/snapshot') return opts.view.snapshot(res);
      // /api/updates
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(opts.updates?.() ?? { state: 'off', available: false }));
    },
    sweep() {
      for (const st of [...streams]) if (!verify(st.cookie)) closeStream(st);
    },
    revokeAll() {
      gen++;
      live.clear();
      for (const s of [...streams]) closeStream(s);
    },
    openStreams: () => streams.size,
  };
}
