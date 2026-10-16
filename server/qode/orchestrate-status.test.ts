import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDevflowReady, probeDevflow, qodeOrchestrateStatus, resolveDevflowRoot } from './orchestrate-status';

const CANARY = '/tmp/QODE_CANARY_PRIVATE_B1_PATH/dev-flow-secret-xyz';

function writeValidFixture(root: string): void {
  writeFileSync(join(root, 'AGENTS.md'), '# floating-flow agents\n');
  writeFileSync(
    join(root, 'flow.config.json'),
    JSON.stringify({ $schema: 'schemas/project.schema.json', project: { name: 'dev-flow' } }),
  );
  mkdirSync(join(root, 'plugin', 'skills', 'flow-orchestrate'), { recursive: true });
  writeFileSync(
    join(root, 'plugin', 'skills', 'flow-orchestrate', 'SKILL.md'),
    '---\nname: flow-orchestrate\n---\n# flow-orchestrate\n',
  );
}

describe('B1 orchestrate-status', () => {
  it('resolveDevflowRoot prefere QODE_DEVFLOW_ROOT (interno; não vaza no DTO)', () => {
    expect(resolveDevflowRoot({ QODE_DEVFLOW_ROOT: '/opt/dev-flow' }, '/home/x')).toBe('/opt/dev-flow');
    expect(resolveDevflowRoot({}, '/home/x')).toBe('/home/x/Documents/GitHub/dev-flow');
  });

  it('dirs com os nomes dos marcadores NÃO passam configured/artifactsPresent', () => {
    const root = mkdtempSync(join(tmpdir(), 'qode-b1-dirs-'));
    mkdirSync(join(root, 'AGENTS.md')); // dir, não ficheiro
    mkdirSync(join(root, 'flow.config.json'));
    mkdirSync(join(root, 'plugin', 'skills', 'flow-orchestrate', 'SKILL.md'), { recursive: true });
    const p = probeDevflow(root);
    expect(p.configured).toBe(false);
    expect(p.artifactsPresent).toBe(false);
    expect(isDevflowReady(root)).toBe(false);
  });

  it('ficheiros vazios ou JSON inválido → configured pode ser true só com size>0; artifacts exige contrato', () => {
    const root = mkdtempSync(join(tmpdir(), 'qode-b1-empty-'));
    writeFileSync(join(root, 'AGENTS.md'), '');
    writeFileSync(join(root, 'flow.config.json'), '{');
    mkdirSync(join(root, 'plugin', 'skills', 'flow-orchestrate'), { recursive: true });
    writeFileSync(join(root, 'plugin', 'skills', 'flow-orchestrate', 'SKILL.md'), 'no marker');
    expect(probeDevflow(root).configured).toBe(false); // AGENTS vazio

    writeFileSync(join(root, 'AGENTS.md'), '# x\n');
    writeFileSync(join(root, 'flow.config.json'), '{"nope":1}');
    writeFileSync(join(root, 'plugin', 'skills', 'flow-orchestrate', 'SKILL.md'), 'hello');
    const p = probeDevflow(root);
    expect(p.configured).toBe(true);
    expect(p.artifactsPresent).toBe(false); // sem flow-orchestrate / project|$schema
  });

  it('ready só com configured+artifactsPresent (contrato mínimo de observe)', () => {
    const root = mkdtempSync(join(tmpdir(), 'qode-b1-flow-'));
    expect(isDevflowReady(root)).toBe(false);
    writeValidFixture(root);
    expect(isDevflowReady(root)).toBe(true);
    const st = qodeOrchestrateStatus({ QODE_DEVFLOW_ROOT: root }, '/tmp');
    expect(st.ready).toBe(true);
    expect(st.configured).toBe(true);
    expect(st.artifactsPresent).toBe(true);
    expect(st.coordinator).toBe('floating-flow');
    expect(st.role).toBe('observe-only');
    expect(st).not.toHaveProperty('root');
  });

  it('P1: caminho-canário NÃO aparece no DTO (sucesso, ausência, env apontado)', () => {
    // Ausência
    const absent = qodeOrchestrateStatus({ QODE_DEVFLOW_ROOT: CANARY }, '/tmp');
    const absentJson = JSON.stringify(absent);
    expect(absent.ready).toBe(false);
    expect(absent).not.toHaveProperty('root');
    expect(absentJson).not.toContain(CANARY);
    expect(absentJson).not.toContain('QODE_CANARY_PRIVATE_B1_PATH');
    expect(absentJson).not.toContain('/tmp/');
    expect(absent.note).not.toContain(CANARY);

    // Sucesso com root = canary path (fixture real sob canary basename em tmp)
    const root = mkdtempSync(join(tmpdir(), 'qode-b1-canary-'));
    writeValidFixture(root);
    const ok = qodeOrchestrateStatus({ QODE_DEVFLOW_ROOT: root }, '/tmp');
    const okJson = JSON.stringify(ok);
    expect(ok.ready).toBe(true);
    expect(ok).not.toHaveProperty('root');
    expect(okJson).not.toContain(root);
    // env canary string also must not appear even if we set it alongside
    const mixed = qodeOrchestrateStatus({ QODE_DEVFLOW_ROOT: CANARY }, root);
    expect(JSON.stringify(mixed)).not.toContain(CANARY);
  });

  it('P1: health ausente/inválido não vaza canary via orchestrate', async () => {
    const { setupQode } = await import('./index');
    const { RoomAliases } = await import('../model/room-aliases');
    const qode = setupQode({
      env: { QODE_DEVFLOW_ROOT: CANARY },
      dataDir: '/tmp/habblaud-qode-b1-ausente-nao-existe',
      home: '/tmp',
      roomAliases: new RoomAliases(null),
      office: () => {
        throw new Error('office não deve ser chamado sem config');
      },
    });
    const h = qode.health();
    const dump = JSON.stringify(h);
    expect(h.config).toBe('ausente');
    expect(h.orchestrate).not.toHaveProperty('root');
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain('QODE_CANARY_PRIVATE_B1_PATH');
    expect(h.orchestrate.configured).toBe(false);
    expect(h.orchestrate.artifactsPresent).toBe(false);
    expect(h.orchestrate.ready).toBe(false);
  });
});
