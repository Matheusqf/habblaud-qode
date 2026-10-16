// Painel do monitor da mesa (PR2): diálogo SÓ LEITURA de quem está sentado na mesa clicada. Abre
// pelo clique no monitor (world.onDeskClick, resolvido por id no estado das mesas); Esc (ou o
// botão Fechar) fecha e devolve o foco ao canvas. Sem botões de ação e sem atalhos de resposta:
// aprovar/recusar/responder/terminal continuam só na gaveta do agente (drawer.ts), que segue
// operacional e intocada. Todo o conteúdo vem do modelo puro (desk-panel-model.ts).
import type { UiComponent, UiContext } from './context';
import {
  DESK_PARTS,
  DESK_PANEL_CLOSED,
  DESK_ROW_KEYS,
  deskClick,
  deskClose,
  deskPanelAgent,
  deskPanelView,
  type DeskPanelEffect,
  type DeskPanelState,
  type DeskPanelView,
  type DeskRowKey,
} from './desk-panel-model';
import { h, iconButton, setAttr, setHidden, setText, setVariant } from './dom';
import { ICONS } from './icons';
import { createStatusDot, updateStatusDot } from './widgets';

/** Quanto tempo a dica "Mesa livre" fica de pé. */
const TIP_MS = 1800;

export class DeskPanel implements UiComponent {
  readonly el: HTMLElement;
  /** Dica curta ("Mesa livre") no ponto do clique numa mesa vazia. */
  readonly tip: HTMLElement;
  private state: DeskPanelState = DESK_PANEL_CLOSED;
  private name: HTMLElement;
  private role: HTMLElement;
  private dot: HTMLElement;
  private statusText: HTMLElement;
  private rows = new Map<DeskRowKey, { dt: HTMLElement; dd: HTMLElement }>();
  private tipTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ctx: UiContext,
    /** Onde o foco do teclado volta ao fechar (Esc): o canvas do escritório. */
    private canvas: HTMLElement | null,
  ) {
    // o canvas volta a receber o foco ao fechar (focável de programação, fora da ordem de tabulação)
    if (canvas) canvas.tabIndex = -1;
    this.el = h(
      'aside',
      { class: 'ui-panel ui-desk', tabIndex: -1, attrs: { role: 'dialog', 'aria-label': 'Detalhes do agente na mesa (só leitura)', 'aria-hidden': 'true' }, hidden: true },
    );
    this.tip = h('p', { class: 'ui-desk-tip', role: 'status' });

    // materializa as peças do modelo: um único botão (o Fechar), o resto é texto.
    const head = h('div', { class: 'ui-desk__head' });
    const dl = h('dl', { class: 'ui-desk__rows' });
    let name: HTMLElement | null = null;
    let role: HTMLElement | null = null;
    let dot: HTMLElement | null = null;
    let statusText: HTMLElement | null = null;
    this.el.append(head);
    for (const part of DESK_PARTS) {
      if (part.kind === 'title') {
        name = h('h2', { class: 'ui-desk__name' });
        head.append(name);
      } else if (part.kind === 'readonly') {
        head.append(h('span', { class: 'ui-desk__ro', text: part.label }));
      } else if (part.kind === 'close') {
        head.append(iconButton(ICONS.close, part.label, () => this.close(), 'ui-icon-btn--sm'));
      } else if (part.kind === 'role') {
        role = h('p', { class: 'ui-desk__role' });
        this.el.append(role);
      } else if (part.kind === 'status') {
        dot = createStatusDot();
        statusText = h('span', { class: 'ui-desk__status-text' });
        this.el.append(h('div', { class: 'ui-desk__status' }, dot, statusText));
      } else {
        const dt = h('dt', { text: part.label });
        const dd = h('dd');
        dl.append(dt, dd);
        this.rows.set(part.row, { dt, dd });
      }
    }
    this.el.append(dl);
    this.name = name!;
    this.role = role!;
    this.dot = dot!;
    this.statusText = statusText!;

    // Esc dentro do painel fecha (o mesmo caminho do atalho global da UI).
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  /** Clique no monitor de uma mesa: abre no agente sentado (por id) ou só a dica de mesa livre. */
  onDeskClick(agentId: string | null, at: { x: number; y: number }): void {
    const r = deskClick(this.state, agentId);
    this.apply(r.state, r.effect);
    if (r.state.open) this.place(at);
    if (r.effect.tooltip) this.showTip(at, r.effect.tooltip);
    this.ctx.invalidate();
  }

  /** Fecha (Esc, botão Fechar ou agente que saiu): o foco volta ao canvas do escritório. */
  close(): void {
    const r = deskClose(this.state);
    this.apply(r.state, r.effect);
  }

  render(): void {
    if (!this.state.open || this.state.agentId === null) return;
    const a = deskPanelAgent(this.state, this.ctx.store.snapshot?.agents ?? []);
    if (!a) {
      // quem estava sentado saiu do escritório (trocar de mesa não: o painel segue pelo id)
      this.close();
      return;
    }
    this.update(deskPanelView(a));
  }

  private apply(state: DeskPanelState, effect: DeskPanelEffect): void {
    const wasOpen = this.state.open;
    this.state = state;
    const open = state.open;
    setHidden(this.el, !open);
    setAttr(this.el, 'aria-hidden', open ? 'false' : 'true');
    if (effect.focus === 'canvas') this.canvas?.focus({ preventScroll: true });
    if (open && !wasOpen) requestAnimationFrame(() => this.el.focus({ preventScroll: true }));
  }

  private update(v: DeskPanelView): void {
    setText(this.name, v.name);
    setText(this.role, v.role);
    updateStatusDot(this.dot, v.status);
    setText(this.statusText, v.statusText);
    setVariant(this.el, 'is-', v.status);
    this.el.dataset.state = v.state;
    for (const key of DESK_ROW_KEYS) {
      const r = this.rows.get(key)!;
      const value = v.rows[key];
      setHidden(r.dt, value === null);
      setHidden(r.dd, value === null);
      if (value !== null) setText(r.dd, value);
    }
  }

  /** Posiciona o painel ao lado do clique, sem sair da janela. */
  private place(at: { x: number; y: number }): void {
    const w = this.el.offsetWidth || 320;
    const h = this.el.offsetHeight || 240;
    const x = Math.round(Math.min(Math.max(8, at.x + 14), Math.max(8, window.innerWidth - w - 8)));
    const y = Math.round(Math.min(Math.max(8, at.y - h - 10), Math.max(8, window.innerHeight - h - 8)));
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  /** Dica curta no ponto do clique (mesa livre); some sozinha. */
  private showTip(at: { x: number; y: number }, text: string): void {
    setText(this.tip, text);
    this.tip.classList.add('is-visible');
    const x = Math.round(Math.min(Math.max(8, at.x - 40), Math.max(8, window.innerWidth - 130)));
    const y = Math.round(Math.max(8, at.y - 46));
    this.tip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => {
      this.tipTimer = null;
      this.tip.classList.remove('is-visible');
      this.tip.textContent = '';
    }, TIP_MS);
  }
}
