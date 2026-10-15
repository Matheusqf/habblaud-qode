/** HB-INT-01: painel só-leitura do registo de tarefas. Aparece apenas se /api/tasks disser enabled. Sem botões de ação. */
import './continuity.css';
const STATUS: Record<string, string> = {open: 'Aberta', claimed: 'Atribuída', running: 'Em execução', submitted: 'Submetida', blocked: 'Bloqueada', done: 'Concluída'};
const APPROVAL: Record<string, string> = {none: 'Sem revisão', pending_review: 'Revisão pendente', approved: 'Aprovada', changes_requested: 'Alterações pedidas'};
const KEYS = ['task_id','project','owner','status','blocker','approval_state','version','updated_at','head','patch_sha256','evidence_ref','reviewer','review_ref','origin','executions'];
const TXT = /^[A-Za-z0-9:._/#@ -]{0,140}$/;
function valid(v: unknown): v is Record<string, string | number | null> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(o, k))) return false;
  return Object.hasOwn(STATUS, String(o.status)) && Object.hasOwn(APPROVAL, String(o.approval_state)) && Number.isInteger(o.version) && Number.isInteger(o.executions)
    && Object.values(o).every(x => x === null || typeof x === 'number' || (typeof x === 'string' && TXT.test(x)));
}
export function mountTaskPanel(root: HTMLElement): void {
  const section = document.createElement('section'); section.className = 'ui-continuity ui-tasks'; section.hidden = true; section.setAttribute('aria-label', 'Registo de tarefas');
  const launcher = document.createElement('button'); launcher.className = 'ui-continuity-launcher ui-tasks-launcher'; launcher.type = 'button'; launcher.hidden = true; launcher.textContent = 'Tarefas'; launcher.setAttribute('aria-expanded', 'false');
  const title = document.createElement('h2'); title.textContent = 'Tarefas';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Fechar'; close.setAttribute('aria-label', 'Fechar tarefas');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const list = document.createElement('div');
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Atualizar';
  section.append(title, close, status, list, refresh); root.append(launcher, section);
  let enabled = false, open = false, seq = 0;
  const vis = () => { launcher.hidden = !enabled; section.hidden = !enabled || !open; launcher.setAttribute('aria-expanded', String(open)); };
  launcher.addEventListener('click', () => { open = !open; vis(); if (open) void load(); });
  close.addEventListener('click', () => { open = false; vis(); });
  async function load(): Promise<void> {
    // Cada pedido tem um número; respostas superadas (fora de ordem) são descartadas e nunca tocam no DOM.
    const my = ++seq;
    list.replaceChildren(); status.textContent = 'Registo indisponível. Nenhuma ação será iniciada.';
    try {
      const r = await fetch('/api/tasks', {cache: 'no-store', credentials: 'same-origin'}); if (my !== seq || !r.ok) return;
      const v = await r.json() as Record<string, unknown>; if (my !== seq) return; enabled = v?.enabled === true; vis();
      if (!enabled || v.status !== 'available' || !Array.isArray(v.tasks)) return;
      const tasks = v.tasks.filter(valid); list.replaceChildren(); status.textContent = `${tasks.length} tarefa(s) · só leitura`;
      for (const t of tasks) {
        const card = document.createElement('article'); card.className = 'ui-hbtask'; card.dataset.taskId = String(t.task_id);
        const h = document.createElement('h3'); h.textContent = String(t.task_id); card.append(h);
        const dl = document.createElement('dl');
        const rows: [string, string][] = [['Projeto', String(t.project)], ['Owner', String(t.owner ?? 'Sem owner')], ['Estado', STATUS[String(t.status)]], ['Bloqueio', String(t.blocker ?? 'Nenhum')],
          ['Aprovação', APPROVAL[String(t.approval_state)]], ['Versão', String(t.version)], ['Atualizado', String(t.updated_at)], ['Head', String(t.head ?? '—')], ['Patch SHA256', String(t.patch_sha256 ?? '—')],
          ['Evidência', String(t.evidence_ref ?? '—')], ['Revisor', String(t.reviewer ?? '—')], ['Execuções', String(t.executions)],
          // Sem prova verificável de automação nesta POC: a UI mostra sempre 'Manual'.
          ['Origem', 'Manual (transcrito)']];
        for (const [k, val] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = val; dl.append(dt, dd); }
        card.append(dl); list.append(card);
      }
    } catch { /* fail closed */ }
  }
  refresh.addEventListener('click', () => void load()); void load();
}
