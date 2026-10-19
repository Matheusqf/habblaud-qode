// C9 com integração REAL (review ZikaBOT #13/#14): Office + privacidade QODE (setupQode) + Hub + PermissionRegistry +
// createAuth (auth.json sintético num diretório temporário) + createApiHandler do operador, e a entrada só-leitura
// (router + vista própria + DTO remoto) atrás de um proxy que reescreve o Host para loopback (como o Tailscale Serve).
// Nada de handler falso: o que se prova aqui é a integração.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { setLogFilter } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { createPermissionRoutes } from '../permissions/http';
import { PermissionRegistry } from '../permissions/registry';
import { setupQode } from '../qode';
import { createApiHandler } from './app';
import { createAuth, loadAuthFile, writePasswordFile } from './auth';
import { createRemoteDto } from './remote-dto';
import { createReadOnlyRouter, roAuthFileSource, RO_COOKIE } from './remote-ro';
import { createRemoteView } from './remote-view';
import { Hub } from './sse';

const PASSWORD = 'senha-sintetica-integracao-123';
const CANARY = 'CANARIO-INTEG-7d1';
const ORIGIN = 'office.example.ts.net';
const SESSION = 'sess-local-1';
const MAIN = `.claude:${SESSION}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setLogFilter(undefined);
});

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
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

async function setup(o: { onAuthRead?: (dataDir: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qode-ro-int-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const dataDir = join(dir, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const loja = join(home, 'loja');
  const segredo = join(home, `segredo-${CANARY}`);
  writeFileSync(join(dataDir, 'qode.config.json'), JSON.stringify({ projetos: [{ nome: 'Loja', caminhos: [loja], privado: false }, { nome: 'Cofre', caminhos: [segredo], privado: true }] }));
  writePasswordFile(dataDir, PASSWORD); // auth.json SINTÉTICO no diretório temporário

  const aliases = new RoomAliases(null);
  let office!: Office;
  let permissions: PermissionRegistry | undefined;
  const qode = setupQode({ env: {}, dataDir, home, roomAliases: aliases, office: () => office });
  expect(qode.privacy).toBeDefined();
  office = new Office({
    names: new NameStore(null),
    roomAlias: (p) => aliases.get(p),
    version: 't',
    startedAt: Date.now(),
    // Canários também nos campos livres da conta (short/name: override do operador pode trazer e-mail/caminho).
    accounts: () => [{ id: '.claude', short: `/Users/${CANARY}`, name: `dono-${CANARY}@example.com`, email: `dono-${CANARY}@example.com`, organization: CANARY, color: '#f08a3c', configDir: join(home, `.claude-${CANARY}`), sessions: 1, usageStatus: 'ok' }],
    sources: () => [{ label: 'claude', path: join(home, `.claude-${CANARY}`, 'projects'), sessions: 1, ok: true }],
    accountName: () => `dono-${CANARY}@example.com`,
    terminal: true,
    messages: () => new Set([MAIN]),
    permissions: () => permissions?.snapshot() ?? new Map(),
    roomOf: qode.roomOf,
    privacy: qode.privacy,
  });
  const hub = new Hub(office, { throttleMs: 5 });
  hub.start();
  cleanups.push(() => hub.stop());
  // Igual ao index.ts: o registo só desvia pedidos do terminal com página LOCAL aberta (Hub.localSize).
  permissions = new PermissionRegistry({ office: qode.officeView(office), viewers: () => hub.localSize, transcriptPathOf: () => undefined });
  const auth = createAuth({ enabled: true, dataDir });
  cleanups.push(() => auth.dispose());
  const api = createApiHandler({ office, hub, accounts: { list: () => [] } as never, sources: () => [], version: '9.9.9', inDocker: false, permissions: createPermissionRoutes(permissions) });
  const operator = http.createServer((rq, rs) => {
    const url = new URL(rq.url ?? '/', 'http://x');
    if (auth.handle(rq, rs, url.pathname)) return;
    if (!api(rq, rs, url)) {
      rs.writeHead(404);
      rs.end();
    }
  });
  const operatorPort = await listen(operator);
  cleanups.push(() => new Promise<void>((r) => (operator.closeAllConnections(), operator.close(() => r()))));

  const view = createRemoteView({ hub, dto: createRemoteDto() });
  cleanups.push(() => view.stop());
  const shellHits: string[] = [];
  const ro = createReadOnlyRouter({
    authFile: () => {
      const snap = roAuthFileSource(dataDir)();
      o.onAuthRead?.(dataDir);
      return snap;
    },
    view,
    shell: (rq, rs, url) => {
      shellHits.push(url.pathname);
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      rs.end('<!doctype html><div id="app"></div>');
    },
    expectedOrigin: ORIGIN,
  });
  cleanups.push(() => ro.revokeAll());
  const roServer = http.createServer((rq, rs) => ro.handle(rq, rs));
  const roPort = await listen(roServer);
  cleanups.push(() => new Promise<void>((r) => (roServer.closeAllConnections(), roServer.close(() => r()))));
  // Proxy à la Tailscale Serve: Host reescrito para LOOPBACK (é isto que faria o Hub contar o viewer como local).
  const proxy = http.createServer((rq, rs) => {
    const up = http.request({ host: '127.0.0.1', port: roPort, method: rq.method, path: rq.url, headers: { ...rq.headers, host: `127.0.0.1:${roPort}`, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https' } }, (r) => {
      rs.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(rs);
    });
    up.on('socket', (sock) => sock.on('close', () => rs.destroy()));
    up.on('error', () => rs.destroy());
    rq.pipe(up);
  });
  const proxyPort = await listen(proxy);
  cleanups.push(() => new Promise<void>((r) => (proxy.closeAllConnections(), proxy.close(() => r()))));

  // Agente LOCAL público (projeto Loja) com texto livre canário, e um agente local num projeto privado.
  office.addMain({ id: MAIN, account: '.claude', sessionId: SESSION, cwd: loja, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  // Nome do personagem escolhido pelo operador = texto livre (canário e-mail + caminho).
  expect(office.setCharacter(MAIN, { name: `${CANARY}@example.com`, seed: 7, parts: {} })).toEqual({ result: 'ok' });
  office.addActivity(MAIN, { id: `${MAIN}#a1`, kind: 'read', icon: '📖', text: `Lendo ${loja}/${CANARY}.ts`, detail: CANARY, tool: CANARY, at: Date.now() }, true);
  office.addMain({ id: '.claude:sess-priv', account: '.claude', sessionId: 'sess-priv', cwd: segredo, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  hub.flush();

  const roLogin = async () => {
    const r = await req(proxyPort, 'POST', '/api/auth/login', { origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
    expect(r.status).toBe(204);
    return String(r.headers['set-cookie']).split(';')[0];
  };
  return { dataDir, office, hub, permissions, auth, ro, view, operatorPort, proxyPort, shellHits, roLogin, loja };
}

function openStream(port: number, cookie: string) {
  const events: Array<{ event: string; data: string }> = [];
  let buf = '';
  let res!: http.IncomingMessage;
  const ready = new Promise<void>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie } }, (r) => {
      res = r;
      r.setEncoding('utf8');
      r.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data });
        }
        resolve();
      });
    });
  });
  return { events, ready, close: () => void res?.destroy() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('C9 integração real: RO + Hub + PermissionRegistry + auth', () => {
  it('viewer RO pelo proxy (Host loopback) não é cliente do Hub e NÃO desvia pedidos de permissão do terminal', async () => {
    const e = await setup();
    const c = await e.roLogin();
    const s = openStream(e.proxyPort, c);
    cleanups.push(s.close);
    await s.ready;
    await wait(50);
    expect(e.view.size()).toBe(1);
    expect(e.hub.size).toBe(0);
    expect(e.hub.localSize).toBe(0);
    // Pedido de permissão real do hook: sem página LOCAL, o registo não desvia (o agente continua no terminal).
    const hook = { session_id: SESSION, cwd: e.loja, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [], timeout_ms: 60_000 };
    expect(e.permissions.register(hook)).toEqual({ skip: 'no-viewers' });
    // Pelas rotas: o RO não decide nem lê permissões.
    expect((await req(e.proxyPort, 'GET', '/api/permissions', { cookie: c })).status).toBe(403);
    expect((await req(e.proxyPort, 'POST', '/api/permissions/x/decision', { cookie: c, origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, '{"behavior":"allow"}')).status).toBe(405);
    expect(e.permissions.snapshot().size).toBe(0);
  });

  it('DTO remoto com allowlist também para agentes LOCAIS: sem texto livre, caminhos, e-mail, configDir, fontes; ids opacos; sem ações', async () => {
    const e = await setup();
    const c = await e.roLogin();
    const r = await req(e.proxyPort, 'GET', '/api/snapshot', { cookie: c });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(CANARY);
    expect(r.body).not.toContain(e.loja);
    expect(r.body).not.toContain(SESSION);
    const snap = JSON.parse(r.body) as OfficeSnapshot;
    expect(snap.agents).toHaveLength(2);
    for (const a of snap.agents) {
      expect(a.id).toMatch(/^a-/);
      expect(a.roomId).toMatch(/^s-/);
      expect(a.recent).toEqual([]);
      expect(a.tasks).toEqual([]);
      for (const k of ['shells', 'model', 'gitBranch', 'permissionMode', 'permission', 'canMessage', 'title', 'observed']) expect(a).not.toHaveProperty(k);
      if (a.activity) {
        expect(a.activity).not.toHaveProperty('detail');
        expect(a.activity).not.toHaveProperty('tool');
      }
    }
    expect(snap.rooms.every((x) => x.id.startsWith('s-') && x.path === x.name)).toBe(true);
    expect(snap.accounts[0]).not.toHaveProperty('email');
    // Pseudónimos (review pós-#13/#14 P1): nome de agente e short/name de conta nunca são o texto de origem.
    expect(snap.agents.map((a) => a.name).sort()).toEqual(['Agente 1', 'Agente 2']);
    expect([snap.accounts[0].short, snap.accounts[0].name]).toEqual(['A', 'Conta A']);
    expect(r.body).not.toContain('/Users/');
    expect(r.body).not.toContain('@example.com');
    expect(snap.accounts[0].configDir).toBe('');
    expect(snap.meta.sources).toEqual([]);
    expect(snap.meta.terminal).toBe(false);
    expect(snap.meta.messages).toBe(false);
    // O operador continua a ver o seu snapshot completo (o DTO é só da entrada remota).
    const opLogin = await req(e.operatorPort, 'POST', '/api/auth/login', { origin: `http://127.0.0.1:${e.operatorPort}`, host: `127.0.0.1:${e.operatorPort}`, 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
    expect(opLogin.status).toBe(200);
    const opCookie = String(opLogin.headers['set-cookie']).split(';')[0];
    const op = await req(e.operatorPort, 'GET', '/api/snapshot', { cookie: opCookie });
    expect(op.status).toBe(200);
    expect(op.body).toContain(e.loja);
  });

  it('SSE remoto recebe mudanças projetadas pelo DTO (texto livre novo não sai)', async () => {
    const e = await setup();
    const c = await e.roLogin();
    const s = openStream(e.proxyPort, c);
    cleanups.push(s.close);
    await s.ready;
    e.office.addActivity(MAIN, { id: `${MAIN}#a2`, kind: 'edit', icon: '✏️', text: `Editando ${CANARY}-novo`, at: Date.now() }, true);
    e.hub.flush();
    await wait(80);
    const snaps = s.events.filter((x) => x.event === 'snapshot');
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(s.events.some((x) => x.event === 'feed')).toBe(true);
    const all = s.events.map((x) => x.data).join('\n');
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain('@example.com');
    expect(all).not.toContain('/Users/');
    const feeds = s.events.filter((x) => x.event === 'feed').flatMap((x) => JSON.parse(x.data) as Array<{ agentName: string }>);
    expect(feeds.length).toBeGreaterThan(0);
    expect(feeds.every((f) => /^Agente \d+$/.test(f.agentName))).toBe(true);
    const last = JSON.parse(snaps[snaps.length - 1].data) as OfficeSnapshot;
    expect(last.agents.some((a) => a.activity?.kind === 'edit')).toBe(true);
  });

  it('cookies não se cruzam: operador ≠ RO; sessão RO ligada à generation do auth.json real (troca de senha = 401 já)', async () => {
    const e = await setup();
    const c = await e.roLogin();
    // cookie RO no operador: 401
    expect((await req(e.operatorPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
    // cookie do operador no RO: 401
    const opLogin = await req(e.operatorPort, 'POST', '/api/auth/login', { origin: `http://127.0.0.1:${e.operatorPort}`, host: `127.0.0.1:${e.operatorPort}`, 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
    const opCookie = String(opLogin.headers['set-cookie']).split(';')[0];
    expect((await req(e.proxyPort, 'GET', '/api/snapshot', { cookie: opCookie })).status).toBe(401);
    expect(c.startsWith(`${RO_COOKIE}=`)).toBe(true);
    const s = openStream(e.proxyPort, c);
    cleanups.push(s.close);
    await s.ready;
    // auth:set-password (nova generation no auth.json sintético)
    writePasswordFile(e.dataDir, `${PASSWORD}-nova`);
    expect((await req(e.proxyPort, 'GET', '/api/snapshot', { cookie: c })).status).toBe(401);
    e.ro.sweep();
    await wait(50);
    expect(e.ro.openStreams()).toBe(0);
    // auth.json inválido: login recusado (fail-closed)
    writeFileSync(join(e.dataDir, 'auth.json'), '{}');
    const r = await req(e.proxyPort, 'POST', '/api/auth/login', { origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, JSON.stringify({ password: `${PASSWORD}-nova` }));
    expect(r.status).toBe(401);
  });

  it('P1 pós-#13/#14: auth:set-password atómico ENTRE as leituras do login não emite sessão (senha antiga + generation nova)', async () => {
    let reads = 0;
    let rotated = false;
    const e = await setup({
      onAuthRead: (dir) => {
        // Só no 1.º login: troca atómica (tmp + rename) do auth.json REAL logo após o snapshot.
        if (!rotated && ++reads === 1) {
          rotated = true;
          writePasswordFile(dir, `${PASSWORD}-rodada`);
        }
      },
    });
    const before = loadAuthFile(e.dataDir)?.generation;
    const r = await req(e.proxyPort, 'POST', '/api/auth/login', { origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }));
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(loadAuthFile(e.dataDir)?.generation).not.toBe(before);
    // A senha antiga já não vale; a nova sim.
    expect((await req(e.proxyPort, 'POST', '/api/auth/login', { origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, JSON.stringify({ password: PASSWORD }))).status).toBe(401);
    expect((await req(e.proxyPort, 'POST', '/api/auth/login', { origin: `https://${ORIGIN}`, 'content-type': 'application/json' }, JSON.stringify({ password: `${PASSWORD}-rodada` }))).status).toBe(204);
  });

  it('shell no navegador: GET / sem sessão serve o HTML; /api/auth/status no formato do gate do cliente', async () => {
    const e = await setup();
    const root = await req(e.proxyPort, 'GET', '/');
    expect(root.status).toBe(200);
    expect(root.headers['content-type']).toMatch(/text\/html/);
    expect(e.shellHits).toEqual(['/']);
    expect(JSON.parse((await req(e.proxyPort, 'GET', '/api/auth/status')).body)).toEqual({ authRequired: true, authenticated: false, readOnly: true });
  });
});
