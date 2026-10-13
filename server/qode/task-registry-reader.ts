/** Leitor opt-in do registo HB-INT-01. Flag própria (HABBLAUD_TASK_REGISTRY=1), independente das demais;
 * só bind loopback; ficheiro fixo dataDir/task-registry.json; saída = projectTasks (allowlist). */
import {join} from 'node:path';
import {isLoopbackHost} from '../http/guard';
import {projectTasks, readRegistry, type TaskCard} from './task-registry';
export type TasksResponse = {enabled: false; status: 'unavailable'} | {enabled: true; status: 'unavailable'} | {enabled: true; status: 'available'; tasks: TaskCard[]};
export function setupTaskRegistry(env: NodeJS.ProcessEnv, host: string, dataDir: string, projects: readonly string[] = ['habblaud']): () => TasksResponse {
  const enabled = env.HABBLAUD_TASK_REGISTRY === '1' && isLoopbackHost(host);
  const file = join(dataDir, 'task-registry.json');
  return () => {
    if (!enabled) return {enabled: false, status: 'unavailable'};
    try { const tasks = projectTasks(readRegistry(file), {projects}); return tasks ? {enabled: true, status: 'available', tasks} : {enabled: true, status: 'unavailable'}; }
    catch { return {enabled: true, status: 'unavailable'}; }
  };
}
