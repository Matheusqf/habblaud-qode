// Painel do monitor da mesa (PR2): modelo puro. O painel é SÓ LEITURA — sem aprovar/recusar/
// responder/terminal (caminho da gaveta, intocado). Aqui: mesa livre, resolução por id, saída do
// agente, sem botões de ação e Esc devolvendo o foco ao canvas.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, Activity, PermissionRequestInfo } from '../../../shared/types';
import { UNIFIED_LABEL } from '../../../shared/unified-state';
import { DESK_PARTS, DESK_PANEL_CLOSED, deskClick, deskClose, deskPanelAgent, deskPanelView } from './desk-panel-model';

const act = (o: Partial<Activity> = {}): Activity => ({ id: 'a1', at: 0, kind: 'read', icon: '📖', text: 'Lendo cliente/src/main.ts', ...o });

const ag = (id: string, o: Partial<AgentInfo> = {}): AgentInfo =>
  ({
    id,
    kind: 'main',
    roomId: 'r1',
    name: id === 'm' ? 'Marina' : id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    seed: 1,
    stats: { toolCalls: 3, tokensIn: 1234, tokensOut: 567, subagents: 0, costUSD: 0.42 },
    activity: act(),
    model: 'claude-opus-4-6',
    ...o,
  }) as AgentInfo;

const perm = (o: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo => ({ id: 'p1', tool: 'Bash', title: 'Bash(npm test)', text: 'Rodar testes', icon: '💻', createdAt: 0, expiresAt: 60_000, ...o });

describe('ciclo de vida (puro)', () => {
  it('mesa livre: clique não abre painel, só a dica "Mesa livre" no ponto', () => {
    const r = deskClick(DESK_PANEL_CLOSED, null);
    expect(r.state).toEqual({ open: false, agentId: null });
    expect(r.effect.tooltip).toBe('Mesa livre');
    expect(r.effect.focus).toBeNull();
    // com painel aberto, mesa livre também fecha e devolve o foco ao canvas
    const open = deskClick({ open: true, agentId: 'm' }, 'm');
    const empty = deskClick(open.state, null);
    expect(empty.state).toEqual(DESK_PANEL_CLOSED);
    expect(empty.effect).toEqual({ focus: 'canvas', tooltip: 'Mesa livre' });
  });

  it('abre no agente sentado, resolvido por id (trocar de mesa não troca o agente mostrado)', () => {
    const r = deskClick(DESK_PANEL_CLOSED, 'm');
    expect(r.state).toEqual({ open: true, agentId: 'm' });
    expect(r.effect).toEqual({ focus: null, tooltip: null });
    // outro clique noutro monitor troca de agente; no mesmo, segue
    expect(deskClick(r.state, 'b').state).toEqual({ open: true, agentId: 'b' });
    expect(deskClick(r.state, 'm').state).toEqual({ open: true, agentId: 'm' });
    // resolve pelo id no snapshot, mesmo que ele tenha mudado de sala/mesa
    const moved = ag('m', { roomId: 'r2' });
    expect(deskPanelAgent(r.state, [moved])?.roomId).toBe('r2');
  });

  it('agente sai do escritório: resolução por id não acha mais, o painel fecha', () => {
    const open = deskClick(DESK_PANEL_CLOSED, 'm').state;
    expect(deskPanelAgent(open, [ag('m'), ag('b')])?.id).toBe('m');
    expect(deskPanelAgent(open, [ag('b')])).toBeNull();
    expect(deskPanelAgent(open, [])).toBeNull();
    expect(deskPanelAgent(DESK_PANEL_CLOSED, [ag('m')])).toBeNull();
  });

  it('Esc fecha o painel aberto e devolve o foco ao canvas; fechado, não faz nada', () => {
    const open = deskClick(DESK_PANEL_CLOSED, 'm').state;
    expect(deskClose(open)).toEqual({ state: DESK_PANEL_CLOSED, effect: { focus: 'canvas', tooltip: null } });
    expect(deskClose(DESK_PANEL_CLOSED)).toEqual({ state: DESK_PANEL_CLOSED, effect: { focus: null, tooltip: null } });
  });
});

describe('vista só leitura', () => {
  it('só estado, modelo, ficheiro atual, atividade e tokens/custo (auxiliares existentes)', () => {
    const v = deskPanelView(ag('m', { activity: act({ kind: 'edit', detail: 'client/src/ui/drawer.ts\n+2 −1', text: 'Editando client/src/ui/drawer.ts' }) }));
    expect(v.name).toBe('Marina');
    expect(v.state).toBe('editing');
    expect(v.rows).toEqual({
      state: `✏️ ${UNIFIED_LABEL.editing}`,
      model: 'Opus 4.6',
      file: 'client/src/ui/drawer.ts',
      activity: 'Editando client/src/ui/drawer.ts',
      tokens: '1,2 k entrada + 567 saída',
      cost: 'US$ 0,42',
    });
    // sem ficheiro e sem custo: linha some / indisponível
    const bare = deskPanelView(ag('b', { model: undefined, activity: undefined, stats: { toolCalls: 0, tokensIn: 10, tokensOut: 5, subagents: 0 } }));
    expect(bare.rows.file).toBeNull();
    expect(bare.rows.activity).toBe('Trabalhando…');
    expect(bare.rows.cost).toBe('indisponível');
    expect(bare.rows.model).toBe('—');
  });

  it('espera com pedido pendente mostra o motivo no status', () => {
    const a = ag('m', { status: 'waiting', waitingFor: 'aprovar uma permissão', permission: perm(), activity: act({ kind: 'ask' }) });
    const v = deskPanelView(a);
    expect(v.statusText).toBe('Precisa de você: aprovar uma permissão');
    expect(v.state).toBe('waiting');
  });
});

describe('sem botões de ação (só leitura)', () => {
  // Nenhum botão com aprovar/recusar/responder/terminal: o componente materializa exatamente
  // DESK_PARTS (um único botão, o de fechar) e só troca TEXTO com a vista.
  const forbidden = /aprovar|recusar|responder|terminal/i;

  it('as peças têm um único botão (Fechar) e nenhum rótulo de ação', () => {
    const buttons = DESK_PARTS.filter((p) => p.kind === 'close');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.label).toBe('Fechar (Esc)');
    for (const part of DESK_PARTS) {
      if (part.kind === 'close' || part.kind === 'readonly') expect(forbidden.test(part.label)).toBe(false);
    }
    // nenhuma peça é de ação: fora o fechar, só título, selo, papel, status e linhas
    expect(DESK_PARTS.filter((p) => p.kind !== 'close').map((p) => p.kind)).toEqual(['title', 'readonly', 'role', 'status', 'row', 'row', 'row', 'row', 'row', 'row']);
  });

  it('a vista só descreve textos (dados) de estado/atividade/uso: nada a clicar, nenhum rótulo de ação', () => {
    const v = deskPanelView(ag('m', { activity: act({ kind: 'run', text: 'Rodando comando no terminal' }) }));
    // textos livres (podem citar o terminal: são dados da atividade, não botões)
    expect(v.rows.activity).toBe('Rodando comando no terminal');
    // rótulos fixos das linhas: sem ação
    const labels = DESK_PARTS.filter((p) => p.kind === 'row').map((p) => p.label);
    expect(labels).toEqual(['Estado', 'Modelo', 'Ficheiro atual', 'Atividade', 'Tokens', 'Custo estimado']);
    expect(labels.some((l) => forbidden.test(l))).toBe(false);
  });
});
