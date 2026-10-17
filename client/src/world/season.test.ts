import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOfficePreset } from './season';

describe('presete do escritório (?office=)', () => {
  it('o parâmetro vale sobre o da build; sem ele, o fallback; desconhecido ignora', () => {
    expect(resolveOfficePreset('?office=gather', undefined)).toBe('gather');
    expect(resolveOfficePreset('?office=classic', 'gather')).toBe('classic');
    expect(resolveOfficePreset('', 'gather')).toBe('gather');
    expect(resolveOfficePreset('', undefined)).toBeUndefined();
    expect(resolveOfficePreset('?office=outra', 'gather')).toBe('gather');
    expect(resolveOfficePreset('?rooms=gather', 'classic')).toBe('classic');
  });
});

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
