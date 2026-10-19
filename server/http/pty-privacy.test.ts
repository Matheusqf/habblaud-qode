// Composição: app + PtyManager + política QODE. Criar, assumir, listar e fazer stream de sessões privadas
// é recusado; um stream já aberto corta se a família passar a privada.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { PtyManager, type PtyProcess } from '../pty/manager';
import { setupQode } from '../qode/index';
import { tempDir } from '../test/fixtures';
import { createApiHandler } from './app';
import { createPtyRoutes } from './pty';
import { Hub } from './sse';

setQuiet(true);

const EXAMPLE = resolve(import.meta.dirname, '../../qode/qode.config.example.json');
const SENT = 'CANARIO-PTY-PRIVADO-4b1e';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

class FakeProc implements PtyProcess {
  data: (d: string) => void = () => {};
  exit: (e: { exitCode: number }) => void = () => {};
  constructor(readonly pid: number) {}
  onData(cb: (d: string) => void) {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write() {}
  resize() {}
  kill() {
    this.exit({ exitCode: 0 });
  }
}

afterEach(() => setQuiet(true));

describe('PTY + privacidade QODE (app real)', () => {
  it('bloqueia create/takeover/list/stream privados e corta stream já aberto após taint', async () => {
    const tmp = tempDir('qode-pty-');
    const home = join(tmp.dir, 'home');
    const dataDir = join(tmp.dir, 'data');
    const vida = join(home, 'Documents', 'Vida', 'notas');
    const clinicas = join(home, 'Documents', 'GitHub', 'clinicas');
    mkdirSync(vida, { recursive: true });
    mkdirSync(clinicas, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(EXAMPLE, join(dataDir, 'qode.config.json'));

    const aliases = new RoomAliases(null);
    let office!: Office;
    const qode = setupQode({ env: {}, dataDir, home, roomAliases: aliases, office: () => office });
    office = new Office({
      names: new NameStore(null),
      roomAlias: (p) => aliases.get(p),
      version: 't',
      startedAt: 0,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      terminal: true,
      roomOf: qode.roomOf,
      privacy: qode.privacy,
    });
    office.addMain({
      id: '.claude:4242',
      account: '.claude',
      sessionId: SESSION,
      cwd: vida,
      role: 'Agente principal',
      startedAt: Date.now(),
      status: 'working',
    });
    office.addMain({
      id: '.claude:9001',
      account: '.claude',
      sessionId: 's-pub',
      cwd: clinicas,
      role: 'Agente principal',
      startedAt: Date.now(),
      status: 'working',
    });

    let nextPid = 9000;
    const view = qode.officeView(office);
    const ptys = new PtyManager({
      spawn: () => new FakeProc(++nextPid),
      claudeBin: process.execPath,
      accounts: () => [{ id: '.claude', dir: join(tmp.dir, 'conta'), isDefault: true }],
      agent: (id) => {
        const a = view.get(id);
        return a && { id: a.id, kind: a.kind, account: a.account, sessionId: a.sessionId, cwd: office.roomPath(a.roomId) };
      },
      blockedCwd: (cwd) => qode.blockedCwd(cwd),
      hidden: (info) => qode.hiddenPty(info),
      onChange: () => office.markDirty(),
      readSession: () => ({ sessionId: SESSION, startedAt: Date.now() }),
      procInfo: async () => undefined,
      isAlive: () => false,
      sleep: async () => {},
    });
    office.onChange(() => ptys.enforcePrivacy());

    const claudeDir = join(tmp.dir, '.claude');
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [claudeDir], home, env: {}, onChange: () => undefined });
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const api = createApiHandler({
      office,
      hub,
      accounts,
      sources: () => [],
      version: 't',
      inDocker: false,
      terminal: true,
      pty: createPtyRoutes(ptys),
    });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const json = { 'Content-Type': 'application/json' };

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

    try {
      const createdPriv = await post('/api/pty', { cwd: vida });
      expect(createdPriv.status, 'create cwd privado').toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await createdPriv.json())).not.toContain(SENT);

      const takeover = await post('/api/agents/.claude%3A4242/takeover', { cols: 80, rows: 24 });
      expect(takeover.status, 'takeover privado').toBeGreaterThanOrEqual(400);

      const createdPub = await post('/api/pty', { cwd: clinicas });
      expect(createdPub.status).toBe(201);
      const pub = (await createdPub.json()) as { id: string; cwd: string };
      expect(pub.cwd).toBe(clinicas);

      const listed = (await (await fetch(`${base}/api/pty`)).json()) as { ptys: Array<{ id: string; cwd: string; agentId: string }> };
      expect(listed.ptys.every((p) => !p.cwd.includes('Vida') && p.agentId !== '.claude:4242')).toBe(true);
      expect(listed.ptys.some((p) => p.id === pub.id)).toBe(true);

      const streamPub = await fetch(`${base}/api/pty/${pub.id}/stream`);
      expect(streamPub.status).toBe(200);
      const reader = streamPub.body!.getReader();
      await reader.read();

      qode.privacy!.taint('.claude:9001');
      office.addActivity('.claude:9001', { id: 'x', kind: 'read', icon: '📖', text: `leu ${vida}/${SENT}.md`, at: Date.now() }, true);
      office.markDirty();

      let done = false;
      for (let i = 0; i < 20 && !done; i++) done = (await reader.read()).done;
      expect(done, 'stream público corta após taint da família').toBe(true);

      const listedAfter = (await (await fetch(`${base}/api/pty`)).json()) as { ptys: Array<{ id: string }> };
      expect(listedAfter.ptys.some((p) => p.id === pub.id)).toBe(false);

      const streamAgain = await fetch(`${base}/api/pty/${pub.id}/stream`);
      expect(streamAgain.status).toBeGreaterThanOrEqual(400);
    } finally {
      ptys.stopAll();
      hub.stop();
      await new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      });
      tmp.cleanup();
    }
  });
});
