import { describe, it, expect } from 'vitest';
import { NICKNAME_POOL, assignNicknames, applyNicknames } from './nicknames';
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
  it('keeps id, sets realName, and does not mutate input', () => {
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

    const first = result.agents[0] as AgentInfo & { realName?: string };
    const second = result.agents[1] as AgentInfo & { realName?: string };

    expect(first.id).toBe('a');
    expect(first.realName).toBe('Alice');
    expect(second.id).toBe('b');
    expect(second.realName).toBe('Bob');
    expect(['f', 'm']).toContain(first.look);
  });
});
