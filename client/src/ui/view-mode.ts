// Modos de vista (opt-in pela URL): kiosk/TV e mobile. Ideia do Cubicle (caglarutkuguler/cubicle, MIT), código próprio.
// - ?view=kiosk (ou ?kiosk=1): ecrã de TV — esconde painéis e controlos, letra maior, cursor some quando parado.
// - ?view=mobile: força a vista compacta de telemóvel (que também liga sozinha abaixo de 600 px, via CSS).
export type ViewMode = 'normal' | 'kiosk' | 'mobile';

export function resolveViewMode(search: string): ViewMode {
  const p = new URLSearchParams(search);
  const v = (p.get('view') ?? '').toLowerCase();
  if (v === 'kiosk' || v === 'tv' || p.get('kiosk') === '1') return 'kiosk';
  if (v === 'mobile') return 'mobile';
  return 'normal';
}

/** Liga as classes do modo no <html> e, no kiosk, esconde o cursor após `idleMs` sem movimento. Devolve o modo. */
export function applyViewMode(doc: Document, search: string, idleMs = 3_000): ViewMode {
  const mode = resolveViewMode(search);
  const root = doc.documentElement;
  root.classList.toggle('qode-kiosk', mode === 'kiosk');
  root.classList.toggle('qode-mobile', mode === 'mobile');
  if (mode === 'kiosk') {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = (): void => {
      root.classList.remove('qode-cursor-hidden');
      clearTimeout(t);
      t = setTimeout(() => root.classList.add('qode-cursor-hidden'), idleMs);
    };
    doc.addEventListener('pointermove', wake, { passive: true });
    wake();
  }
  return mode;
}
