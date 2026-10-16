// Monta os coletores ligados pela config. Cada um só existe com o seu interruptor E a credencial no servidor.
import { log } from '../log';
import type { CloudConfig } from './contract';
import { CURSOR_KEY_ENV, CursorCollector } from './cursor';
import type { CloudCollector } from './source';

export function buildCloudCollectors(cfg: CloudConfig, env: NodeJS.ProcessEnv): CloudCollector[] {
  const out: CloudCollector[] = [];
  if (cfg.cursor) {
    const key = env[CURSOR_KEY_ENV]?.trim();
    if (key) out.push(new CursorCollector({ apiKey: key, cfg }));
    else log.warn(`Cloud: HABBLAUD_CLOUD_CURSOR=1 mas ${CURSOR_KEY_ENV} não está definida; coletor Cursor desligado.`);
  }
  return out;
}
