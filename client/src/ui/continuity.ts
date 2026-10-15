import './continuity.css';
const action:Record<string,string>={idle:'Parado',implement:'Implementando',validate:'Validando',review:'Revisando',merge:'Merge pendente',wait:'Aguardando'};
const next:Record<string,string>={none:'Nenhuma',approve:'Aprovação',validate:'Validação',review:'Revisão necessária',reconcile:'Reconciliação'};
const capability:Record<string,string>={unknown:'Capacidade desconhecida',available:'Disponível',read_only:'Somente leitura',unavailable:'Indisponível',blocked_policy:'Bloqueado por política'};
const keys=['task_id','project_id','initiated_by','owner_ref','action','next_required','capability','observed_at'];
function validCard(value:unknown):value is Record<string,string|null>{
 if(!value || typeof value!=='object' || Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k)))return false;
 for(const k of ['task_id','project_id','initiated_by'])if(typeof v[k]!=='string'|| !/^[a-z][a-z0-9_-]{0,63}$/.test(v[k] as string))return false;
 if(!(v.owner_ref===null || typeof v.owner_ref==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v.owner_ref)))return false;
 return typeof v.action==='string' && Object.hasOwn(action,v.action) && typeof v.next_required==='string' && Object.hasOwn(next,v.next_required)
  && typeof v.capability==='string' && Object.hasOwn(capability,v.capability) && typeof v.observed_at==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v.observed_at);
}
export function mountContinuityPanel(root:HTMLElement):void {
 const section=document.createElement('section');section.className='ui-continuity';section.hidden=true;section.setAttribute('aria-label','Continuidade de tarefas');
 const launcher=document.createElement('button');launcher.className='ui-continuity-launcher';launcher.type='button';launcher.hidden=true;launcher.textContent='Continuidade';launcher.setAttribute('aria-expanded','false');
 const close=document.createElement('button');close.type='button';close.textContent='Fechar';close.setAttribute('aria-label','Fechar continuidade');
 const title=document.createElement('h2');title.textContent='Continuidade';
 const badge=document.createElement('p');badge.textContent='Demonstração · dados inventados';
 const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const content=document.createElement('dl');
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Atualizar';
 section.append(title,close,badge,status,content,refresh);root.append(launcher,section);
 let loading=false;let knownEnabled=false;let expanded=false;let expiry:ReturnType<typeof setTimeout>|undefined;
 const visibility=()=>{launcher.hidden=!knownEnabled;section.hidden=!knownEnabled||!expanded;launcher.setAttribute('aria-expanded',String(expanded));};
 launcher.addEventListener('click',()=>{expanded=!expanded;visibility();if(expanded)void load();});
 close.addEventListener('click',()=>{expanded=false;visibility();launcher.focus();});
 const clear=()=>{content.replaceChildren();status.textContent='Fonte indisponível. Nenhuma ação será iniciada.';};
 async function load():Promise<void>{
  if(loading)return;loading=true;refresh.disabled=true;if(expiry)clearTimeout(expiry);clear();
  try{
   const response=await fetch('/api/continuity',{cache:'no-store',credentials:'same-origin'});
   if(!response.ok){visibility();return;}
   const raw:unknown=await response.json();
   if(!raw || typeof raw!=='object' || Array.isArray(raw)){visibility();return;}
   const v=raw as Record<string,unknown>;knownEnabled=v.enabled===true;visibility();
   if(!knownEnabled)return;
   if(v.status!=='available' || v.mode!=='fixture' || !validCard(v.card) || Object.keys(v).some(k=>!['enabled','mode','status','card'].includes(k)))return;
   const c=v.card;const stamp=Date.parse(c.observed_at!);const age=Date.now()-stamp;
   if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==c.observed_at!.replace('Z','.000Z')||age<0||age>300000)return;
   expiry=setTimeout(clear,300001-age);status.textContent=capability[c.capability!];
   for(const [label,text] of [['Projeto',c.project_id],['Tarefa',c.task_id],['Iniciou',c.initiated_by],['Responsável',c.owner_ref??'Sem responsável'],['Ação',action[c.action!]],['Próxima etapa',next[c.next_required!]],['Observado em',c.observed_at]]){
    const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=text;content.append(dt,dd);
   }
  }catch{visibility();}finally{loading=false;refresh.disabled=false;}
 }
 refresh.addEventListener('click',()=>void load());void load();
 // Sem polling escondido: ao voltar à aba, reconsulta para não manter um card antigo.
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load();});
}
