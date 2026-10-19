// B4: preflight de segurança — corre SEMPRE quando HABBLAUD_AUTH / HABBLAUD_REMOTE / ALLOWED_HOSTS
// (não depende de HABBLAUD_QODE_REQUIRED). Rejeita configs inseguras antes de arrancar serviços.
import { lstatSync } from 'node:fs';
import { isLoopbackBind, isTruthy } from '../config';
import { authEnabled, authFile, loadAuthFile, remoteEnabled, resolveHooksToken } from './auth';

export interface SecurityPreflightInput {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  host: string;
  inDocker: boolean;
  /** true = Vite middleware / npm run dev. */
  dev: boolean;
  allowedHosts: ReadonlySet<string>;
}

/**
 * Problemas do auth.json (vazio = presente, ficheiro regular e válido). Partilhado com o preflight da entrada
 * só-leitura (remote-ro.ts), que depende do MESMO auth.json para o login.
 */
export function authFileProblems(dataDir: string, flags = 'HABBLAUD_AUTH/HABBLAUD_REMOTE'): string[] {
  let present = false;
  try {
    lstatSync(authFile(dataDir));
    present = true;
  } catch {
    /* ausente */
  }
  if (!present) return [`senha ausente: rode \`npm run auth:set-password\` antes de ${flags}`];
  if (!loadAuthFile(dataDir))
    return ['auth.json inválido: precisa ser ficheiro regular com registo scrypt/parâmetros/hash/generation válidos (rode `npm run auth:set-password`)'];
  return [];
}

/** Lista de problemas (vazia = pode iniciar). */
export function securityPreflight(input: SecurityPreflightInput): string[] {
  const { env } = input;
  const errors: string[] = [];
  const auth = authEnabled(env);
  const remote = remoteEnabled(env);
  const authFlag = ['1', 'true', 'sim', 'on'].includes(env.HABBLAUD_AUTH?.trim().toLowerCase() ?? '');

  // ALLOWED_HOSTS sem auth deixa o Host aberto a nomes externos — footgun. Fail-closed.
  if (input.allowedHosts.size > 0 && !authFlag) {
    errors.push('HABBLAUD_ALLOWED_HOSTS exige HABBLAUD_AUTH=1 (hosts extras sem auth não são permitidos)');
  }

  if (!auth && !remote) {
    // Review ZikaBOT pós-#13/#14 P2: só HABBLAUD_REMOTE_RO (sem AUTH/REMOTE) também exige auth.json válido —
    // fail-closed no boot, não só login recusado depois.
    if (isTruthy(env.HABBLAUD_REMOTE_RO)) errors.push(...authFileProblems(input.dataDir, 'HABBLAUD_REMOTE_RO'));
    return errors;
  }

  // Remoto fail-closed: precisa AUTH explícita (não basta HABBLAUD_REMOTE sozinho no authEnabled).
  if (remote && !authFlag) {
    errors.push('HABBLAUD_REMOTE=1 exige HABBLAUD_AUTH=1 (remoto sem auth é recusado)');
  }

  const bind = input.inDocker ? env.HABBLAUD_BIND?.trim() : input.host;
  if (!bind || !isLoopbackBind(bind)) {
    errors.push(`bind externo: ${input.inDocker ? 'HABBLAUD_BIND' : 'HABBLAUD_HOST'} precisa ser loopback com auth/remoto (127.0.0.1, ::1 ou localhost)`);
  }

  if (input.allowedHosts.size > 0) {
    // L1/L2 local+Serve TBD: hosts extras ainda não estão no perfil canónico.
    errors.push('HABBLAUD_ALLOWED_HOSTS precisa estar vazio enquanto o perfil remoto canónico não estiver definido (Tailscale Serve TBD)');
  }

  errors.push(...authFileProblems(input.dataDir));
  if (!resolveHooksToken(input.dataDir, input.env.HABBLAUD_HOOKS_TOKEN)) {
    errors.push('token de hooks ausente/inválido: HABBLAUD_HOOKS_TOKEN (≥32) ou <dataDir>/hooks.token regular (rode `npm run auth:set-password`)');
  }

  if (remote && input.dev) {
    errors.push('HABBLAUD_REMOTE=1 não permite modo dev/Vite (use build de produção)');
  }

  return errors;
}
