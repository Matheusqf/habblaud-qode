// Q4 — matriz sintética de regressão (canário QODE_CANARY_PRIVATE_48H).
// Reusa o método de verification de qode.test.ts (Office + Privacy + HTTP).
// Proteções atuais: zero canário nas saídas. Gaps conhecidos: reproduzidos à parte, sem alegar correção.
// NÃO invoca flow-council nem lê Vida/UBOTS/Wellhub reais.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, OfficeSnapshot, PermissionRequestInfo } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { DayStatsService } from '../history/daystats';
import { TimelineRecorder } from '../history/timeline';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { log, setLogFilter, setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { tempDir } from '../test/fixtures';
import { mentionsPrivate } from './config';
import { setupQode, type QodeSetup } from './index';

setQuiet(true);

/** Canário sintético do ciclo (Sol Q4). Só em fixtures. */
export const CANARY = 'QODE_CANARY_PRIVATE_48H';

interface Env {
  home: string;
  dataDir: string;
  office: Office;
  qode: QodeSetup;
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

const now = () => Date.now();

function setup(): Env {
  const tmp = tempDir('habblaud-qode-canary-');
  const home = join(tmp.dir, 'home');
  const dataDir = join(tmp.dir, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const privado = join(home, 'Documents', 'PrivadoSintetico');
  mkdirSync(privado, { recursive: true });
  writeFileSync(
    join(dataDir, 'qode.config.json'),
    JSON.stringify({
      projetos: [
        { nome: 'PublicoSintetico', caminhos: [join(home, 'Documents', 'PublicoSintetico')], privado: false },
        { nome: 'PrivadoSintetico', caminhos: [privado], privado: true },
      ],
    }),
  );
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
  return { home, dataDir, office, qode, perms, cleanup: tmp.cleanup };
}

const privadoRoot = (e: Env) => join(e.home, 'Documents', 'PrivadoSintetico');
const publicoRoot = (e: Env) => join(e.home, 'Documents', 'PublicoSintetico');

function main(e: Env, id: string, cwd: string, sessionId = `s-${id}`): void {
  e.office.addMain({ id, account: '.claude', sessionId, cwd, role: 'Agente principal', startedAt: now(), status: 'working' });
}

function act(id: string, over: Partial<Activity> = {}): Activity {
  return { id: `${id}#${Math.random()}`, kind: 'read', icon: '📖', text: 'Lendo arquivo', at: now(), ...over };
}

/** Canário em título, tarefa, diff/detail, shell, permissão e aviso. */
function fillCanary(e: Env, id: string): void {
  e.office.applyTranscript(id, {
    title: `titulo-${CANARY}`,
    tasks: [{ id: 't1', title: `task-${CANARY}`, status: 'in_progress', activeForm: `form-${CANARY}` }],
    stats: { toolCalls: 1, tokensIn: 1, tokensOut: 1, subagents: 0 },
    model: `model-${CANARY}`,
    gitBranch: `branch-${CANARY}`,
    permissionMode: `perm-${CANARY}`,
  });
  e.office.addActivity(id, act(id, { text: `diff-${CANARY}`, detail: join(privadoRoot(e), `${CANARY}.md`), tool: `tool-${CANARY}` }), true);
  e.office.setShells(id, [{ id: 'j1', label: `label-${CANARY}`, command: `echo ${CANARY}`, startedAt: now(), background: true, kind: 'shell' }]);
  e.perms.set(id, { id: 'p1', tool: 'Bash', title: `ask-${CANARY}`, text: `cmd ${CANARY}`, icon: '🔐', createdAt: now(), expiresAt: now() + 60_000 });
  e.office.setStatus(id, 'waiting', `wait-${CANARY}`);
  e.office.noticePermission(id, `notice-${CANARY}`);
}

describe('Q4 matriz canário — proteções atuais', () => {
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

  it('zero canário em snapshot, detalhe, SSE, histórico, timeline, stats e logs; controlo público visível', async () => {
    const e = setup();
    mkdirSync(publicoRoot(e), { recursive: true });
    main(e, 'priv', privadoRoot(e), 'sp');
    main(e, 'pub', publicoRoot(e), 'su');
    fillCanary(e, 'priv');
    e.office.applyTranscript('pub', {
      title: 'Agenda publica OK',
      tasks: [],
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    });

    const tmp = tempDir('habblaud-qode-canary-out-');
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
    out.detail = JSON.stringify([e.office.detail('priv'), e.office.detail('pub')]);
    out.snapshot = await (await fetch(`${base}/api/snapshot`)).text();
    out.agent = await (await fetch(`${base}/api/agents/${encodeURIComponent('priv')}`)).text();
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
    log.warn(`ensaio ${privadoRoot(e)}/${CANARY}.md`);
    out.log = lines.join('\n');

    for (const [where, text] of Object.entries(out)) {
      expect(text, where).not.toContain(CANARY);
      // Nome da sala "PrivadoSintetico" pode aparecer (desenho: mostra o nome do projeto).
      // O path real sob home/Documents não pode.
      expect(text, where).not.toContain(join(e.home, 'Documents', 'PrivadoSintetico'));
      expect(text.toLowerCase(), where).not.toContain('/documents/privadosintetico');
    }
    expect(out.log).toContain('[privado]');
    expect(out.timeline.length).toBeGreaterThan(0);

    const snap = JSON.parse(out.snapshot) as OfficeSnapshot;
    const pub = snap.agents.find((a) => a.id === 'pub')!;
    expect(pub.title).toBe('Agenda publica OK');
    const priv = snap.agents.find((a) => a.id === 'priv')!;
    expect(priv.title).toBeUndefined();
    expect(priv.status).toBe('waiting');
  });

  it('caminho absoluto com canário no transcript contamina (proteção atual)', () => {
    const e = setup();
    main(e, 'c', publicoRoot(e));
    e.office.applyTranscript('c', { title: 'ok', tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } });
    expect(e.office.commit().snapshot.agents[0].title).toBe('ok');
    e.office.addActivity('c', act('c', { detail: join(privadoRoot(e), `${CANARY}.md`) }), true);
    const snap = e.office.commit().snapshot;
    expect(JSON.stringify(snap)).not.toContain(CANARY);
    expect(snap.agents[0].title).toBeUndefined();
  });
});

describe('Q4 gaps conhecidos (reproduzidos; NÃO corrigidos neste ciclo)', () => {
  it('caminho relativo: B3 fecha via segmento de nome (antes gap)', () => {
    const e = setup();
    const cfg = e.qode.config!;
    // Relativo a partir de outra pasta — README já lista como limite.
    expect(mentionsPrivate(cfg, `cat ../../Documents/PrivadoSintetico/${CANARY}.md`)).toBe(true);
  });

  it('variável que não é HOME: B3 fecha via segmento de nome (antes gap)', () => {
    const e = setup();
    const cfg = e.qode.config!;
    // Forma do README: D=~/Documents; cat $D/PrivadoSintetico/… (sem expandir HOME no token).
    expect(mentionsPrivate(cfg, `D=~/Documents; cat $D/PrivadoSintetico/${CANARY}.md`)).toBe(true);
  });

  it('paste sem caminho: título com canário em projeto público NÃO contamina sozinho (gap documentado)', () => {
    const e = setup();
    main(e, 'c', publicoRoot(e));
    e.office.applyTranscript('c', {
      title: `colei ${CANARY} no prompt`,
      tasks: [],
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    });
    const snap = e.office.commit().snapshot;
    // Gap: sem path privado, o canário no título público ainda sai (máscara ≠ isolamento).
    expect(snap.agents[0].title).toContain(CANARY);
  });
});
