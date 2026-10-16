// C9 (plano ZikaBOT fatia 5): servidor real + proxy real à frente, Host reescrito, headers forjados, cookies,
// CSRF, negação de hooks/ops, canários privados e SSE (expiração e revogação com stream já aberto).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword } from './auth';
import { createReadOnlyRouter, loadRemoteRoConfig, roPathAllowed, RO_COOKIE, RO_HOST, type RoRouter } from './remote-ro';

const PASSWORD = 'senha-de-teste-c9-123';
const CANARY = 'CANARIO-PRIVADO-C9';
const rec = hashPassword(PASSWORD);

interface Env { ro: RoRouter; proxyPort: number; directPort: number; innerHits: string[]; close: () => Promise<void> }
let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

async function setup(ttlMs = 60_000): Promise<Env> {
  const innerHits: string[] = [];
  const ro = createReadOnlyRouter({
    password: () => rec,
    ttlMs,
    expectedOrigin: 'office.example.ts.net',
    inner: (req, res, url) => {
      innerHits.push(`${req.method} ${url.pathname} xff=${req.headers['x-forwarded-for'] ?? ''}`);
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: snapshot\ndata: {}\n\n');
        const t = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 50);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (url.pathname === '/api/snapshot') return void res.end(JSON.stringify({ agents: [] }));
      res.end(`inner ${url.pathname} ${CANARY}`);
    },
  });
  const app = http.createServer((req, res) => ro.handle(req, res));
  const directPort = await listen(app);
  // Proxy "Tailscale Serve"-like: reescreve Host, acrescenta X-Forwarded-*, conexão chega em loopback.
  const proxy = http.createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: directPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${directPort}`, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': 'office.example.ts.net', 'x-forwarded-proto': 'https' } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('socket', (sock) => sock.on('close', () => res.destroy()));
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  const proxyPort = await listen(proxy);
  const close = async () => {
    ro.revokeAll();
    proxy.closeAllConnections();
    app.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => app.close(r));
  };
  return { ro, proxyPort, directPort, innerHits, close };
}

function req(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function login(port: number): Promise<string> {
  const r = await req(port, 'POST', '/ro/login', { origin: 'https://office.example.ts.net', 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
  expect(r.status).toBe(204);
  const c = String(r.headers['set-cookie']);
  expect(c).toMatch(/HttpOnly/);
  expect(c).toMatch(/SameSite=Strict/);
  return c.split(';')[0];
}

describe('C9 entrada remota só-leitura', () => {
  it('desligada por padrão e porta obrigatória', () => {
    expect(loadRemoteRoConfig({}).enabled).toBe(false);
    expect(loadRemoteRoConfig({ HABBLAUD_REMOTE_RO: '1' }).enabled).toBe(false);
    expect(loadRemoteRoConfig({ HABBLAUD_REMOTE_RO: '1', HABBLAUD_REMOTE_RO_PORT: '4320' })).toEqual({ enabled: true, port: 4320 });
    // Sem acesso direto por LAN/IPv6: o bind é fixo em loopback IPv4, não configurável.
    expect(RO_HOST).toBe('127.0.0.1');
    expect(loadRemoteRoConfig({ HABBLAUD_REMOTE_RO: '1', HABBLAUD_REMOTE_RO_PORT: '80' }).enabled).toBe(false);
  });

  it('sem login: 401 em tudo, inclusive pelo proxy; inner nunca é chamado', async () => {
    env = await setup();
    for (const p of ['/', '/api/snapshot', '/api/stream', '/api/hooks']) expect((await req(env.proxyPort, 'GET', p)).status).toBe(401);
    expect(env.innerHits).toEqual([]);
  });

  it('cookie do operador, cookie forjado e Authorization (hooks) não valem', async () => {
    env = await setup();
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: 'habblaud_session=abc; __Host-habblaud_session=abc' })).status).toBe(401);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: `${RO_COOKIE}=eyJhdWQiOiJxb2RlLXJvIn0.forjado` })).status).toBe(401);
    const c = await login(env.proxyPort);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c, authorization: 'Bearer hooks-token' })).status).toBe(401);
  });

  it('CSRF: login sem Origin certo ou sem JSON é recusado; senha errada 401', async () => {
    env = await setup();
    const body = JSON.stringify({ password: PASSWORD });
    expect((await req(env.proxyPort, 'POST', '/ro/login', { 'content-type': 'application/json' }, body)).status).toBe(403);
    expect((await req(env.proxyPort, 'POST', '/ro/login', { origin: 'https://evil.example', 'content-type': 'application/json' }, body)).status).toBe(403);
    expect((await req(env.proxyPort, 'POST', '/ro/login', { origin: 'https://office.example.ts.net', 'content-type': 'text/plain' }, body)).status).toBe(415);
    expect((await req(env.proxyPort, 'POST', '/ro/login', { origin: 'https://office.example.ts.net', 'content-type': 'application/json' }, '{"password":"errada-errada"}')).status).toBe(401);
  });

  it('com login: leitura ok; hooks/terminal/mensagens/permissões/ops/escrita negados; X-Forwarded removidos', async () => {
    env = await setup();
    const c = await login(env.proxyPort);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(200);
    expect((await req(env.proxyPort, 'GET', '/', { cookie: c })).status).toBe(200);
    for (const p of ['/api/hooks', '/api/codex/events', '/api/agents/x/terminal', '/api/messages', '/api/permissions', '/api/mod/inbox', '/api/health', '/api/sessions/a/b', '/api/continuity', '/api/tasks', '/api/demo', '/api/timeline/days']) {
      const r = await req(env.proxyPort, 'GET', p, { cookie: c });
      expect(r.status, p).toBe(403);
      expect(r.body).not.toContain(CANARY);
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await req(env.proxyPort, m, '/api/rooms/rename', { cookie: c, origin: 'https://office.example.ts.net' })).status, m).toBe(405);
    expect(env.innerHits.every((h) => h.endsWith('xff='))).toBe(true);
  });

  it('allowlist de caminhos', () => {
    expect(roPathAllowed('/api/stream')).toBe(true);
    expect(roPathAllowed('/api/stats/2026-10-16')).toBe(true);
    expect(roPathAllowed('/api/stats/../hooks')).toBe(false);
    expect(roPathAllowed('/assets/app.js')).toBe(true);
    expect(roPathAllowed('/ro/admin')).toBe(false);
  });

  it('SSE: revogação fecha stream já aberto e o cookie deixa de valer', async () => {
    env = await setup();
    const c = await login(env.proxyPort);
    const closed = new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: env!.proxyPort, path: '/api/stream', headers: { cookie: c } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', () => undefined);
        res.on('close', () => resolve(Date.now()));
        res.on('error', () => resolve(Date.now()));
      });
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(env.ro.openStreams()).toBe(1);
    env.ro.revokeAll();
    await closed;
    expect(env.ro.openStreams()).toBe(0);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
  });

  it('SSE: expiração da sessão fecha stream aberto — pelo proxy e com cliente lento direto', async () => {
    env = await setup(600);
    const c = await login(env.proxyPort);
    const open = (port: number, slow: boolean) =>
      new Promise<number>((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie: c } }, (res) => {
          if (slow) res.pause(); // cliente lento: não lê
          else res.on('data', () => undefined);
          const done = () => resolve(Date.now());
          res.on('end', done);
          res.on('close', done);
          res.socket.on('close', done);
        });
      });
    const t0 = Date.now();
    const [a, b] = await Promise.all([open(env.proxyPort, false), open(env.directPort, true)]);
    expect(a - t0).toBeLessThan(3000);
    expect(b - t0).toBeLessThan(3000);
    expect(env.ro.openStreams()).toBe(0);
    // reconexão com cookie expirado é recusada
    expect((await req(env.proxyPort, 'GET', '/api/stream', { cookie: c })).status).toBe(401);
  });
});
