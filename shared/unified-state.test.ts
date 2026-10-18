import { describe, expect, it } from 'vitest';
import type { Activity, ActivityKind } from './types';
import { currentFile, UNIFIED_LABEL, UNIFIED_STATES, unifiedState } from './unified-state';

const act = (kind: ActivityKind, extra: Partial<Activity> = {}): Activity => ({ id: 'x', kind, icon: '', text: '', at: 0, ...extra });

describe('unifiedState', () => {
  it('tem os 7 estados com rótulo', () => {
    expect(UNIFIED_STATES.map((s) => UNIFIED_LABEL[s])).toEqual(['Lendo', 'Editando', 'Rodando comando', 'Esperando', 'Erro', 'Feito', 'Inferido (sem estado ao vivo)']);
  });
  it('atividade só inferida (observed) nunca vira Feito, nem ociosa', () => {
    for (const activity of ['active', 'idle', 'unknown'] as const)
      for (const stale of [false, true])
        expect(unifiedState({ status: 'idle', provider: 'opencode', observed: { basis: 'inferred', activity, at: 0, stale } })).toBe('inferred');
    expect(unifiedState({ status: 'idle' })).toBe('done');
    // erro gravado e leitura em dia = Erro; stale volta a inferido
    expect(unifiedState({ status: 'idle', observed: { basis: 'inferred', activity: 'idle', at: 0, stale: false, error: true } })).toBe('error');
    expect(unifiedState({ status: 'idle', observed: { basis: 'inferred', activity: 'unknown', at: 0, stale: true, error: true } })).toBe('inferred');
  });
  it('Claude: mapeia atividade e status', () => {
    expect(unifiedState({ status: 'working', activity: act('read') })).toBe('reading');
    expect(unifiedState({ status: 'working', activity: act('edit') })).toBe('editing');
    expect(unifiedState({ status: 'working', activity: act('run') })).toBe('command');
    expect(unifiedState({ status: 'shell' })).toBe('command');
    expect(unifiedState({ status: 'waiting', activity: act('edit') })).toBe('waiting');
    expect(unifiedState({ status: 'working', activity: act('run', { error: true }) })).toBe('error');
    expect(unifiedState({ status: 'idle', activity: act('done') })).toBe('done');
    expect(unifiedState({ status: 'done' })).toBe('done');
  });
  it('Codex: apply_patch conta como edição', () => {
    expect(unifiedState({ provider: 'codex', status: 'working', activity: act('run', { tool: 'apply_patch' }) })).toBe('editing');
    expect(unifiedState({ provider: 'codex', status: 'working', activity: act('run', { tool: 'exec' }) })).toBe('command');
  });
  it('Cursor: nomes de ferramenta do agente', () => {
    expect(unifiedState({ provider: 'cursor', status: 'working', activity: act('other', { tool: 'edit_file' }) })).toBe('editing');
    expect(unifiedState({ provider: 'cursor', status: 'working', activity: act('other', { tool: 'run_terminal_cmd' }) })).toBe('command');
    expect(unifiedState({ provider: 'cursor', status: 'working', activity: act('other', { tool: 'read_file' }) })).toBe('reading');
    expect(unifiedState({ provider: 'cursor', status: 'waiting' })).toBe('waiting');
  });
  it('fornecedor desconhecido cai no adaptador base', () => {
    expect(unifiedState({ provider: 'outro', status: 'working', activity: act('write') })).toBe('editing');
  });
});

describe('currentFile', () => {
  it('só para leitura/edição, primeira linha', () => {
    expect(currentFile({ activity: act('edit', { detail: 'src/a.ts\nmais' }) })).toBe('src/a.ts');
    expect(currentFile({ activity: act('run', { detail: 'npm test' }) })).toBeNull();
    expect(currentFile({})).toBeNull();
  });
});
