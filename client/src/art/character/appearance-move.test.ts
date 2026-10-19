// O sorteio da aparência mora em shared/world/appearance-flat.ts; o módulo do cliente re-exporta as paletas e aplica
// por cima o kit do OpenCode (provider), sem mudar o resultado quando o provider não é opencode.
import { describe, expect, it } from 'vitest';
import * as shared from '../../../../shared/world/appearance-flat';
import { appearanceFromSeed, SKINS } from './appearance';

describe('client/src/art/character/appearance', () => {
  it('re-exporta as cores de pele de shared/world e o sorteio bate sem kit', () => {
    expect(SKINS).toBe(shared.SKINS);
    expect(appearanceFromSeed(42)).toEqual(shared.appearanceFromSeed(42));
    expect(appearanceFromSeed(7, { look: 'f', sub: true })).toEqual(shared.appearanceFromSeed(7, { look: 'f', sub: true }));
  });
});
