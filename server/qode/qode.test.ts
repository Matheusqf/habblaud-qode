// Fork QODE: salas por projeto e privacidade. Só textos sentinela sintéticos (nada de conteúdo real do Vida OS),
// numa HOME falsa em pasta temporária.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, AgentInfo, FeedItem, Notice, OfficeSnapshot, PermissionRequestInfo, RecentSession, RoomInfo } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { DayStatsService } from '../history/daystats';
import { TimelineRecorder } from '../history/timeline';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { log, setLogFilter, setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import type { PermissionRegistry } from '../permissions/registry';
import type { SessionLookup } from '../sources/source';
import { tempDir } from '../test/fixtures';
import { isPrivatePath, loadQodeConfig, mentionsPrivate, parseConfig, PRIVATE_ROOM_PREFIX, projectOf } from './config';
import { PRIVATE_SESSION_ERROR, setupQode, TranscriptScanner, type QodeSetup } from './index';
import {
  ACTIVITY_RULES,
  AGENT_RULES,
  FEED_RULES,
  META_RULES,
  NOTICE_RULES,
  Privacy,
  PRIVATE_TEXT,
  privateAgent,
  ROOM_RULES,
  SNAPSHOT_RULES,
} from './privacy';

setQuiet(true);

const SENT = 'SENTINELA-PRIVADA-7f3a9c';
const EXAMPLE = resolve(__dirname, '../../qode/qode.config.example.json');
const now = () => Date.now();

interface Env {
  home: string;
  dataDir: string;
  office: Office;
  qode: QodeSetup;
  aliases: RoomAliases;
  perms: Map<string, PermissionRequestInfo>;
  cleanup: () => void;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  setLogFilter(undefined);
  setQuiet(true);
  vi.restoreAllMocks();
});

function setup(configText?: string): Env {
  const tmp = tempDir('habblaud-qode-');
  const home = join(tmp.dir, 'home');
  const dataDir = join(tmp.dir, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (configText === undefined) copyFileSync(EXAMPLE, join(dataDir, 'qode.config.json'));
  else writeFileSync(join(dataDir, 'qode.config.json'), configText);
  const aliases = new RoomAliases(null);
  const perms = new Map<string, PermissionRequestInfo>();
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
    permissions: () => perms,
    roomOf: qode.roomOf,
    privacy: qode.privacy,
  });
  cleanups.push(tmp.cleanup);
  return { home, dataDir, office, qode, aliases, perms, cleanup: tmp.cleanup };
}

function main(e: Env, id: string, cwd: string, sessionId = `s-${id}`): void {
  e.office.addMain({ id, account: '.claude', sessionId, cwd, role: 'Agente principal', startedAt: now(), status: 'working' });
}

function act(id: string, over: Partial<Activity> = {}): Activity {
  return { id: `${id}#${Math.random()}`, kind: 'read', icon: '📖', text: 'Lendo arquivo', at: now(), ...over };
}

/** Enche o agente de sentinelas em todo campo que carrega conteúdo. */
function fill(e: Env, id: string): void {
  e.office.applyTranscript(id, {
    title: SENT,
    tasks: [{ id: 't1', title: SENT, status: 'in_progress', activeForm: SENT }],
    stats: { toolCalls: 3, tokensIn: 10, tokensOut: 10, subagents: 1, costUSD: 1 },
    model: SENT,
    gitBranch: SENT,
    permissionMode: SENT,
  });
  e.office.addActivity(id, act(id, { text: SENT, detail: SENT, tool: SENT }), true);
  e.office.setShells(id, [{ id: 'j1', label: SENT, command: SENT, startedAt: now(), background: true, kind: 'shell' }]);
  e.perms.set(id, { id: 'p1', tool: 'Bash', title: SENT, text: SENT, icon: '🔐', createdAt: now(), expiresAt: now() + 60_000 });
  e.office.setStatus(id, 'waiting', SENT);
  e.office.noticePermission(id, SENT);
}

const vida = (e: Env, sub = '') => join(e.home, 'Documents', 'Vida', sub);
const clinicas = (e: Env) => join(e.home, 'Documents', 'GitHub', 'clinicas');

describe('qode.config.json', () => {
  it('o exemplo do repositório é válido e cobre worktrees irmãs', () => {
    const home = '/Users/teste';
    const cfg = parseConfig(JSON.parse(readFileSync(EXAMPLE, 'utf8')), home);
    expect(cfg.invalid).toBeUndefined();
    expect(projectOf(cfg, '/Users/teste/Documents/GitHub/singolo-feature-x')?.nome).toBe('Singolo');
    expect(projectOf(cfg, '/Users/teste/Documents/GitHub/singolo/src')?.nome).toBe('Singolo');
    expect(projectOf(cfg, '/users/TESTE/documents/github/corasy-pr10')?.nome).toBe('CoRaSy');
    expect(projectOf(cfg, '/Users/teste/Documents/corasy-pr42')?.nome).toBe('CoRaSy');
    expect(projectOf(cfg, '/Users/teste/Documents/GitHub/singolos')).toBeUndefined();
    expect(projectOf(cfg, '/Users/teste/Documents/GitHub/clinicas-api')).toBeUndefined();
    expect(isPrivatePath(cfg, '/Users/teste/Documents/Vida/notas')).toBe(true);
    expect(isPrivatePath(cfg, '/Users/teste/Documents/Vida-Context')).toBe(true);
    expect(isPrivatePath(cfg, '/Users/teste/Documents/GitHub/clinicas')).toBe(false);
    expect(projectOf(cfg, '/Users/teste/Documents/Vida')?.roomKey.startsWith(PRIVATE_ROOM_PREFIX)).toBe(true);
  });

  it('detecta caminho privado citado em texto (absoluto, ~/, $HOME/ e cwd codificado)', () => {
    const cfg = parseConfig(JSON.parse(readFileSync(EXAMPLE, 'utf8')), '/Users/teste');
    expect(mentionsPrivate(cfg, 'cat /Users/teste/Documents/Vida/a.md')).toBe(true);
    expect(mentionsPrivate(cfg, 'rg x ~/Documents/Vida-Context')).toBe(true);
    expect(mentionsPrivate(cfg, 'ls $HOME/Documents/Vida')).toBe(true);
    expect(mentionsPrivate(cfg, '/x/.claude/projects/-Users-teste-Documents-Vida/abc.jsonl')).toBe(true);
    expect(mentionsPrivate(cfg, 'cat /Users/teste/Documents/GitHub/clinicas/a.md')).toBe(false);
  });

  it.each([
    ['chave com erro de digitação', { projetos: [{ nome: 'X', caminhos: ['~/x'], privada: true }] }],
    ['"*" no meio', { projetos: [{ nome: 'X', caminhos: ['~/a*/b'] }] }],
    ['caminho relativo', { projetos: [{ nome: 'X', caminhos: ['docs/x'] }] }],
    ['a home inteira', { projetos: [{ nome: 'X', caminhos: ['~'] }] }],
    ['privado não booleano', { projetos: [{ nome: 'X', caminhos: ['~/x'], privado: 'sim' }] }],
    ['sem projetos', {}],
  ])('recusa %s', (_why, raw) => {
    expect(() => parseConfig(raw, '/Users/teste')).toThrow();
  });

  it('sem arquivo: undefined (upstream); ilegível: inválido', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    expect(loadQodeConfig({}, tmp.dir, '/h')).toBeUndefined();
    writeFileSync(join(tmp.dir, 'qode.config.json'), '{ isto não é json');
    expect(loadQodeConfig({}, tmp.dir, '/h')?.invalid).toBeTruthy();
    expect(loadQodeConfig({ HABBLAUD_QODE_CONFIG: join(tmp.dir, 'nao-existe.json') }, tmp.dir, '/h')).toBeUndefined();
  });
});

describe('uma sala por projeto', () => {
  it('repositório e worktrees irmãs dividem a sala, com o nome do projeto', () => {
    const e = setup();
    const gh = join(e.home, 'Documents', 'GitHub');
    main(e, 'a', join(gh, 'singolo'));
    main(e, 'b', join(gh, 'singolo-feature-x', 'src'));
    main(e, 'c', join(gh, 'CoRaSy-pr7'));
    main(e, 'd', join(e.home, 'outro'));
    const snap = e.office.commit().snapshot;
    const room = (id: string) => snap.rooms.find((r) => r.id === snap.agents.find((a) => a.id === id)!.roomId)!;
    expect(room('a').id).toBe(room('b').id);
    expect(room('a').name).toBe('Singolo');
    expect(room('c').name).toBe('CoRaSy');
    expect(room('d').name).toBe('outro');
    expect(snap.rooms).toHaveLength(3);
  });

  it('sala privada: id opaco e caminho trocado pelo nome', () => {
    const e = setup();
    main(e, 'v', vida(e, 'notas'));
    main(e, 'vc', join(e.home, 'Documents', 'Vida-Context'));
    const snap = e.office.commit().snapshot;
    expect(snap.rooms).toHaveLength(1);
    expect(snap.rooms[0]).toMatchObject({ name: 'Vida OS', path: 'Vida OS' });
    expect(JSON.stringify(snap).toLowerCase()).not.toContain('documents/vida');
  });
});

describe('privacidade em todas as saídas', () => {
  let server: http.Server | undefined;
  beforeEach(() => {
    server = undefined;
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((ok) => server!.close(() => ok()));
    }
  });

  it('nenhuma sentinela sai por snapshot, SSE, HTTP, statusline do mod, linha do tempo, estatísticas e logs', async () => {
    const e = setup();
    main(e, '.claude:1', vida(e, 'notas'), 'sv');
    main(e, '.claude:2', clinicas(e), 'sc');
    e.office.addSub({ id: 'sv:sub1', parentId: '.claude:1', sessionId: 'sv', role: 'Explore', title: SENT, background: false, startedAt: now() });
    fill(e, '.claude:1');
    fill(e, 'sv:sub1');
    e.office.applyTranscript('.claude:2', { title: 'Agenda pública', tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } });

    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const claudeDir = join(tmp.dir, '.claude');
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [claudeDir], home: tmp.dir, env: {}, onChange: () => undefined });
    const hub = new Hub(e.office, { throttleMs: 10 });
    hub.start();
    cleanups.push(() => hub.stop());
    const api = createApiHandler({ office: e.office, hub, accounts, sources: () => [], version: 't', inDocker: false });
    server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.end();
    });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const out: Record<string, string> = {};
    const commit = e.office.commit();
    out.commit = JSON.stringify(commit);
    out.recentFeed = JSON.stringify(e.office.recentFeed(50));
    out.detail = JSON.stringify([e.office.detail('.claude:1'), e.office.detail('sv:sub1')]);
    out.snapshot = await (await fetch(`${base}/api/snapshot`)).text();
    out.agent = await (await fetch(`${base}/api/agents/${encodeURIComponent('.claude:1')}`)).text();
    out.sub = await (await fetch(`${base}/api/agents/${encodeURIComponent('sv:sub1')}`)).text();
    out.summary = await (await fetch(`${base}/api/mod/summary`)).text();
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = stream.body!.getReader();
    let sse = '';
    while (!sse.includes('event: feed')) sse += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    out.sse = sse;

    const timelineDir = join(tmp.dir, 'timeline');
    const timeline = new TimelineRecorder({ dir: timelineDir });
    timeline.ingest(hub.current());
    timeline.stop();
    out.timeline = readdirSync(timelineDir)
      .map((f) => readFileSync(join(timelineDir, f), 'utf8'))
      .join('\n');
    const statsDir = join(tmp.dir, 'stats');
    const stats = new DayStatsService({ dir: statsDir, snapshot: () => hub.current() });
    stats.sample();
    stats.flush();
    out.stats = readdirSync(statsDir)
      .map((f) => readFileSync(join(statsDir, f), 'utf8'))
      .join('\n');

    setQuiet(false);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: string) => void lines.push(m));
    log.warn(`Falha ao ler ${vida(e, 'diario.md')} e ~/Documents/Vida-Context/x`);
    out.log = lines.join('\n');

    for (const [where, text] of Object.entries(out)) {
      expect(text, where).not.toContain(SENT);
      expect(text.toLowerCase(), where).not.toContain('documents/vida');
    }
    expect(out.log).toContain('[privado]');
    expect(out.timeline.length).toBeGreaterThan(0);

    const snap = JSON.parse(out.snapshot) as OfficeSnapshot;
    const v = snap.agents.find((a) => a.id === '.claude:1')!;
    expect(v.status).toBe('waiting');
    expect(v.waitingFor).toBe('responder no terminal');
    expect(v.permission).toBeUndefined();
    expect(snap.agents.find((a) => a.id === '.claude:2')!.title).toBe('Agenda pública');
    expect((JSON.parse(out.summary) as { waiting: Array<{ answerable: boolean }> }).waiting.every((w) => !w.answerable)).toBe(true);
    expect(commit.notices.filter((n) => n.agentId === '.claude:1').every((n) => n.text === PRIVATE_TEXT)).toBe(true);
  });

  it('agente fora do Vida OS que lê um arquivo dele por caminho absoluto vira privado, com a família', () => {
    const e = setup();
    main(e, 'c', clinicas(e), 'sc');
    e.office.addSub({ id: 'sc:sub', parentId: 'c', sessionId: 'sc', role: 'Explore', title: 'Revisar', background: false, startedAt: now() });
    e.office.applyTranscript('c', { title: 'Agenda', tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } });
    expect(e.office.commit().snapshot.agents.find((a) => a.id === 'c')!.title).toBe('Agenda');

    e.office.addActivity('sc:sub', act('sc:sub', { text: 'Lendo diario.md', detail: vida(e, 'diario.md') }), true);
    e.office.addActivity('c', act('c', { text: SENT }), true);
    const { snapshot, feed } = e.office.commit();
    for (const id of ['c', 'sc:sub']) {
      const a = snapshot.agents.find((x) => x.id === id)!;
      expect(a.title).toBeUndefined();
      expect(a.activity?.detail).toBeUndefined();
    }
    expect(JSON.stringify(snapshot)).not.toContain(SENT);
    expect(JSON.stringify(feed).toLowerCase()).not.toContain('documents/vida');
    expect(JSON.stringify(feed)).not.toContain(SENT);
    expect(JSON.stringify(e.office.detail('c'))).not.toContain(SENT);
  });

  it.each([
    ['~/', (e: Env) => `cat ~/Documents/Vida/a.md`],
    ['$HOME/', (e: Env) => `ls $HOME/Documents/Vida-Context`],
    ['cwd codificado', (e: Env) => `${e.home}/.claude/projects/${vida(e).replace(/\/$/, '').replace(/[^a-zA-Z0-9]/g, '-')}/x.jsonl`],
  ])('contamina pelo caminho na forma %s', (_form, text) => {
    const e = setup();
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'run', text: 'Rodando', detail: text(e) }), true);
    expect(e.office.commit().snapshot.agents[0].activity?.detail).toBeUndefined();
  });

  it('subagente sem pai conhecido é privado (na dúvida, privado)', () => {
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/p'], privado: true }] }, '/h');
    const p = new Privacy(cfg, { agent: () => undefined, agents: () => [], changed: () => undefined });
    const base: Omit<AgentInfo, 'id' | 'kind' | 'roomId'> = { name: 'Ana', look: 'f', role: 'Explore', sessionId: 's', account: 'a', status: 'working', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, seed: 1, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } };
    const orphan: AgentInfo = { ...base, id: 'x:1', kind: 'sub', parentId: 'sumiu', roomId: '/publico', title: SENT };
    const noParent: AgentInfo = { ...base, id: 'x:2', kind: 'sub', roomId: '/publico', title: SENT };
    const pub: AgentInfo = { ...base, id: 'x:3', kind: 'main', roomId: '/publico', title: 'ok' };
    const snap = p.snapshot({ rev: 1, serverTime: 0, rooms: [], agents: [orphan, noParent, pub], accounts: [], meta: { demo: false, sources: [], startedAt: 0, version: 't' } });
    expect(JSON.stringify(snap)).not.toContain(SENT);
    expect(snap.agents[2].title).toBe('ok');
  });

  it('config inválida: todos os agentes ficam privados e o log avisa', () => {
    setQuiet(false);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const e = setup('{"projetos": [{"nome": "Vida", "caminhos": ["~/Documents/Vida"], "privada": true}]}');
    setQuiet(true);
    expect(errors.join('\n')).toContain('TODOS os agentes ficam privados');
    main(e, 'v', vida(e));
    main(e, 'c', clinicas(e));
    fill(e, 'v');
    fill(e, 'c');
    const { snapshot } = e.office.commit();
    expect(JSON.stringify(snapshot)).not.toContain(SENT);
    expect(snapshot.rooms.every((r) => r.path === r.name)).toBe(true);
  });
});

describe('o que não passa pelo Office', () => {
  it('terminal: agente privado e transcript que cita caminho privado ficam sem conversa', () => {
    const e = setup();
    main(e, 'v', vida(e));
    main(e, 'c', clinicas(e));
    const file = join(e.dataDir, 'c.jsonl');
    writeFileSync(file, '{"type":"user","message":"ok"}\n');
    const pathOf = e.qode.transcriptPathOf(() => file);
    expect(pathOf('v')).toBeUndefined();
    expect(pathOf('c')).toBe(file);

    const base = { push: (line: string) => [{ id: line, kind: 'text', text: line }] } as never;
    const parser = e.qode.parserFor(() => base)('c')!;
    expect(parser.push('linha pública')).toHaveLength(1);

    appendFileSync(file, `{"tool_input":{"file_path":"${vida(e, 'a.md')}"}}\n`);
    expect(pathOf('c')).toBeUndefined();
    expect(parser.push(SENT)).toEqual([]);
    expect(e.qode.privacy!.isPrivate('c')).toBe(true);
  });

  it('linha nova que cita caminho privado some e contamina o agente', () => {
    const e = setup();
    main(e, 'c', clinicas(e));
    const base = { push: (line: string) => [{ id: line, kind: 'text', text: line }] } as never;
    const parser = e.qode.parserFor(() => base)('c')!;
    expect(parser.push(`ler ~/Documents/Vida/${SENT}`)).toEqual([]);
    expect(parser.push('depois')).toEqual([]);
    e.office.addActivity('c', act('c', { text: SENT }), true);
    expect(JSON.stringify(e.office.commit().snapshot)).not.toContain(SENT);
  });

  it('histórico de sessões: lista sem as privadas e recusa abrir transcript que cita caminho privado', async () => {
    const e = setup();
    main(e, 'v', vida(e), 'sv');
    const clean = join(e.dataDir, 'clean.jsonl');
    const dirty = join(e.dataDir, 'dirty.jsonl');
    writeFileSync(clean, '{"cwd":"/x"}\n');
    writeFileSync(dirty, `{"cwd":"${vida(e)}"}\n`);
    const s = (over: Partial<RecentSession>): RecentSession => ({ account: '.claude', sessionId: 'x', projectDir: '-x', lastAt: 0, size: 1, open: false, ...over });
    const inner: SessionLookup = {
      list: async () => [
        s({ sessionId: 'a', project: vida(e), title: SENT }),
        s({ sessionId: 'b', project: clinicas(e), title: 'pública' }),
        s({ sessionId: 'c', title: SENT }),
        s({ sessionId: 'd', project: clinicas(e), title: `resumir ${vida(e, 'x.md')}` }),
        s({ sessionId: 'e', project: clinicas(e), open: true, agentId: 'v', title: SENT }),
      ],
      resolve: (_acc, id) => ({ path: id === 'dirty' ? dirty : clean, createParser: () => ({ push: () => [] }) }),
    };
    const h = e.qode.history(inner);
    expect((await h.list()).map((x) => x.sessionId)).toEqual(['b']);
    expect(h.resolve('.claude', 'dirty')).toEqual({ status: 404, error: PRIVATE_SESSION_ERROR });
    expect('path' in h.resolve('.claude', 'clean')).toBe(true);
  });

  it('permissões e mensagens: privado some do registro; pedido que cita caminho privado sai na hora', () => {
    const e = setup();
    main(e, 'v', vida(e), 'sv');
    main(e, 'c', clinicas(e), 'sc');
    const view = e.qode.officeView(e.office);
    expect(view.get('v')).toBeUndefined();
    expect(view.list().map((a) => a.id)).toEqual(['c']);

    const calls: unknown[] = [];
    const inner = {
      register: (raw: unknown) => (calls.push(raw), { id: 'p', expiresAt: 0 }),
      wait: () => undefined,
      decide: () => 'not-found' as const,
      detail: (id: string) => ({ id, tool: 'Read', title: id === 'sujo' ? `Read(${vida(e, 'a.md')})` : 'Read(x)', text: 'Lendo', icon: '📖', createdAt: 0, expiresAt: 0 }),
    } as unknown as PermissionRegistry;
    const routes = e.qode.permissionRoutes(inner);
    expect(routes.register({ session_id: 'sc', tool_name: 'Read', tool_input: { file_path: vida(e, `${SENT}.md`) } })).toEqual({ skip: 'unknown-session' });
    expect(calls).toHaveLength(0);
    expect(view.get('c')).toBeUndefined();
    expect(routes.register({ session_id: 'outra', tool_name: 'Read', tool_input: { file_path: '/x' } })).toEqual({ id: 'p', expiresAt: 0 });
    expect(routes.detail('sujo')).toBeUndefined();
    expect(routes.detail('limpo')).toBeDefined();
  });

  it('o leitor de transcript procura só nos bytes novos e acha o trecho partido entre blocos', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const file = join(tmp.dir, 't.jsonl');
    const needle = '/users/teste/documents/vida';
    writeFileSync(file, `${'x'.repeat((1 << 20) - 10)}/Users/teste/Documents/Vida/a\n`);
    expect(new TranscriptScanner([needle]).mentions(file)).toBe(true);
    const sc = new TranscriptScanner([needle]);
    const other = join(tmp.dir, 'u.jsonl');
    writeFileSync(other, 'limpo\n');
    expect(sc.mentions(other)).toBe(false);
    appendFileSync(other, 'cat /USERS/teste/Documents/Vida-Context\n');
    expect(sc.mentions(other)).toBe(true);
  });
});

describe('allowlist: campo novo do upstream não passa sem decisão', () => {
  it('as tabelas cobrem exatamente os campos dos tipos (Required<> quebra o typecheck se faltar um)', () => {
    const activity: Required<Activity> = { id: 'a', kind: 'read', icon: 'i', text: 't', detail: 'd', tool: 't', at: 0, durationMs: 0, error: false, questions: [] };
    const agent: Required<AgentInfo> = {
      id: 'a', kind: 'main', provider: 'claude', parentId: 'p', roomId: 'r', name: 'n', look: 'f', role: 'r', title: 't', sessionId: 's', account: 'a',
      status: 'working', waitingFor: 'w', activity, recent: [], tasks: [], shells: [], model: 'm', gitBranch: 'g', permissionMode: 'p', startedAt: 0,
      lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 0, parts: {}, custom: true, background: true,
      permission: { id: 'p', tool: 't', title: 't', text: 't', icon: 'i', createdAt: 0, expiresAt: 0 }, canMessage: true,
    };
    const room: Required<RoomInfo> = { id: 'r', name: 'n', path: 'p', slot: 0, seed: 0, createdAt: 0, effect: { kind: 'party', text: 't', at: 0, until: 0 } };
    const feed: Required<FeedItem> = { id: 'f', agentId: 'a', roomId: 'r', agentName: 'n', roomName: 'r', account: 'a', activity };
    const notice: Required<Notice> = { id: 'n', level: 'info', text: 't', agentId: 'a', roomId: 'r', at: 0 };
    const meta: Required<OfficeSnapshot['meta']> = { demo: false, sources: [], startedAt: 0, version: 'v', build: 'b', terminal: true, messages: true, updates: { status: 'disabled' } as never };
    const snap: Required<OfficeSnapshot> = { rev: 0, serverTime: 0, rooms: [], agents: [], accounts: [], meta };
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(ACTIVITY_RULES)).toEqual(keys(activity));
    expect(keys(AGENT_RULES)).toEqual(keys(agent));
    expect(keys(ROOM_RULES)).toEqual(keys(room));
    expect(keys(FEED_RULES)).toEqual(keys(feed));
    expect(keys(NOTICE_RULES)).toEqual(keys(notice));
    expect(keys(META_RULES)).toEqual(keys(meta));
    expect(keys(SNAPSHOT_RULES)).toEqual(keys(snap));
  });

  it('todo campo que o Office emite de verdade está nas tabelas', () => {
    const e = setup();
    main(e, 'c', clinicas(e), 'sc');
    e.office.addSub({ id: 'sc:s', parentId: 'c', sessionId: 'sc', role: 'Explore', title: 't', background: true, startedAt: now() });
    fill(e, 'c');
    e.office.githubEvent('c', { kind: 'pr_merged', number: 1 } as never, { key: 'k', at: now() });
    const { snapshot, feed, notices } = e.office.commit();
    const missing = (o: object, rules: object) => Object.keys(o).filter((k) => !(k in rules));
    for (const a of snapshot.agents) {
      expect(missing(a, AGENT_RULES), a.id).toEqual([]);
      for (const x of [a.activity, ...a.recent]) if (x) expect(missing(x, ACTIVITY_RULES)).toEqual([]);
    }
    for (const r of snapshot.rooms) expect(missing(r, ROOM_RULES)).toEqual([]);
    for (const f of feed) expect(missing(f, FEED_RULES)).toEqual([]);
    for (const n of notices) expect(missing(n, NOTICE_RULES)).toEqual([]);
    expect(missing(snapshot, SNAPSHOT_RULES)).toEqual([]);
    expect(missing(snapshot.meta, META_RULES)).toEqual([]);
  });

  it('campo desconhecido num agente privado não sai', () => {
    const a = { id: 'a', kind: 'main', roomId: 'r', name: 'n', look: 'f', role: 'r', sessionId: 's', account: 'a', status: 'idle', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, seed: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, campoNovo: SENT } as AgentInfo;
    expect(JSON.stringify(privateAgent(a))).not.toContain(SENT);
  });
});
