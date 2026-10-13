import * as fs from 'node:fs';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEntry } from '../../shared/types';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { setLogFilter } from '../log';
import { FileTail } from '../sources/tail';
import { createTerminalParser } from '../sources/terminal';
import { parseConfig } from './config';
import { PRIVATE_SESSION_ERROR, setupQode, TranscriptScanner } from './index';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setLogFilter(undefined);
  vi.restoreAllMocks();
});

function line(type: string, content: string): string {
  return JSON.stringify({
    type,
    uuid: `${type}-test`,
    timestamp: '2026-10-12T00:00:00.000Z',
    sessionId: 'sess-test',
    cwd: '/tmp/public-project',
    message: { role: type, content },
  });
}

function qodeFor(home: string, dataDir: string) {
  writeFileSync(join(dataDir, 'qode.config.json'), JSON.stringify({ projetos: [{ nome: 'Vida', caminhos: ['~/private'], privado: true }] }));
  let office!: Office;
  const aliases = new RoomAliases(null);
  const qode = setupQode({ env: {}, dataDir, home, roomAliases: aliases, office: () => office });
  office = new Office({
    names: new NameStore(null),
    roomAlias: (p) => aliases.get(p),
    version: 'test',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: true,
    roomOf: qode.roomOf,
    privacy: qode.privacy,
  });
  return qode;
}

describe('scanner de privacidade e transcript incremental', () => {
  it('revalida o prefixo reescrito antes de history.resolve e fecha o terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-scanner-'));
    roots.push(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const privatePath = join(home, 'private', 'segredo.md');
    const file = join(root, 'session.jsonl');
    const qode = qodeFor(home, dataDir);
    const inner = {
      list: async () => [],
      resolve: () => ({ path: file, createParser: () => createTerminalParser() }),
    };
    const history = qode.history(inner);

    writeFileSync(file, `${line('user', 'conversa pública')}${' '.repeat(900)}\n`);
    expect(history.resolve('.claude', 'sess-test')).toEqual({ path: file, createParser: expect.any(Function) });

    const sentinel = 'SENTINELA-TAIL-PRIVACY-7f3a9c';
    const prefix = `${line('user', `cat ${privatePath}`)}\n`;
    const paddingLine = JSON.stringify({ type: 'assistant', uuid: 'padding', sessionId: 'sess-test', message: { role: 'assistant', content: [{ type: 'text', text: 'padding '.repeat(1500) }] } });
    const padding = `${paddingLine}\n`.repeat(450);
    const finalMessage = `${line('user', sentinel)}\n`;
    writeFileSync(file, prefix + padding + finalMessage);
    expect(Buffer.byteLength(prefix + padding + finalMessage)).toBeGreaterThan(4 * 1024 * 1024);

    // O leitor que alimenta o terminal começa no fim e, portanto, encontra o sentinela sem o prefixo.
    const tail = new FileTail(file);
    const offset = tail.seekTail(4 * 1024 * 1024);
    expect(offset).toBeGreaterThan(Buffer.byteLength(prefix));
    const parser = createTerminalParser();
    const entries: TerminalEntry[] = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const raw of r.lines) entries.push(...parser.push(raw));
      if (!r.more) break;
    }
    expect(entries.some((e) => 'text' in e && e.text === sentinel)).toBe(true);

    // O scanner valida o prefixo antigo no mesmo inode antes de admitir o tail.
    expect(history.resolve('.claude', 'sess-test')).toEqual({ status: 404, error: PRIVATE_SESSION_ERROR });
  });

  it('reavalia crescimento e encontra bytes privados no sufixo', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-scanner-short-'));
    roots.push(root);
    const file = join(root, 'session.jsonl');
    writeFileSync(file, `${line('user', 'pública')}\n`);
    const scanner = new TranscriptScanner((text) => text.includes('/private/'));
    expect(scanner.scan(file)).toBe('clean');
    writeFileSync(file, `${line('user', 'pública')}\n${line('user', 'continuação /private/segredo')}\n`);
    expect(scanner.scan(file)).toBe('hit');
  });

  it('falha e recupera quando readSync retorna zero antes do fim', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-scanner-zero-'));
    roots.push(root);
    const file = join(root, 'session.jsonl');
    writeFileSync(file, `${line('user', 'pública')}\n`);
    const scanner = new TranscriptScanner((text) => text.includes('/private/'));
    vi.spyOn(fs, 'readSync').mockImplementationOnce(() => 0);
    expect(scanner.scan(file)).toBe('error');
    expect(scanner.scan(file)).toBe('clean');
  });

  it('preserva UTF-8 incompleto entre polls e encontra caminho privado com é', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-scanner-utf8-'));
    roots.push(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const qode = qodeFor(home, dataDir);
    // O alias nasce depois do setup: não está aquecido em privateAliases.
    mkdirSync(join(home, 'private'), { recursive: true });
    const alias = join(home, 'alias-é');
    symlinkSync(join(home, 'private'), alias);
    const privatePath = join(alias, 'segredo.md');
    const file = join(root, 'session.jsonl');
    const scanner = new TranscriptScanner((text) => qode.privacy!.mentions(text));
    const prefix = Buffer.from(`${line('user', `cat ${privatePath}`)}`);
    const split = prefix.indexOf(Buffer.from('é')) + 1;
    writeFileSync(file, Buffer.concat([prefix.subarray(0, split)]));
    expect(scanner.scan(file)).toBe('error');
    appendFileSync(file, Buffer.concat([prefix.subarray(split), Buffer.from('\n')]));
    expect(scanner.scan(file)).toBe('hit');
  });

  it('detecta reescrita no meio do prefixo com o mesmo inode e tamanho', () => {
    const root = mkdtempSync(join(tmpdir(), 'habblaud-scanner-middle-'));
    roots.push(root);
    const file = join(root, 'session.jsonl');
    const width = 8_190;
    const publicLine = (i: number) => `public-${i}-${'x'.repeat(width)}\n`;
    const old = Array.from({ length: 320 }, (_, i) => publicLine(i)).join('');
    writeFileSync(file, old);
    const scanner = new TranscriptScanner((text) => text.includes('/private/'));
    expect(scanner.scan(file)).toBe('clean');
    const oldLine = publicLine(240);
    const at = old.indexOf(oldLine);
    const replacement = `/private/segredo-${'x'.repeat(oldLine.length - 1 - '/private/segredo-'.length)}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(oldLine));
    writeFileSync(file, old.slice(0, at) + replacement + old.slice(at + Buffer.byteLength(oldLine)));
    expect(scanner.scan(file)).toBe('hit');
  });
});
