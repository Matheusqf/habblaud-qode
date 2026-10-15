// Q3 + B1: origem/capacidade explícitas — Manual≠live; floating-flow observe-only.
import { describe, expect, it } from 'vitest';
import { hasMisleadingLive, qodeCapabilities, floatingFlowCapability } from './capabilities';
import type { SourceInfo } from '../../shared/types';
import type { OrchestrateStatus } from './orchestrate-status';

const flowDown: OrchestrateStatus = {
  coordinator: 'floating-flow',
  role: 'observe-only',
  ready: false,
  note: 'down',
};
const flowUp: OrchestrateStatus = {
  coordinator: 'floating-flow',
  role: 'observe-only',
  ready: true,
  root: '/tmp/dev-flow',
  note: 'up',
};

describe('Q3 capabilities', () => {
  it('catálogo inclui Manual, OpenCode, Cursor e floating-flow com origem correta', () => {
    const caps = qodeCapabilities({ orchestrate: flowDown });
    const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(byId['manual-registry'].origin).toBe('manual');
    expect(byId['manual-registry'].capabilities).toEqual([]);
    expect(byId.opencode.origin).toBe('unavailable');
    expect(byId.opencode.capabilities).toEqual([]);
    expect(byId.cursor.origin).toBe('unavailable');
    expect(byId.cursor.capabilities).toEqual([]);
    expect(byId['floating-flow'].origin).toBe('unavailable');
    expect(byId['floating-flow'].capabilities).toEqual([]);
    // Sem SourceInfo: Claude/Codex ficam unknown (não fingem live).
    expect(byId.claude.origin).toBe('unknown');
    expect(byId.codex.origin).toBe('unknown');
    expect(hasMisleadingLive(caps)).toBe(false);
  });

  it('Claude/Codex ok → live; floating-flow ready → manual+observe (nunca live)', () => {
    const connected: SourceInfo[] = [
      { label: '.claude', path: '/x', sessions: 1, ok: true },
      { label: '.codex', provider: 'codex', path: '/y', sessions: 0, ok: false, error: 'sem pasta' },
    ];
    const caps = qodeCapabilities({ connected, orchestrate: flowUp });
    const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(byId.claude.origin).toBe('live');
    expect(byId.codex.origin).toBe('unknown');
    expect(byId.opencode.origin).toBe('unavailable');
    expect(byId.cursor.origin).toBe('unavailable');
    expect(byId['manual-registry'].origin).toBe('manual');
    expect(byId['floating-flow'].origin).toBe('manual');
    expect(byId['floating-flow'].capabilities).toEqual(['observe']);
    expect(hasMisleadingLive(caps)).toBe(false);
  });

  it('floatingFlowCapability: root sem ready → unknown; sem root → unavailable', () => {
    expect(floatingFlowCapability({ ...flowDown, root: '/missing' }).origin).toBe('unknown');
    expect(floatingFlowCapability(flowDown).origin).toBe('unavailable');
  });

  it('health do setup ausente inclui capabilities + orchestrate', async () => {
    const { setupQode } = await import('./index');
    const { RoomAliases } = await import('../model/room-aliases');
    const qode = setupQode({
      env: {},
      dataDir: '/tmp/habblaud-qode-caps-ausente-nao-existe',
      home: '/tmp',
      roomAliases: new RoomAliases(null),
      office: () => {
        throw new Error('office não deve ser chamado sem config');
      },
    });
    const h = qode.health();
    expect(h.config).toBe('ausente');
    expect(h.capabilities.find((c) => c.id === 'opencode')?.origin).toBe('unavailable');
    expect(h.capabilities.find((c) => c.id === 'manual-registry')?.origin).toBe('manual');
    expect(h.capabilities.find((c) => c.id === 'floating-flow')).toBeTruthy();
    expect(h.orchestrate.coordinator).toBe('floating-flow');
    expect(h.orchestrate.role).toBe('observe-only');
    expect(h.orchestrate.ready).toBe(false);
  });
});
