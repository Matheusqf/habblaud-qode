// Padrões de cenário do pacote de tema em client/src/world/season.ts: cadeia URL > var de build >
// pacote, com os parâmetros explícitos sempre no comando.
import { describe, expect, it } from 'vitest';
import { resolveGardenWithPack, resolveOfficePresetWithPack, resolveRoomStyleWithPack, resolveSeason } from './season';

const QODE_SCENERY = { office: 'gather' as const, rooms: 'openspace' as const, garden: 'river' as const, fx: 'off' as const };
const NEUTRAL = {};

describe('office: cadeia completa', () => {
  it('URL > build > pacote', () => {
    expect(resolveOfficePresetWithPack('?office=classic', 'gather', QODE_SCENERY.office)).toBe('classic');
    expect(resolveOfficePresetWithPack('', 'gather', QODE_SCENERY.office)).toBe('gather');
    expect(resolveOfficePresetWithPack('', undefined, QODE_SCENERY.office)).toBe('gather');
    expect(resolveOfficePresetWithPack('', undefined, undefined)).toBeUndefined();
  });
});

describe('rooms: cadeia completa', () => {
  it('?rooms= vence tudo; var de build vence o pacote; sem nada, o padrão do pacote', () => {
    expect(resolveRoomStyleWithPack('?rooms=island', 'gather', QODE_SCENERY)).toBe('island');
    expect(resolveRoomStyleWithPack('', 'classic', QODE_SCENERY)).toBeUndefined();
    expect(resolveRoomStyleWithPack('', undefined, QODE_SCENERY)).toBe('openspace');
    expect(resolveRoomStyleWithPack('', undefined, NEUTRAL)).toBeUndefined();
    expect(resolveRoomStyleWithPack('?office=gather', undefined, NEUTRAL)).toBe('openspace');
  });
});

describe('garden: cadeia completa', () => {
  it('?garden= vence; var de build vence o pacote; office classic do pacote desliga o rio', () => {
    expect(resolveGardenWithPack('?garden=off', undefined, QODE_SCENERY)).toBeUndefined();
    expect(resolveGardenWithPack('', undefined, QODE_SCENERY)).toBe('river');
    expect(resolveGardenWithPack('', undefined, { ...QODE_SCENERY, garden: undefined })).toBe('river');
    expect(resolveGardenWithPack('', undefined, { office: 'classic' })).toBeUndefined();
    expect(resolveGardenWithPack('', undefined, NEUTRAL)).toBeUndefined();
    expect(resolveGardenWithPack('?office=gather', undefined, NEUTRAL)).toBe('river');
    expect(resolveGardenWithPack('', 'gather', { office: 'classic' })).toBe('river');
    expect(resolveGardenWithPack('', 'classic', QODE_SCENERY)).toBeUndefined();
  });
});

describe('season: toggle sazonal do pacote', () => {
  const october = new Date(2026, 9, 15);

  it('seasonal=false desliga o auto; ?season=halloween|off vale sempre', () => {
    expect(resolveSeason('', october, false)).toBeUndefined();
    expect(resolveSeason('?season=halloween', october, false)).toBe('halloween');
    expect(resolveSeason('?season=off', october, true)).toBeUndefined();
    expect(resolveSeason('', october, true)).toBe('halloween');
    expect(resolveSeason('', new Date(2026, 10, 1), true)).toBeUndefined();
  });
});

describe('?office= explícito vence rooms/garden do pacote', () => {
  const qode = { rooms: 'openspace' as const, office: 'gather' as const, garden: 'river' as const };
  it('?office=classic com pacote gather → sem openspace e sem rio', () => {
    expect(resolveRoomStyleWithPack('?office=classic', undefined, qode)).toBeUndefined();
    expect(resolveGardenWithPack('?office=classic', undefined, qode)).toBeUndefined();
  });
  it('?office=gather com pacote neutro → openspace + rio; ?rooms=/?garden= continuam a vencer', () => {
    expect(resolveRoomStyleWithPack('?office=gather', undefined, {})).toBe('openspace');
    expect(resolveGardenWithPack('?office=gather', undefined, {})).toBe('river');
    expect(resolveRoomStyleWithPack('?office=classic&rooms=island', undefined, qode)).toBe('island');
    expect(resolveGardenWithPack('?office=classic&garden=river', undefined, qode)).toBe('river');
  });
});

describe('garden off do pacote', () => {
  it('não é reativado pelo preset gather do pacote; ?garden=river ainda liga', () => {
    expect(resolveGardenWithPack('', undefined, { garden: 'off', office: 'gather' })).toBeUndefined();
    expect(resolveGardenWithPack('?garden=river', undefined, { garden: 'off', office: 'gather' })).toBe('river');
  });
});
