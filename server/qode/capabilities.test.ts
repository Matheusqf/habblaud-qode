// Q3 + B2: origem/capacidade explícitas — Manual≠live; ops-room unavailable.
import { describe, expect, it } from 'vitest';
import { hasMisleadingLive, opsRoomCapability, qodeCapabilities } from './capabilities';
import type { SourceInfo } from '../../shared/types';

describe('Q3 capabilities', () => {
  it('catálogo inclui Manual, OpenCode, Cursor e ops-room com origem correta', () => {
    const caps = qodeCapabilities();
    const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(byId['manual-registry'].origin).toBe('manual');
    expect(byId['manual-registry'].capabilities).toEqual([]);
    expect(byId.opencode.origin).toBe('unavailable');
    expect(byId.opencode.capabilities).toEqual([]);
    expect(byId.cursor.origin).toBe('unavailable');
    expect(byId.cursor.capabilities).toEqual([]);
    expect(byId['ops-room'].origin).toBe('unavailable');
    expect(byId['ops-room'].capabilities).toEqual([]);
    // Sem SourceInfo: Claude/Codex ficam unknown (não fingem live).
    expect(byId.claude.origin).toBe('unknown');
    expect(byId.codex.origin).toBe('unknown');
    expect(hasMisleadingLive(caps)).toBe(false);
  });

  it('Claude/Codex ok → live; OpenCode/Cursor/ops-room nunca live', () => {
    const connected: SourceInfo[] = [
      { label: '.claude', path: '/x', sessions: 1, ok: true },
      { label: '.codex', provider: 'codex', path: '/y', sessions: 0, ok: false, error: 'sem pasta' },
    ];
    const caps = qodeCapabilities(connected);
    const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(byId.claude.origin).toBe('live');
    expect(byId.codex.origin).toBe('unknown');
    expect(byId.opencode.origin).toBe('unavailable');
    expect(byId.cursor.origin).toBe('unavailable');
    expect(byId['ops-room'].origin).toBe('unavailable');
    expect(byId['manual-registry'].origin).toBe('manual');
    expect(hasMisleadingLive(caps)).toBe(false);
  });

  it('opsRoomCapability nunca live', () => {
    const c = opsRoomCapability();
    expect(c.id).toBe('ops-room');
    expect(c.origin).toBe('unavailable');
    expect(c.capabilities).toEqual([]);
  });

  it('health do setup ausente inclui capabilities + opsRoom', async () => {
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
    expect(h.capabilities.find((c) => c.id === 'ops-room')?.origin).toBe('unavailable');
    expect(h.opsRoom.bot).toBe('opencode');
    expect(h.opsRoom.ready).toBe(false);
    expect(h.opsRoom.api).toBe('unavailable');
    expect(h.opsRoom.vida).toBe('excluded');
  });
});
