/** Servidor de prova: API/static reais, Office só fictício; sem watchers/contas pessoais. */
import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApiHandler} from '../server/http/app';
import {createRequestGuard} from '../server/http/guard';
import {createStaticHandler} from '../server/http/static';
import {Hub} from '../server/http/sse';
import {Office} from '../server/model/office';
import {NameStore} from '../server/model/names';
import {AccountsService} from '../server/accounts/service';
import {setupContinuityFixture} from '../server/qode/continuity-reader';
const dataDir=mkdtempSync(join(tmpdir(),'habblaud-continuity-demo-'));
const file=join(dataDir,'continuity.fixture.json');
const observed_at=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
writeFileSync(file,JSON.stringify({status:'available',schema_version:1,task_id:'sol-blocked',project_id:'habblaud-fixture',initiated_by:'matheus',owner_ref:'sol',action:'merge',next_required:'review',capability:'blocked_policy',observed_at}));
const accounts=new AccountsService({dirs:[],home:dataDir,env:{},onChange:()=>{}});
const office=new Office({names:new NameStore(null),version:'0.8.0-fixture',startedAt:Date.now(),accounts:()=>[],sources:()=>[],accountName:()=>undefined,terminal:false});
office.setDemo(true);
const hub=new Hub(office);hub.start();
const env={...(process.argv.includes('--enable-continuity')?{HABBLAUD_CONTINUITY:'1'}:{}),...(process.argv.includes('--fixture-grant')?{HABBLAUD_CONTINUITY_FIXTURE:'1'}:{})};
const api=createApiHandler({office,hub,accounts,sources:()=>[],version:'0.8.0-fixture',inDocker:false,continuity:setupContinuityFixture(env,'127.0.0.1',dataDir)});
const guard=createRequestGuard();const staticHandler=createStaticHandler(join(process.cwd(),'dist/client'));
const server=http.createServer((req,res)=>{if(guard(req,res))return;const url=new URL(req.url??'/','http://localhost');if(!api(req,res,url))staticHandler(req,res,url.pathname);});
server.listen(0,'127.0.0.1',()=>{
 const address=server.address();if(!address||typeof address==='string')throw Error('bind');
 const result={url:`http://127.0.0.1:${address.port}`,file,mode:'synthetic_fixture_only',noPersonalWatchers:true,disabled:!process.argv.includes('--enable-continuity'),noACL:!process.argv.includes('--fixture-grant')};
 writeFileSync(join(process.cwd(),'continuity-demo-location.json'),JSON.stringify(result));console.log(JSON.stringify(result));
});
function close(){hub.stop();server.closeAllConnections();server.close(()=>{rmSync(dataDir,{recursive:true,force:true});process.exit(0);});}
process.on('SIGTERM',close);process.on('SIGINT',close);
