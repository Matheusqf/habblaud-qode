import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
describe('config Tailscale inerte', () => {
  it('serve só aponta para a entrada só-leitura em loopback e não liga Funnel', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'deploy/tailscale/serve.inert.json'), 'utf8'));
    const handlers = Object.values(cfg.Web).flatMap((w: any) => Object.values(w.Handlers)) as Array<{ Proxy: string }>;
    expect(handlers.map((h) => h.Proxy)).toEqual(['http://127.0.0.1:4320']);
    expect(Object.keys(cfg.AllowFunnel ?? {})).toEqual([]);
  });
  it('nenhum script do repo chama tailscale', () => {
    const pkg = readFileSync(join(root, 'package.json'), 'utf8');
    expect(pkg).not.toMatch(/tailscale|funnel/i);
  });
  it('ACL: só identidade/grupo explícito do Matheus na 443 e teste negativo de outro membro', () => {
    const raw = readFileSync(join(root, 'deploy/tailscale/acl.inert.hujson'), 'utf8');
    const acl = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(raw).not.toMatch(/autogroup:member|autogroup:tagged|"\*"/);
    expect(acl.acls).toEqual([{ action: 'accept', src: ['group:qode-owner'], dst: ['tag:qode-office:443'] }]);
    expect(acl.groups['group:qode-owner']).toHaveLength(1);
    const owner = acl.groups['group:qode-owner'][0];
    const neg = acl.tests.find((t: any) => t.src !== owner);
    expect(neg.accept).toBeUndefined();
    expect(neg.deny).toContain('tag:qode-office:443');
  });
});
