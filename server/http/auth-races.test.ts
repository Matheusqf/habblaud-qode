// B4 PR #8 rodada 3 (ZikaBOT msgs 1792109368.628049 + 1792109413.788869): races de login/rotação, auth.json
// apagado/corrompido, rate-limit com bodies suspensos, matriz cookie→ingest, preflight estrito, timers automáticos,
// e app real (guard+API) com terminal/permissões/mensagens + fluxo real do hook de permissões.
// Tudo sintético: senha/token de teste, tmpdir, loopback. Sem credencial real, sem remoto.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth, writePasswordFile, type Auth, type AuthOptions } from './auth';
import { securityPreflight } from './security-preflight';
import { createRequestGuard } from './guard';
import { createApiHandler } from './app';
import { Hub } from './sse';
import { TerminalStreams } from './terminal';
import { createPermissionRoutes } from '../permissions/http';
import { Office } from '../model/office';
import { NameStore } from '../model/names';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
// @ts-expect-error módulo .mjs do plugin, sem tipos
import { run as runPermissionHook } from '../../mod/habblaud-permissoes/hooks/permission-hook.mjs';

setQuiet(true);

const PW = 'correct horse battery';
const PW2 = 'correct horse battery ROTATED';
const HOOK = 'h'.repeat(43);
/** Timers acelerados: continuam automáticos (ninguém chama sweep/check à mão). */
const fast: Partial<AuthOptions> = {
  setTimeoutFn: ((fn: () => void) => setTimeout(fn, 10)) as unknown as typeof setTimeout,
  setIntervalFn: ((fn: () => void) => setInterval(fn, 20)) as unknown as typeof setInterval,
};
/** Sem poll: prova que o próprio login reconcilia (não depende do timer). */
const noPoll: Partial<AuthOptions> = {
  setIntervalFn: (() => ({ unref() {} })) as unknown as typeof setInterval,
  clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
};

let servers: http.Server[] = [];
let auths: Auth[] = [];
let cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of auths) a.dispose();
  for (const c of cleanups) c();
  auths = [];
  cleanups = [];
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  servers = [];
});

async function start(extra: Partial<AuthOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qode-race-'));
  writePasswordFile(dataDir, PW);
  const auth = createAuth({ enabled: true, dataDir, hooksToken: HOOK, ...extra });
  auths.push(auth);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (auth.handle(req, res, path)) return;
    if (path === '/api/stream' || path.endsWith('/terminal')) {
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
  return { base: `http://127.0.0.1:${port}`, port, auth, dataDir };
}

const login = (base: string, password: string) =>
  fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

/** Login com body pausado: headers chegam já, o corpo só quando `finish()` é chamado. */
function pausedLogin(port: number, password: string) {
  const body = JSON.stringify({ password });
  let resolve!: (v: { status: number; cookie: string }) => void;
  const done = new Promise<{ status: number; cookie: string }>((r) => (resolve = r));
  const req = http.request(
    { host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port}` } },
    (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] });
    },
  );
  req.flushHeaders();
  req.write(body.slice(0, 3));
  return { done, finish: () => req.end(body.slice(3)) };
}

/**
 * true só se o SERVIDOR fechar o stream (read() → done) dentro de `ms`.
 * Timeout → false (nunca conta o nosso próprio cancel como fecho). Cancel apenas no finally, para limpeza.
 */
async function streamClosed(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 2000): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); });
  const closed = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return 'closed' as const;
      }
    } catch {
      return 'error' as const;
    }
  })();
  try {
    return (await Promise.race([closed, timeout])) === 'closed';
  } finally {
    clearTimeout(t);
    await reader.cancel().catch(() => {});
  }
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('helper streamClosed: controle negativo', () => {
  it('servidor mantém o SSE aberto → helper devolve false (timeout não é fecho)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      const iv = setInterval(() => res.write(': ping\n\n'), 20); // mantém aberto e ativo
      res.on('close', () => clearInterval(iv));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const sse = await fetch(`http://127.0.0.1:${port}/`);
    const reader = sse.body!.getReader();
    await reader.read();
    const t0 = Date.now();
    expect(await streamClosed(reader, 300)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });
  it('controle positivo: servidor fecha o SSE → helper devolve true', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ok\n\n');
      setTimeout(() => res.end(), 50);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const reader = (await fetch(`http://127.0.0.1:${port}/`)).body!.getReader();
    await reader.read();
    expect(await streamClosed(reader, 1000)).toBe(true);
  });
});

describe('race 1: login concorrente × rotação (epoch por sessão)', () => {
  it('body pausado → rotacionar → concluir login (senha nova) → cookie antigo 401 e SSE cortado', async () => {
    const { base, port, auth, dataDir } = await start(noPoll);
    const oldCookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/stream`, { headers: { cookie: oldCookie } });
    const reader = sse.body!.getReader();
    await reader.read();
    const p = pausedLogin(port, PW2);
    await tick();
    writePasswordFile(dataDir, PW2); // rotação enquanto o body está suspenso; nenhum outro pedido no meio
    p.finish();
    const r = await p.done;
    expect(r.status).toBe(200);
    expect(await streamClosed(reader)).toBe(true);
    expect(auth.sessionCount()).toBe(1); // só a nova
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie: oldCookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie: r.cookie } })).status).toBe(200);
  });

  it('body pausado com senha ANTIGA → rotação → 401 (não emite sob epoch velho)', async () => {
    const { port, dataDir } = await start(noPoll);
    const p = pausedLogin(port, PW);
    await tick();
    writePasswordFile(dataDir, PW2);
    p.finish();
    expect((await p.done).status).toBe(401);
  });
});

describe('race 2: auth.json apagado/corrompido → fail-closed', () => {
  for (const mode of ['apagar', 'corromper', 'parâmetros inválidos', 'symlink'] as const) {
    it(`${mode}: revoga sessões, corta SSE, recusa login`, async () => {
      const { base, auth, dataDir } = await start(noPoll);
      const cookie = cookieOf(await login(base, PW));
      const sse = await fetch(`${base}/api/agents/a/terminal`, { headers: { cookie } });
      const reader = sse.body!.getReader();
      await reader.read();
      const f = join(dataDir, 'auth.json');
      if (mode === 'apagar') rmSync(f);
      else if (mode === 'corromper') writeFileSync(f, '{"password": {"algo":');
      else if (mode === 'parâmetros inválidos') writeFileSync(f, JSON.stringify({ password: { algo: 'scrypt', N: 2, r: 1, p: 1, salt: 'AA==', hash: 'AA==' }, generation: 'f'.repeat(32) }));
      else {
        const real = join(dataDir, 'real.json');
        writePasswordFile(mkdtempSync(join(tmpdir(), 'qode-x-')), PW);
        writeFileSync(real, '{}');
        rmSync(f);
        symlinkSync(real, f);
      }
      expect(auth.checkPasswordRotation()).toBe(true);
      expect(await streamClosed(reader)).toBe(true);
      expect(auth.sessionCount()).toBe(0);
      expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
      expect((await login(base, PW)).status).toBe(401);
    });
  }

  it('timer automático (sem chamada manual): apagar auth.json corta SSE', async () => {
    const { base, dataDir } = await start(fast);
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/stream`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    await reader.read();
    rmSync(join(dataDir, 'auth.json'));
    expect(await streamClosed(reader)).toBe(true);
  });

  it('timer automático: rotação corta SSE sem novo pedido', async () => {
    const { base, dataDir } = await start(fast);
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/agents/x/terminal`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    await reader.read();
    writePasswordFile(dataDir, PW2);
    expect(await streamClosed(reader)).toBe(true);
  });

  it('timer automático: expiração idle corta SSE sem sweep manual', async () => {
    let t = 1_000_000;
    const { base } = await start({ ...fast, now: () => t });
    const cookie = cookieOf(await login(base, PW));
    const sse = await fetch(`${base}/api/stream`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    await reader.read();
    t += 9 * 3600_000;
    expect(await streamClosed(reader)).toBe(true);
  });

  it('escrita atómica: sem .tmp residual e o ficheiro é sempre válido', async () => {
    const d = mkdtempSync(join(tmpdir(), 'qode-atomic-'));
    for (let i = 0; i < 5; i++) writePasswordFile(d, PW);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(d)).toEqual(['auth.json']);
  });
});

describe('race 3: rate-limit com bodies suspensos', () => {
  it('7 logins suspensos liberados juntos: no máx. 5 avaliados, resto 429; depois a certa → 429', async () => {
    const { base, port } = await start(noPoll);
    const ps = Array.from({ length: 7 }, () => pausedLogin(port, 'errada-errada-x'));
    await tick(100);
    for (const p of ps) p.finish();
    const st = (await Promise.all(ps.map((p) => p.done))).map((r) => r.status).sort();
    expect(st.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(st.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    expect((await login(base, PW)).status).toBe(429);
  });
});

describe('matriz: cookie de browser NÃO abre ingest', () => {
  it('cookie → register/wait/events/inbox/bridge/summary 401; Bearer → passa', async () => {
    const { base } = await start(noPoll);
    const cookie = cookieOf(await login(base, PW));
    const routes: [string, string][] = [
      ['POST', '/api/permissions'],
      ['GET', '/api/permissions/x/wait'],
      ['POST', '/api/codex/events'],
      ['POST', '/api/mod/inbox'],
      ['POST', '/api/mod/inbox/ack'],
      ['POST', '/api/codex/bridge/poll'],
      ['POST', '/api/codex/bridge/ack'],
      ['GET', '/api/mod/summary'],
    ];
    for (const [method, p] of routes) {
      const init = (h: Record<string, string>) => ({ method, headers: { ...h, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
      expect((await fetch(base + p, init({ cookie }))).status, `cookie ${method} ${p}`).toBe(401);
      expect((await fetch(base + p, init({ authorization: `Bearer ${HOOK}` }))).status, `bearer ${method} ${p}`).toBe(200);
    }
    // cookie continua a abrir UI
    expect((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status).toBe(200);
  });
});

describe('preflight estrito (auth.json + token)', () => {
  const mk = (token = true) => {
    const d = mkdtempSync(join(tmpdir(), 'qode-pf-'));
    writePasswordFile(d, PW);
    if (token) writeFileSync(join(d, 'hooks.token'), HOOK + '\n', { mode: 0o600 });
    return d;
  };
  const pf = (dataDir: string, env: NodeJS.ProcessEnv = { HABBLAUD_AUTH: '1' }) =>
    securityPreflight({ env, dataDir, host: '127.0.0.1', inDocker: false, dev: false, allowedHosts: new Set() });

  it('válido → []', () => expect(pf(mk())).toEqual([]));
  it('token ausente → fail-closed', () => expect(pf(mk(false)).join()).toMatch(/token de hooks/));
  it('token curto no env → fail-closed', () => expect(pf(mk(false), { HABBLAUD_AUTH: '1', HABBLAUD_HOOKS_TOKEN: 'curto' }).join()).toMatch(/token de hooks/));
  it('auth.json corrompido → inválido', () => {
    const d = mk();
    writeFileSync(join(d, 'auth.json'), 'nope');
    expect(pf(d).join()).toMatch(/auth.json inválido/);
  });
  it('auth.json sem generation → inválido', () => {
    const d = mk();
    writeFileSync(join(d, 'auth.json'), JSON.stringify({ password: { algo: 'scrypt', N: 16384, r: 8, p: 1, salt: 'A'.repeat(24), hash: 'A'.repeat(88) } }));
    expect(pf(d).join()).toMatch(/auth.json inválido/);
  });
  it('auth.json diretório/symlink → inválido', () => {
    const d = mk();
    rmSync(join(d, 'auth.json'));
    mkdirSync(join(d, 'auth.json'));
    expect(pf(d).join()).toMatch(/auth.json inválido/);
    const e = mk();
    const other = mk();
    rmSync(join(e, 'auth.json'));
    symlinkSync(join(other, 'auth.json'), join(e, 'auth.json'));
    expect(pf(e).join()).toMatch(/auth.json inválido/);
  });
});

describe('app real (guard + API): terminal, permissões, mensagens, hook', () => {
  async function startFull() {
    const tmp = mkdtempSync(join(tmpdir(), 'qode-full3-'));
    const claude = join(tmp, '.claude');
    mkdirSync(join(claude, 'sessions'), { recursive: true });
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePasswordFile(dataDir, PW);
    const late: { office?: Office } = {};
    const accounts = new AccountsService({ dirs: [claude], home: tmp, env: {}, onChange: () => late.office?.markDirty() });
    const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
    late.office = office;
    office.setDemo(true);
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const terminals = new TerminalStreams({ office, transcriptPathOf: () => undefined, pollMs: 20, demoPollMs: 20 });
    // Registry sintético atrás das rotas REAIS de /api/permissions (server/permissions/http.ts).
    const decided = new Map<string, (v: unknown) => void>();
    const registered: unknown[] = [];
    const registry = {
      register: (body: unknown) => {
        registered.push(body);
        return { id: 'p1', expiresAt: Date.now() + 60_000 };
      },
      wait: (id: string) => ({ result: new Promise((r) => decided.set(id, r)), cancel: () => {} }),
      decide: (id: string, d: { behavior: string }) => {
        const r = decided.get(id);
        if (!r) return 'not-found' as const;
        r({ status: 'decided', ...d });
        return 'ok' as const;
      },
      detail: (id: string) => (id === 'p1' ? { id } : undefined),
    };
    const msgs: string[] = [];
    const api = createApiHandler({
      office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false,
      terminal: true, terminals,
      permissions: createPermissionRoutes(registry as never),
      messages: (req, res, path) => {
        msgs.push(`${req.method} ${path}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      },
    });
    const guard = createRequestGuard({ allowedHosts: new Set() });
    const auth = createAuth({ enabled: true, dataDir, hooksToken: HOOK, ...noPoll });
    auths.push(auth);
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      if (auth.handle(req, res, url.pathname)) return;
      if (!api(req, res, url)) { res.writeHead(404); res.end(); }
    });
    servers.push(server);
    cleanups.push(() => { hub.stop(); terminals.stop?.(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const cookie = cookieOf(await login(base, PW));
    return { base, port, auth, cookie, office, registered, msgs };
  }
  const J = { 'Content-Type': 'application/json' };
  const B = { authorization: `Bearer ${HOOK}` };

  it('terminal real (demo): cookie abre SSE; Bearer 401; revogação corta', async () => {
    const env = await startFull();
    const id = env.office.commit().snapshot.agents.find((a) => a.id.startsWith('demo:'))!.id;
    const path = `/api/agents/${encodeURIComponent(id)}/terminal`;
    expect((await fetch(env.base + path, { headers: B })).status).toBe(401);
    const sse = await fetch(env.base + path, { headers: { cookie: env.cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    await reader.read();
    env.auth.revokeAll();
    expect(await streamClosed(reader)).toBe(true);
  });

  it('permissões reais: Bearer registra; cookie NÃO registra; decision só cookie', async () => {
    const env = await startFull();
    expect((await fetch(`${env.base}/api/permissions`, { method: 'POST', headers: { ...J, cookie: env.cookie }, body: '{}' })).status).toBe(401);
    expect(env.registered).toHaveLength(0);
    expect((await fetch(`${env.base}/api/permissions`, { method: 'POST', headers: { ...J, ...B }, body: '{"session_id":"s","tool_name":"Read"}' })).status).toBe(201);
    expect((await fetch(`${env.base}/api/permissions/p1/decision`, { method: 'POST', headers: { ...J, ...B }, body: '{"behavior":"allow"}' })).status).toBe(401);
    expect((await fetch(`${env.base}/api/permissions/p1`, { headers: B })).status).toBe(401);
    expect((await fetch(`${env.base}/api/permissions/p1`, { headers: { cookie: env.cookie } })).status).toBe(200);
  });

  it('mensagens reais: /api/messages só cookie; /api/mod/inbox só Bearer', async () => {
    const env = await startFull();
    expect((await fetch(`${env.base}/api/messages`, { method: 'POST', headers: { ...J, ...B }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${env.base}/api/messages`, { method: 'POST', headers: { ...J, cookie: env.cookie }, body: '{}' })).status).toBe(200);
    expect((await fetch(`${env.base}/api/mod/inbox`, { method: 'POST', headers: { ...J, cookie: env.cookie }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${env.base}/api/mod/inbox`, { method: 'POST', headers: { ...J, ...B }, body: '{}' })).status).toBe(200);
    expect(env.msgs).toEqual(['POST /api/messages', 'POST /api/mod/inbox']);
  });

  it('/api/mod/summary: Bearer 200, cookie 401', async () => {
    const env = await startFull();
    expect((await fetch(`${env.base}/api/mod/summary`, { headers: B })).status).toBe(200);
    expect((await fetch(`${env.base}/api/mod/summary`, { headers: { cookie: env.cookie } })).status).toBe(401);
  });

  it('fluxo real do hook de permissões: sem token → não desvia; com token → registra, espera, recebe decisão do operador', async () => {
    const env = await startFull();
    const input = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const base = { HABBLAUD_PORT: String(env.port), HOME: mkdtempSync(join(tmpdir(), 'qode-home-')) };
    expect(await runPermissionHook(['--timeout', '2'], base, input)).toBeUndefined();
    expect(env.registered).toHaveLength(0);
    const out = runPermissionHook(['--timeout', '5'], { ...base, HABBLAUD_HOOKS_TOKEN: HOOK }, input);
    for (let i = 0; i < 40 && env.registered.length === 0; i++) await tick(25);
    expect(env.registered).toHaveLength(1);
    await tick(50);
    expect((await fetch(`${env.base}/api/permissions/p1/decision`, { method: 'POST', headers: { ...J, cookie: env.cookie }, body: '{"behavior":"allow"}' })).status).toBe(200);
    expect(await out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });
});
