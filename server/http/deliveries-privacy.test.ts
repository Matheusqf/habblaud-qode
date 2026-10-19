// Composição: createApiHandler + política QODE real. Um projeto privado com canários no texto, nos metadados
// e nos anexos não pode sair por GET /api/deliveries nem pelos ficheiros.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecentSession } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { DeliveryIndex } from '../deliveries/deliveries';
import { FileFetcher } from '../deliveries/fetcher';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { createTerminalParser } from '../sources/terminal';
import { tempDir } from '../test/fixtures';
import { setupQode } from '../qode/index';
import { createApiHandler } from './app';
import { Hub } from './sse';

setQuiet(true);

const EXAMPLE = resolve(import.meta.dirname, '../../qode/qode.config.example.json');
const SENT = 'CANARIO-DELIVERY-PRIVADO-9f2c';
const now = Date.now();

const ts = (s: number) => new Date(Date.UTC(2026, 9, 12, 12, 0, s)).toISOString();
const user = (id: string, s: number, text: string) => ({ type: 'user', uuid: id, timestamp: ts(s), message: { role: 'user', content: text } });
const tool = (id: string, s: number, name: string, input: object) => ({
  type: 'assistant',
  uuid: id,
  timestamp: ts(s),
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${id}`, name, input }] },
});
const say = (id: string, s: number, text: string) => ({
  type: 'assistant',
  uuid: id,
  timestamp: ts(s),
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

afterEach(() => {
  setQuiet(true);
});

describe('entregas + privacidade QODE (API real)', () => {
  it('projeto privado com canários no texto, metadados e anexos não sai pela API', async () => {
    const tmp = tempDir('qode-deliv-');
    const home = join(tmp.dir, 'home');
    const dataDir = join(tmp.dir, 'data');
    const vida = join(home, 'Documents', 'Vida', 'notas');
    const clinicas = join(home, 'Documents', 'GitHub', 'clinicas');
    mkdirSync(vida, { recursive: true });
    mkdirSync(clinicas, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(EXAMPLE, join(dataDir, 'qode.config.json'));

    const privateFile = join(vida, `relatorio-${SENT}.md`);
    const publicFile = join(clinicas, 'agenda.md');
    writeFileSync(privateFile, `# ${SENT}\nconteúdo privado\n`);
    writeFileSync(publicFile, '# Agenda pública\n');

    const privateJsonl = join(tmp.dir, 'priv.jsonl');
    const publicJsonl = join(tmp.dir, 'pub.jsonl');
    const privateReply = `**Pedido concluído no Vida OS** (${SENT}).\n\nO relatório ficou em ${privateFile} e também em [notas](${privateFile}). Em poucas palavras: a entrega privada ${SENT} está pronta para a BA.`;
    writeFileSync(
      privateJsonl,
      [
        user('u1', 0, `Leia ${vida} e escreva o relatório ${SENT}`),
        tool('a1', 1, 'Edit', { file_path: privateFile, old_string: 'a', new_string: 'b' }),
        tool('a2', 2, 'SendUserFile', { files: [privateFile], caption: `Anexo ${SENT}` }),
        say('a3', 3, privateReply),
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    writeFileSync(
      publicJsonl,
      [
        user('u1', 0, 'Atualize a agenda da clínica'),
        tool('a1', 1, 'Edit', { file_path: publicFile, old_string: 'a', new_string: 'b' }),
        tool('a2', 2, 'SendUserFile', { files: [publicFile], caption: 'Agenda' }),
        say(
          'a3',
          3,
          '**A agenda está pronta** e foi enviada. Veja o ficheiro da pasta.\n\nEm poucas palavras: a agenda pública da clínica agora mostra o último dia certo, e o texto está na pasta do projeto para a BA conferir.',
        ),
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );

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
    office.addMain({ id: '.claude:1', account: '.claude', sessionId: 'sess-priv', cwd: vida, role: 'Agente principal', startedAt: now, status: 'idle' });
    office.addMain({ id: '.claude:2', account: '.claude', sessionId: 'sess-pub', cwd: clinicas, role: 'Agente principal', startedAt: now, status: 'idle' });

    const sessions: RecentSession[] = [
      {
        account: '.claude',
        sessionId: 'sess-priv',
        project: vida,
        projectDir: '-Documents-Vida-notas',
        title: `Diário ${SENT}`,
        lastAt: now,
        size: 1000,
        open: true,
        agentId: '.claude:1',
      },
      {
        account: '.claude',
        sessionId: 'sess-pub',
        project: clinicas,
        projectDir: '-Documents-GitHub-clinicas',
        title: 'Agenda',
        lastAt: now,
        size: 800,
        open: true,
        agentId: '.claude:2',
      },
    ];
    const files = new Map<string, string>([
      ['.claude:sess-priv', privateJsonl],
      ['.claude:sess-pub', publicJsonl],
    ]);
    const rawHistory = {
      list: async () => sessions,
      resolve: (account: string, sessionId: string) => {
        const path = files.get(`${account}:${sessionId}`);
        if (!path) return { status: 404 as const, error: 'ausente' };
        return { path, createParser: createTerminalParser };
      },
    };
    // Mesma ligação que server/index.ts: qode.history + qode.deliveries (política antes da leitura).
    const historyView = qode.history(rawHistory);
    const deliveries = new DeliveryIndex(
      qode.deliveries({
        sessions: () => historyView.list(),
        resolve: (account, sessionId) => {
          const r = historyView.resolve(account, sessionId);
          return 'path' in r ? r : undefined;
        },
        isBusy: (id) => {
          const st = office.list().find((a) => a.id === id)?.status;
          return st === 'working' || st === 'waiting' || st === 'shell';
        },
        agentName: (id) => office.list().find((a) => a.id === id)?.name,
      }),
    );
    const fetcher = new FileFetcher({ direct: true });

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
      deliveries,
      files: fetcher,
    });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const listRes = await fetch(`${base}/api/deliveries`);
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { deliveries: Array<Record<string, unknown>> };
      const dump = JSON.stringify(body);
      expect(dump, 'canário no texto/metadados').not.toContain(SENT);
      expect(dump.toLowerCase(), 'caminho Vida').not.toContain('documents/vida');
      expect(dump, 'pedido privado').not.toContain('Vida OS');
      expect(body.deliveries.some((d) => d.sessionId === 'sess-priv' || d.agentId === '.claude:1')).toBe(false);
      expect(body.deliveries.some((d) => d.sessionId === 'sess-pub')).toBe(true);

      const leaked = body.deliveries.flatMap((d) => (d.attachments as Array<{ id: string }> | undefined) ?? []);
      for (const a of leaked) {
        const file = await fetch(`${base}/api/deliveries/file/${a.id}`);
        const text = await file.text();
        expect(text, `anexo ${a.id}`).not.toContain(SENT);
        expect(text.toLowerCase(), `anexo ${a.id}`).not.toContain('documents/vida');
      }
      const guess = await fetch(`${base}/api/deliveries/file/${'f'.repeat(20)}`);
      expect([404, 400]).toContain(guess.status);
    } finally {
      hub.stop();
      await new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      });
      tmp.cleanup();
    }
  });
});
