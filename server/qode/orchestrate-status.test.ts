import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDevflowReady, qodeOrchestrateStatus, resolveDevflowRoot } from './orchestrate-status';

describe('B1 orchestrate-status', () => {
  it('resolveDevflowRoot prefere QODE_DEVFLOW_ROOT', () => {
    expect(resolveDevflowRoot({ QODE_DEVFLOW_ROOT: '/opt/dev-flow' }, '/home/x')).toBe('/opt/dev-flow');
    expect(resolveDevflowRoot({}, '/home/x')).toBe('/home/x/Documents/GitHub/dev-flow');
  });

  it('ready só com AGENTS.md + flow-orchestrate skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'qode-b1-flow-'));
    expect(isDevflowReady(root)).toBe(false);
    writeFileSync(join(root, 'AGENTS.md'), '# x\n');
    expect(isDevflowReady(root)).toBe(false);
    mkdirSync(join(root, 'plugin', 'skills', 'flow-orchestrate'), { recursive: true });
    writeFileSync(join(root, 'plugin', 'skills', 'flow-orchestrate', 'SKILL.md'), '# s\n');
    expect(isDevflowReady(root)).toBe(true);
    const st = qodeOrchestrateStatus({ QODE_DEVFLOW_ROOT: root }, '/tmp');
    expect(st.ready).toBe(true);
    expect(st.coordinator).toBe('floating-flow');
    expect(st.role).toBe('observe-only');
    expect(st.root).toBe(root);
  });
});
