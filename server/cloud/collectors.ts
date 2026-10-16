// Monta os coletores ligados pela config. Cada um só existe com o seu interruptor E a credencial no servidor.
import { log } from '../log';
import type { CloudConfig } from './contract';
import { findCodexBin } from '../messages/codex';
import { CodexCloudCollector } from './codex-cloud';
import { CURSOR_KEY_ENV, CursorCollector } from './cursor';
import type { CloudCollector } from './source';

export function buildCloudCollectors(cfg: CloudConfig, env: NodeJS.ProcessEnv): CloudCollector[] {
  const out: CloudCollector[] = [];
  if (cfg.cursor) {
    const key = env[CURSOR_KEY_ENV]?.trim();
    if (key) out.push(new CursorCollector({ apiKey: key, cfg }));
    else log.warn(`Cloud: HABBLAUD_CLOUD_CURSOR=1 mas ${CURSOR_KEY_ENV} não está definida; coletor Cursor desligado.`);
  }
  if (cfg.codex) {
    const bin = findCodexBin(env);
    if (bin) out.push(new CodexCloudCollector({ bin, cfg, pinnedVersion: env.HABBLAUD_CLOUD_CODEX_VERSION?.trim() || undefined }));
    else log.warn('Cloud: HABBLAUD_CLOUD_CODEX=1 mas o CLI `codex` não foi encontrado (HABBLAUD_CODEX_BIN ou PATH).');
  }
  return out;
}
