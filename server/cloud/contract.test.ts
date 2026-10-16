import { describe, expect, it } from 'vitest';
import { type RawCloudItem, effectiveState, loadCloudConfig, normalizeProject, normalizeState, sanitize } from './contract';
import { CANARY, FIX_NOW } from './fixtures';

const cfg = { projects: new Set(['matheusqf/habblaud-qode']), ttlMs: 180_000 };

describe('cloud contract', () => {
  it('desligado por padrão e coletores exigem HABBLAUD_CLOUD', () => {
    expect(loadCloudConfig({}).enabled).toBe(false);
    expect(loadCloudConfig({ HABBLAUD_CLOUD_CURSOR: '1', HABBLAUD_CLOUD_CODEX: '1' })).toMatchObject({ cursor: false, codex: false });
    const on = loadCloudConfig({ HABBLAUD_CLOUD: '1', HABBLAUD_CLOUD_PROJECTS: 'https://github.com/Matheusqf/Habblaud-QODE.git, ,x y' });
    expect([...on.projects]).toEqual(['matheusqf/habblaud-qode']);
  });
  it('normaliza projetos', () => {
    expect(normalizeProject('github.com/A/B')).toBe('a/b');
    expect(normalizeProject('../etc/passwd')).toBeUndefined();
    expect(normalizeProject(42)).toBeUndefined();
  });
  it('IDLE não é sucesso nem trabalho; desconhecido fica desconhecido', () => {
    expect(normalizeState('cursor', 'IDLE')).toBe('idle');
    expect(normalizeState('cursor', 'ACTIVE')).toBe('running');
    expect(normalizeState('cursor', 'WHATEVER')).toBe('unknown');
    expect(normalizeState('codex-cloud', 'pending')).toBe('unknown');
    expect(normalizeState('codex-cloud', 'queued')).toBe('unknown');
    expect(normalizeState('codex-cloud', 'in_progress')).toBe('running');
  });
  it('allowlist antes de tudo e só campos do contrato', () => {
    const raw = { id: 'bc-abcdef12', project: 'https://github.com/Matheusqf/habblaud-qode', nativeState: 'ACTIVE', updatedAt: FIX_NOW - 1000, link: 'https://cursor.com/agents/bc-abcdef12?token=x#y', name: CANARY, prompt: CANARY } as RawCloudItem;
    const o = sanitize('cursor', raw, cfg, FIX_NOW)!;
    expect(Object.keys(o).sort()).toEqual(['expiresAt', 'id', 'link', 'nativeState', 'project', 'provider', 'state', 'updatedAt']);
    expect(o.link).toBe('https://cursor.com/agents/bc-abcdef12');
    expect(JSON.stringify(o)).not.toContain(CANARY);
    expect(sanitize('cursor', { ...raw, project: 'outro/repo' }, cfg, FIX_NOW)).toBeUndefined();
    expect(sanitize('cursor', { ...raw, id: '../x' }, cfg, FIX_NOW)).toBeUndefined();
  });
  it('links fora do host do provedor são removidos', () => {
    const o = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'IDLE', updatedAt: FIX_NOW, link: 'https://evil.example/x' }, cfg, FIX_NOW)!;
    expect(o.link).toBeUndefined();
    const o2 = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'IDLE', updatedAt: FIX_NOW, link: 'javascript:alert(1)' }, cfg, FIX_NOW)!;
    expect(o2.link).toBeUndefined();
  });
  it('sem hora = desconhecido; running vencido = stale', () => {
    expect(sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'ACTIVE', updatedAt: undefined }, cfg, FIX_NOW)!.state).toBe('unknown');
    const o = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'ACTIVE', updatedAt: FIX_NOW }, cfg, FIX_NOW)!;
    expect(effectiveState(o, FIX_NOW + 1)).toBe('running');
    expect(effectiveState(o, o.expiresAt + 1)).toBe('stale');
    const idle = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'IDLE', updatedAt: FIX_NOW }, cfg, FIX_NOW)!;
    expect(effectiveState(idle, idle.expiresAt + 1)).toBe('stale');
    const unk = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'XYZ', updatedAt: FIX_NOW }, cfg, FIX_NOW)!;
    expect(effectiveState(unk, unk.expiresAt + 1)).toBe('stale');
    const end = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'ARCHIVED', updatedAt: FIX_NOW }, cfg, FIX_NOW)!;
    expect(effectiveState(end, end.expiresAt + 1)).toBe('ended');
    const old = sanitize('cursor', { id: 'bc-abcdef12', project: 'matheusqf/habblaud-qode', nativeState: 'ACTIVE', updatedAt: FIX_NOW - 86_400_000 }, cfg, FIX_NOW)!;
    expect(old.state).toBe('stale');
  });
});
