import { afterEach, describe, expect, it, vi } from 'vitest';

describe('season=auto não recarrega a página', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('resolve só ao abrir; nenhum reload nem timer, mesmo com a virada do mês', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59));
    const reload = vi.fn();
    vi.stubGlobal('location', { search: '?season=auto', reload });
    const mod = await import('./season');
    expect(mod.currentSeason()).toBe('halloween');
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date(2026, 10, 1, 0, 1));
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(reload).not.toHaveBeenCalled();
    expect('watchAutoSeason' in mod).toBe(false);
  });
});
