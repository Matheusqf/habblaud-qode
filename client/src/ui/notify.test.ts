// Som de novo pedido de permissão: JÁ EXISTE pelo aviso de alerta que o servidor emite UMA vez ao
// registrar cada pedido (server/permissions/registry.ts -> Office.noticePermission -> Notice nível
// 'alert' -> SSE 'notice' -> Notifier -> SoundBoard.play('chime'), categoria "Avisos"; toca até com a
// aba oculta). Não adicionamos um som duplicado: estes testes travam o comportamento existente —
// desligado por padrão (o interruptor geral de sons, prefs.sound, vem false; a categoria "Avisos"
// desliga só o sino/estalo), um toque por aviso, e aprovar/recusar um pedido (que só gera atividade no
// feed, nunca aviso) não toca nada.
import { describe, expect, it } from 'vitest';
import type { Notice } from '../../../shared/types';
import type { SoundBoard } from '../audio/board';
import { DEFAULT_SOUND_SETTINGS, SoundScheduler } from '../audio/scheduler';
import type { UiContext } from './context';
import { Notifier } from './notify';
import { DEFAULT_PREFS } from './prefs';

/** Contexto mínimo: captura o manipulador de 'notice' que o Notifier registra no store. */
function fakeCtx() {
  const handlers: ((n: Notice) => void)[] = [];
  const ctx = { prefs: DEFAULT_PREFS, store: { on: (_ev: string, fn: (n: Notice) => void) => void handlers.push(fn) } };
  return { ctx: ctx as unknown as UiContext, emit: (n: Notice) => handlers.forEach((h) => h(n)) };
}

/** Mesa de som falsa que só registra o que pediriam para tocar. */
function fakeBoard() {
  const played: string[] = [];
  const board = { play: (kind: string) => (played.push(kind), true) };
  return { board: board as unknown as SoundBoard, played };
}

describe('som de novo pedido de permissão (o chime de aviso que já existe)', () => {
  it('aviso de alerta (novo pedido) pede o sino; conclusão pede o estalo; o resto não pede nada', () => {
    const { ctx, emit } = fakeCtx();
    const { board, played } = fakeBoard();
    new Notifier(ctx, board);
    emit({ id: 'n1', level: 'alert', text: '🔐 Marina pede permissão em loja: Bash(npm test)', at: 0 });
    expect(played).toEqual(['chime']);
    emit({ id: 'n2', level: 'success', text: '✅ Marina concluiu em loja', at: 1 });
    expect(played).toEqual(['chime', 'pop']);
    // aprovar/recusar (e tudo mais que não é aviso) nunca passa por aqui: sem som
    emit({ id: 'n3', level: 'info', text: '🏗️ Nova sala: loja', at: 2 });
    emit({ id: 'n4', level: 'warn', text: '❌ shell falhou em loja', at: 3 });
    expect(played).toEqual(['chime', 'pop']);
  });

  it('desligado por padrão: com as preferências padrão o sino do pedido não sai da mesa', () => {
    expect(DEFAULT_PREFS.sound).toBe(false);
    const s = new SoundScheduler();
    s.configure(DEFAULT_PREFS.sound, DEFAULT_PREFS.sounds);
    expect(s.decide('chime', 1_000)).toBeNull();
    // depois que o usuário liga os sons, o mesmo aviso toca — uma vez (o canal de avisos tem intervalo)
    s.configure(true, DEFAULT_PREFS.sounds);
    expect(s.decide('chime', 2_000)).not.toBeNull();
    expect(s.decide('chime', 2_050)).toBeNull();
    // e a categoria "Avisos" desliga o sino sem mexer no resto
    s.configure(true, { ...DEFAULT_SOUND_SETTINGS, alerts: false });
    expect(s.decide('chime', 9_000)).toBeNull();
  });
});
