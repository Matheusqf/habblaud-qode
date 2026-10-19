// Review ZikaBOT pós-#13/#14 P1: nomes de agente/conta e feed.agentName são texto livre (overrides, e-mail, caminho).
// Na entrada só-leitura saem SÓ pseudónimos estáveis ('Agente N', 'Conta X'), iguais no snapshot, SSE e feed.
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AccountInfo, AgentInfo, FeedItem, OfficeSnapshot } from '../../shared/types';
import { createRemoteDto } from './remote-dto';
import { createRemoteView, type RemoteViewHub } from './remote-view';
import type { HubEvent } from './sse';

const EMAIL = 'dono.canario@exemplo.com';
const MAC = '/Users/matheus-canario/projetos/segredo';
const LINUX = '/home/canario/.claude-pessoal';
const WIN = 'C:\\Users\\canario\\work';
const CANARIES = [EMAIL, MAC, LINUX, WIN, 'canario', '@exemplo.com', '/Users/', '/home/', 'C:\\'];

function agent(id: string, name: string, account: string, kind: AgentInfo['kind'] = 'main', parentId?: string): AgentInfo {
  return { id, kind, name, account, roomId: 'loja', sessionId: `sess-${id}`, status: 'working', role: name, startedAt: 1, lastEventAt: 1, statusSince: 1, look: 0, seed: 1, recent: [], tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, ...(parentId ? { parentId } : {}) } as unknown as AgentInfo;
}
function account(id: string, short: string, name: string): AccountInfo {
  return { id, short, name, email: EMAIL, color: '#f08a3c', configDir: LINUX, sessions: 1, usageStatus: 'ok' } as AccountInfo;
}
function snap(agents: AgentInfo[], accounts: AccountInfo[]): OfficeSnapshot {
  return { rev: 1, serverTime: 1, rooms: [{ id: 'loja', name: 'Loja', path: 'Loja', slot: 0, seed: 1, createdAt: 1 }], agents, accounts, meta: { demo: false, sources: [], startedAt: 1, version: 't', terminal: true, messages: true } } as unknown as OfficeSnapshot;
}
function feed(agentId: string, agentName: string): FeedItem {
  return { id: `f-${agentId}`, agentId, roomId: 'loja', agentName, roomName: 'Loja', account: '.claude', activity: { id: 'x', kind: 'read', icon: '📖', text: `Lendo ${MAC}`, at: 1 } } as FeedItem;
}
const noLeak = (s: string) => {
  for (const c of CANARIES) expect(s, c).not.toContain(c);
};

const AGENTS = [agent('.claude:s1', EMAIL, '.claude'), agent('.claude-pessoal:s2', MAC, '.claude-pessoal'), agent('.claude:s1/sub', WIN, '.claude', 'sub', '.claude:s1')];
const ACCOUNTS = [account('.claude', EMAIL, MAC), account('.claude-pessoal', LINUX, `Conta ${EMAIL}`)];

describe('DTO remoto: pseudónimos para nomes de agente/conta (canários e-mail/caminho)', () => {
  it('snapshot: agent.name e account.short/name nunca saem; rótulos genéricos e estáveis', () => {
    const dto = createRemoteDto();
    const out = dto.snapshot(snap(AGENTS, ACCOUNTS));
    noLeak(JSON.stringify(out));
    expect(out.agents.map((a) => a.name)).toEqual(['Agente 1', 'Agente 2', 'Agente 3']);
    expect(out.accounts.map((a) => [a.short, a.name])).toEqual([['A', 'Conta A'], ['B', 'Conta B']]);
    // Estável: outra emissão (ordem trocada) mantém o rótulo de cada id.
    const again = dto.snapshot(snap([...AGENTS].reverse(), [...ACCOUNTS].reverse()));
    expect(again.agents.map((a) => a.name)).toEqual(['Agente 3', 'Agente 2', 'Agente 1']);
    expect(again.accounts.map((a) => a.name)).toEqual(['Conta B', 'Conta A']);
    // Projeto público: o nome da sala decidido pelo filtro QODE continua (exceção já aprovada, não reaberta).
    expect(out.rooms[0].name).toBe('Loja');
  });

  it('feed: agentName vira o MESMO pseudónimo do agente no snapshot', () => {
    const dto = createRemoteDto();
    const s = dto.snapshot(snap(AGENTS, ACCOUNTS));
    const f = dto.feed([feed('.claude-pessoal:s2', MAC), feed('.claude:s1', EMAIL), feed('.desconhecido:s9', `${EMAIL} ${WIN}`)]);
    noLeak(JSON.stringify(f));
    expect(f.map((x) => x.agentName)).toEqual(['Agente 2', 'Agente 1', 'Agente 4']);
    expect(f[0].agentId).toBe(s.agents[1].id);
    expect(f[0].roomName).toBe('Loja');
    for (const x of f) expect(x).not.toHaveProperty('account');
  });

  it('SSE (vista remota): snapshot inicial, feed e atualizações sem canários', async () => {
    const dto = createRemoteDto();
    let listener: ((ev: HubEvent) => void) | undefined;
    const hub: RemoteViewHub = {
      current: () => snap(AGENTS, ACCOUNTS),
      recentFeed: () => [feed('.claude:s1', EMAIL)],
      observe: (cb) => ((listener = cb), () => (listener = undefined)),
    };
    const view = createRemoteView({ hub, dto, pingMs: 60_000 });
    const sock = { setTimeout: () => undefined, setNoDelay: () => undefined };
    const req = Object.assign(new PassThrough(), { socket: sock }) as unknown as IncomingMessage;
    const body = new PassThrough();
    let out = '';
    body.on('data', (c: Buffer) => (out += c.toString()));
    const res = Object.assign(body, { writeHead: () => res }) as unknown as ServerResponse;
    view.attach(req, res);
    listener?.({ type: 'snapshot', data: snap([...AGENTS, agent('.claude:s3', `${MAC}/novo`, '.claude')], ACCOUNTS) } as HubEvent);
    listener?.({ type: 'feed', data: [feed('.claude:s3', `${EMAIL} em ${LINUX}`)] } as HubEvent);
    await new Promise((r) => setImmediate(r));
    view.stop();
    expect(out).toContain('event: snapshot');
    expect(out).toContain('event: feed');
    expect(out).toContain('Agente 4');
    expect(out).toContain('Conta A');
    noLeak(out);
  });

  it('snapshot via vista remota (GET /api/snapshot) sem canários', () => {
    const dto = createRemoteDto();
    const hub: RemoteViewHub = { current: () => snap(AGENTS, ACCOUNTS), recentFeed: () => [], observe: () => () => undefined };
    const view = createRemoteView({ hub, dto, pingMs: 60_000 });
    let out = '';
    const res = { writeHead: () => res, end: (b: string) => (out = b) } as unknown as ServerResponse;
    view.snapshot(res);
    view.stop();
    noLeak(out);
    expect(JSON.parse(out).agents[0].name).toBe('Agente 1');
  });
});
