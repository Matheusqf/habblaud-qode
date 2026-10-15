/** Leitor opt-in. Guard HTTP continua separado de autenticação/ACL.
 * Bootstrap só tem fixtures de IDs fixos; nenhuma concessão real é criada.
 */
import {constants, closeSync, fstatSync, openSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {isLoopbackHost} from '../http/guard';
import {projectContinuity, type ContinuityGate, type Projection} from './continuity-dto';
export type ContinuityResponse = Projection & {enabled:boolean; mode:'fixture' | 'unavailable'};
export function createContinuityReader(o: {enabled:boolean; read:()=>unknown; grant:()=>ContinuityGate | undefined; now?:()=>number}): ()=>ContinuityResponse {
  return () => {
    if (!o.enabled) return {enabled:false,mode:'unavailable',status:'unavailable'};
    try {
      const grant=o.grant();
      if (!grant) return {enabled:true,mode:'unavailable',status:'unavailable'};
      return {...projectContinuity(o.read(),grant,(o.now ?? Date.now)()),enabled:true,mode:'fixture'};
    } catch {return {enabled:true,mode:'unavailable',status:'unavailable'};}
  };
}
function readFixture(file:string):unknown {
  const fd=openSync(file,constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.size>4096) return undefined;
    const buffer=Buffer.alloc(4097);const n=readSync(fd,buffer,0,buffer.length,0);
    if(n>4096) return undefined;
    const end=fstatSync(fd);
    if (stat.ino!==end.ino || stat.size!==end.size || stat.mtimeMs!==end.mtimeMs || n!==stat.size) return undefined;
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,n)));
  } finally {closeSync(fd);}
}
export function setupContinuityFixture(env:NodeJS.ProcessEnv, host:string, dataDir:string):()=>ContinuityResponse {
  const enabled=env.HABBLAUD_CONTINUITY==='1' && isLoopbackHost(host);
  const fixture=env.HABBLAUD_CONTINUITY_FIXTURE==='1';
  return createContinuityReader({enabled,read:()=>readFixture(join(dataDir,'continuity.fixture.json')),grant:()=> fixture ? {
    enabled:true,authenticated:true,readStatus:true,projects:['habblaud-fixture'],tasks:['sol-blocked','fixture-task'],identities:['matheus','sol','actor-a'],maxAgeSeconds:300,
  }:undefined});
}
