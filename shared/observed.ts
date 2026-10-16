// Rótulo da atividade INFERIDA (AgentInfo.observed): fontes sem estado ao vivo (ex.: OpenCode lido do banco) nunca
// se apresentam como "trabalhando"; dizem o que o dado sugere, de quando, e se a leitura está desatualizada.
import type { ObservedActivity } from './types';

const WORD: Readonly<Record<ObservedActivity['activity'], string>> = { active: 'ativa', idle: 'parada', unknown: 'desconhecida' };

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Ex.: "atividade inferida: ativa (dado das 21:03)" / "... desconhecida (dado das 21:03, leitura desatualizada)". */
export function observedLabel(o: ObservedActivity | undefined, time: (ms: number) => string = hhmm): string | undefined {
  if (!o) return undefined;
  return `atividade inferida: ${WORD[o.activity]}${o.error ? ', última resposta com erro' : ''} (dado das ${time(o.at)}${o.stale ? ', leitura desatualizada' : ''})`;
}
