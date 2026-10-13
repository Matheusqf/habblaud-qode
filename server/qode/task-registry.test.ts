import {describe, it, expect} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyMessage, emptyRegistry, projectTasks, readRegistry, writeRegistry, type Message, type RegistryState} from './task-registry';
import {setupTaskRegistry} from './task-registry-reader';
import {HB_MESSAGES} from './task-registry-hb';

const run = (msgs: Message[], s: RegistryState = emptyRegistry()) => { const out = []; for (const m of msgs) { const r = applyMessage(s, m); s = r.state; out.push(r.result); } return {s, out}; };
const base = {at: '2026-10-13T20:00:00Z', origin: 'manual' as const};
const flow = (): Message[] => [
  {...base, message_id: 'm1', task_id: 'HB-T-01', op: 'create', actor: 'zikabot', expected_version: 0, project: 'habblaud'},
  {...base, message_id: 'm2', task_id: 'HB-T-01', op: 'claim', actor: 'grok-bot', expected_version: 1, owner: 'socio-bot'},
  {...base, message_id: 'm3', task_id: 'HB-T-01', op: 'start', actor: 'socio-bot', expected_version: 2},
];

describe('HB-INT-01 registo: owner único, versões, transições', () => {
  it('real HB-INV-01 replays to done/approved with exactly one execution and review by another actor bound to head', () => {
    const {s, out} = run(HB_MESSAGES);
    expect(out.every(o => o.outcome === 'applied')).toBe(true);
    const inv = s.tasks['HB-INV-01'];
    expect(inv).toMatchObject({owner: 'grok-bot', status: 'done', approval_state: 'approved', version: 6, blocker: null, updated_at: '2026-10-13T20:22:01Z',
      evidence: {head: '343dbde955eb4474cf14eff20e0327f5573392d4'}, review: {reviewer: 'zikabot', head: '343dbde955eb4474cf14eff20e0327f5573392d4'}});
    expect(s.executions.filter(e => e.task_id === 'HB-INV-01')).toHaveLength(1);
    expect(s.tasks['HB-INT-01']).toMatchObject({owner: 'socio-bot', status: 'running', version: 3});
    expect(s.transitions.map(t => t.version)).toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3]);
  });
  it('duplicate message (same id) does not create a second execution or transition', () => {
    const msgs = flow(); const {s} = run(msgs); const again = run(msgs, s);
    expect(again.out.map(o => o.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(again.s).toBe(s); expect(again.s.executions).toHaveLength(1);
  });
  it('stale message (old version, new id) or older timestamp is rejected; no execution', () => {
    const {s} = run(flow());
    const r = applyMessage(s, {...base, message_id: 'm3-redelivered', task_id: 'HB-T-01', op: 'start', actor: 'socio-bot', expected_version: 2});
    expect(r.result).toMatchObject({outcome: 'rejected', reason: 'stale:expected=2,current=3'}); expect(r.state.executions).toHaveLength(1);
    const old = applyMessage(s, {...base, at: '2026-10-13T19:00:00Z', message_id: 'm-old', task_id: 'HB-T-01', op: 'block', actor: 'socio-bot', expected_version: 3, blocker: 'x'});
    expect(old.result).toMatchObject({outcome: 'rejected', reason: 'stale:older_than_task'});
  });
  it('single owner: no takeover, only owner starts/submits; review must be separate and on submitted head', () => {
    let {s} = run(flow());
    expect(applyMessage(s, {...base, message_id: 'x1', task_id: 'HB-T-01', op: 'submit', actor: 'grok-bot', expected_version: 3, evidence: {head: 'abcdef1', patch_sha256: null, ref: 'github:Matheusqf/habblaud-qode#2'}}).result).toMatchObject({reason: 'not_owner'});
    s = applyMessage(s, {...base, message_id: 'm4', task_id: 'HB-T-01', op: 'submit', actor: 'socio-bot', expected_version: 3, evidence: {head: 'abcdef1', patch_sha256: null, ref: 'github:Matheusqf/habblaud-qode#2'}}).state;
    const rv = (actor: string, head: string, id: string) => applyMessage(s, {...base, message_id: id, task_id: 'HB-T-01', op: 'review', actor, expected_version: 4, verdict: 'approved', ref: 'slack:C0C8STB9R27/1791923503.805269', evidence: {head, patch_sha256: null, ref: 'github:Matheusqf/habblaud-qode#2'}});
    expect(rv('socio-bot', 'abcdef1', 'r1').result).toMatchObject({reason: 'self_review'});
    expect(rv('zikabot', 'abcdef2', 'r2').result).toMatchObject({reason: 'candidate_mismatch'});
    expect(applyMessage(s, {...base, message_id: 'c0', task_id: 'HB-T-01', op: 'complete', actor: 'zikabot', expected_version: 4}).result).toMatchObject({reason: 'not_approved'});
    s = rv('zikabot', 'abcdef1', 'r3').state; expect(s.tasks['HB-T-01'].approval_state).toBe('approved');
    const {s: s2} = run([{...base, message_id: 'c1', task_id: 'HB-T-01', op: 'claim', actor: 'other', expected_version: 5, owner: 'other'}], s);
    expect(s2.tasks['HB-T-01'].owner).toBe('socio-bot');
  });
  it('blocker is tracked as a versioned transition', () => {
    const {s} = run([...flow(), {...base, message_id: 'b1', task_id: 'HB-T-01', op: 'block', actor: 'socio-bot', expected_version: 3, blocker: 'needs_permission'}]);
    expect(s.tasks['HB-T-01']).toMatchObject({status: 'blocked', blocker: 'needs_permission', version: 4});
  });
});

describe('HB-INT-01 privacidade da projeção', () => {
  it('only allowlisted fields leave; extra/private fields, free refs, other projects never projected', () => {
    const {s} = run(HB_MESSAGES);
    const tampered = JSON.parse(JSON.stringify(s));
    tampered.tasks['HB-INV-01'].body = 'PRIVATE_CANARY'; tampered.tasks['HB-INV-01'].evidence.token = 'sk-PRIVATE_CANARY';
    tampered.tasks['HB-INT-01'].evidence = {head: 'PRIVATE_CANARY', ref: 'file:///Users/x/Vida/PRIVATE_CANARY'};
    tampered.tasks['VIDA-X-01'] = {...s.tasks['HB-INV-01'], task_id: 'VIDA-X-01', project: 'vida'};
    tampered.seen['PRIVATE_CANARY'] = 'x';
    const out = projectTasks(tampered, {projects: ['habblaud']})!;
    expect(out.map(t => t.task_id)).toEqual(['HB-INT-01', 'HB-INV-01']);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_CANARY');
    expect(Object.keys(out[1]).sort()).toEqual(['approval_state','blocker','evidence_ref','executions','head','patch_sha256','origin','owner','project','reviewer','review_ref','status','task_id','updated_at','version'].sort());
    expect(out[0]).toMatchObject({head: null, patch_sha256: null, evidence_ref: null});
  });
  it('invalid refs/heads are rejected at message level (no local paths or URLs into registry)', () => {
    const {s} = run(flow());
    for (const ev of [{head: 'abcdef1', patch_sha256: null, ref: 'https://evil.example/x'}, {head: 'abcdef1', patch_sha256: null, ref: '/Users/matheus/Vida/x.md'}, {head: 'not-a-sha', patch_sha256: null, ref: 'github:Matheusqf/habblaud-qode#2'}])
      expect(applyMessage(s, {...base, message_id: 'e-' + ev.ref.length + ev.head, task_id: 'HB-T-01', op: 'submit', actor: 'socio-bot', expected_version: 3, evidence: ev}).result.outcome).toBe('rejected');
  });
  it('reader: flag off by default, loopback only, independent of continuity flags; file is symlink-safe and atomic', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-reg-'));
    try {
      writeRegistry(join(root, 'task-registry.json'), run(HB_MESSAGES).s);
      for (const env of [{}, {HABBLAUD_CONTINUITY: '1', HABBLAUD_CONTINUITY_FIXTURE: '1'}, {HABBLAUD_TASK_REGISTRY: 'true'}]) expect(setupTaskRegistry(env, '127.0.0.1', root)()).toEqual({enabled: false, status: 'unavailable'});
      expect(setupTaskRegistry({HABBLAUD_TASK_REGISTRY: '1'}, '0.0.0.0', root)().enabled).toBe(false);
      const on = setupTaskRegistry({HABBLAUD_TASK_REGISTRY: '1'}, '127.0.0.1', root)();
      expect(on.status).toBe('available'); expect('tasks' in on && on.tasks.find(t => t.task_id === 'HB-INV-01')).toMatchObject({status: 'done', executions: 1});
      expect(readRegistry(join(root, 'task-registry.json')).schema_version).toBe(1);
      rmSync(join(root, 'task-registry.json')); writeFileSync(join(root, 'other.json'), readFileSync(join(root, 'other.json'), {flag: 'a+'}));
      symlinkSync(join(root, 'other.json'), join(root, 'task-registry.json'));
      expect(setupTaskRegistry({HABBLAUD_TASK_REGISTRY: '1'}, '127.0.0.1', root)().status).toBe('unavailable');
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});

describe('HB-INT-01 regressões da revisão ZikaBOT (P1/P2)', () => {
  const P = 'a'.repeat(64), Q = 'b'.repeat(64);
  const ref = 'github:Matheusqf/habblaud-qode#2', rref = 'slack:C0C8STB9R27/1791923503.805269';
  const sub = (ev: object, v = 3): Message => ({...base, message_id: 'p-sub', task_id: 'HB-T-01', op: 'submit', actor: 'socio-bot', expected_version: v, evidence: ev as never});
  const rev = (ev: object | undefined, id: string, v = 4): Message => ({...base, message_id: id, task_id: 'HB-T-01', op: 'review', actor: 'zikabot', expected_version: v, verdict: 'approved', ref: rref, evidence: ev as never});
  it('P1: submit without any immutable id (head null and no patch_sha256) is rejected', () => {
    const {s} = run(flow());
    for (const ev of [{head: null, ref}, {head: null, patch_sha256: null, ref}, {head: null, patch_sha256: 'xyz', ref}])
      expect(applyMessage(s, sub(ev)).result).toMatchObject({outcome: 'rejected', reason: 'invalid:evidence'});
  });
  it('P1: patch-only candidate; review must match patch_sha256 AND head exactly, otherwise no completion', () => {
    let {s} = run(flow()); s = applyMessage(s, sub({head: null, patch_sha256: P, ref})).state;
    expect(s.tasks['HB-T-01'].evidence).toEqual({head: null, patch_sha256: P, ref});
    for (const [id, ev] of [['x1', {head: 'deadbee', patch_sha256: null, ref: 'github:Other/x#9'}], ['x2', {head: null, patch_sha256: Q, ref}], ['x3', {head: 'abcdef1', patch_sha256: P, ref}]] as const)
      expect(applyMessage(s, rev(ev, id)).result).toMatchObject({reason: 'candidate_mismatch'});
    expect(applyMessage(s, rev(undefined, 'x4')).result).toMatchObject({reason: 'candidate_mismatch'});
    expect(applyMessage(s, {...base, message_id: 'x5', task_id: 'HB-T-01', op: 'complete', actor: 'zikabot', expected_version: 4}).result).toMatchObject({reason: 'not_approved'});
    s = applyMessage(s, rev({head: null, patch_sha256: P, ref: rref}, 'ok')).state;
    expect(s.tasks['HB-T-01'].review).toMatchObject({head: null, patch_sha256: P});
    expect(applyMessage(s, {...base, message_id: 'c-own', task_id: 'HB-T-01', op: 'complete', actor: 'socio-bot', expected_version: 5}).result).toMatchObject({reason: 'not_reviewer'});
    expect(applyMessage(s, {...base, message_id: 'c-rev', task_id: 'HB-T-01', op: 'complete', actor: 'zikabot', expected_version: 5}).result.outcome).toBe('applied');
  });
  it('P1: exact frozen-candidate reproduction (head null + other evidence) no longer reaches done', () => {
    let {s} = run(flow());
    const r1 = applyMessage(s, sub({head: null, patch_sha256: null, ref})); expect(r1.result.outcome).toBe('rejected');
  });
  it('P2: block→unblock from claimed restores claimed; zero executions cannot submit/complete', () => {
    const msgs: Message[] = [flow()[0], flow()[1],
      {...base, message_id: 'b3', task_id: 'HB-T-01', op: 'block', actor: 'socio-bot', expected_version: 2, blocker: 'x'},
      {...base, message_id: 'b4', task_id: 'HB-T-01', op: 'unblock', actor: 'socio-bot', expected_version: 3}];
    const {s, out} = run(msgs);
    expect(out.map(o => o.outcome)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(s.tasks['HB-T-01']).toMatchObject({status: 'claimed', blocker: null}); expect(s.executions).toHaveLength(0);
    expect(applyMessage(s, sub({head: 'abcdef1', patch_sha256: null, ref}, 4)).result).toMatchObject({reason: 'not_running_or_no_evidence'});
    const started = applyMessage(s, {...base, message_id: 'b5', task_id: 'HB-T-01', op: 'start', actor: 'socio-bot', expected_version: 4});
    expect(started.result).toMatchObject({outcome: 'applied'}); expect(started.state.executions).toHaveLength(1);
  });
  it('P2: block from running restores running (execution kept); cannot block open/submitted/done', () => {
    let {s} = run([...flow(), {...base, message_id: 'b3', task_id: 'HB-T-01', op: 'block', actor: 'socio-bot', expected_version: 3, blocker: 'x'},
      {...base, message_id: 'b4', task_id: 'HB-T-01', op: 'unblock', actor: 'socio-bot', expected_version: 4}]);
    expect(s.tasks['HB-T-01'].status).toBe('running'); expect(s.executions).toHaveLength(1);
    s = applyMessage(s, sub({head: 'abcdef1', patch_sha256: null, ref}, 5)).state;
    expect(applyMessage(s, {...base, message_id: 'b9', task_id: 'HB-T-01', op: 'block', actor: 'socio-bot', expected_version: 6, blocker: 'x'}).result).toMatchObject({reason: 'not_blockable'});
  });
  it('same class: tampered state (running with no execution, review on other candidate) cannot submit/complete', () => {
    const {s} = run(flow());
    const noExec: RegistryState = {...s, executions: []};
    expect(applyMessage(noExec, sub({head: 'abcdef1', patch_sha256: null, ref})).result).toMatchObject({reason: 'no_tracked_execution'});
    let s2 = applyMessage(s, sub({head: 'abcdef1', patch_sha256: null, ref})).state;
    s2 = applyMessage(s2, rev({head: 'abcdef1', patch_sha256: null, ref}, 'ok2')).state;
    const forged = JSON.parse(JSON.stringify(s2)); forged.tasks['HB-T-01'].review.head = 'deadbee';
    expect(applyMessage(forged, {...base, message_id: 'cf', task_id: 'HB-T-01', op: 'complete', actor: 'zikabot', expected_version: 5}).result).toMatchObject({reason: 'candidate_mismatch'});
    const noExec2 = {...s2, executions: []};
    expect(applyMessage(noExec2, {...base, message_id: 'cn', task_id: 'HB-T-01', op: 'complete', actor: 'zikabot', expected_version: 5}).result).toMatchObject({reason: 'no_tracked_execution'});
  });
});

describe('HB-INT-01 regressões da revisão ZikaBOT (msg 1791924989.894939)', () => {
  it('1: FIFO no caminho do registo não bloqueia; fica unavailable', async () => {
    const {execFileSync, spawnSync} = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'hb-fifo-'));
    try {
      execFileSync('mkfifo', [join(root, 'task-registry.json')]);
      const t0 = Date.now();
      expect(() => readRegistry(join(root, 'task-registry.json'))).toThrow(/regular file/);
      expect(setupTaskRegistry({HABBLAUD_TASK_REGISTRY: '1'}, '127.0.0.1', root)().status).toBe('unavailable');
      expect(Date.now() - t0).toBeLessThan(1000);
      void spawnSync;
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  it('3: datas inválidas (mês 13, dia 31/02, hora 25) são rejeitadas sem RangeError', () => {
    for (const at of ['2026-13-45T99:99:99Z', '2026-02-31T10:00:00Z', '2026-10-13T25:00:00Z']) {
      const r = applyMessage(emptyRegistry(), {...base, at, message_id: 'd-' + at.slice(5, 7) + at.slice(11, 13), task_id: 'HB-T-01', op: 'create', actor: 'zikabot', expected_version: 0, project: 'habblaud'});
      expect(r.result).toMatchObject({outcome: 'rejected', reason: 'invalid:at'});
    }
    const s = run(HB_MESSAGES).s; const bad = JSON.parse(JSON.stringify(s)); bad.tasks['HB-INV-01'].updated_at = '2026-13-45T99:99:99Z';
    expect(() => projectTasks(bad, {projects: ['habblaud']})).not.toThrow();
    expect(projectTasks(bad, {projects: ['habblaud']})!.map(t => t.task_id)).toEqual(['HB-INT-01']);
  });
  it('4: owner/reviewer fora da allowlist de identidades não saem; blocker desconhecido vira "other"', () => {
    const s = JSON.parse(JSON.stringify(run(HB_MESSAGES).s));
    s.tasks['HB-INT-01'].owner = 'matheus-cpf-12345678900';
    s.tasks['HB-INV-01'].review.reviewer = 'evil-actor';
    const out = projectTasks(s, {projects: ['habblaud']})!;
    expect(out.map(t => t.task_id)).toEqual(['HB-INV-01']);
    expect(out[0].reviewer).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/cpf|evil-actor/);
    const b = JSON.parse(JSON.stringify(run(HB_MESSAGES).s)); b.tasks['HB-INT-01'].blocker = 'paciente_joao_silva'; b.tasks['HB-INT-01'].status = 'blocked';
    const pb = projectTasks(b, {projects: ['habblaud']})!.find(t => t.task_id === 'HB-INT-01')!;
    expect(pb.blocker).toBe('other'); expect(JSON.stringify(pb)).not.toContain('joao');
  });
  it('5: origin "automated" na entrada nunca é projetada como automação', () => {
    const s = JSON.parse(JSON.stringify(run(HB_MESSAGES).s));
    for (const t of Object.values(s.tasks) as {origin: string}[]) t.origin = 'automated';
    expect(projectTasks(s, {projects: ['habblaud']})!.every(t => t.origin === 'manual')).toBe(true);
  });
});
