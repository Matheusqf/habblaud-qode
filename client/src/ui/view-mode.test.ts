import { describe, expect, it, vi } from 'vitest';
import { applyViewMode, resolveViewMode } from './view-mode';

describe('resolveViewMode', () => {
  it('padrão é normal', () => expect(resolveViewMode('')).toBe('normal'));
  it('kiosk por view=kiosk, view=tv ou kiosk=1', () => {
    expect(resolveViewMode('?view=kiosk')).toBe('kiosk');
    expect(resolveViewMode('?view=TV')).toBe('kiosk');
    expect(resolveViewMode('?kiosk=1')).toBe('kiosk');
  });
  it('mobile forçado', () => expect(resolveViewMode('?view=mobile')).toBe('mobile'));
  it('valor desconhecido cai no normal', () => expect(resolveViewMode('?view=xyz')).toBe('normal'));
});

describe('applyViewMode', () => {
  function fakeDoc() {
    const cls = new Set<string>();
    const listeners: Record<string, () => void> = {};
    return {
      cls,
      listeners,
      doc: {
        documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)), add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) } },
        addEventListener: (n: string, f: () => void) => (listeners[n] = f),
      } as unknown as Document,
    };
  }
  it('kiosk liga a classe e esconde o cursor parado', () => {
    vi.useFakeTimers();
    const f = fakeDoc();
    expect(applyViewMode(f.doc, '?view=kiosk', 1000)).toBe('kiosk');
    expect(f.cls.has('qode-kiosk')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(f.cls.has('qode-cursor-hidden')).toBe(true);
    f.listeners.pointermove!();
    expect(f.cls.has('qode-cursor-hidden')).toBe(false);
    vi.useRealTimers();
  });
  it('normal não liga nada', () => {
    const f = fakeDoc();
    applyViewMode(f.doc, '');
    expect(f.cls.size).toBe(0);
  });
});
