// Decoração da marca no pacote de tema: schema de `decor`, padrão neutro sem decoração e busca por nome de sala.
import { describe, expect, it } from 'vitest';
import { DECOR_ROOMS_MAX, HABBLAUD_PACK, QODE_PACK, decorForRoom, validateThemePack } from './theme-packs';

const base = { ...HABBLAUD_PACK, id: 'acme', name: 'Acme' };

describe('decor do pacote de tema', () => {
  it('o neutro não tem decoração; o qode decora o núcleo e a sala WorkToDo', () => {
    expect(validateThemePack(HABBLAUD_PACK)?.decor).toBeUndefined();
    const q = validateThemePack(QODE_PACK)!;
    expect(q.decor?.core).toBe('qode');
    expect(decorForRoom(q.decor, 'WorkToDo')).toBe('worktodo');
    expect(decorForRoom(q.decor, '  QODE Office ')).toBe('qode');
    expect(decorForRoom(q.decor, 'Clínicas')).toBeUndefined();
    expect(decorForRoom(q.decor, 'constructor')).toBeUndefined();
    expect(decorForRoom(q.decor, '__proto__')).toBeUndefined();
    expect(decorForRoom(undefined, 'worktodo')).toBeUndefined();
  });

  it('aceita decor válido em JSON', () => {
    const p = validateThemePack({ ...base, decor: { core: 'worktodo', rooms: { 'meu app': 'qode' } } });
    expect(p?.decor?.core).toBe('worktodo');
    expect(decorForRoom(p?.decor, 'Meu App')).toBe('qode');
  });

  it.each([
    ['não objeto', 'qode'],
    ['chave desconhecida', { lobby: 'qode' }],
    ['conjunto desconhecido no núcleo', { core: 'gather' }],
    ['conjunto desconhecido na sala', { rooms: { a: 'x' } }],
    ['nome com maiúsculas', { rooms: { WorkToDo: 'worktodo' } }],
    ['nome vazio', { rooms: { '': 'qode' } }],
    ['nome longo demais', { rooms: { ['a'.repeat(61)]: 'qode' } }],
    ['rooms em lista', { rooms: ['qode'] }],
    ['salas demais', { rooms: Object.fromEntries(Array.from({ length: DECOR_ROOMS_MAX + 1 }, (_, i) => [`s${i}`, 'qode'])) }],
  ])('recusa o pacote com decor inválido (%s)', (_label, decor) => {
    expect(validateThemePack({ ...base, decor })).toBeUndefined();
  });

  it('nomes herdados do Object.prototype não resolvem num pacote JSON', () => {
    const p = validateThemePack(JSON.parse('{"id":"acme","name":"A","brand":{"text":"A","logo":""},"palette":{"--ui-accent":"#fff"},"fonts":{"body":"Arial","brand":"Arial"},"nicknames":true,"seasonal":true,"decor":{"rooms":{"__proto__":"qode"}}}'));
    expect(p).toBeDefined();
    expect(decorForRoom(p!.decor, 'toString')).toBeUndefined();
    expect(decorForRoom(p!.decor, '__proto__')).toBe('qode');
  });
});
