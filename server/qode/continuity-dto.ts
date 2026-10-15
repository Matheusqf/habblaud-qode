/** Candidata isolada: só projeta DTO. Não lê hubs, snapshots ou transcripts.
 * Grants são fornecidos pelo autenticador/ACL do servidor, nunca pelo DTO.
 * Não há rota, configuração instalada ou feature upstream modificada.
 */
export interface ContinuityGate {
  enabled: boolean;
  authenticated: boolean;
  readStatus: boolean;
  projects: readonly string[];
  tasks: readonly string[];
  identities: readonly string[];
  maxAgeSeconds: number;
}
export interface ContinuityCard {
  task_id: string;
  project_id: string;
  initiated_by: string;
  owner_ref: string | null;
  action: string;
  next_required: string;
  capability: string;
  observed_at: string;
}
export type Projection = {status: 'unavailable'} | {status: 'available'; card: ContinuityCard};
const keys = ['status','schema_version','task_id','project_id','initiated_by','owner_ref','action','next_required','capability','observed_at'];
const id = /^[a-z][a-z0-9_-]{0,63}$/;
const unavailable = (): Projection => ({status:'unavailable'});
const nominal = (v: unknown): v is string => typeof v === 'string' && id.test(v) && !v.startsWith('sk-');
const validList = (v: unknown): v is string[] => Array.isArray(v) && v.every(nominal);
export function projectContinuity(raw: unknown, gate: ContinuityGate, now: number): Projection {
  if (!gate || gate.enabled !== true || gate.authenticated !== true || gate.readStatus !== true
      || !validList(gate.projects) || !validList(gate.tasks) || !validList(gate.identities)
      || !Number.isFinite(now) || !Number.isInteger(gate.maxAgeSeconds) || gate.maxAgeSeconds < 1 || gate.maxAgeSeconds > 300) return unavailable();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))
      || v.status !== 'available' || v.schema_version !== 1) return unavailable();
  if (!nominal(v.task_id) || !nominal(v.project_id) || !nominal(v.initiated_by)
      || !(v.owner_ref === null || nominal(v.owner_ref))) return unavailable();
  if (!gate.projects.includes(v.project_id) || !gate.tasks.includes(v.task_id)
      || !gate.identities.includes(v.initiated_by) || (v.owner_ref !== null && !gate.identities.includes(v.owner_ref))) return unavailable();
  if (typeof v.action !== 'string' || !['idle','implement','validate','review','merge','wait'].includes(v.action)
      || typeof v.next_required !== 'string' || !['none','approve','validate','review','reconcile'].includes(v.next_required)
      || typeof v.capability !== 'string' || !['unknown','available','read_only','unavailable','blocked_policy'].includes(v.capability)) return unavailable();
  if (typeof v.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v.observed_at)) return unavailable();
  const stamp = Date.parse(v.observed_at);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== v.observed_at.replace('Z','.000Z')
      || now < stamp || now - stamp > gate.maxAgeSeconds * 1000) return unavailable();
  return {status:'available',card:{task_id:v.task_id,project_id:v.project_id,initiated_by:v.initiated_by,owner_ref:v.owner_ref,
    action:v.action,next_required:v.next_required,capability:v.capability,observed_at:v.observed_at}};
}
