// Monta os coletores ligados pela config. Fatia 1: nenhum (contrato + fixtures só). Fatias 2/3 acrescentam.
import type { CloudConfig } from './contract';
import type { CloudCollector } from './source';

export function buildCloudCollectors(_cfg: CloudConfig, _env: NodeJS.ProcessEnv): CloudCollector[] {
  return [];
}
