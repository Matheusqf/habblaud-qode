// Vista em cartões (?view=cards): alternativa compacta à sala, só leitura. Clicar num cartão seleciona o agente (abre a gaveta).
import type { OfficeStore } from '../net/store';
import type { WorldApi } from '../world/api';
import { UNIFIED_ICON, UNIFIED_LABEL } from '../../../shared/unified-state';
import { observedLabel } from '../../../shared/observed';
import { buildCards, costLabel, type AgentCard } from './cards-model';
import { formatTokens, formatUSD } from './format';

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function cardEl(c: AgentCard, world: WorldApi, depth: number): HTMLElement {
  const a = c.agent;
  const b = el('button', `qode-card is-${c.state}${depth ? ' qode-card--sub' : ''}`) as HTMLButtonElement;
  b.type = 'button';
  b.dataset.id = a.id;
  b.append(
    el('div', 'qode-card__top', `${a.name}${a.provider === 'codex' ? ' · Codex' : a.provider === 'opencode' ? ' · OpenCode' : ''}${depth ? ` · ${a.role}` : ''}`),
    el('div', 'qode-card__state', `${UNIFIED_ICON[c.state]} ${UNIFIED_LABEL[c.state]}${a.status === 'waiting' && a.waitingFor ? `: ${a.waitingFor}` : ''}`),
    el('div', 'qode-card__act', a.activity?.text ?? observedLabel(a.observed) ?? ''),
    el('div', 'qode-card__usage', `${formatTokens(c.usage.tokens)} tokens · custo ${costLabel(c.usage, formatUSD)}`),
  );
  b.setAttribute('aria-label', `${a.name}: ${UNIFIED_LABEL[c.state]}`);
  b.addEventListener('click', () => world.select({ type: 'agent', id: a.id }, { focus: true }));
  const wrap = el('div', 'qode-card-wrap');
  wrap.append(b);
  if (c.subs.length) {
    const subs = el('div', 'qode-card__subs');
    c.subs.forEach((s) => subs.append(cardEl(s, world, depth + 1)));
    wrap.append(subs);
  }
  return wrap;
}

export function mountCards(root: HTMLElement, store: OfficeStore, world: WorldApi): void {
  const view = el('section', 'qode-cards');
  view.setAttribute('aria-label', 'Vista em cartões');
  root.append(view);
  let raf = 0;
  const render = (): void => {
    raf = 0;
    const rooms = buildCards(store.snapshot);
    view.replaceChildren(
      ...(rooms.length
        ? rooms.map((r) => {
            const sec = el('div', 'qode-cards__room');
            sec.append(el('h3', 'qode-cards__title', `${r.name} — ${formatTokens(r.usage.tokens)} tokens · custo ${costLabel(r.usage, formatUSD)}`));
            const grid = el('div', 'qode-cards__grid');
            r.cards.forEach((c) => grid.append(cardEl(c, world, 0)));
            sec.append(grid);
            return sec;
          })
        : [el('p', 'qode-cards__empty', 'Nenhum agente no escritório.')]),
    );
  };
  store.on('snapshot', () => {
    if (!raf) raf = requestAnimationFrame(render);
  });
  render();
}
