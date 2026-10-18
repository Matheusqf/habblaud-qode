import { describe, expect, it } from 'vitest';
import { accountChipLabel, fallbackShort, showsProviderTag } from './provider';

describe('ferramenta OpenCode (olho próprio, sem cair no Claude)', () => {
  it('letra do chip sem a conta no snapshot: "O" quando não há letra; Codex e Claude intactos', () => {
    expect(fallbackShort('...', 'opencode')).toBe('O');
    expect(fallbackShort('', 'opencode')).toBe('O');
    expect(fallbackShort('~2', 'opencode')).toBe('O');
    expect(fallbackShort('minha-conta', 'opencode')).toBe('M');
    expect(fallbackShort('')).toBe('?');
    expect(fallbackShort('.codex')).toBe('X');
    expect(fallbackShort('...', 'codex')).toBe('X');
  });

  it('selo "OpenCode": só no OpenCode, e sem repetir o nome da conta (sem distinção de maiúsculas)', () => {
    expect(showsProviderTag('opencode', 'Conta O')).toBe(true);
    expect(showsProviderTag('opencode', 'OpenCode')).toBe(false);
    expect(showsProviderTag('opencode', 'Demo opencode')).toBe(false);
    expect(showsProviderTag('opencode', 'OPENCODE-work')).toBe(false);
    expect(showsProviderTag('opencode', 'Codex')).toBe(true);
    expect(showsProviderTag('claude', 'Conta C')).toBe(false);
    expect(showsProviderTag('codex', 'Conta X')).toBe(true);
    expect(showsProviderTag('codex', 'Codex')).toBe(false);
  });

  it('rótulo do chip: " · OpenCode" como no Codex; Codex e Claude inalterados', () => {
    expect(accountChipLabel({ name: 'Conta O', plan: 'Pro', provider: 'opencode' }, '.opencode', 'opencode')).toBe('Conta O · OpenCode · plano Pro');
    expect(accountChipLabel({ name: 'OpenCode', plan: 'Pro', provider: 'opencode' }, '.opencode', 'opencode')).toBe('OpenCode · plano Pro');
    expect(accountChipLabel({ name: 'Conta O', provider: 'opencode' }, '.opencode', 'opencode')).toBe('Conta O · OpenCode');
    expect(accountChipLabel(undefined, 'demo:.opencode', 'opencode')).toBe('demo:.opencode · OpenCode');
    expect(accountChipLabel({ name: 'Conta C', email: 'a@b.c' }, '.claude', 'claude')).toBe('Conta C (a@b.c)');
    expect(accountChipLabel({ name: 'Conta X', plan: 'Team', provider: 'codex' }, '.codex', 'codex')).toBe('Conta X · Codex · plano Team');
    expect(accountChipLabel(undefined, '.codex', 'codex')).toBe('.codex · Codex');
    expect(accountChipLabel(undefined, '', 'opencode')).toBe('Conta desconhecida');
  });
});
