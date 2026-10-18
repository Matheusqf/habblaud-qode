import { describe, expect, it } from 'vitest';
import { resolveVibe, vibeForActivity, vibeForMode } from './vibe';
import { areaFor, parseAreas } from '../../../../shared/areas';

describe('vibe (animações de estado)', () => {
  it('erro = tombo, fim do principal = confete, espera = café', () => {
    expect(vibeForActivity('error', true)).toBe('tumble');
    expect(vibeForActivity('error', false)).toBe('tumble');
    expect(vibeForActivity('done', true)).toBe('confetti');
    expect(vibeForActivity('done', false)).toBeNull();
    expect(vibeForActivity('edit', true)).toBeNull();
    expect(vibeForMode('work', 'wait')).toBe('coffee');
    expect(vibeForMode('wait', 'wait')).toBeNull();
    expect(vibeForMode('wait', 'work')).toBeNull();
  });
  it('opt-in: desligado por padrão; URL tem precedência sobre o build', () => {
    expect(resolveVibe('')).toBe(false);
    expect(resolveVibe('?fx=vibe')).toBe(true);
    expect(resolveVibe('', 'vibe')).toBe(true);
    expect(resolveVibe('?fx=off', 'vibe')).toBe(false);
  });
});

describe('areas por projeto', () => {
  const areas = parseAreas(JSON.stringify([
    { name: 'Singolo', paths: ['/home/m/qode/singolo', '~/x/singolo-api'] },
    { name: 'QODE', paths: ['/home/m/qode'] },
    { name: '', paths: ['/bad'] },
    { name: 'SemPaths', paths: [] },
    'lixo',
  ]));
  it('ignora entradas inválidas e JSON quebrado', () => {
    expect(areas.map((a) => a.name)).toEqual(['Singolo', 'QODE']);
    expect(parseAreas('{')).toEqual([]);
    expect(parseAreas(undefined)).toEqual([]);
  });
  it('prefixo mais longo, respeitando fronteira de pasta, ~ e barras', () => {
    expect(areaFor('/home/m/qode/singolo/web', areas)?.name).toBe('Singolo');
    expect(areaFor('/home/m/qode/clinicas', areas)?.name).toBe('QODE');
    expect(areaFor('/home/m/qode-other', areas)).toBeUndefined();
    expect(areaFor('/home/m/x/singolo-api/', areas, '/home/m')?.name).toBe('Singolo');
    expect(areaFor('C:\\home\\m\\qode\\singolo', parseAreas(JSON.stringify([{ name: 'W', paths: ['C:/home/m/qode'] }])))?.name).toBe('W');
  });
});
