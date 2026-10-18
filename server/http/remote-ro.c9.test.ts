// C9 (plano ZikaBOT fatia 5): servidor real + proxy real à frente, Host reescrito, headers forjados, cookies,
// CSRF, negação de hooks/ops, canários privados e SSE (expiração e revogação com stream já aberto).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword } from './auth';
import { createReadOnlyRouter, loadRemoteRoConfig, remoteRoPreflight, roPathAllowed, RO_COOKIE, RO_HOST, type RoRouter } from './remote-ro';

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

/** generation do auth.json sintético (mutável nos testes: troca de senha / ficheiro ausente). */
const auth: { generation: string | undefined } = { generation: 'g1' };

async function setup(ttlMs = 60_000, onPassword?: () => void): Promise<Env> {
  const innerHits: string[] = [];
  auth.generation = 'g1';
  const hit = (req: http.IncomingMessage, path: string) => innerHits.push(`${req.method} ${path} xff=${req.headers['x-forwarded-for'] ?? ''}`);
  const ro = createReadOnlyRouter({
    password: () => (onPassword?.(), rec),
    authGeneration: () => auth.generation,
    ttlMs,
    expectedOrigin: 'office.example.ts.net',
    view: {
      attach: (req, res) => {
        hit(req, '/api/stream');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: snapshot\ndata: {}\n\n');
        const t = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 50);
        res.on('close', () => clearInterval(t));
      },
      snapshot: (res) => void res.end(JSON.stringify({ agents: [] })),
    },
    shell: (req, res, url) => {
      hit(req, url.pathname);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><div id="app"></div>');
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

  it('sem login: dados 401 pelo proxy; só o shell estático (sem dados) e o status do gate respondem', async () => {
    env = await setup();
    for (const p of ['/api/snapshot', '/api/stream', '/api/updates']) expect((await req(env.proxyPort, 'GET', p)).status, p).toBe(401);
    // rota de operação: fora da allowlist, nunca chega a ninguém
    expect((await req(env.proxyPort, 'GET', '/api/hooks')).status).toBe(403);
    expect(env.innerHits).toEqual([]);
    // P2: GET / sem sessão devolve o HTML (shell), não 401 JSON
    const root = await req(env.proxyPort, 'GET', '/');
    expect(root.status).toBe(200);
    expect(root.headers['content-type']).toMatch(/text\/html/);
    const st = await req(env.proxyPort, 'GET', '/api/auth/status');
    expect(st.status).toBe(200);
    expect(JSON.parse(st.body)).toEqual({ authRequired: true, authenticated: false, readOnly: true });
  });

  it('P2 fluxo do cliente (auth-gate): status → POST /api/auth/login → sessão qode_ro → dados; logout pelo /api/auth/logout', async () => {
    env = await setup();
    const h = { origin: 'https://office.example.ts.net', 'content-type': 'application/json' };
    const r = await req(env.proxyPort, 'POST', '/api/auth/login', h, JSON.stringify({ password: PASSWORD }));
    expect(r.status).toBe(204); // res.ok no cliente
    const c = String(r.headers['set-cookie']).split(';')[0];
    expect(c.startsWith(`${RO_COOKIE}=`)).toBe(true);
    expect(JSON.parse((await req(env.proxyPort, 'GET', '/api/auth/status', { cookie: c })).body)).toMatchObject({ authenticated: true, readOnly: true });
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(200);
    // mesmas defesas do /ro/login: Origin e JSON
    expect((await req(env.proxyPort, 'POST', '/api/auth/login', { 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }))).status).toBe(403);
    expect((await req(env.proxyPort, 'GET', '/api/auth/login')).status).toBe(405);
    expect((await req(env.proxyPort, 'POST', '/api/auth/logout', { cookie: c })).status).toBe(204);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
  });

  it('sessão ligada ao auth.json: generation trocada ou ficheiro ausente invalida no próprio pedido; sweep fecha SSE; login recusado sem auth.json', async () => {
    env = await setup();
    const c = await login(env.proxyPort);
    const closed = new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1', port: env!.proxyPort, path: '/api/stream', headers: { cookie: c } }, (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve());
        res.on('close', () => resolve());
      });
    });
    await new Promise((r) => setTimeout(r, 150));
    auth.generation = 'g2'; // auth:set-password
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
    env.ro.sweep();
    await closed;
    expect(env.ro.openStreams()).toBe(0);
    const c2 = await login(env.proxyPort);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c2 })).status).toBe(200);
    auth.generation = undefined; // auth.json removido/inválido
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c2 })).status).toBe(401);
    expect((await req(env.proxyPort, 'POST', '/ro/login', { origin: 'https://office.example.ts.net', 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }))).status).toBe(401);
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
    for (const p of ['/api/hooks', '/api/codex/events', '/api/agents/x/terminal', '/api/messages', '/api/permissions', '/api/mod/inbox', '/api/health', '/api/sessions/a/b', '/api/continuity', '/api/tasks', '/api/demo', '/api/timeline/days', '/api/stats', '/api/agents/x']) {
      const r = await req(env.proxyPort, 'GET', p, { cookie: c });
      expect(r.status, p).toBe(403);
      expect(r.body).not.toContain(CANARY);
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await req(env.proxyPort, m, '/api/rooms/rename', { cookie: c, origin: 'https://office.example.ts.net' })).status, m).toBe(405);
    expect(env.innerHits.every((h) => h.endsWith('xff='))).toBe(true);
  });

  it('allowlist de caminhos', () => {
    expect(roPathAllowed('/api/stream')).toBe(true);
    expect(roPathAllowed('/api/stats/2026-10-16')).toBe(false); // não passa pelo DTO remoto
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

  it('limitador B4: 5 falhas → 429 mesmo com senha certa, sem correr scrypt', async () => {
    let checks = 0;
    env = await setup(60_000, () => checks++);
    const h = { origin: 'https://office.example.ts.net', 'content-type': 'application/json' };
    for (let i = 0; i < 5; i++) expect((await req(env.proxyPort, 'POST', '/ro/login', h, '{"password":"errada-errada"}')).status).toBe(401);
    const before = checks;
    expect((await req(env.proxyPort, 'POST', '/ro/login', h, JSON.stringify({ password: PASSWORD }))).status).toBe(429);
    expect(checks).toBe(before);
  });

  it('limitador B4 concorrente: bodies suspensos reservam tentativas antes do scrypt', async () => {
    let checks = 0;
    env = await setup(60_000, () => checks++);
    const pending: http.ClientRequest[] = [];
    const statuses: Promise<number>[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push(
        new Promise((resolve) => {
          const r = http.request({ host: '127.0.0.1', port: env!.directPort, method: 'POST', path: '/ro/login', headers: { origin: 'https://office.example.ts.net', 'content-type': 'application/json' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          r.on('error', () => resolve(-1));
          r.write('{"password":'); // body suspenso
          pending.push(r);
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(checks).toBe(0); // ninguém chegou ao scrypt
    for (const r of pending) r.end('"errada-errada"}');
    const st = await Promise.all(statuses);
    expect(st.filter((x) => x === 429).length).toBe(3);
    expect(st.filter((x) => x === 401).length).toBe(5);
    expect(checks).toBe(5);
  });

  it('logout revoga no servidor: cookie copiado deixa de valer e SSE aberto fecha', async () => {
    env = await setup();
    const c = await login(env.proxyPort);
    const other = await login(env.proxyPort);
    const closed = new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1', port: env!.proxyPort, path: '/api/stream', headers: { cookie: c } }, (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve());
        res.on('close', () => resolve());
      });
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(env.ro.openStreams()).toBe(1);
    expect((await req(env.proxyPort, 'POST', '/ro/logout', { cookie: c })).status).toBe(204);
    await closed;
    expect(env.ro.openStreams()).toBe(0);
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
    // a outra sessão continua válida
    expect((await req(env.proxyPort, 'GET', '/api/snapshot', { cookie: other })).status).toBe(200);
  });
  it('preflight: produção, origem HTTPS canónica, bind seguro e privacidade QODE válida', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qode-ro-pre-'));
    try {
      const cfgFile = join(tmp, 'qode.config.json');
      writeFileSync(cfgFile, JSON.stringify({ projetos: [{ nome: 'Loja', caminhos: [join(tmp, 'loja')], privado: false }] }));
      const qode = { dataDir: tmp, home: tmp, inDocker: false, allowedHosts: new Set<string>() };
      const ok = { HABBLAUD_REMOTE_RO: '1', HABBLAUD_REMOTE_RO_PORT: '4320', HABBLAUD_REMOTE_RO_ORIGIN: 'office.tail1234.ts.net', HABBLAUD_QODE_CONFIG: cfgFile };
      expect(remoteRoPreflight({ env: {}, dev: true, host: '0.0.0.0', qode })).toEqual([]); // desligado: nada a verificar
      expect(remoteRoPreflight({ env: ok, dev: false, host: '127.0.0.1', qode })).toEqual([]);
      expect(remoteRoPreflight({ env: ok, dev: true, host: '127.0.0.1', qode }).join()).toMatch(/produção/);
      expect(remoteRoPreflight({ env: ok, dev: false, host: '0.0.0.0', qode }).join()).toMatch(/loopback/);
      for (const bad of ['https://office.tail1234.ts.net', 'office.tail1234.ts.net:443', 'localhost', '', 'a/b.ts.net'])
        expect(remoteRoPreflight({ env: { ...ok, HABBLAUD_REMOTE_RO_ORIGIN: bad }, dev: false, host: '127.0.0.1', qode }).join(), bad).toMatch(/canónico/);
      expect(remoteRoPreflight({ env: { ...ok, HABBLAUD_PORT: '4320' }, dev: false, host: '127.0.0.1', qode }).join()).toMatch(/operador/);
      // P1: sem config / config inválida / "privado" implícito → recusa, SEM HABBLAUD_QODE_REQUIRED
      const noCfg = { ...ok, HABBLAUD_QODE_CONFIG: join(tmp, 'nao-existe.json') };
      expect(noCfg).not.toHaveProperty('HABBLAUD_QODE_REQUIRED');
      expect(remoteRoPreflight({ env: noCfg, dev: false, host: '127.0.0.1', qode }).join()).toMatch(/privacidade QODE válida: config QODE ausente/);
      const badFile = join(tmp, 'bad.json');
      writeFileSync(badFile, '{"projetos": [');
      expect(remoteRoPreflight({ env: { ...ok, HABBLAUD_QODE_CONFIG: badFile }, dev: false, host: '127.0.0.1', qode }).join()).toMatch(/privacidade QODE válida: config QODE não é JSON/);
      const implicit = join(tmp, 'implicit.json');
      writeFileSync(implicit, JSON.stringify({ projetos: [{ nome: 'Loja', caminhos: [join(tmp, 'loja')] }] }));
      expect(remoteRoPreflight({ env: { ...ok, HABBLAUD_QODE_CONFIG: implicit }, dev: false, host: '127.0.0.1', qode }).join()).toMatch(/privado/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
