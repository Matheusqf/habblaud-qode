// Item 1 (balão de atenção + som opcional): já existia no upstream; este teste trava o contrato.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from './prefs';
import { CATEGORY_OF } from '../audio/scheduler';

describe('atenção', () => {
  it('som desligado por padrão; o sino de "precisa de você" é da categoria avisos', () => {
    expect(DEFAULT_PREFS.sound).toBe(false);
    expect(CATEGORY_OF.chime).toBe('alerts');
  });
});
