import { describe, expect, it } from 'vitest';
import { qodeOpsRoomStatus } from './ops-room-status';

describe('B2 ops-room-status', () => {
  it('sempre unavailable / não ready / OpenCode proposto', () => {
    const st = qodeOpsRoomStatus();
    expect(st.bot).toBe('opencode');
    expect(st.role).toBe('observe-only');
    expect(st.ready).toBe(false);
    expect(st.api).toBe('unavailable');
    expect(st.crossRoom).toBe('denied');
    expect(st.vida).toBe('excluded');
    expect(st.authDependency).toBe('b4-required-for-remote');
    expect(st.note).toMatch(/sem API live/);
  });
});
