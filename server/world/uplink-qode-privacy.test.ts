// World ligado + política QODE: a projeção do uplink não pode contar tarefas concluídas de agentes privados.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectWithReport } from '../../shared/world/projection';
import { VISIBILITY_DEFAULTS } from '../../shared/world/protocol';
import { isDemoId } from '../../shared/timeline';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { setupQode } from '../qode/index';
import { tempDir } from '../test/fixtures';
import { WorldIds } from './ids';
import { AgentSignals } from './signals';
import { resolveWorldTheme } from './theme';

const EXAMPLE = resolve(import.meta.dirname, '../../qode/qode.config.example.json');
const SENT = 'CANARIO-WORLD-TASKS-8c0d';
const NOW = 1_790_000_000_000;

describe('World uplink + privacidade QODE', () => {
  it('opt-in do World não projeta tasksDone de agente privado', () => {
    const tmp = tempDir('qode-world-');
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
      roomOf: qode.roomOf,
      privacy: qode.privacy,
    });
    office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's-priv', cwd: vida, role: 'Agente principal', startedAt: NOW, status: 'working' });
    office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's-pub', cwd: clinicas, role: 'Agente principal', startedAt: NOW, status: 'idle' });
    office.applyTranscript('.claude:1', {
      title: SENT,
      tasks: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: `${SENT}-${i}`, status: 'completed' as const })),
      stats: { toolCalls: 6, tokensIn: 0, tokensOut: 0, subagents: 0 },
    });
    office.applyTranscript('.claude:2', {
      title: 'Agenda',
      tasks: [{ id: 'p1', title: 'Público', status: 'completed' }],
      stats: { toolCalls: 1, tokensIn: 0, tokensOut: 0, subagents: 0 },
    });

    expect(qode.privacy!.isPrivate('.claude:1')).toBe(true);
    expect(qode.privacy!.isPrivate('.claude:2')).toBe(false);

    // Mesma composição que BuildingUplink.flush após a projeção QODE: officeView (máscara) e depois o filtro demo.
    const agents = qode.officeView(office).list().filter((a) => !isDemoId(a.id));
    const rooms = [...new Set(agents.map((a) => a.roomId))].map((id) => ({ id }));
    const signals = new AgentSignals(() => '2026-10-19').observe(agents, NOW);
    const r = projectWithReport(
      {
        rooms,
        agents,
        theme: resolveWorldTheme('none', new Date(NOW)),
        version: 't',
        options: { compactions: false, tokensVisible: false },
        tasksToday: signals.tasksToday,
        previousNames: new Map(),
      },
      new WorldIds(),
      NOW,
    );
    const dump = JSON.stringify(r.uplink);
    expect(dump).not.toContain(SENT);
    expect(dump.toLowerCase()).not.toContain('documents/vida');
    const privSignals = signals.tasksToday.get('.claude:1') ?? 0;
    expect(privSignals, 'signals não conta tarefas privadas').toBe(0);
    const floors = r.uplink.floors.flatMap((f) => f.agents);
    expect(floors.every((a) => (a.tasksDone ?? 0) <= 1)).toBe(true);
    expect(visibilitySafe(r.uplink, SENT)).toBe(true);
    void VISIBILITY_DEFAULTS;
    tmp.cleanup();
  });
});

function visibilitySafe(uplink: { floors: Array<{ agents: Array<{ tasksDone?: number }> }> }, canary: string): boolean {
  return !JSON.stringify(uplink).includes(canary);
}
