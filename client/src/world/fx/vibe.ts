// Animações de estado "vibe" (opt-in: ?fx=vibe, VITE_HABBLAUD_FX=vibe ou o pacote de tema).
import { currentThemePack } from '../../../../shared/theme-packs';
//
// Ideias adaptadas de vibeoffice (https://github.com/acost1a/vibeoffice, MIT, Copyright (c) 2026
// acost1a): café ao esperar permissão, "cair da cadeira" quando uma ferramenta dá erro e confete
// quando o trabalho termina. Implementação própria sobre o motor do habblaud (sem código nem sprites
// copiados); ver NOTICE.md.

export type VibeReaction = 'coffee' | 'tumble' | 'confetti';

/** Reação a uma atividade nova do agente (puro). */
export function vibeForActivity(kind: string, isMain: boolean): VibeReaction | null {
  if (kind === 'error') return 'tumble';
  if (kind === 'done' && isMain) return 'confetti';
  return null;
}

/** Reação a uma troca de modo (puro): entrar em espera de permissão = café. */
export function vibeForMode(prev: string, next: string): VibeReaction | null {
  return next === 'wait' && prev !== 'wait' ? 'coffee' : null;
}

export function resolveVibe(search: string, build?: string): boolean {
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get('fx');
  } catch {
    v = null;
  }
  if (v === 'vibe') return true;
  if (v === 'off') return false;
  return build === 'vibe';
}

function buildEnv(key: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.[key];
}

export function vibeEnabled(): boolean {
  if (typeof location === 'undefined') return false;
  // ?fx= > VITE_HABBLAUD_FX > fx do pacote de tema (default 'off').
  const pack = currentThemePack().scenery.fx;
  return resolveVibe(location.search, buildEnv('VITE_HABBLAUD_FX') ?? (pack === 'off' ? undefined : pack));
}

/** Áreas por projeto da config de build (JSON em VITE_HABBLAUD_AREAS). */
export function buildAreasJson(): string | undefined {
  return buildEnv('VITE_HABBLAUD_AREAS');
}
