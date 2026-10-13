import test from 'node:test';
import assert from 'node:assert/strict';
import {projectContinuity} from './continuity-dto.ts';
const now=Date.parse('2026-10-13T13:00:00Z');
const dto={status:'available',schema_version:1,task_id:'task-a',project_id:'project-a',initiated_by:'actor-a',owner_ref:'actor-a',action:'wait',next_required:'review',capability:'blocked_policy',observed_at:'2026-10-13T13:00:00Z'};
const gate={enabled:true,authenticated:true,readStatus:true,projects:['project-a'],tasks:['task-a'],identities:['actor-a'],maxAgeSeconds:300};
const deny=(d,g=gate,n=now)=>assert.deepEqual(projectContinuity(d,g,n),{status:'unavailable'});
test('projection requires feature flag AND authenticated ACL',()=>{
 for(const k of ['enabled','authenticated','readStatus']) for(const value of [false,'true',undefined]) deny(dto,{...gate,[k]:value});
});
test('nominal project, task and identities cannot be bypassed with strings or wildcard',()=>{
 for(const k of ['projects','tasks','identities']) for(const value of [[],['*'],'project-a',null]) deny(dto,{...gate,[k]:value});
 deny({...dto,owner_ref:'actor-b'});deny({...dto,project_id:'project-b'});deny({...dto,task_id:'task-b'});
});
test('raw checkpoint, snapshot and extra private fields fail closed',()=>{
 for(const k of ['lease_digest','authorization_ref','body','source_revision','snapshot','transcript','token','path']) deny({...dto,[k]:'SYNTHETIC_PRIVATE_CANARY'});
 deny({...dto,status:'denied'});deny(null);deny([dto]);
});
test('stale, future and invalid calendar data unavailable',()=>{
 deny(dto,gate,now+300001);deny(dto,gate,now-1);deny({...dto,observed_at:'2026-02-31T13:00:00Z'});
 for(const maxAgeSeconds of [0,301,NaN,'300'])deny(dto,{...gate,maxAgeSeconds});
});
test('safe DTO retains owner and blocked action without granting execution',()=>{
 const out=projectContinuity(dto,gate,now);assert.equal(out.status,'available');assert.equal(out.card.owner_ref,'actor-a');assert.equal(out.card.action,'wait');assert.equal(out.card.capability,'blocked_policy');
 assert.deepEqual(Object.keys(out.card).sort(),['task_id','project_id','initiated_by','owner_ref','action','next_required','capability','observed_at'].sort());
});
test('unknown enum and unmapped identifiers deny',()=>{
 deny({...dto,action:'needs: review'});deny({...dto,next_required:'execute'});deny({...dto,initiated_by:'sk-private'});deny({...dto,capability:'authorized'});
});
