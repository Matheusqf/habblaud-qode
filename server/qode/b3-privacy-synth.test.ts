// B3 — suite sintética de privacidade (fixtures only; nada de Vida/UBOTS/Wellhub reais).
// Mede: relativo, variáveis, paste sem caminho, symlink, delegação, persistência (restart simulado), logs.
// NÃO cobre SSE nem isolamento remoto; ver docs/QODE-B3-LIMITACOES.md.
// `it` = proteção verificada; `it.fails` = gap reproduzido (passa enquanto o gap existir; quando corrigido, vira `it`).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '../../shared/types';
import { log, setLogFilter, setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { tempDir } from '../test/fixtures';
import { mentionsPrivate } from './config';
import { setupQode } from './index';

setQuiet(true);
const CANARY = 'QODE_CANARY_B3_SYNTH';
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  setLogFilter(undefined);
  setQuiet(true);
  vi.restoreAllMocks();
});

function world(dir?: string) {
  const tmp = dir ? undefined : tempDir('habblaud-qode-b3-');
  const root = dir ?? tmp!.dir;
  if (tmp) cleanups.push(tmp.cleanup);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const priv = join(home, 'Documents', 'PrivadoSintetico');
  const pub = join(home, 'Documents', 'PublicoSintetico');
  mkdirSync(priv, { recursive: true });
  mkdirSync(pub, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'qode.config.json'),
    JSON.stringify({ projetos: [{ nome: 'PublicoSintetico', caminhos: [pub], privado: false }, { nome: 'PrivadoSintetico', caminhos: [priv], privado: true }] }),
  );
  const aliases = new RoomAliases(null);
  let office!: Office;
  const qode = setupQode({ env: {}, dataDir, home, roomAliases: aliases, office: () => office });
  office = new Office({
    names: new NameStore(null),
    roomAlias: (p) => aliases.get(p),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: true,
    permissions: () => new Map(),
    roomOf: qode.roomOf,
    privacy: qode.privacy,
  });
  return { root, home, priv, pub, office, qode, cfg: qode.config! };
}

const act = (over: Partial<Activity> = {}): Activity => ({ id: `a${Math.random()}`, kind: 'read', icon: '📖', text: 'Lendo', at: Date.now(), ...over });
const mainAt = (w: ReturnType<typeof world>, id: string, cwd: string, sessionId = `s-${id}`) =>
  w.office.addMain({ id, account: '.claude', sessionId, cwd, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
const leaks = (w: ReturnType<typeof world>) => JSON.stringify(w.office.commit().snapshot).includes(CANARY);

describe('B3 relativo e variáveis', () => {
  it('relativo ../../Documents/PrivadoSintetico detetado (hardening B3)', () => {
    expect(mentionsPrivate(world().cfg, `cat ../../Documents/PrivadoSintetico/${CANARY}`)).toBe(true);
  });
  it('relativo ./PrivadoSintetico a partir de Documents detetado', () => {
    expect(mentionsPrivate(world().cfg, `cd ~/Documents && cat ./PrivadoSintetico/x`)).toBe(true);
  });
  it('$VAR/PrivadoSintetico detetado (hardening B3)', () => {
    expect(mentionsPrivate(world().cfg, `cat $D/PrivadoSintetico/${CANARY}`)).toBe(true);
  });
  it.fails('gap: relativo sem barra antes do nome (cd PrivadoSintetico) não deteta', () => {
    expect(mentionsPrivate(world().cfg, `cd PrivadoSintetico && cat ${CANARY}`)).toBe(true);
  });
  it.fails('gap: nome montado por variável (P=Privado; $P"Sintetico") não deteta', () => {
    expect(mentionsPrivate(world().cfg, `P=Privado; cat ~/Documents/$P"Sintetico"/x`)).toBe(true);
  });
  it('controlo: nome parecido não contamina (PrivadoSinteticoX)', () => {
    expect(mentionsPrivate(world().cfg, `cat /tmp/PrivadoSinteticoX/y`)).toBe(false);
  });
});

describe('B3 paste sem caminho', () => {
  it.fails('gap: canário colado em agente público sai no snapshot (sem marcador de conteúdo)', () => {
    const w = world();
    mainAt(w, 'p', w.pub);
    w.office.applyTranscript('p', { title: `colei ${CANARY}`, tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } });
    expect(leaks(w)).toBe(false);
  });
});

describe('B3 symlink', () => {
  it('symlink fora da home apontando para pasta privada contamina', () => {
    const w = world();
    const link = join(w.root, 'atalho');
    symlinkSync(w.priv, link);
    expect(mentionsPrivate(w.cfg, `cat ${link}/${CANARY}`)).toBe(true);
  });
});

describe('B3 delegação', () => {
  it('subagente que cita privado contamina o principal e irmãos', () => {
    const w = world();
    mainAt(w, 'm', w.pub);
    w.office.addSub({ id: 'm:a', parentId: 'm', sessionId: 's-m', role: 'Subagente', startedAt: Date.now() } as never);
    w.office.addSub({ id: 'm:b', parentId: 'm', sessionId: 's-m', role: 'Subagente', startedAt: Date.now() } as never);
    w.office.addActivity('m:a', act({ detail: join(w.priv, CANARY) }), true);
    w.office.addActivity('m:b', act({ text: `irmão ${CANARY}` }), true);
    expect(leaks(w)).toBe(false);
  });
});

describe('B3 persistência — invariante atual (mesmo processo)', () => {
  it('taint inicial: agente que lê pasta privada fica privado', () => {
    const tmp = tempDir('habblaud-qode-b3-restart-');
    cleanups.push(tmp.cleanup);
    const a = world(tmp.dir);
    mainAt(a, 'm', a.pub, 'sess');
    a.office.addActivity('m', act({ detail: join(a.priv, 'x') }), true);
    expect(a.qode.privacy!.isPrivate('m')).toBe(true);
  });
});

// LIMITE: isto NÃO é um restart real (sem novo processo nem replay de transcript/hooks). Só prova que o taint não
// está em disco: um segundo setupQode no mesmo dataDir começa limpo. Restart/replay real fica em aberto (ver doc).
describe('B3 persistência — gap (restart simulado no mesmo processo)', () => {
  it.fails('gap: novo setupQode no mesmo dataDir não herda o taint da sessão', () => {
    const tmp = tempDir('habblaud-qode-b3-restart-');
    cleanups.push(tmp.cleanup);
    const a = world(tmp.dir);
    mainAt(a, 'm', a.pub, 'sess');
    a.office.addActivity('m', act({ detail: join(a.priv, 'x') }), true);
    const b = world(tmp.dir);
    mainAt(b, 'm', b.pub, 'sess');
    expect(b.qode.privacy!.isPrivate('m')).toBe(true);
  });
});

describe('B3 logs', () => {
  it('log com caminho relativo privado é redigido', () => {
    const w = world();
    setQuiet(false);
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: string) => void lines.push(m));
    log.warn(`falhou ../Documents/PrivadoSintetico/${CANARY}`);
    expect(lines.join('\n')).not.toContain(CANARY);
    void w;
  });
});
