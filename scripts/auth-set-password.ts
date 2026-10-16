// B4 L1: define a senha do operador (hash scrypt em <dataDir>/auth.json, 0600) e cria <dataDir>/hooks.token se faltar.
// Uso: npm run auth:set-password   (lê a senha do stdin SEM eco; nunca de argv para não ir ao histórico do shell)
// Rotação: cada gravação muda `generation` em auth.json — o servidor vivo revoga cookies/SSE ao detectar.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline';
import { loadConfig } from '../server/config';
import { MIN_PASSWORD, writePasswordFile } from '../server/http/auth';

/** Lê uma linha sem eco (TTY). Em pipe (testes/CI) cai no readline normal. */
async function readSecret(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    const rl = createInterface({ input, output, terminal: false });
    const line = await new Promise<string>((resolve) => {
      output.write(prompt);
      rl.once('line', (l) => {
        rl.close();
        resolve(l);
      });
    });
    return line;
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  let buf = '';
  return await new Promise<string>((resolve, reject) => {
    const onData = (ch: string) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        output.write('\n');
        resolve(buf);
        return;
      }
      if (ch === '\u0003') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        output.write('\n');
        reject(new Error('cancelado'));
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
        return;
      }
      // Ignora escapes/controlo; não ecoa caracteres.
      if (ch < ' ' && ch !== '\t') return;
      buf += ch;
    };
    input.on('data', onData);
  });
}

const { dataDir } = loadConfig();
let pw: string;
let again: string;
try {
  pw = await readSecret(`Nova senha (≥${MIN_PASSWORD}): `);
  again = await readSecret('Repita: ');
} catch {
  console.error('Cancelado.');
  process.exit(1);
}
if (pw !== again) {
  console.error('As senhas não coincidem.');
  process.exit(1);
}
if (pw.length < MIN_PASSWORD) {
  console.error(`A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`);
  process.exit(1);
}
writePasswordFile(dataDir, pw);
const tok = join(dataDir, 'hooks.token');
if (!existsSync(tok)) writeFileSync(tok, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
console.log(`Senha gravada em ${join(dataDir, 'auth.json')} (generation nova — sessões anteriores inválidas). Token dos hooks: ${tok}. Ligue com HABBLAUD_AUTH=1.`);
