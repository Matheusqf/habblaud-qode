import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTruthy, loadConfig, parseWorldConfig } from './config';
import { createRequestGuard } from './http/guard';
import { sessionsLockError } from './http/sessions';
import { hashPassword } from './remote/password';

const HASH_TEXT = await hashPassword('correct horse battery', 10);

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: '/tmp/qode-flags-home-does-not-exist',
    HABBLAUD_HOST: '127.0.0.1',
    HABBLAUD_IN_DOCKER: '0',
    HABBLAUD_UPDATE_CHECK: '0',
    ...extra,
  };
}

describe('flags QODE (World / remoto / PTY)', () => {
  it('Habblaud World fica desligado sem HABBLAUD_WORLD=1 e não aponta para server.habblaud.com', () => {
    expect(parseWorldConfig({}, [])).toEqual({ enabled: false, dev: false });
    expect(parseWorldConfig({ HABBLAUD_WORLD_URL: 'https://server.habblaud.com' }, [])).toEqual({
      enabled: false,
      dev: false,
    });
    expect(parseWorldConfig({ HABBLAUD_WORLD: '0' }, [])).toEqual({ enabled: false, dev: false });
    expect(parseWorldConfig({ HABBLAUD_WORLD: 'false' }, [])).toEqual({ enabled: false, dev: false });
    const cfg = loadConfig(baseEnv(), []);
    expect(cfg.world.enabled).toBe(false);
    expect(cfg.world.url).toBeUndefined();
    expect(JSON.stringify(cfg.world)).not.toContain('server.habblaud.com');
  });

  it('Habblaud World só liga com opt-in explícito HABBLAUD_WORLD=1', () => {
    expect(parseWorldConfig({ HABBLAUD_WORLD: '1' }, [])).toMatchObject({
      enabled: true,
      url: 'https://server.habblaud.com',
      defaultUrl: true,
    });
    expect(parseWorldConfig({ HABBLAUD_WORLD: 'true' }, []).enabled).toBe(true);
    expect(parseWorldConfig({ HABBLAUD_WORLD: 'sim' }, []).enabled).toBe(true);
    expect(loadConfig(baseEnv({ HABBLAUD_WORLD: '1' }), []).world.enabled).toBe(true);
  });

  it('remoto do celular do upstream fica desligado sem HABBLAUD_REMOTE_CELL=1, mesmo com credenciais', () => {
    const creds = {
      HABBLAUD_REMOTE_USER: 'ana',
      HABBLAUD_REMOTE_PASSWORD_HASH: HASH_TEXT,
      HABBLAUD_REMOTE_INSECURE_HTTP: '1',
    };
    const off = loadConfig(baseEnv(creds), []);
    expect(off.remote).toBeUndefined();
    expect(off.remoteWarning).toMatch(/HABBLAUD_REMOTE_CELL=1/);
    const qodeRemote = loadConfig(baseEnv({ ...creds, HABBLAUD_REMOTE: '1' }), []);
    expect(qodeRemote.remote).toBeUndefined();
    expect(qodeRemote.remoteWarning).toMatch(/HABBLAUD_REMOTE_CELL=1/);
    const on = loadConfig(baseEnv({ ...creds, HABBLAUD_REMOTE_CELL: '1' }), []);
    expect(on.remote).toMatchObject({ user: 'ana', port: 4748 });
    expect(on.remoteWarning).toBeUndefined();
  });

  it('terminal interativo e Novo agente só ligam com HABBLAUD_PTY=1', () => {
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy('')).toBe(false);
    expect(isTruthy('0')).toBe(false);
    expect(isTruthy('1')).toBe(true);
    const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    expect(src).toMatch(/const ptyOptIn = isTruthy\(ptyFlag\)/);
    expect(src).toMatch(/const spawnOn = config\.messages && ptyOptIn/);
    expect(src).toMatch(/desligado \(ligue com HABBLAUD_PTY=1\)/);
  });
});

describe('guard e permissões após o merge', () => {
  it('recusa Host estranho com mensagem i18n do QODE Office', () => {
    const chunks: Buffer[] = [];
    const res = {
      writeHead() {},
      end(body?: string | Buffer) {
        if (body) chunks.push(typeof body === 'string' ? Buffer.from(body) : body);
      },
    } as unknown as import('node:http').ServerResponse;
    const blocked = createRequestGuard()(
      { headers: { host: 'evil.example' }, method: 'GET', url: '/api/snapshot' } as import('node:http').IncomingMessage,
      res,
    );
    expect(blocked).toBe(true);
    expect(Buffer.concat(chunks).toString()).toMatch(/QODE Office/);
    expect(Buffer.concat(chunks).toString()).toMatch(/HABBLAUD_ALLOWED_HOSTS/);
  });

  it('sessionsLockError: desligado, remoto sem allow, e Host não local', () => {
    expect(sessionsLockError(false, 'localhost:4747')).toMatch(/QODE Office/);
    expect(sessionsLockError(true, 'localhost:4747', false)).toMatch(/HABBLAUD_REMOTE_ALLOW/);
    expect(sessionsLockError(true, '192.168.0.10:4747')).toMatch(/próprio computador/);
    expect(sessionsLockError(true, 'localhost:4747')).toBeUndefined();
    expect(sessionsLockError(true, 'localhost:4747', true)).toBeUndefined();
  });
});
