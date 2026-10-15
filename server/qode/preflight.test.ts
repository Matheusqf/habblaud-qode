import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qodePreflight, qodeRequired } from './preflight';

const dir = mkdtempSync(join(tmpdir(), 'qode-pf-'));
const home = mkdtempSync(join(tmpdir(), 'qode-home-'));
let n = 0;
function cfg(content: unknown): string {
  const f = join(dir, `c${n++}.json`);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}
const ok = { projetos: [{ nome: 'Clínicas', caminhos: ['~/clinicas'], privado: false }] };
function run(over: { file?: string; env?: NodeJS.ProcessEnv; host?: string; allowed?: string[]; inDocker?: boolean } = {}) {
  const env = over.env ?? { HABBLAUD_QODE_CONFIG: over.file ?? cfg(ok) };
  return qodePreflight({ env, dataDir: dir, home, host: over.host ?? '127.0.0.1', inDocker: over.inDocker ?? false, allowedHosts: new Set(over.allowed ?? []) });
}

describe('qodeRequired', () => {
  it('só liga com valor explícito', () => {
    expect(qodeRequired({})).toBe(false);
    expect(qodeRequired({ HABBLAUD_QODE_REQUIRED: '0' })).toBe(false);
    expect(qodeRequired({ HABBLAUD_QODE_REQUIRED: '1' })).toBe(true);
  });
});

describe('qodePreflight', () => {
  it('aceita config válida, loopback e sem hosts extras', () => expect(run()).toEqual([]));
  it('config ausente', () => expect(run({ file: join(dir, 'nao-existe.json') }).join()).toMatch(/ausente/));
  it('config ausente no dataDir padrão', () => expect(run({ env: {} }).join()).toMatch(/ausente/));
  it('HABBLAUD_QODE_CONFIG relativo', () => expect(run({ env: { HABBLAUD_QODE_CONFIG: 'qode.config.json' } }).join()).toMatch(/absoluto/));
  it('JSON inválido', () => expect(run({ file: cfg('{ nope') }).join()).toMatch(/JSON/));
  it('typo "privada"', () => {
    const e = run({ file: cfg({ projetos: [{ nome: 'X', caminhos: ['~/x'], privada: true }] }) }).join();
    expect(e).toMatch(/inválida/);
    expect(e).toMatch(/mal escrito/);
  });
  it('"_privado" comentado', () =>
    expect(run({ file: cfg({ projetos: [{ nome: 'X', caminhos: ['~/x'], _privado: true }] }) }).join()).toMatch(/explícito|mal escrito/));
  it('"privado" omitido', () => expect(run({ file: cfg({ projetos: [{ nome: 'X', caminhos: ['~/x'] }] }) }).join()).toMatch(/explícito/));
  it('projetos: []', () => expect(run({ file: cfg({ projetos: [] }) }).join()).toMatch(/vazio/));
  it('bind externo', () => expect(run({ host: '0.0.0.0' }).join()).toMatch(/bind externo/));
  it('Docker sem HABBLAUD_BIND', () => expect(run({ inDocker: true }).join()).toMatch(/bind externo/));
  it('hosts extras', () => expect(run({ allowed: ['tunel.example.com'] }).join()).toMatch(/ALLOWED_HOSTS/));
  it('não vaza caminhos de projeto nas mensagens', () => {
    const e = run({ file: cfg({ projetos: [{ nome: 'X', caminhos: ['~/segredo-xyz'] }] }) }).join();
    expect(e).not.toMatch(/segredo-xyz/);
  });
});

describe('manifesto do ciclo (qode/qode.config.ciclo.json)', () => {
  const file = join(__dirname, '..', '..', 'qode', 'qode.config.ciclo.json');
  it('passa no preflight', () => expect(run({ file })).toEqual([]));
  it('8 projetos, sem dev-flow como sala e sem proibidos', async () => {
    const { readFileSync } = await import('node:fs');
    const m = JSON.parse(readFileSync(file, 'utf8')) as { projetos: { nome: string; caminhos: string[] }[]; _dependencias: Record<string, string> };
    expect(m.projetos).toHaveLength(8);
    const all = JSON.stringify(m.projetos).toLowerCase();
    for (const bad of ['dev-flow', 'vida', 'ubots', 'wellhub']) expect(all).not.toContain(bad);
    expect(m._dependencias['dev-flow']).toMatch(/ORQUESTRAÇÃO/);
  });
});
