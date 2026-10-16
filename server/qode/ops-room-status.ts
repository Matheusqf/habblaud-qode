/** B2: ops room observe-only — 1 bot OpenCode proposto; API unavailable até adaptador + B1/B4. */
export interface OpsRoomStatus {
  /** Bot piloto proposto (não implica integração). */
  bot: 'opencode';
  /** QODE só observa; nunca despacha. */
  role: 'observe-only';
  /** Sempre false neste stub (sem API comprovada no QODE). */
  ready: boolean;
  /** Estado da API face ao QODE. */
  api: 'unavailable';
  /** Cruzar salas é proibido por contrato. */
  crossRoom: 'denied';
  /** Vida BOT fora deste track. */
  vida: 'excluded';
  /** Depende de B4 para qualquer superfície remota. */
  authDependency: 'b4-required-for-remote';
  note: string;
}

const NOTE =
  'B2 stub: bot proposto=OpenCode via floating-flow/flow-bot-relay; sem API live; sem cruzar salas; Vida excluído; remoto só após B4';

/**
 * Status para /api/health. Sem side-effects, sem chamadas cloud.
 * ready=false e api=unavailable até existir adaptador que leia ledger/hub.
 */
export function qodeOpsRoomStatus(): OpsRoomStatus {
  return {
    bot: 'opencode',
    role: 'observe-only',
    ready: false,
    api: 'unavailable',
    crossRoom: 'denied',
    vida: 'excluded',
    authDependency: 'b4-required-for-remote',
    note: NOTE,
  };
}
