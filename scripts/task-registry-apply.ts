/** Aplica as transições reais (HB_MESSAGES) ao ficheiro de registo indicado. Idempotente: reexecutar não cria execuções.
 * Uso: tsx scripts/task-registry-apply.ts <dataDir> [--submit-int01 --patch-sha256 <hex64> | --head <sha>] [--at <iso>]
 * --submit-int01 SÓ SUBMETE (owner socio-bot → pending_review). NÃO aprova nem conclui: a aprovação é uma mensagem
 * `review` separada do revisor (≠ owner) com a MESMA candidata (head e patch_sha256), seguida de `complete` pelo revisor.
 * Este script não tem modo de aprovação. Sem rede, sem Slack, sem credenciais. */
import {join} from 'node:path';
import {applyMessage, readRegistry, writeRegistry, type Message} from '../server/qode/task-registry';
import {HB_MESSAGES} from '../server/qode/task-registry-hb';
const dir = process.argv[2]; if (!dir) throw Error('dataDir obrigatório');
const file = join(dir, 'task-registry.json');
let state = readRegistry(file); const report: Record<string, string> = {};
const extra: Message[] = [];
const arg = (k: string) => { const j = process.argv.indexOf(k); return j > 0 ? process.argv[j + 1] : undefined; };
if (process.argv.includes('--submit-int01')) {
  const patch = arg('--patch-sha256') ?? null, head = arg('--head') ?? null;
  if (!patch && !head) throw Error('--submit-int01 exige --patch-sha256 (candidata sem commit) ou --head');
  extra.push({message_id: `local:socio-bot/hb-int-01:submit:${patch ?? head}`, task_id: 'HB-INT-01', op: 'submit', actor: 'socio-bot', expected_version: 3,
    at: arg('--at') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), origin: 'manual', evidence: {head, patch_sha256: patch, ref: 'github:Matheusqf/habblaud-qode#2'}});
}
for (const msg of [...HB_MESSAGES, ...extra]) { const r = applyMessage(state, msg); state = r.state; report[msg.message_id] = r.result.outcome + ('reason' in r.result ? `:${r.result.reason}` : ''); }
writeRegistry(file, state);
console.log(JSON.stringify({file, report, note: 'submit only; approval requires a separate reviewer message', executions: state.executions.length, transitions: state.transitions.length}, null, 1));
