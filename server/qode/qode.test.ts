// Fork QODE: salas por projeto e privacidade. Só textos sentinela sintéticos (nada de conteúdo real do Vida OS),
// numa HOME falsa em pasta temporária.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
import { isPrivatePath, loadQodeConfig, mentionsPrivate, MENTIONS_TOKENS_MAX, parseConfig, PRIVATE_ROOM_PREFIX, projectOf } from './config';
import { PRIVATE_SESSION_ERROR, setupQode, TranscriptScanner, type QodeSetup } from './index';
import { createTerminalParser } from '../sources/terminal';
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
    expect(routes.detail('p')).toBeDefined();
    expect(routes.detail('sujo')).toBeUndefined();
    expect(routes.detail('limpo')).toBeUndefined();
  });

  it('o leitor de transcript procura só nos bytes novos e acha o trecho partido entre blocos', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/Documents/Vida'], privado: true }] }, '/Users/teste');
    const has = (t: string) => mentionsPrivate(cfg, t);
    const file = join(tmp.dir, 't.jsonl');
    writeFileSync(file, `${'x '.repeat(((1 << 20) - 10) / 2)}/Users/teste/Documents/Vida/a\n`);
    expect(new TranscriptScanner(has).scan(file)).toBe('hit');
    const sc = new TranscriptScanner(has);
    const other = join(tmp.dir, 'u.jsonl');
    writeFileSync(other, 'limpo\n');
    expect(sc.scan(other)).toBe('clean');
    appendFileSync(other, 'cat /USERS/teste/Documents/Vida/x\n');
    expect(sc.scan(other)).toBe('hit');
    expect(sc.scan(join(tmp.dir, 'nao-existe.jsonl'))).toBe('error');
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

describe('revisões de 11/10/2026 (Grok e DeepSeek)', () => {
  /** Tudo o que o escritório publica (snapshot, feed, avisos, feed recente, detalhe) e o que vai para o disco. */
  function published(e: Env, ids: string[]): string {
    const c = e.office.commit();
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const tl = new TimelineRecorder({ dir: join(tmp.dir, 'tl') });
    tl.ingest(c.snapshot);
    tl.stop();
    const stats = new DayStatsService({ dir: join(tmp.dir, 'st'), snapshot: () => c.snapshot });
    stats.sample();
    stats.flush();
    const disk = ['tl', 'st'].flatMap((d) => readdirSync(join(tmp.dir, d)).map((f) => readFileSync(join(tmp.dir, d, f), 'utf8')));
    return [JSON.stringify(c), JSON.stringify(e.office.recentFeed(50)), ...ids.map((id) => JSON.stringify(e.office.detail(id))), ...disk].join('\n');
  }

  it('config inválida: id da sala, roomId, feed, avisos, timeline, stats e rooms.json sem o caminho', () => {
    const e = setup('{"projetos": [{"nome": "Vida", "caminhos": ["~/Documents/Vida"], "privada": true}]}');
    main(e, 'v', vida(e, 'notas'));
    main(e, 'v2', vida(e, 'outra'));
    main(e, 'c', clinicas(e));
    e.office.addActivity('v', act('v', { text: SENT, detail: vida(e, 'a.md') }), true);
    const out = published(e, ['v', 'c']);
    expect(out).not.toContain(SENT);
    expect(out.toLowerCase()).not.toContain(e.home.toLowerCase());
    expect(out.toLowerCase()).not.toContain('documents');
    expect(out).not.toContain('notas');
    const snap = e.office.commit().snapshot;
    expect(snap.rooms).toHaveLength(3);
    for (const r of snap.rooms) expect(r.id.startsWith(PRIVATE_ROOM_PREFIX)).toBe(true);

    const file = join(e.dataDir, 'rooms.json');
    const aliases = new RoomAliases(file);
    aliases.set(e.office.roomPath(snap.rooms[0].id)!, 'Renomeada');
    expect(readFileSync(file, 'utf8').toLowerCase()).not.toContain('documents');
    expect(e.qode.health()).toMatchObject({ config: 'invalida' });
    expect(JSON.stringify(e.qode.health())).not.toContain('Vida');
  });

  it('/api/health indica a config inválida', async () => {
    const e = setup('{ quebrado');
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    mkdirSync(join(tmp.dir, '.claude', 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [join(tmp.dir, '.claude')], home: tmp.dir, env: {}, onChange: () => undefined });
    const hub = new Hub(e.office);
    const api = createApiHandler({ office: e.office, hub, accounts, sources: () => [], version: 't', inDocker: false, health: () => ({ qode: e.qode.health() }) });
    const server = http.createServer((req, res) => void (api(req, res, new URL(req.url ?? '/', 'http://x')) || res.end()));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`)).json()) as { ok: boolean; qode: { config: string } };
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    expect(body.ok).toBe(true);
    expect(body.qode.config).toBe('invalida');
  });

  it('symlink para o Vida OS: cwd no atalho e leitura pelo atalho ficam privados', () => {
    const e = setup();
    mkdirSync(vida(e, 'notas'), { recursive: true });
    mkdirSync(clinicas(e), { recursive: true });
    symlinkSync(vida(e), join(e.home, 'atalho-vida'));
    symlinkSync(vida(e), join(clinicas(e), 'notas-link'));
    main(e, 'a', join(e.home, 'atalho-vida', 'notas'));
    fill(e, 'a');
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { detail: `cat ${join(clinicas(e), 'notas-link', 'x.md')}`, text: SENT }), true);
    main(e, 'd', join(e.home, 'outro'));
    e.office.addActivity('d', act('d', { detail: 'cat ~/atalho-vida/diario.md', text: SENT }), true);
    const out = published(e, ['a', 'c', 'd']);
    expect(out).not.toContain(SENT);
    expect(out).not.toContain('atalho-vida');
    expect(e.office.commit().snapshot.rooms.find((r) => r.name === 'Vida OS')).toBeDefined();
  });

  it('".." depois de um symlink vale no alvo: clinicas/ponte/../Vida é o Vida OS', () => {
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    mkdirSync(clinicas(e), { recursive: true });
    symlinkSync(vida(e), join(clinicas(e), 'ponte'));
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: `cat ${clinicas(e)}/ponte/../Vida/secret.md` }), true);
    main(e, 'g', clinicas(e));
    e.office.addActivity('g', act('g', { kind: 'run', text: SENT, detail: `rg x "${clinicas(e)}/ponte/../Vi"*` }), true);
    main(e, 'w', `${clinicas(e)}/ponte/../Vida/notas`);
    fill(e, 'w');
    expect(['c', 'g', 'w'].map((id) => e.qode.privacy!.isPrivate(id))).toEqual([true, true, true]);
    expect(published(e, ['c', 'g', 'w'])).not.toContain(SENT);
  });

  it('".." depois de um componente que não existe ainda revela a ponte', () => {
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    mkdirSync(clinicas(e), { recursive: true });
    symlinkSync(vida(e), join(clinicas(e), 'ponte'));
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: `cat ${clinicas(e)}/nao-existe/../ponte/secret.md` }), true);
    main(e, 'g', clinicas(e));
    e.office.addActivity('g', act('g', { kind: 'run', text: SENT, detail: `rg x "${clinicas(e)}/nao-existe/../ponte/Vi"*` }), true);
    main(e, 'w', `${clinicas(e)}/nao-existe/../ponte`);
    fill(e, 'w');
    expect(['c', 'g', 'w'].map((id) => e.qode.privacy!.isPrivate(id))).toEqual([true, true, true]);
    expect(published(e, ['c', 'g', 'w'])).not.toContain(SENT);
  });

  it('chmod 000 no meio não esconde a ponte (pula se root)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    mkdirSync(clinicas(e), { recursive: true });
    symlinkSync(vida(e), join(clinicas(e), 'ponte'));
    const locked = join(clinicas(e), 'fechado');
    mkdirSync(locked);
    chmodSync(locked, 0);
    try {
      main(e, 'c', clinicas(e));
      e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: `cat ${locked}/../ponte/secret.md` }), true);
      main(e, 'w', `${locked}/../ponte`);
      fill(e, 'w');
      expect(e.qode.privacy!.isPrivate('c')).toBe(true);
      expect(e.qode.privacy!.isPrivate('w')).toBe(true);
      expect(published(e, ['c', 'w'])).not.toContain(SENT);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('na dúvida entre a leitura do texto e a física, o privado ganha', () => {
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    mkdirSync(clinicas(e), { recursive: true });
    symlinkSync(clinicas(e), join(vida(e), 'volta'));
    main(e, 'v', `${vida(e)}/volta/..`);
    fill(e, 'v');
    expect(e.qode.privacy!.isPrivate('v')).toBe(true);
    expect(published(e, ['v'])).not.toContain(SENT);
  });

  it('file://localhost/ é o mesmo que file:///', () => {
    const e = setup();
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'read', text: SENT, detail: `file://localhost${e.home}/Documents/Vida/a.md` }), true);
    expect(e.qode.privacy!.isPrivate('c')).toBe(true);
  });

  it('cache do realpath: symlink criado depois e symlink trocado valem na consulta seguinte', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const e = setup();
      mkdirSync(vida(e), { recursive: true });
      mkdirSync(clinicas(e), { recursive: true });
      const novo = join(e.home, 'novo-atalho');
      main(e, 'a', clinicas(e));
      e.office.addActivity('a', act('a', { kind: 'run', detail: `cat ${novo}/a.md` }), true);
      expect(e.qode.privacy!.isPrivate('a')).toBe(false);
      symlinkSync(vida(e), novo);
      main(e, 'b', clinicas(e));
      e.office.addActivity('b', act('b', { kind: 'run', detail: `cat ${novo}/a.md` }), true);
      expect(e.qode.privacy!.isPrivate('b')).toBe(true);

      const troca = join(e.home, 'troca');
      symlinkSync(clinicas(e), troca);
      main(e, 'c', clinicas(e));
      e.office.addActivity('c', act('c', { kind: 'run', detail: `cat ${troca}/a.md` }), true);
      expect(e.qode.privacy!.isPrivate('c')).toBe(false);
      unlinkSync(troca);
      symlinkSync(vida(e), troca);
      vi.setSystemTime(Date.now() + 5_000);
      main(e, 'd', clinicas(e));
      e.office.addActivity('d', act('d', { kind: 'run', detail: `cat ${troca}/a.md` }), true);
      expect(e.qode.privacy!.isPrivate('d')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['..', (e: Env) => join(e.home, 'Documents', 'GitHub') + '/../Vida/notas'],
    ['.', (e: Env) => join(e.home, 'Documents') + '/./Vida'],
    ['barra dupla', (e: Env) => join(e.home, 'Documents') + '//Vida/'],
  ])('cwd com %s cai na sala privada', (_why, cwd) => {
    const e = setup();
    main(e, 'v', cwd(e));
    fill(e, 'v');
    const out = published(e, ['v']);
    expect(out).not.toContain(SENT);
    expect(out.toLowerCase()).not.toContain('documents');
  });

  const forms: Array<[string, (e: Env) => string]> = [
    ['"$HOME"/', () => 'cat "$HOME"/Documents/Vida/diario.md'],
    ['$HOME"/…"', () => 'cat $HOME"/Documents/Vida"/diario.md'],
    ['${HOME}', () => 'cat ${HOME}/Documents/Vida/diario.md'],
    ['~usuário/', (e) => `cat ~${basename(e.home)}/Documents/Vida/diario.md`],
    ['barra dupla', (e) => `cat ${e.home}/Documents//Vida/a.md`],
    ['/./', (e) => `cat ${e.home}/Documents/./Vida/a.md`],
    ['/../', (e) => `cat ${e.home}/Documents/GitHub/../Vida/a.md`],
    ['%2F', (e) => `abrir ${encodeURIComponent(`${e.home}/Documents/Vida/a.md`)}`],
    ['file://', (e) => `file://${e.home}/Documents/Vida/a.md`],
    ['JSON com \\/', (e) => JSON.stringify({ p: `${e.home}/Documents/Vida/a.md` }).replace(/\//g, '\\/')],
    ['aspas simples', () => "cat '~/Documents/Vida/a.md'"],
    ['glob no nome', () => 'rg senha ~/Documents/Vi*'],
    ['maiúsculas', (e) => `cat ${e.home}/DOCUMENTS/vida/a.md`],
  ];
  it.each(forms)('contamina pela forma %s', (_why, text) => {
    const e = setup();
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: text(e) }), true);
    expect(published(e, ['c'])).not.toContain(SENT);
  });

  it.each([
    ['pasta vizinha com nome parecido', (e: Env) => `cat ${e.home}/Documents/Vidal/a.md`],
    ['projeto público', (e: Env) => `cat ${clinicas(e)}/a.md`],
    ['caminho relativo (limite documentado)', () => 'cat ../../Documents/Vida/a.md'],
  ])('não contamina: %s', (_why, text) => {
    const e = setup();
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: text(e) }), true);
    expect(e.qode.privacy!.isPrivate('c')).toBe(false);
  });

  it('log: some o caminho inteiro, inclusive o sufixo e com espaços', () => {
    const e = setup();
    setQuiet(false);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: string) => void lines.push(m));
    log.warn(`Falha ao ler ${vida(e, 'diario/senhas.md')} (ENOENT)`);
    log.warn('Falha ao ler "$HOME"/Documents/Vida/minhas notas secretas.md');
    log.warn(`Arquivo ${clinicas(e)}/ok.md lido`);
    expect(lines[0]).toBe('[habblaud] Falha ao ler [privado]');
    expect(lines[1]).toBe('[habblaud] Falha ao ler [privado]');
    expect(lines.join('\n')).not.toMatch(/senhas|notas|secretas/);
    expect(lines[2]).toContain('ok.md');
  });

  it('log com config inválida: caminhos da home somem', () => {
    const e = setup('{ quebrado');
    setQuiet(false);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: string) => void lines.push(m));
    log.warn(`Falha ao ler ${vida(e, 'diario/senhas.md')}`);
    log.warn('Habblaud em http://127.0.0.1:4747');
    expect(lines[0]).toBe('[habblaud] Falha ao ler [privado]');
    expect(lines[1]).toContain('127.0.0.1:4747');
  });

  function fakeRegistry(e: Env) {
    const decided: string[] = [];
    const inner = {
      register: () => ({ id: `p${decided.length}-${Math.random()}`, expiresAt: 0 }),
      wait: () => undefined,
      decide: (id: string) => (decided.push(id), 'ok' as const),
      detail: (id: string) => ({ id, tool: 'Bash', title: `Bash(${SENT})`, text: 'Rodando', icon: '⚙️', createdAt: 0, expiresAt: 0 }),
    } as unknown as PermissionRegistry;
    return { routes: e.qode.permissionRoutes(inner), decided };
  }

  it('permissão registrada antes da contaminação deixa de ser legível e aprovável', () => {
    const e = setup();
    main(e, 'c', clinicas(e), 'sc');
    const { routes, decided } = fakeRegistry(e);
    const r = routes.register({ session_id: 'sc', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect('id' in r).toBe(true);
    const id = (r as { id: string }).id;
    expect(routes.detail(id)).toBeDefined();
    e.office.addActivity('c', act('c', { detail: vida(e, 'a.md') }), true);
    expect(routes.detail(id)).toBeUndefined();
    expect(routes.decide(id, { behavior: 'allow' })).toBe('not-found');
    expect(decided).toEqual([]);
  });

  it('pedido que cita o Vida OS antes de o agente existir: a sessão fica marcada', () => {
    const e = setup();
    const { routes } = fakeRegistry(e);
    expect(routes.register({ session_id: 'sx', agent_id: 'ag', tool_name: 'Read', tool_input: { file_path: vida(e, 'a.md') } })).toEqual({ skip: 'unknown-session' });
    main(e, 'x', clinicas(e), 'sx');
    fill(e, 'x');
    e.office.addSub({ id: 'sx:ag', parentId: 'x', sessionId: 'sx', role: 'Explore', title: SENT, background: false, startedAt: now() });
    expect(published(e, ['x', 'sx:ag'])).not.toContain(SENT);
    expect(routes.register({ session_id: 'sx', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ skip: 'unknown-session' });
  });

  it('papel do subagente privado vira genérico', () => {
    const e = setup();
    main(e, 'v', vida(e));
    e.office.addSub({ id: 'v:s', parentId: 'v', sessionId: 'sv', role: `revisor-${SENT}`, background: false, startedAt: now() });
    const out = published(e, ['v:s']);
    expect(out).not.toContain(SENT);
    expect(e.office.commit().snapshot.agents.find((a) => a.id === 'v:s')!.role).toBe('Subagente');
  });

  it('model, gitBranch e permissionMode também contaminam', () => {
    for (const k of ['model', 'gitBranch', 'permissionMode'] as const) {
      const e = setup();
      main(e, 'c', clinicas(e));
      e.office.applyTranscript('c', { title: SENT, tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, [k]: `x ${vida(e)}` });
      expect(published(e, ['c']), k).not.toContain(SENT);
    }
  });

  it('transcript ilegível ou ausente: falha fechada (sem terminal, sem sessão), sem contaminar', () => {
    const e = setup();
    main(e, 'c', clinicas(e));
    expect(e.qode.transcriptPathOf(() => join(e.dataDir, 'sumiu.jsonl'))('c')).toBeUndefined();
    expect(e.qode.privacy!.isPrivate('c')).toBe(false);
    const h = e.qode.history({ list: async () => [], resolve: () => ({ path: join(e.dataDir, 'sumiu.jsonl'), createParser: () => ({ push: () => [] }) }) });
    expect(h.resolve('.claude', 'x')).toEqual({ status: 404, error: PRIVATE_SESSION_ERROR });
  });

  it('transcript reescrito no lugar com o mesmo tamanho é varrido de novo', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/Documents/Vida'], privado: true }] }, '/Users/teste');
    const sc = new TranscriptScanner((t) => mentionsPrivate(cfg, t));
    const file = join(tmp.dir, 't.jsonl');
    const dirty = 'cat /Users/teste/Documents/Vida/a\n';
    writeFileSync(file, 'x'.repeat(dirty.length));
    utimesSync(file, 1, 1);
    expect(sc.scan(file)).toBe('clean');
    writeFileSync(file, dirty);
    utimesSync(file, 2, 2);
    expect(sc.scan(file)).toBe('hit');
  });

  it('sem projeto privado, subagente órfão não é escondido', () => {
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/p'] }] }, '/h');
    const p = new Privacy(cfg, { agent: () => undefined, agents: () => [], changed: () => undefined });
    expect(p.isPrivate('qualquer')).toBe(false);
  });

  it('caminho absoluto com espaço (aspas ou barra invertida) contamina', () => {
    const run = (detail: (alias: string) => string) => {
      const e = setup();
      mkdirSync(vida(e), { recursive: true });
      const alias = join(e.dataDir, 'qode alias');
      symlinkSync(vida(e), alias);
      expect(isPrivatePath(e.qode.config!, `${alias}/secret.txt`)).toBe(true);
      main(e, 'c', clinicas(e));
      e.office.addActivity('c', act('c', { kind: 'run', text: SENT, detail: detail(alias) }), true);
      expect(e.qode.privacy!.isPrivate('c')).toBe(true);
      expect(published(e, ['c'])).not.toContain(SENT);
      expect(published(e, ['c'])).not.toContain('qode alias');
    };
    run((alias) => `cat "${alias}/secret.txt"`);
    run((alias) => `cat '${alias}/secret.txt'`);
    run((alias) => `cat ${alias.replace(' ', '\\ ')}/secret.txt`);
  });

  it('file:// com %20 no nome não parte o token (nem file://localhost)', () => {
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    const alias = join(e.dataDir, 'qode alias');
    symlinkSync(vida(e), alias);
    const enc = alias.replace(/ /g, '%20');
    main(e, 'c', clinicas(e));
    e.office.addActivity('c', act('c', { kind: 'read', text: SENT, detail: `open file://${enc}/secret.txt` }), true);
    expect(e.qode.privacy!.isPrivate('c')).toBe(true);
    main(e, 'd', clinicas(e));
    e.office.addActivity('d', act('d', { kind: 'read', text: SENT, detail: `open file://localhost${enc}/secret.txt` }), true);
    expect(e.qode.privacy!.isPrivate('d')).toBe(true);
    expect(published(e, ['c', 'd'])).not.toContain(SENT);
  });

  it('aspas concatenadas e bash -c com aspas aninhadas contaminam', () => {
    const e = setup();
    mkdirSync(vida(e), { recursive: true });
    const alias = join(e.dataDir, 'qode alias');
    const dir = e.dataDir;
    symlinkSync(vida(e), alias);
    const forms = [
      `"${dir}/qode"" alias/secret.txt"`,
      `'${dir}/qode'\\ 'alias'/secret.txt`,
      `"${dir}/"'qode alias'/secret.txt`,
      `bash -c 'cat "${alias}/secret.txt"'`,
      `zsh -lc 'cat "${alias}/secret.txt"'`,
      `eval 'cat "${alias}/secret.txt"'`,
    ];
    const ids: string[] = [];
    for (const [i, detail] of forms.entries()) {
      const id = `c${i}`;
      ids.push(id);
      main(e, id, clinicas(e));
      e.office.addActivity(id, act(id, { kind: 'run', text: SENT, detail }), true);
      expect(e.qode.privacy!.isPrivate(id), detail).toBe(true);
    }
    expect(published(e, ids)).not.toContain(SENT);
    expect(published(e, ids)).not.toContain('qode alias');
  });

  it('transcript JSON com \\u002f é inspecionado já decodificado; linha que não parseia fecha', () => {
    const e = setup();
    main(e, 'c', clinicas(e), 'sc');
    const file = join(e.dataDir, 'u.jsonl');
    const hidden = JSON.stringify({ type: 'assistant', cwd: clinicas(e), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: vida(e, 'a.md') } }] } }).replace(/\//g, '\\u002f');
    expect(hidden).not.toContain('/Documents/Vida');
    writeFileSync(file, `${hidden}\n`);
    expect(new TranscriptScanner((t) => mentionsPrivate(e.qode.config!, t)).scan(file)).toBe('hit');
    const leaked: string[] = [];
    const h = e.qode.history({
      list: async () => [],
      resolve: () => ({
        path: file,
        createParser: () => ({
          push: (line) => {
            leaked.push(line);
            return [];
          },
        }),
      }),
    });
    expect(h.resolve('.claude', 'sc')).toEqual({ status: 404, error: PRIVATE_SESSION_ERROR });
    const parser = e.qode.parserFor(() => createTerminalParser())('c')!;
    expect(parser.push(hidden)).toEqual([]);
    expect(parser.push(`{"cwd":"${clinicas(e)}", quebrado`)).toEqual([]);
    expect(e.qode.privacy!.isPrivate('c')).toBe(true);
    expect(leaked).toEqual([]);
  });

  it('vínculo pedido→sessão não é descartado; sem identidade, decide/detail fecham', () => {
    const e = setup();
    main(e, 'c', clinicas(e), 'sc');
    const decided: string[] = [];
    let n = 0;
    const routes = e.qode.permissionRoutes({
      register: () => ({ id: `p${n++}`, expiresAt: 0 }),
      wait: () => undefined,
      decide: (id: string) => (decided.push(id), 'ok' as const),
      detail: (id: string) => ({ id, tool: 'Bash', title: `Bash(${SENT})`, text: 'Rodando', icon: '⚙️', createdAt: 0, expiresAt: 0 }),
    } as unknown as PermissionRegistry);
    const first = routes.register({ session_id: 'sc', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const id = (first as { id: string }).id;
    for (let i = 0; i < 500; i++) {
      const r = routes.register({ session_id: 'outra', tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(routes.decide((r as { id: string }).id, { behavior: 'allow' })).toBe('ok');
    }
    e.office.addActivity('c', act('c', { detail: vida(e, 'a.md') }), true);
    expect(routes.detail(id)).toBeUndefined();
    expect(routes.decide(id, { behavior: 'allow' })).toBe('not-found');
    expect(decided).not.toContain(id);
    expect(routes.detail('sumiu')).toBeUndefined();
    expect(routes.decide('sumiu', { behavior: 'allow' })).toBe('not-found');
  });

  it('mentionsPrivate é linear mesmo com 64 KB de barras invertidas', () => {
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/Documents/Vida'], privado: true }] }, '/Users/teste');
    const junk = '\\'.repeat(64 * 1024);
    const t0 = performance.now();
    expect(mentionsPrivate(cfg, junk)).toBe(false);
    expect(mentionsPrivate(cfg, `${junk} cat /Users/teste/Documents/Vida/a.md`)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('JSON de 247 KB / 8000 caminhos: teto no scanner e no histórico, sem travar', () => {
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/Documents/Vida'], privado: true }] }, '/Users/teste');
    const files = Array.from({ length: 8_000 }, (_, i) => `/tmp/public-workspace/dir/file-${String(i).padStart(5, '0')}.md`);
    const line = JSON.stringify({ type: 'user', cwd: '/tmp/public', files });
    expect(Buffer.byteLength(line)).toBeGreaterThan(240_000);
    expect(line.length).toBeGreaterThan(96 * 1024);
    const t0 = performance.now();
    expect(mentionsPrivate(cfg, line)).toBe(true);
    const mentionsMs = performance.now() - t0;
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const file = join(tmp.dir, 'big.jsonl');
    writeFileSync(file, `${line}\n`);
    const t1 = performance.now();
    expect(new TranscriptScanner((t) => mentionsPrivate(cfg, t)).scan(file)).toBe('hit');
    const scanMs = performance.now() - t1;
    const e = setup();
    const t2 = performance.now();
    const h = e.qode.history({ list: async () => [], resolve: () => ({ path: file, createParser: () => ({ push: () => [] }) }) });
    expect(h.resolve('.claude', 'x')).toEqual({ status: 404, error: PRIVATE_SESSION_ERROR });
    const histMs = performance.now() - t2;
    expect(mentionsMs, `mentions ${mentionsMs}ms`).toBeLessThan(200);
    expect(scanMs, `scan ${scanMs}ms`).toBeLessThan(200);
    expect(histMs, `hist ${histMs}ms`).toBeLessThan(200);
  });

  it('linha JSON incompleta bloqueia sem contaminar; completa e reavalia', () => {
    const e = setup();
    main(e, 'c', clinicas(e));
    const file = join(e.dataDir, 'partial.jsonl');
    writeFileSync(file, '{"type":"user","cwd":"/tmp/pub","message":"oi"');
    const has = (t: string) => mentionsPrivate(e.qode.config!, t);
    const sc = new TranscriptScanner(has);
    expect(sc.scan(file)).toBe('error');
    expect(e.qode.transcriptPathOf(() => file)('c')).toBeUndefined();
    expect(e.qode.privacy!.isPrivate('c')).toBe(false);
    appendFileSync(file, '}\n');
    expect(sc.scan(file)).toBe('clean');
    expect(new TranscriptScanner(has).scan(file)).toBe('clean');
    expect(e.qode.transcriptPathOf(() => file)('c')).toBe(file);
    expect(e.qode.privacy!.isPrivate('c')).toBe(false);
  });

  it('JSON com milhares de caminhos: teto de inspeção, falha fechada, sem travar', () => {
    const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: ['~/Documents/Vida'], privado: true }] }, '/Users/teste');
    const files = Array.from({ length: 8_000 }, (_, i) => `/tmp/pub/f${i}.md`);
    const text = JSON.stringify({ files });
    expect(files.length).toBeGreaterThan(MENTIONS_TOKENS_MAX);
    const t0 = performance.now();
    expect(mentionsPrivate(cfg, text)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
    const small = JSON.stringify({ files: files.slice(0, 8) });
    expect(mentionsPrivate(cfg, small)).toBe(false);
  });

  it('/api/health não ecoa chave inválida que é um caminho privado', () => {
    const e = setup(JSON.stringify({ '~/Documents/Vida/secret.md': true, projetos: [{ nome: 'X', caminhos: ['~/p'] }] }));
    const body = JSON.stringify(e.qode.health());
    expect(e.qode.health()).toMatchObject({ config: 'invalida' });
    expect(body.toLowerCase()).not.toMatch(/vida|documents|secret|~\//);
  });
});
