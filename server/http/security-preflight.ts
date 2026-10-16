// B4: preflight de segurança — corre SEMPRE quando HABBLAUD_AUTH / HABBLAUD_REMOTE / ALLOWED_HOSTS
// (não depende de HABBLAUD_QODE_REQUIRED). Rejeita configs inseguras antes de arrancar serviços.
import { existsSync } from 'node:fs';
import { isLoopbackBind } from '../config';
import { authEnabled, authFile, remoteEnabled } from './auth';

export interface SecurityPreflightInput {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  host: string;
  inDocker: boolean;
  /** true = Vite middleware / npm run dev. */
  dev: boolean;
  allowedHosts: ReadonlySet<string>;
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

  if (!auth && !remote) return errors;

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

  if (!existsSync(authFile(input.dataDir))) {
    errors.push('senha ausente: rode `npm run auth:set-password` antes de HABBLAUD_AUTH/HABBLAUD_REMOTE');
  }

  if (remote && input.dev) {
    errors.push('HABBLAUD_REMOTE=1 não permite modo dev/Vite (use build de produção)');
  }

  return errors;
}
