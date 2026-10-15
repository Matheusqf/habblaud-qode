// Teste de engenharia em navegador headless novo, sem perfil/histórico pessoal.
import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const out=process.env.CONTINUITY_TEST_OUTPUT;
assert(out,'Diretório de evidência explícito obrigatório');mkdirSync(out,{recursive:true});
const checks=[];const servers=[];
async function start(args=[]){
 const child=spawn('/opt/homebrew/bin/node',['node_modules/tsx/dist/cli.mjs','scripts/continuity-fixture-demo.ts',...args],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});servers.push(child);
 let buffer='';return await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('startup timeout')),10000);
  child.stdout.on('data',d=>{buffer+=d.toString();const line=buffer.split('\n').find(l=>l.startsWith('{'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});
  child.on('exit',()=>{clearTimeout(timer);reject(Error('fixture server exited'));});
 });
}
const browser=await chromium.launch({executablePath:'/Applications/Chromium.app/Contents/MacOS/Chromium',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const e=await start(['--enable-continuity','--fixture-grant']);
 const fixture=()=>({status:'available',schema_version:1,task_id:'sol-blocked',project_id:'habblaud-fixture',initiated_by:'matheus',owner_ref:'sol',action:'merge',next_required:'review',capability:'blocked_policy',observed_at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')});
 writeFileSync(e.file,JSON.stringify(fixture()));await page.goto(e.url);await page.getByRole('button',{name:'Continuidade',exact:true}).waitFor();await page.getByRole('button',{name:'Continuidade',exact:true}).click();
 const panel=page.getByRole('region',{name:'Continuidade de tarefas'});await panel.getByText('sol',{exact:true}).waitFor();
 assert((await panel.innerText()).includes('Bloqueado por política'));assert((await panel.innerText()).includes('Revisão necessária'));assert((await panel.innerText()).includes('Demonstração · dados inventados'));checks.push('Sol blocked/headchanged preserves owner and next review');
 await page.screenshot({path:out+'/panel-positive.png'});
 await page.setViewportSize({width:390,height:844});const box=await panel.boundingBox();assert(box && box.x>=0 && box.x+box.width<=390);await page.screenshot({path:out+'/panel-mobile.png'});checks.push('mobile viewport card stays within screen');await page.setViewportSize({width:1280,height:900});
 assert.equal(await panel.evaluate(el=>getComputedStyle(el).zIndex),'15');
 await panel.getByRole('button',{name:'Fechar continuidade'}).click();assert.equal(await panel.isVisible(),false);await page.getByRole('button',{name:'Continuidade',exact:true}).click();checks.push('close/reopen and stacking below drawer/terminal');
 for(const [name,change] of [['extra-private-fields',{...fixture(),body:'PRIVATE_CANARY'}],['stale',{...fixture(),observed_at:new Date(Date.now()-301000).toISOString().replace(/\.\d{3}Z$/,'Z')}],['future',{...fixture(),observed_at:new Date(Date.now()+60000).toISOString().replace(/\.\d{3}Z$/,'Z')}]]){
  writeFileSync(e.file,JSON.stringify(change));await panel.getByRole('button',{name:'Atualizar',exact:true}).click();await panel.getByText('Fonte indisponível. Nenhuma ação será iniciada.').waitFor();
  assert.equal(await panel.locator('dd').count(),0);assert(!(await page.locator('body').innerText()).includes('PRIVATE_CANARY'));checks.push(name+' denies and clears UI');
 }
 writeFileSync(e.file,JSON.stringify({...fixture(),observed_at:new Date(Date.now()-298000).toISOString().replace(/\.\d{3}Z$/,'Z')}));await panel.getByRole('button',{name:'Atualizar',exact:true}).click();await panel.getByText('sol',{exact:true}).waitFor();await panel.getByText('Fonte indisponível. Nenhuma ação será iniciada.').waitFor();checks.push('foreground expiry clears old card without polling');
 writeFileSync(e.file,JSON.stringify(fixture()));await panel.getByRole('button',{name:'Atualizar',exact:true}).click();await panel.getByText('sol',{exact:true}).waitFor();checks.push('fresh source restores card');
 const snapshot=await (await page.request.get(e.url+'/api/snapshot')).json();assert.equal(snapshot.meta.terminal,false);assert.equal(snapshot.meta.messages,false);checks.push('native feature flags remain independent');
 const noAcl=await start(['--enable-continuity']);await page.goto(noAcl.url);await page.getByRole('button',{name:'Continuidade',exact:true}).waitFor();await page.getByRole('button',{name:'Continuidade',exact:true}).click();await page.getByRole('region',{name:'Continuidade de tarefas'}).getByText('Fonte indisponível. Nenhuma ação será iniciada.').waitFor();checks.push('no ACL denies in actual UI');
 const disabled=await start();await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/continuity')),page.goto(disabled.url)]);
 assert.equal(await page.getByRole('button',{name:'Continuidade',exact:true}).isVisible(),false);checks.push('default disabled hides UI');
 assert.deepEqual(errors,[]);writeFileSync(out+'/browser-result.json',JSON.stringify({status:'passed',checks,pageErrors:errors,scope:'fresh headless Chromium; actual built UI/API with fixture grants; no real auth or personal watchers'},null,2));
 console.log(JSON.stringify({status:'passed',checks}));
}finally{
 await browser.close();for(const s of servers){s.kill('SIGTERM');await Promise.race([once(s,'exit'),new Promise(resolve=>setTimeout(resolve,3000))]);}
}
