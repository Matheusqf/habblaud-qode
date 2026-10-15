import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authEnabled, createAuth, hashPassword, parseCookies, verifyPassword, writePasswordFile, type Auth } from './auth';
import { qodePreflight } from '../qode/preflight';

const PW = 'correct horse battery';
const HOOK = 'h'.repeat(43);

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function start(enabled = true, now?: () => number): Promise<{ base: string; auth: Auth; port: number }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'qode-auth-'));
  writePasswordFile(dataDir, PW);
  const auth = createAuth({ enabled, dataDir, hooksToken: HOOK, now });
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (auth.handle(req, res, path)) return;
    if (path === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, auth, port };
}

const login = (base: string, password: string) =>
  fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('hash de senha', () => {
  it('scrypt verifica certo/errado e recusa curta', () => {
    const rec = hashPassword(PW);
    expect(verifyPassword(PW, rec)).toBe(true);
    expect(verifyPassword(PW + 'x', rec)).toBe(false);
    expect(() => hashPassword('curta')).toThrow();
  });
  it('auth.json é 0600 e não contém a senha', () => {
    const d = mkdtempSync(join(tmpdir(), 'qode-auth-'));
    writePasswordFile(d, PW);
    expect(statSync(join(d, 'auth.json')).mode & 0o777).toBe(0o600);
  });
  it('flags', () => {
    expect(authEnabled({})).toBe(false);
    expect(authEnabled({ HABBLAUD_AUTH: '1' })).toBe(true);
    expect(authEnabled({ HABBLAUD_REMOTE: '1' })).toBe(true);
    expect(parseCookies('a=1; b=2').get('b')).toBe('2');
  });
});

describe('middleware HTTP', () => {
  it('default OFF: tudo passa como antes', async () => {
    const { base } = await start(false);
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/status`)).status).toBe(200); // cai na app (que dará 404 real)
  });

  it('C1: sem credencial snapshot/stream → 401; status diz authRequired', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/api/stream`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ authRequired: true, authenticated: false });
  });

  it('C2: senha errada → 401 genérico; 5 falhas → 429 (mesmo com a certa)', async () => {
    const { base } = await start();
    for (let i = 0; i < 5; i++) {
      const r = await login(base, 'errada-errada');
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'credenciais inválidas' });
    }
    expect((await login(base, PW)).status).toBe(429);
  });

  it('C3: login → cookie HttpOnly SameSite=Strict; 200; logout → 401', async () => {
    const { base, auth } = await start();
    const r = await login(base, PW);
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(sc).toMatch(/Path=\//);
    const cookie = cookieOf(r);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(200);
    expect(auth.sessionCount()).toBe(1);
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' } });
    expect(out.status).toBe(200);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('C4: token em query string é ignorado', async () => {
    const { base } = await start();
    const token = cookieOf(await login(base, PW)).split('=')[1];
    expect((await fetch(`${base}/api/snapshot?session=${token}`)).status).toBe(401);
  });

  it('C5: revogar no store → 401 e SSE aberta é fechada', async () => {
    const { base, auth } = await start();
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/stream`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    await reader.read();
    expect(auth.revokeAll()).toBe(1);
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('expira por inatividade', async () => {
    let t = 1_000_000;
    const { base } = await start(true, () => t);
    const cookie = cookieOf(await login(base, PW));
    t += 9 * 3600_000;
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('C6: hook em loopback sem Bearer → 401; com Bearer → 200; Bearer errado → 401', async () => {
    const { base } = await start();
    const url = `${base}/api/codex/events`;
    const h = { 'Content-Type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: h, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...h, authorization: `Bearer ${HOOK}` }, body: '{}' })).status).toBe(200);
    expect((await fetch(url, { method: 'POST', headers: { ...h, authorization: 'Bearer x'.padEnd(45, 'y') }, body: '{}' })).status).toBe(401);
  });

  it('C9 (proxy de teste): Host reescrito para 127.0.0.1 sem cookie → 401 em cada capacidade', async () => {
    const { port } = await start();
    const proxy = http.createServer((req, res) => {
      const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1' } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const pbase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    for (const p of ['/api/snapshot', '/api/stream', '/api/agents/x/terminal', '/api/permissions', '/api/messages', '/api/qode/tasks']) {
      expect((await fetch(pbase + p)).status, p).toBe(401);
    }
  });
});

describe('preflight C8', () => {
  const base = { dataDir: '/nao-existe', home: '/tmp', host: '127.0.0.1', inDocker: false, allowedHosts: new Set<string>() };
  it('remote sem auth → erro; remote com auth → sem esse erro', () => {
    expect(qodePreflight({ ...base, env: { HABBLAUD_REMOTE: '1' } }).join()).toMatch(/HABBLAUD_REMOTE=1 exige HABBLAUD_AUTH=1/);
    expect(qodePreflight({ ...base, env: { HABBLAUD_REMOTE: '1', HABBLAUD_AUTH: '1' } }).join()).not.toMatch(/exige HABBLAUD_AUTH/);
  });
});
