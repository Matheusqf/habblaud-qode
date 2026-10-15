// Fork QODE: preflight no servidor. Só vale com HABBLAUD_QODE_REQUIRED=1; sem ela, nada muda (contrato do upstream).
// Com ela, o Habblaud recusa iniciar a ingestão quando a config QODE ausente, inválida ou ambígua deixaria
// algum projeto exposto por engano, ou quando o servidor ficaria acessível além do próprio computador.
// Mensagens não repetem caminhos dos projetos (só índices e nomes de chave).
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isLoopbackBind } from '../config';
import { configPath, parseConfig } from './config';

export function qodeRequired(env: NodeJS.ProcessEnv): boolean {
  const v = env.HABBLAUD_QODE_REQUIRED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'sim' || v === 'on';
}

export interface PreflightInput {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  home: string;
  /** HABBLAUD_HOST efetivo (Node) ou HABBLAUD_BIND (Docker). */
  host: string;
  inDocker: boolean;
  allowedHosts: ReadonlySet<string>;
}

/** Lista de problemas (vazia = pode iniciar). */
export function qodePreflight(input: PreflightInput): string[] {
  const { env, dataDir, home } = input;
  const errors: string[] = [];
  const bind = input.inDocker ? env.HABBLAUD_BIND?.trim() : input.host;
  if (!bind || !isLoopbackBind(bind)) {
    errors.push(`bind externo: ${input.inDocker ? 'HABBLAUD_BIND' : 'HABBLAUD_HOST'} precisa ser loopback (127.0.0.1, ::1 ou localhost)`);
  }
  if (input.allowedHosts.size > 0) errors.push('HABBLAUD_ALLOWED_HOSTS precisa estar vazio no perfil local (proxy/túnel não permitido)');

  const explicit = env.HABBLAUD_QODE_CONFIG?.trim();
  if (explicit !== undefined && explicit !== '' && !isAbsolute(explicit)) errors.push('HABBLAUD_QODE_CONFIG precisa ser um caminho absoluto');
  if (env.HABBLAUD_QODE_CONFIG !== undefined && !explicit) errors.push('HABBLAUD_QODE_CONFIG está definida mas vazia');
  const file = configPath(env, dataDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'erro';
    errors.push(code === 'ENOENT' ? 'config QODE ausente (verifique HABBLAUD_QODE_CONFIG)' : `config QODE ilegível (${code})`);
    return errors;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    errors.push('config QODE não é JSON válido');
    return errors;
  }
  try {
    parseConfig(raw, home, file);
  } catch (err) {
    errors.push(`config QODE inválida: ${err instanceof Error ? err.message.slice(0, 200) : 'formato inválido'}`);
  }
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const list = top && Array.isArray(top.projetos) ? top.projetos : undefined;
  if (list && list.length === 0) errors.push('"projetos" está vazio');
  for (const [i, item] of (list ?? []).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    if (typeof p.privado !== 'boolean') errors.push(`projetos[${i}]: "privado" precisa ser explícito (true ou false)`);
    for (const k of Object.keys(p)) {
      if (k === 'privado') continue;
      if (/^[_$]*priva/i.test(k)) errors.push(`projetos[${i}]: chave "${k.slice(0, 20)}" parece "privado" mal escrito ou comentado`);
    }
  }
  return errors;
}
