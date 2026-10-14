import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContinuityReader,setupContinuityFixture} from './continuity-reader';
const stamp='2026-10-13T13:00:00Z',now=Date.parse(stamp);
const dto={status:'available',schema_version:1,task_id:'sol-blocked',project_id:'habblaud-fixture',initiated_by:'matheus',owner_ref:'sol',action:'merge',next_required:'review',capability:'blocked_policy',observed_at:stamp};
const gate={enabled:true,authenticated:true,readStatus:true,projects:['habblaud-fixture'],tasks:['sol-blocked'],identities:['matheus','sol'],maxAgeSeconds:300};
it('continuity disabled and no ACL do not even read the DTO',()=>{
 for(const o of [{enabled:false,grant:()=>gate},{enabled:true,grant:()=>undefined}]){
  let reads=0;const r=createContinuityReader({...o,read:()=>{reads++;return dto;}})();expect(r.status).toBe('unavailable');expect(reads).toBe(0);
 }
});
it('Sol blocked/head changed shows next review with same owner, never a new execution',()=>{
 const read=createContinuityReader({enabled:true,grant:()=>gate,read:()=>dto,now:()=>now});
 expect(read()).toMatchObject({enabled:true,mode:'fixture',status:'available',card:{owner_ref:'sol',action:'merge',next_required:'review',capability:'blocked_policy'}});
});
it('stale, future, denied, private extra fields and unknown schema never reach response',()=>{
 for(const d of [{...dto,observed_at:'2026-10-13T12:00:00Z'},{...dto,observed_at:'2026-10-14T13:00:00Z'},{...dto,body:'PRIVATE_CANARY'},{...dto,status:'denied'},{...dto,lease_digest:'PRIVATE_CANARY'}]){
  const r=createContinuityReader({enabled:true,grant:()=>gate,read:()=>d,now:()=>now})();expect(r.status).toBe('unavailable');expect(JSON.stringify(r)).not.toContain('PRIVATE_CANARY');expect(r).not.toHaveProperty('card');
 }
});
it('bootstrap requires BOTH fixture and continuity flags and loopback bind',()=>{
 const root=mkdtempSync(join(tmpdir(),'continuity-read-'));
 try{
  writeFileSync(join(root,'continuity.fixture.json'),JSON.stringify({...dto,observed_at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}));
  for(const env of [{},{HABBLAUD_CONTINUITY:'1'},{HABBLAUD_CONTINUITY_FIXTURE:'1'},{HABBLAUD_CONTINUITY:'true',HABBLAUD_CONTINUITY_FIXTURE:'1'}])expect(setupContinuityFixture(env,'127.0.0.1',root)().status).toBe('unavailable');
  const env={HABBLAUD_CONTINUITY:'1',HABBLAUD_CONTINUITY_FIXTURE:'1'};expect(setupContinuityFixture(env,'0.0.0.0',root)().enabled).toBe(false);expect(setupContinuityFixture(env,'127.0.0.1',root)().status).toBe('available');
  writeFileSync(join(root,'continuity.fixture.json'),'x'.repeat(4097));expect(setupContinuityFixture(env,'127.0.0.1',root)().status).toBe('unavailable');
  rmSync(join(root,'continuity.fixture.json'));writeFileSync(join(root,'else.json'),JSON.stringify(dto));symlinkSync(join(root,'else.json'),join(root,'continuity.fixture.json'));expect(setupContinuityFixture(env,'127.0.0.1',root)().status).toBe('unavailable');
 }finally{rmSync(root,{recursive:true,force:true});}
});
