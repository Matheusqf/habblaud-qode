// reader.ts: SQLite do OpenCode estritamente somente leitura, sem criar, migrar nem escrever.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readOnlyRunner } from './reader';
import { parseSessions, sessionsSql } from './sessions';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Cria um banco de teste com o SQL dado (processo filho: node:sqlite pede a flag no Node 22.12). */
function makeDb(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ro-'));
  dirs.push(dir);
  const path = join(dir, 'opencode.db');
  execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);d.close();`, path, sql]);
  return path;
}

const SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, model text, agent text, title text,
  cost real DEFAULT 0, tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0, tokens_reasoning integer DEFAULT 0,
  tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0, time_created integer, time_updated integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
INSERT INTO session VALUES ('ses_1', NULL, '/p', NULL, 'build', 'SEGREDO-TITULO', 0.25, 10, 2, 0, 5, 0, 100, 200, NULL);
INSERT INTO message VALUES ('m1', 'ses_1', 150, 150, '{"role":"assistant","modelID":"glm-5.3","providerID":"opencode","time":{"completed":160}}');
`;

describe('readOnlyRunner', () => {
  it('lê sessões (sem título) de um banco válido', async () => {
    const db = makeDb(SCHEMA);
    const out = await readOnlyRunner(db)(sessionsSql(0));
    expect(out).not.toContain('SEGREDO-TITULO');
    expect(parseSessions(out)).toMatchObject([{ id: 'ses_1', model: 'opencode/glm-5.3', inferred: 'idle', costUSD: 0.25 }]);
  });

  it('banco ausente: erro sinalizado e nenhum arquivo criado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ro-'));
    dirs.push(dir);
    const path = join(dir, 'opencode.db');
    await expect(readOnlyRunner(path)(sessionsSql(0))).rejects.toThrow('banco do OpenCode ausente');
    expect(existsSync(path)).toBe(false);
  });

  it('schema antigo: erro "schema incompatível" e o arquivo continua idêntico (nada migrado)', async () => {
    const db = makeDb('CREATE TABLE session (id text PRIMARY KEY, directory text); CREATE TABLE message (id text);');
    const before = readFileSync(db);
    const mtime = statSync(db).mtimeMs;
    await expect(readOnlyRunner(db)(sessionsSql(0))).rejects.toThrow(/schema incompatível/);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(statSync(db).mtimeMs).toBe(mtime);
  });

  it('escrita é recusada pela conexão somente leitura', async () => {
    const db = makeDb(SCHEMA);
    await expect(readOnlyRunner(db)("DELETE FROM session")).rejects.toThrow(/readonly|somente leitura|falha de leitura/i);
    const out = await readOnlyRunner(db)(sessionsSql(0));
    expect(parseSessions(out)).toHaveLength(1);
  });

  it('falha de leitura (SQL inválido / arquivo corrompido) vira erro, nunca saída parcial', async () => {
    const db = makeDb(SCHEMA);
    await expect(readOnlyRunner(db)('SELECT * FROM nao_existe')).rejects.toThrow(/falha de leitura/);
  });
});
