/** Servidor de prova HB-INT-01: API/static reais, Office fictício, sem watchers/contas pessoais, bind 127.0.0.1.
 * Usa um registo existente (--data <dir>) para mostrar tarefas reais transcritas. Flags nativas inalteradas. */
import http from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApiHandler} from '../server/http/app';
import {createRequestGuard} from '../server/http/guard';
import {createStaticHandler} from '../server/http/static';
import {Hub} from '../server/http/sse';
import {Office} from '../server/model/office';
import {NameStore} from '../server/model/names';
import {AccountsService} from '../server/accounts/service';
import {setupTaskRegistry} from '../server/qode/task-registry-reader';
const i=process.argv.indexOf('--data');const dataDir=process.argv[i+1];if(i<0||!dataDir)throw Error('--data obrigatório');
const accounts=new AccountsService({dirs:[],home:dataDir,env:{},onChange:()=>{}});
const office=new Office({names:new NameStore(null),version:'0.8.0-hb-int-01',startedAt:Date.now(),accounts:()=>[],sources:()=>[],accountName:()=>undefined,terminal:false});
office.setDemo(true);const hub=new Hub(office);hub.start();
const env=process.argv.includes('--enable-tasks')?{HABBLAUD_TASK_REGISTRY:'1'}:{};
const api=createApiHandler({office,hub,accounts,sources:()=>[],version:'0.8.0-hb-int-01',inDocker:false,tasks:setupTaskRegistry(env,'127.0.0.1',dataDir)});
const guard=createRequestGuard();const st=createStaticHandler(join(process.cwd(),'dist/client'));
const server=http.createServer((req,res)=>{if(guard(req,res))return;const url=new URL(req.url??'/','http://localhost');if(!api(req,res,url))st(req,res,url.pathname);});
server.listen(0,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')throw Error('bind');console.log(JSON.stringify({url:`http://127.0.0.1:${a.port}`,enabled:!!env.HABBLAUD_TASK_REGISTRY}));});
const close=()=>{hub.stop();server.closeAllConnections();server.close(()=>process.exit(0));};process.on('SIGTERM',close);process.on('SIGINT',close);
