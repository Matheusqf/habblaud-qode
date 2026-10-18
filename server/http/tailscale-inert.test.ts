import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
describe('config Tailscale inerte', () => {
  it('config efetiva: nenhum AllowFunnel=true e só o destino/porta esperados', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'deploy/tailscale/serve.inert.json'), 'utf8'));
    // Funnel: nenhuma entrada com true (não basta "status vazio").
    expect(Object.values(cfg.AllowFunnel ?? {}).some((v) => v === true)).toBe(false);
    // Só TCP 443 com HTTPS; nada de TCPForward/porta crua.
    expect(Object.keys(cfg.TCP)).toEqual(['443']);
    expect(cfg.TCP['443']).toEqual({ HTTPS: true });
    // Só um host:443, só "/" e só o proxy da entrada só-leitura em loopback (nunca a porta do operador 4319).
    expect(Object.keys(cfg.Web)).toEqual(['${TS_CERT_DOMAIN}:443']);
    const h = cfg.Web['${TS_CERT_DOMAIN}:443'].Handlers;
    expect(Object.keys(h)).toEqual(['/']);
    expect(h['/']).toEqual({ Proxy: 'http://127.0.0.1:4320' });
  });
  it('nenhum script do repo chama tailscale', () => {
    const pkg = readFileSync(join(root, 'package.json'), 'utf8');
    expect(pkg).not.toMatch(/tailscale|funnel/i);
  });
  it('ACL: só identidade/grupo explícito do Matheus na 443 e teste negativo de outro membro', () => {
    const raw = readFileSync(join(root, 'deploy/tailscale/acl.inert.hujson'), 'utf8');
    const code = raw.replace(/^\s*\/\/.*$/gm, '');
    const acl = JSON.parse(code);
    expect(code).not.toMatch(/autogroup:member|autogroup:tagged|"\*"/);
    expect(acl.acls).toEqual([{ action: 'accept', src: ['group:qode-owner'], dst: ['tag:qode-office:443'] }]);
    expect(acl.groups['group:qode-owner']).toHaveLength(1);
    const owner = acl.groups['group:qode-owner'][0];
    const neg = acl.tests.find((t: any) => t.src !== owner);
    expect(neg.accept).toBeUndefined();
    expect(neg.deny).toContain('tag:qode-office:443');
  });
  it('runbook: 443 ocupada = parar e decidir (nunca outra porta HTTPS) e privacidade QODE obrigatória', () => {
    const rb = readFileSync(join(root, 'docs/QODE-TAILSCALE-RUNBOOK.md'), 'utf8');
    expect(rb).not.toMatch(/escolher outra porta HTTPS/i);
    expect(rb).toMatch(/\*\*PARAR\*\*/);
    expect(rb).toMatch(/Não\*\* usar outra porta HTTPS/);
    expect(rb).toMatch(/qode\.config\.json/);
    expect(rb).toMatch(/independentemente\*\* de `HABBLAUD_QODE_REQUIRED`/);
  });
});
