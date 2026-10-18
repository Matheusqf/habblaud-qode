// Partes puras das nuvens de parallax do exterior (presete gather): liga/desliga, posição/deriva e o
// tom pelo relógio de luz. O desenho em si (blit de formas pré-renderizadas) é coberto no navegador.
import { describe, expect, it } from 'vitest';
import { ambientAt } from './daylight';
import { CLOUD_COUNT, CLOUD_VARIANTS, puffBounds, cloudDayAlpha, cloudNightAlpha, cloudsActive, cloudX } from './clouds';

describe('nuvens de parallax (presete gather)', () => {
  it('ligam só no presete gather e desligam com prefers-reduced-motion', () => {
    expect(cloudsActive('gather', false)).toBe(true);
    expect(cloudsActive('gather', true)).toBe(false);
    expect(cloudsActive('classic', false)).toBe(false);
    expect(cloudsActive(undefined, false)).toBe(false);
  });

  it('posição determinística dentro da faixa, derivando devagar para o leste', () => {
    const span = 4000;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const x = cloudX(i, 90_000, span);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(span);
      // 1 s de deriva: sempre para a frente, uma fração pequena da faixa (com enrolamento)
      const step = (cloudX(i, 91_000, span) - x + span) % span;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(span / 20);
    }
    // fases diferentes entre as nuvens
    const at0 = new Set<number>();
    for (let i = 0; i < CLOUD_COUNT; i++) at0.add(Math.round(cloudX(i, 0, span)));
    expect(at0.size).toBeGreaterThan(1);
  });

  it('tom pelo relógio de luz: clara de dia, escura e mais apagada de noite', () => {
    const noon = ambientAt(13);
    const dusk = ambientAt(18.6);
    const night = ambientAt(23);
    expect(noon.night).toBe(0);
    expect(cloudDayAlpha(noon.night)).toBeGreaterThan(0.4);
    expect(cloudNightAlpha(noon.night)).toBe(0);
    expect(dusk.night).toBeGreaterThan(0);
    expect(dusk.night).toBeLessThan(1);
    // crepúsculo: crossfade — as duas nuvens (clara e escura) no ar
    expect(cloudDayAlpha(dusk.night)).toBeGreaterThan(0);
    expect(cloudNightAlpha(dusk.night)).toBeGreaterThan(0);
    expect(night.night).toBeGreaterThanOrEqual(0.99);
    expect(cloudDayAlpha(night.night)).toBe(0);
    expect(cloudNightAlpha(night.night)).toBeGreaterThan(0);
    // de noite fica mais apagada que de dia
    expect(cloudDayAlpha(night.night) + cloudNightAlpha(night.night)).toBeLessThan(cloudDayAlpha(noon.night) + cloudNightAlpha(noon.night));
    // cresce/decresce com o nível de noite
    expect(cloudNightAlpha(dusk.night)).toBeLessThan(cloudNightAlpha(night.night));
    expect(cloudDayAlpha(dusk.night)).toBeLessThan(cloudDayAlpha(noon.night));
  });
});

describe('nuvens: caixa dos puffs (sem corte)', () => {
  it('cada variante cabe inteira no canvas, incluindo cy−r e cx−r negativos', () => {
    for (const puffs of CLOUD_VARIANTS) {
      const b = puffBounds(puffs);
      for (const [x, y, r] of puffs) {
        expect(x - r + b.dx).toBeGreaterThanOrEqual(0);
        expect(y - r + b.dy).toBeGreaterThanOrEqual(0);
        expect(x + r + b.dx).toBeLessThanOrEqual(b.w);
        expect(y + r + 1 + b.dy).toBeLessThanOrEqual(b.h);
      }
    }
    expect(CLOUD_VARIANTS.some((p) => p.some(([, y, r]) => y - r < 0))).toBe(true);
  });
});
