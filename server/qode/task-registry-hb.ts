/** Transições REAIS da POC, transcritas manualmente (origin='manual') das mensagens Slack #poc-habblaud
 * (canal C0C8STB9R27, thread 1791921602.553929). Só IDs/metadados; nenhum texto de mensagem é copiado. */
import type {Message} from './task-registry';
const CH = 'C0C8STB9R27';
const at = (ts: string) => new Date(Math.floor(Number(ts)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const slack = (ts: string) => `slack:${CH}/${ts}`;
const m = (ts: string, suffix: string, rest: Omit<Message, 'message_id' | 'at' | 'origin'>): Message =>
  ({message_id: `${slack(ts)}:${suffix}`.toLowerCase(), at: at(ts), origin: 'manual', ...rest});
const HEAD = '343dbde955eb4474cf14eff20e0327f5573392d4';
export const HB_MESSAGES: Message[] = [
  // HB-INV-01: ZikaBOT atribui inventário read-only ao Grok Bot; Grok Bot entrega; ZikaBOT reconcilia.
  m('1791922498.073339', 'create', {task_id: 'HB-INV-01', op: 'create', actor: 'zikabot', expected_version: 0, project: 'habblaud'}),
  m('1791922498.073339', 'claim', {task_id: 'HB-INV-01', op: 'claim', actor: 'zikabot', expected_version: 1, owner: 'grok-bot'}),
  m('1791922722.334769', 'start', {task_id: 'HB-INV-01', op: 'start', actor: 'grok-bot', expected_version: 2}),
  m('1791922722.334769', 'submit', {task_id: 'HB-INV-01', op: 'submit', actor: 'grok-bot', expected_version: 3, evidence: {head: HEAD, patch_sha256: null, ref: slack('1791922722.334769')}}),
  m('1791922921.316539', 'review', {task_id: 'HB-INV-01', op: 'review', actor: 'zikabot', expected_version: 4, verdict: 'approved', ref: slack('1791922921.316539'), evidence: {head: HEAD, patch_sha256: null, ref: slack('1791922921.316539')}}),
  m('1791922921.316539', 'complete', {task_id: 'HB-INV-01', op: 'complete', actor: 'zikabot', expected_version: 5}),
  // HB-INT-01: criada por ZikaBOT; Grok Bot coordena e designa Sócio BOT como executor único; ZikaBOT regista o aceite.
  m('1791923082.694119', 'create', {task_id: 'HB-INT-01', op: 'create', actor: 'zikabot', expected_version: 0, project: 'habblaud'}),
  m('1791923472.455689', 'claim', {task_id: 'HB-INT-01', op: 'claim', actor: 'grok-bot', expected_version: 1, owner: 'socio-bot'}),
  // Início pelo executor (não é mensagem Slack): registo local do Sócio BOT ao começar a execução.
  {message_id: 'local:socio-bot/hb-int-01:start', task_id: 'HB-INT-01', op: 'start', actor: 'socio-bot', expected_version: 2, at: '2026-10-13T20:33:00Z', origin: 'manual'},
];
