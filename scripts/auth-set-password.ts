// B4 L1: define a senha do operador (hash scrypt em <dataDir>/auth.json, 0600) e cria <dataDir>/hooks.token se faltar.
// Uso: npm run auth:set-password   (lê a senha do stdin; nunca de argv para não ir ao histórico do shell)
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from '../server/config';
import { MIN_PASSWORD, writePasswordFile } from '../server/http/auth';

const { dataDir } = loadConfig();
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
const pw = await ask(`Nova senha (≥${MIN_PASSWORD}): `);
const again = await ask('Repita: ');
rl.close();
if (pw !== again) {
  console.error('As senhas não coincidem.');
  process.exit(1);
}
writePasswordFile(dataDir, pw);
const tok = join(dataDir, 'hooks.token');
if (!existsSync(tok)) writeFileSync(tok, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
console.log(`Senha gravada em ${join(dataDir, 'auth.json')}. Token dos hooks: ${tok}. Ligue com HABBLAUD_AUTH=1.`);
