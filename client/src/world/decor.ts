// Decoração da marca (pôsteres, néon, mascotes): vem do pacote de tema em vigor (`decor`).
//   ?decor=off  desliga (avaliado UMA vez ao abrir a página)
// O pacote neutro (habblaud) não tem `decor`: nada muda por padrão.
import { currentThemePack, decorForRoom, type ThemePackDecor, type ThemePackDecorSet } from '../../../shared/theme-packs';

/** `decor` do pacote, ou undefined com `?decor=off`. Puro. */
export function resolveDecor(search: string, pack: { decor?: ThemePackDecor }): ThemePackDecor | undefined {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('decor');
  } catch {
    v = null;
  }
  return v === 'off' ? undefined : pack.decor;
}

export function currentDecor(): ThemePackDecor | undefined {
  if (typeof location === 'undefined') return undefined;
  return resolveDecor(location.search, currentThemePack());
}

/** Conjunto da sala (pelo nome exibido) no pacote em vigor. */
export function roomDecorSet(decor: ThemePackDecor | undefined, name: string): ThemePackDecorSet | undefined {
  return decorForRoom(decor, name);
}
