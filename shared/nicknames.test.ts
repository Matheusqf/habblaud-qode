import { describe, it, expect } from 'vitest';
import { NICKNAME_POOL, assignNicknames, applyNicknames, canonicalName, nicknamesEnabled, originalNameShown } from './nicknames';
import type { AgentInfo, OfficeSnapshot } from './types';

function sortedEntries(map: Map<string, string>): [string, string][] {
  return Array.from(map.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('NICKNAME_POOL', () => {
  it('has no duplicate names', () => {
    const names = NICKNAME_POOL.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('assignNicknames', () => {
  it('returns the same mapping regardless of input order', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const forward = assignNicknames(ids);
    const backward = assignNicknames([...ids].reverse());

    expect(sortedEntries(forward)).toEqual(sortedEntries(backward));
  });

  it('assigns 200 unique names for 200 ids', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
    const mapping = assignNicknames(ids);
    const names = Array.from(mapping.values());

    expect(mapping.size).toBe(200);
    expect(new Set(names).size).toBe(200);
  });
});

describe('applyNicknames', () => {
  it('keeps id, sets canonicalName, and does not mutate input', () => {
    const snap = {
      agents: [
        { id: 'a', name: 'Alice', look: 'f' },
        { id: 'b', name: 'Bob', look: 'm' },
      ],
    } as unknown as OfficeSnapshot;

    const before = JSON.parse(JSON.stringify(snap)) as OfficeSnapshot;
    const result = applyNicknames(snap);

    expect(snap).toEqual(before);
    expect(result).not.toBe(snap);
    expect(result.agents).not.toBe(snap.agents);

    const first = result.agents[0] as AgentInfo & { canonicalName?: string };
    const second = result.agents[1] as AgentInfo & { canonicalName?: string };

    expect(first.id).toBe('a');
    expect(first.canonicalName).toBe('Alice');
    expect(second.id).toBe('b');
    expect(second.canonicalName).toBe('Bob');
    expect(['f', 'm']).toContain(first.look);
  });
});

describe('opções dos apelidos', () => {
  const store = (v: string | null) => ({ getItem: () => v });
  it('ligado por padrão', () => {
    expect(nicknamesEnabled('', store(null))).toBe(true);
    expect(nicknamesEnabled(undefined, undefined)).toBe(true);
  });
  it('?nicknames=0 desliga', () => {
    expect(nicknamesEnabled('?nicknames=0', store(null))).toBe(false);
    expect(nicknamesEnabled('?nicknames=1', store(null))).toBe(true);
  });
  it("localStorage habblaud:nicknames='0' desliga", () => {
    expect(nicknamesEnabled('', store('0'))).toBe(false);
  });
  it('localStorage que lança: fica no padrão (ligado), e ?nicknames=0 ainda desliga', () => {
    const boom = { getItem: () => { throw new Error('SecurityError'); } };
    expect(nicknamesEnabled('', boom)).toBe(true);
    expect(nicknamesEnabled('?nicknames=0', boom)).toBe(false);
  });
  it('canonicalName/originalNameShown separam nome real do exibido', () => {
    const a = { id: 'x', name: 'Neo', canonicalName: 'Ana' } as unknown as AgentInfo;
    expect(canonicalName(a)).toBe('Ana');
    expect(originalNameShown(a)).toBe('Ana');
    const b = { id: 'y', name: 'Bob' } as unknown as AgentInfo;
    expect(canonicalName(b)).toBe('Bob');
    expect(originalNameShown(b)).toBeUndefined();
  });
});
