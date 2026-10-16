// B4 PR #8 (ZikaBOT): setup padrão SÓ com <dataDir>/hooks.token (sem HABBLAUD_HOOKS_TOKEN na env).
// Os clientes suportados (mod habblaud → summary, mod habblaud-mensagens → inbox/ack, codex-bridge → poll/ack)
// têm de resolver o token pelo ficheiro e passar no auth real; sem token → 401. Sintético, tmpdir, loopback.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth, writePasswordFile, type Auth } from '../http/auth';
import { bridgeToken, httpPost, round } from '../../scripts/codex-bridge';
import { resolveModHooksToken as modSummaryToken } from '../../mod/habblaud/hooks/token';
import { resolveModHooksToken as modInboxToken } from '../../mod/habblaud-mensagens/hooks/token';
import { setQuiet } from '../log';

setQuiet(true);
let auths: Auth[] = [];
let servers: http.Server[] = [];
afterEach(async () => {
  for (const a of auths) a.dispose();
  auths = [];
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  servers = [];
});

/** Como `npm run auth:set-password`: auth.json + hooks.token (0600). Servidor sem env de token. */
async function setupFileOnly() {
  const dataDir = mkdtempSync(join(tmpdir(), 'qode-hooktok-'));
  writePasswordFile(dataDir, 'correct horse battery');
  writeFileSync(join(dataDir, 'hooks.token'), randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  const auth = createAuth({ enabled: true, dataDir }); // hooksToken ausente → lê o ficheiro
  auths.push(auth);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (auth.handle(req, res, path)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(path.endsWith('/poll') ? '{"messages":[{"id":"m1","text":"x","thread":"bad"}]}' : '{"ok":true,"messages":[]}');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { dataDir, port: (server.address() as AddressInfo).port };
}
const envOf = (o: Record<string, string>) => (k: string) => o[k];
const nodeRead = (p: string) => readFileSync(p, 'utf8');
const call = (port: number, method: string, path: string, token?: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

describe('hooks.token só em ficheiro (sem env)', () => {
  it('mod habblaud: resolve pelo ficheiro (HABBLAUD_DATA_DIR e HOME/.habblaud) → /api/mod/summary 200; sem token 401', async () => {
    const { dataDir, port } = await setupFileOnly();
    const t = await modSummaryToken(envOf({ HABBLAUD_DATA_DIR: dataDir }), nodeRead);
    expect(t).toBe(readFileSync(join(dataDir, 'hooks.token'), 'utf8').trim());
    expect((await call(port, 'GET', '/api/mod/summary', t)).status).toBe(200);
    expect((await call(port, 'GET', '/api/mod/summary')).status).toBe(401);
    // HOME padrão: <HOME>/.habblaud/hooks.token
    const home = mkdtempSync(join(tmpdir(), 'qode-home-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.habblaud'));
    writeFileSync(join(home, '.habblaud', 'hooks.token'), `${t}\n`);
    expect(await modSummaryToken(envOf({ HOME: home }), nodeRead)).toBe(t);
  });
  it('mod habblaud-mensagens: inbox e inbox/ack passam com o token do ficheiro; sem token 401', async () => {
    const { dataDir, port } = await setupFileOnly();
    const t = await modInboxToken(envOf({ HABBLAUD_DATA_DIR: dataDir }), nodeRead);
    expect(t).toBeTruthy();
    expect((await call(port, 'POST', '/api/mod/inbox', t)).status).toBe(200);
    expect((await call(port, 'POST', '/api/mod/inbox/ack', t)).status).toBe(200);
    expect((await call(port, 'POST', '/api/mod/inbox')).status).toBe(401);
  });
  it('codex-bridge: bridgeToken lê o ficheiro e poll/ack passam (round ok); sem token → refused 401', async () => {
    const { dataDir, port } = await setupFileOnly();
    const tok = bridgeToken({ HABBLAUD_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
    expect(tok).toBeTruthy();
    const seen: string[] = [];
    const post = httpPost(port, tok);
    const spy: typeof post = async (p, b) => { const r = await post(p, b); seen.push(`${p}:${r?.status}`); return r; };
    const r = await round(spy, async () => ({ ok: true }));
    expect(r.state).toBe('ok');
    expect(seen).toEqual(['/api/codex/bridge/poll:200', '/api/codex/bridge/ack:200']);
    expect(await round(httpPost(port, undefined), async () => ({ ok: true }))).toMatchObject({ state: 'refused', status: 401 });
  });
  it('regras do resolver: env curta inválida não cai no ficheiro; ficheiro curto = ausente; sem leitor = só env', async () => {
    const { dataDir } = await setupFileOnly();
    expect(await modSummaryToken(envOf({ HABBLAUD_HOOKS_TOKEN: 'curto', HABBLAUD_DATA_DIR: dataDir }), nodeRead)).toBeUndefined();
    expect(await modSummaryToken(envOf({ HABBLAUD_DATA_DIR: dataDir }))).toBeUndefined();
    writeFileSync(join(dataDir, 'hooks.token'), 'abc');
    expect(await modInboxToken(envOf({ HABBLAUD_DATA_DIR: dataDir }), nodeRead)).toBeUndefined();
    expect(bridgeToken({ HABBLAUD_DATA_DIR: dataDir } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
