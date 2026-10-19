import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authEnabled,
  createAuth,
  hashPassword,
  hooksBearerAllowed,
  isSessionSsePath,
  parseCookies,
  remoteEnabled,
  verifyPassword,
  writePasswordFile,
  type Auth,
} from './auth';
import { securityPreflight } from './security-preflight';
import { qodePreflight } from '../qode/preflight';
import { createRequestGuard } from './guard';
import { createApiHandler } from './app';
import { Hub } from './sse';
import { Office } from '../model/office';
import { NameStore } from '../model/names';
import { AccountsService } from '../accounts/service';
import { FileFetcher } from '../deliveries/fetcher';
import { DictationService } from '../dictation/dictation';
import { SpawnService } from '../spawn/spawn';
import { setQuiet } from '../log';

setQuiet(true);

const PW = 'correct horse battery';
const HOOK = 'h'.repeat(43);

let servers: http.Server[] = [];
let auths: Auth[] = [];
afterEach(async () => {
  for (const a of auths) a.dispose();
  auths = [];
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  servers = [];
});

async function startAuthServer(enabled = true, now?: () => number, secureCookies = false): Promise<{ base: string; auth: Auth; port: number; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'qode-auth-'));
  writePasswordFile(dataDir, PW);
  const auth = createAuth({ enabled, dataDir, hooksToken: HOOK, now, secureCookies });
  auths.push(auth);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (auth.handle(req, res, path)) return;
    if (path === '/api/stream' || path.endsWith('/terminal') || /\/stream$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      return;
    }
    if (path === '/api/permissions' && (req.method ?? 'GET') === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'p1', expiresAt: Date.now() + 60_000 }));
      return;
    }
    if (/^\/api\/permissions\/[^/]+\/wait$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'pending' }));
      return;
    }
    if (/^\/api\/permissions\/[^/]+\/decision$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === '/api/codex/events' && (req.method ?? 'GET') === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, auth, port, dataDir };
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
  it('auth.json é 0600, tem generation e não contém a senha', () => {
    const d = mkdtempSync(join(tmpdir(), 'qode-auth-'));
    const body = writePasswordFile(d, PW);
    expect(statSync(join(d, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(body.generation.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(body)).not.toContain(PW);
  });
  it('flags', () => {
    expect(authEnabled({})).toBe(false);
    expect(authEnabled({ HABBLAUD_AUTH: '1' })).toBe(true);
    expect(authEnabled({ HABBLAUD_REMOTE: '1' })).toBe(true);
    expect(remoteEnabled({ HABBLAUD_REMOTE: '1' })).toBe(true);
    expect(parseCookies('a=1; b=2').get('b')).toBe('2');
  });
  it('hooksBearerAllowed: só register/wait/events/inbox/bridge', () => {
    expect(hooksBearerAllowed('/api/permissions', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/permissions/x/wait', 'GET')).toBe(true);
    expect(hooksBearerAllowed('/api/permissions/x/decision', 'POST')).toBe(false);
    expect(hooksBearerAllowed('/api/permissions/x', 'GET')).toBe(false);
    expect(hooksBearerAllowed('/api/snapshot', 'GET')).toBe(false);
    expect(hooksBearerAllowed('/api/stream', 'GET')).toBe(false);
    expect(hooksBearerAllowed('/api/agents/a/terminal', 'GET')).toBe(false);
    expect(hooksBearerAllowed('/api/codex/events', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/mod/inbox', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/messages', 'POST')).toBe(false);
    expect(isSessionSsePath('/api/stream')).toBe(true);
    expect(isSessionSsePath('/api/agents/x/terminal')).toBe(true);
    expect(isSessionSsePath('/api/sessions/a/b/terminal')).toBe(true);
    expect(isSessionSsePath('/api/pty/abc/stream')).toBe(true);
    expect(isSessionSsePath('/api/pty/abc/input')).toBe(false);
    expect(isSessionSsePath('/api/snapshot')).toBe(false);
    expect(hooksBearerAllowed('/api/host/spawn/poll', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/spawn/ack', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/files/poll', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/files/ack', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/dictation/poll', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/dictation/ack', 'POST')).toBe(true);
    expect(hooksBearerAllowed('/api/host/spawn/poll', 'GET')).toBe(false);
    expect(hooksBearerAllowed('/api/spawn', 'POST')).toBe(false);
  });
});

describe('middleware HTTP', () => {
  it('default OFF: tudo passa como antes', async () => {
    const { base } = await startAuthServer(false);
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(200);

    // Sem 404 na consola: status responde 200 e diz que não há auth.
    const st = await fetch(`${base}/api/auth/status`);
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ authRequired: false, authenticated: true });
  });

  it('C1: sem credencial snapshot/stream → 401; status diz authRequired', async () => {
    const { base } = await startAuthServer();
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/api/stream`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ authRequired: true, authenticated: false });
  });

  it('C2: senha errada → 401 genérico; 5 falhas → 429 (mesmo com a certa)', async () => {
    const { base } = await startAuthServer();
    for (let i = 0; i < 5; i++) {
      const r = await login(base, 'errada-errada');
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'credenciais inválidas' });
    }
    expect((await login(base, PW)).status).toBe(429);
  });

  it('C3: login → cookie HttpOnly SameSite=Strict; 200; logout → 401', async () => {
    const { base, auth } = await startAuthServer();
    const r = await login(base, PW);
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/__Host-/); // local HTTP sem secureCookies
    const cookie = cookieOf(r);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(200);
    expect(auth.sessionCount()).toBe(1);
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' } });
    expect(out.status).toBe(200);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('perfil remoto/canónico: cookie Secure + __Host- (sem X-Forwarded-Proto)', async () => {
    const { base } = await startAuthServer(true, undefined, true);
    const sc = (await login(base, PW)).headers.get('set-cookie')!;
    expect(sc).toMatch(/__Host-qode_session=/);
    expect(sc).toMatch(/Secure/);
    // X-Forwarded-Proto sozinho NÃO activa Secure no perfil local
    const local = await startAuthServer(true, undefined, false);
    const forged = await fetch(`${local.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ password: PW }),
    });
    const sc2 = forged.headers.get('set-cookie')!;
    expect(sc2).not.toMatch(/__Host-/);
    expect(sc2).not.toMatch(/Secure/);
  });

  it('C4: token em query string é ignorado', async () => {
    const { base } = await startAuthServer();
    const token = cookieOf(await login(base, PW)).split('=')[1];
    expect((await fetch(`${base}/api/snapshot?session=${token}`)).status).toBe(401);
  });

  it('C5: revogar → SSE /api/stream e terminal fecham; sem mais dados', async () => {
    const { base, auth } = await startAuthServer();
    const cookie = cookieOf(await login(base, PW));
    const stream = await fetch(`${base}/api/stream`, { headers: { cookie } });
    const term = await fetch(`${base}/api/agents/x/terminal`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(term.status).toBe(200);
    const r1 = stream.body!.getReader();
    const r2 = term.body!.getReader();
    await r1.read();
    await r2.read();
    expect(auth.revokeAll()).toBe(1);
    let done1 = false;
    let done2 = false;
    for (let i = 0; i < 8 && !(done1 && done2); i++) {
      if (!done1) done1 = (await r1.read()).done;
      if (!done2) done2 = (await r2.read()).done;
    }
    expect(done1).toBe(true);
    expect(done2).toBe(true);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('expiração corta SSE sem novo pedido (sweep/timer)', async () => {
    let t = 1_000_000;
    const { base, auth } = await startAuthServer(true, () => t);
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/agents/a/terminal`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    await reader.read();
    t += 9 * 3600_000;
    expect(auth.sweepExpired()).toBe(1);
    let done = false;
    for (let i = 0; i < 8 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  async function readUntilDone(reader: ReadableStreamDefaultReader<Uint8Array>, n = 8, ms = 250): Promise<boolean> {
    let done = false;
    for (let i = 0; i < n && !done; i++) {
      const next = reader.read();
      const result = await Promise.race([
        next.then((v) => v),
        new Promise<ReadableStreamReadResult<Uint8Array>>((ok) => setTimeout(() => ok({ done: false, value: new Uint8Array() }), ms)),
      ]);
      done = result.done;
    }
    return done;
  }

  it('SSE /api/pty/:id/stream fecha no logout, na rotação e na expiração', async () => {
    let t = 1_000_000;
    const { base, auth, dataDir } = await startAuthServer(true, () => t);
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/pty/sess-1/stream`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    await reader.read();
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(await readUntilDone(reader)).toBe(true);

    const cookie2 = cookieOf(await login(base, PW));
    const sse2 = await fetch(`${base}/api/pty/sess-2/stream`, { headers: { cookie: cookie2 } });
    const r2 = sse2.body!.getReader();
    await r2.read();
    writePasswordFile(dataDir, PW + ' nova');
    expect(auth.checkPasswordRotation()).toBe(true);
    expect(await readUntilDone(r2)).toBe(true);

    const cookie3 = cookieOf(await login(base, PW + ' nova'));
    const sse3 = await fetch(`${base}/api/pty/sess-3/stream`, { headers: { cookie: cookie3 } });
    const r3 = sse3.body!.getReader();
    await r3.read();
    t += 9 * 3600_000;
    expect(auth.sweepExpired()).toBe(1);
    expect(await readUntilDone(r3)).toBe(true);
  });

  it('controlo negativo: stream de outra sessão continua aberto após revoke da primeira', async () => {
    const { base, auth } = await startAuthServer();
    const a = cookieOf(await login(base, PW));
    const b = cookieOf(await login(base, PW));
    const sseA = await fetch(`${base}/api/pty/a/stream`, { headers: { cookie: a } });
    const sseB = await fetch(`${base}/api/stream`, { headers: { cookie: b } });
    const rA = sseA.body!.getReader();
    const rB = sseB.body!.getReader();
    await rA.read();
    await rB.read();
    expect(auth.revokeToken(a.split('=')[1])).toBe(true);
    expect(await readUntilDone(rA)).toBe(true);
    const peek = rB.read();
    const raced = await Promise.race([
      peek.then((v) => v.done),
      new Promise<boolean>((ok) => setTimeout(() => ok(false), 40)),
    ]);
    expect(raced).toBe(false);
    expect(auth.sessionCount()).toBe(1);
  });

  it('rotação de senha invalida cookie e fecha streams', async () => {
    const { base, auth, dataDir } = await startAuthServer();
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/stream`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    await reader.read();
    writePasswordFile(dataDir, PW + ' rotated!');
    expect(auth.checkPasswordRotation()).toBe(true);
    let done = false;
    for (let i = 0; i < 8 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
    // nova senha funciona
    const fresh = cookieOf(await login(base, PW + ' rotated!'));
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie: fresh } })).status).toBe(200);
  });

  it('Bearer em /api/snapshot → 401; hook permitido → 200; decision só Bearer → 401', async () => {
    const { base } = await startAuthServer();
    const bearer = { authorization: `Bearer ${HOOK}` };
    expect((await fetch(`${base}/api/snapshot`, { headers: bearer })).status).toBe(401);
    expect((await fetch(`${base}/api/stream`, { headers: bearer })).status).toBe(401);
    expect((await fetch(`${base}/api/agents/x/terminal`, { headers: bearer })).status).toBe(401);
    expect((await fetch(`${base}/api/permissions/x/decision`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{"behavior":"allow"}' })).status).toBe(401);
    expect((await fetch(`${base}/api/permissions/x`, { headers: bearer })).status).toBe(401);
    expect((await fetch(`${base}/api/messages`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/codex/events`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect((await fetch(`${base}/api/permissions`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(201);
    expect((await fetch(`${base}/api/permissions/x/wait`, { headers: bearer })).status).toBe(200);
  });

  it('C6: hook loopback sem Bearer → 401; Bearer errado → 401', async () => {
    const { base } = await startAuthServer();
    const url = `${base}/api/codex/events`;
    const h = { 'Content-Type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers: h, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...h, authorization: 'Bearer x'.padEnd(45, 'y') }, body: '{}' })).status).toBe(401);
  });

  it('C9 (proxy): Host reescrito sem cookie → 401; rotas reais /api/tasks (não /api/qode/tasks)', async () => {
    const { port } = await startAuthServer();
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
    for (const p of ['/api/snapshot', '/api/stream', '/api/agents/x/terminal', '/api/permissions', '/api/messages', '/api/tasks']) {
      expect((await fetch(pbase + p)).status, p).toBe(401);
    }
    // Bearer via proxy ainda NÃO abre UI
    expect((await fetch(pbase + '/api/snapshot', { headers: { authorization: `Bearer ${HOOK}` } })).status).toBe(401);
  });
});

describe('securityPreflight / boot', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qode-sec-'));
  writePasswordFile(dataDir, PW);
  writeFileSync(join(dataDir, 'hooks.token'), HOOK + '\n', { mode: 0o600 });
  const base = { dataDir, host: '127.0.0.1', inDocker: false, dev: false, allowedHosts: new Set<string>() };

  it('REMOTE sem AUTH → erro; REMOTE+AUTH+senha+loopback → ok', () => {
    expect(securityPreflight({ ...base, env: { HABBLAUD_REMOTE: '1' } }).join()).toMatch(/exige HABBLAUD_AUTH/);
    expect(securityPreflight({ ...base, env: { HABBLAUD_REMOTE: '1', HABBLAUD_AUTH: '1' } })).toEqual([]);
  });

  it('AUTH com bind externo → erro', () => {
    expect(securityPreflight({ ...base, host: '0.0.0.0', env: { HABBLAUD_AUTH: '1' } }).join()).toMatch(/bind externo/);
  });

  it('REMOTE + Vite/dev → erro', () => {
    expect(securityPreflight({ ...base, dev: true, env: { HABBLAUD_REMOTE: '1', HABBLAUD_AUTH: '1' } }).join()).toMatch(/dev\/Vite/);
  });

  it('AUTH sem senha → erro', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qode-sec-empty-'));
    expect(securityPreflight({ ...base, dataDir: empty, env: { HABBLAUD_AUTH: '1' } }).join()).toMatch(/senha ausente/);
  });

  it('P2 pós-#13/#14: só HABBLAUD_REMOTE_RO (AUTH/REMOTE off) exige auth.json válido no boot', () => {
    const ro = { HABBLAUD_REMOTE_RO: '1', HABBLAUD_REMOTE_RO_PORT: '4399' };
    // auth.json válido → nada a reportar aqui (o resto do RO é do remoteRoPreflight)
    expect(securityPreflight({ ...base, env: ro })).toEqual([]);
    // ausente
    const empty = mkdtempSync(join(tmpdir(), 'qode-sec-ro-empty-'));
    expect(securityPreflight({ ...base, dataDir: empty, env: ro }).join()).toMatch(/senha ausente.*HABBLAUD_REMOTE_RO/);
    // corrompido (JSON partido) e JSON válido mas sem registo scrypt/generation
    const broken = mkdtempSync(join(tmpdir(), 'qode-sec-ro-broken-'));
    writeFileSync(join(broken, 'auth.json'), '{"password": {"algo": "scr');
    expect(securityPreflight({ ...base, dataDir: broken, env: ro }).join()).toMatch(/auth\.json inválido/);
    const hollow = mkdtempSync(join(tmpdir(), 'qode-sec-ro-hollow-'));
    writeFileSync(join(hollow, 'auth.json'), '{}');
    expect(securityPreflight({ ...base, dataDir: hollow, env: ro }).join()).toMatch(/auth\.json inválido/);
    // não regular (diretório no lugar do ficheiro)
    const dirAuth = mkdtempSync(join(tmpdir(), 'qode-sec-ro-dir-'));
    mkdirSync(join(dirAuth, 'auth.json'));
    expect(securityPreflight({ ...base, dataDir: dirAuth, env: ro }).join()).toMatch(/auth\.json inválido/);
    // RO desligado: sem exigência (comportamento atual)
    expect(securityPreflight({ ...base, dataDir: empty, env: { HABBLAUD_REMOTE_RO: '0' } })).toEqual([]);
    expect(securityPreflight({ ...base, dataDir: empty, env: {} })).toEqual([]);
  });

  it('ALLOWED_HOSTS sem AUTH → erro (não fica aberto)', () => {
    expect(securityPreflight({ ...base, allowedHosts: new Set(['tunel.example']), env: {} }).join()).toMatch(/ALLOWED_HOSTS exige HABBLAUD_AUTH/);
  });

  it('ALLOWED_HOSTS com AUTH ainda bloqueado em L1', () => {
    expect(securityPreflight({ ...base, allowedHosts: new Set(['tunel.example']), env: { HABBLAUD_AUTH: '1' } }).join()).toMatch(/ALLOWED_HOSTS/);
  });

  it('qodePreflight C8 remoto (compat)', () => {
    const qbase = { dataDir: '/nao-existe', home: '/tmp', host: '127.0.0.1', inDocker: false, allowedHosts: new Set<string>() };
    expect(qodePreflight({ ...qbase, env: { HABBLAUD_REMOTE: '1' } }).join()).toMatch(/HABBLAUD_REMOTE=1 exige HABBLAUD_AUTH=1/);
  });
});

describe('app completo + CSRF', () => {
  async function startFull(authOn = true): Promise<{ base: string; auth: Auth; cookie: string; close: () => Promise<void> }> {
    const tmp = mkdtempSync(join(tmpdir(), 'qode-full-'));
    const claude = join(tmp, '.claude');
    mkdirSync(join(claude, 'sessions'), { recursive: true });
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePasswordFile(dataDir, PW);
    const late: { office?: Office } = {};
    const accounts = new AccountsService({ dirs: [claude], home: tmp, env: {}, onChange: () => late.office?.markDirty() });
    const office = new Office({
      names: new NameStore(null),
      version: '9.9.9',
      startedAt: Date.now(),
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: () => undefined,
    });
    late.office = office;
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const spawn = new SpawnService({});
    const files = new FileFetcher({ direct: true });
    const dictation = new DictationService({});
    const api = createApiHandler({
      office,
      hub,
      accounts,
      sources: () => [],
      version: '9.9.9',
      inDocker: false,
      spawn,
      files,
      dictation,
    });
    const guard = createRequestGuard({ allowedHosts: new Set() });
    const auth = createAuth({ enabled: authOn, dataDir, hooksToken: HOOK });
    auths.push(auth);
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      if (auth.handle(req, res, url.pathname)) return;
      if (!api(req, res, url)) {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const cookie = authOn ? cookieOf(await login(base, PW)) : '';
    return {
      base,
      auth,
      cookie,
      close: () =>
        new Promise((ok) => {
          hub.stop();
          server.closeAllConnections();
          server.close(() => ok());
        }),
    };
  }

  it('Bearer token → UI negado no app real; cookie → snapshot ok', async () => {
    const env = await startFull(true);
    expect((await fetch(`${env.base}/api/snapshot`, { headers: { authorization: `Bearer ${HOOK}` } })).status).toBe(401);
    expect((await fetch(`${env.base}/api/snapshot`, { headers: { cookie: env.cookie } })).status).toBe(200);
    expect((await fetch(`${env.base}/api/tasks`, { headers: { authorization: `Bearer ${HOOK}` } })).status).toBe(401);
  });

  it('CSRF real: Origin evil com cookie de sessão → 403 no POST (guard)', async () => {
    const env = await startFull(true);
    const r = await new Promise<{ status: number }>((ok, fail) => {
      const u = new URL(env.base);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: '/api/rooms/rename',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
            cookie: env.cookie,
            Host: `127.0.0.1:${u.port}`,
          },
        },
        (res) => ok({ status: res.statusCode ?? 0 }),
      );
      req.on('error', fail);
      req.end(JSON.stringify({ from: 'a', to: 'b' }));
    });
    expect(r.status).toBe(403);
  });

  it('SSE /api/stream no app real fecha após revoke', async () => {
    const env = await startFull(true);
    const sse = await fetch(`${env.base}/api/stream`, { headers: { cookie: env.cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    await reader.read();
    env.auth.revokeAll();
    let done = false;
    for (let i = 0; i < 8 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('host jobs: Bearer (máquina) entra; cookie (browser) não consome poll/ack', async () => {
    const env = await startFull(true);
    const jobs = ['/api/host/spawn/poll', '/api/host/files/poll', '/api/host/dictation/poll'] as const;
    const acks = ['/api/host/spawn/ack', '/api/host/files/ack', '/api/host/dictation/ack'] as const;
    const jsonH = { 'Content-Type': 'application/json' };
    try {
      for (const path of [...jobs, ...acks]) {
        const cookie = await fetch(`${env.base}${path}`, { method: 'POST', headers: { ...jsonH, cookie: env.cookie }, body: '{}' });
        expect(cookie.status, `cookie ${path}`).toBe(401);
        const bearer = await fetch(`${env.base}${path}`, {
          method: 'POST',
          headers: { ...jsonH, authorization: `Bearer ${HOOK}` },
          body: path.endsWith('/ack') ? JSON.stringify({ results: [], files: [], dictations: [] }) : '{}',
        });
        expect(bearer.status, `bearer ${path}`).toBe(200);
      }
    } finally {
      await env.close();
    }
  });
});
