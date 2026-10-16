// Leitura do banco do OpenCode estritamente SOMENTE LEITURA (revisão ZikaBOT #24, P1).
//
// Não usa `opencode db`: na v1.19.3 ele passa pelo Database.Service do OpenCode, que aplica PRAGMAs e migrações
// antes do SELECT. Aqui abrimos o arquivo direto com node:sqlite em `readOnly: true`, num processo filho
// (node:sqlite ainda pede --experimental-sqlite no Node 22.12), sem PRAGMA nem migração:
// - banco ausente: erro, nada é criado (existsSync antes de abrir; readOnly também não cria);
// - schema antigo/incompatível: erro "schema incompatível", nada é migrado;
// - qualquer escrita é recusada pelo SQLite (conexão read-only);
// - falha de leitura vira erro (a fonte marca stale), nunca saída parcial.
// A saída do filho (linhas JSON) nunca vai para o log.
import { execFile } from 'node:child_process';

/** Colunas exigidas por tabela: sem elas o schema é tratado como incompatível (não migramos nada). */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ['id', 'parent_id', 'directory', 'model', 'agent', 'cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write', 'time_created', 'time_updated', 'time_archived'],
  message: ['session_id', 'time_created', 'data'],
};

/** Script do filho: argv = [dbPath, sql, requiredJson]. Sai com JSON das linhas no stdout ou erro curto no stderr. */
const CHILD = `
const { existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [dbPath, sql, req] = process.argv.slice(1);
const fail = (code, msg) => { process.stderr.write(msg); process.exit(code); };
if (!existsSync(dbPath)) fail(3, 'banco do OpenCode ausente');
let db;
try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { fail(4, 'falha ao abrir (somente leitura)'); }
try {
  const required = JSON.parse(req);
  for (const [table, cols] of Object.entries(required)) {
    const have = new Set(db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name));
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) fail(5, 'schema incompatível: ' + table + ' sem ' + missing.join(','));
  }
  process.stdout.write(JSON.stringify(db.prepare(sql).all()));
} catch (e) {
  fail(6, 'falha de leitura: ' + String(e && e.message || e).slice(0, 120));
} finally { try { db.close(); } catch {} }
`;

/** Runner somente leitura para o banco em `dbPath` (mesma forma de `run` do OpenCodeSource). */
export function readOnlyRunner(dbPath: string, nodeBin = process.execPath): (sql: string) => Promise<string> {
  return (sql: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        nodeBin,
        ['--experimental-sqlite', '--no-warnings', '-e', CHILD, dbPath, sql, JSON.stringify(REQUIRED_COLUMNS)],
        { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
        (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 200) || 'falha de leitura'));
          else resolve(stdout);
        },
      );
    });
}
