// HB-INT-01: prova em Chromium headless novo (sem perfil), rede fora de 127.0.0.1 bloqueada.
// Uso: TASKS_TEST_OUTPUT=<dir> CHROMIUM=<path> node scripts/task-registry-browser-test.mjs
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const out=process.env.TASKS_TEST_OUTPUT;assert(out,'TASKS_TEST_OUTPUT obrigatório');mkdirSync(out,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'hb-int-01-'));const tsx=['node_modules/tsx/dist/cli.mjs'];const servers=[];const checks=[];
const applyOnce=()=>JSON.parse(execFileSync(process.execPath,[...tsx,'scripts/task-registry-apply.ts',data],{encoding:'utf8'}));
const first=applyOnce();const second=applyOnce();
assert.equal(first.executions,2);assert.equal(second.executions,2);assert.equal(second.transitions,first.transitions);
assert(Object.values(second.report).every(v=>v==='duplicate'));checks.push('replay of all real messages => duplicate, executions stay 2 (HB-INV-01, HB-INT-01)');
writeFileSync(join(out,'apply-first.json'),JSON.stringify(first,null,1));writeFileSync(join(out,'apply-replay.json'),JSON.stringify(second,null,1));
async function start(args){const c=spawn(process.execPath,[...tsx,'scripts/task-registry-demo.ts','--data',data,...args],{stdio:['ignore','pipe','pipe']});servers.push(c);
 let b='';return new Promise((res,rej)=>{const t=setTimeout(()=>rej(Error('startup timeout')),15000);c.stdout.on('data',d=>{b+=d;const l=b.split('\n').find(x=>x.startsWith('{'));if(l){clearTimeout(t);res(JSON.parse(l));}});c.on('exit',()=>rej(Error('exited')));});}
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,headless:true});
try{
 const ctx=await browser.newContext({viewport:{width:1280,height:900}});await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const on=await start(['--enable-tasks']);await page.goto(on.url);
 const btn=page.getByRole('button',{name:'Tarefas',exact:true});await btn.waitFor();await btn.click();
 const panel=page.getByRole('region',{name:'Registo de tarefas'});const inv=panel.locator('article[data-task-id="HB-INV-01"]');await inv.waitFor();
 const t=await inv.innerText();for(const s of ['grok-bot','Concluída','Aprovada','343dbde955eb4474cf14eff20e0327f5573392d4','zikabot','Manual (transcrito)','2026-10-13T20:22:01Z'])assert(t.includes(s),s);
 assert(/Versão\s*6/.test(t));assert(/Execuções\s*1/.test(t));checks.push('HB-INV-01 real: owner grok-bot, done, approved by zikabot on head 343dbde, v6, 1 execution, origin manual');
 const it=await panel.locator('article[data-task-id="HB-INT-01"]').innerText();assert(it.includes('socio-bot')&&it.includes('Em execução'));checks.push('HB-INT-01 real: owner socio-bot, running');
 const api=await (await page.request.get(on.url+'/api/tasks')).json();writeFileSync(join(out,'api-tasks.json'),JSON.stringify(api,null,1));
 assert(!JSON.stringify(api).includes('"seen"')&&!JSON.stringify(api).includes('actor'));checks.push('API exposes only allowlisted projection');
 await page.screenshot({path:join(out,'tasks-panel.png')});
 const reg=JSON.parse(readFileSync(join(data,'task-registry.json'),'utf8'));reg.tasks['HB-INV-01'].body='PRIVATE_CANARY';writeFileSync(join(data,'task-registry.json'),JSON.stringify(reg));
 await panel.getByRole('button',{name:'Atualizar',exact:true}).click();await inv.waitFor();assert(!(await page.locator('body').innerText()).includes('PRIVATE_CANARY'));checks.push('private canary in registry never reaches UI');
 // 2: refreshes concorrentes com respostas fora de ordem: a resposta antiga (lenta) chega depois e tem de ser descartada.
 {let n=0;await page.route('**/api/tasks',async route=>{const k=++n;const resp=await route.fetch();let body=await resp.json();
   if(k===1){body={...body,tasks:body.tasks.map(t=>({...t,status:'open',approval_state:'none'}))};await new Promise(r=>setTimeout(r,1500));}
   await route.fulfill({response:resp,json:body});});
  const rb=panel.getByRole('button',{name:'Atualizar',exact:true});await rb.click();await page.waitForTimeout(100);await rb.click();
  await page.waitForTimeout(2200);
  assert.equal(await panel.locator('article[data-task-id]').count(),2,'cards duplicados');
  assert.equal(await panel.locator('article[data-task-id="HB-INV-01"]').count(),1);
  assert((await inv.innerText()).includes('Concluída'),'estado antigo mostrado');assert(!(await panel.innerText()).includes('Aberta'));
  await page.unroute('**/api/tasks');checks.push('out-of-order concurrent refreshes: stale response discarded, no duplicate cards');}
 // 5: origem nunca "Automação comprovada", mesmo com origin=automated no ficheiro.
 {const r2=JSON.parse(readFileSync(join(data,'task-registry.json'),'utf8'));for(const t of Object.values(r2.tasks))t.origin='automated';writeFileSync(join(data,'task-registry.json'),JSON.stringify(r2));
  await panel.getByRole('button',{name:'Atualizar',exact:true}).click();await inv.waitFor();await page.waitForTimeout(300);
  assert(!(await panel.innerText()).includes('Automação comprovada'));checks.push('origin=automated in file still shown as Manual');}
 const snap=await (await page.request.get(on.url+'/api/snapshot')).json();assert.equal(snap.meta.terminal,false);assert.equal(snap.meta.messages,false);checks.push('native feature flags unchanged');
 const off=await start([]);await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/tasks')),page.goto(off.url)]);assert.equal(await page.getByRole('button',{name:'Tarefas',exact:true}).isVisible(),false);checks.push('default off hides panel');
 assert.deepEqual(errors,[]);const result={status:'passed',checks,pageErrors:errors,scope:'headless Chromium, built UI + real API handler, registry from real Slack-transcribed transitions (manual), no network beyond 127.0.0.1'};
 writeFileSync(join(out,'browser-result.json'),JSON.stringify(result,null,1));console.log(JSON.stringify(result));
}finally{await browser.close();for(const s of servers){s.kill('SIGTERM');await Promise.race([once(s,'exit'),new Promise(r=>setTimeout(r,3000))]);}rmSync(data,{recursive:true,force:true});}
