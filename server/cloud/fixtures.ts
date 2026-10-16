// Fixtures sintéticas da fatia 1 (nenhum dado real). Incluem canários de privacidade que NUNCA podem sair.
export const CANARY = 'CANARIO-PRIVADO-9f3a';
export const FIX_NOW = Date.parse('2026-10-16T13:00:00Z');

export const cursorListFixture = {
  items: [
    { id: 'bc-00000000-0000-0000-0000-000000000001', name: `prompt ${CANARY}`, status: 'ACTIVE', url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001', createdAt: '2026-10-16T12:50:00Z', updatedAt: '2026-10-16T12:59:00Z', latestRunId: 'run-1' },
    { id: 'bc-00000000-0000-0000-0000-000000000002', name: `outro ${CANARY}`, status: 'IDLE', url: 'https://evil.example/bc-2', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T11:00:00Z' },
    { id: 'bc-00000000-0000-0000-0000-000000000003', name: 'fora da allowlist', status: 'ACTIVE', url: 'https://cursor.com/agents/bc-3', createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T12:58:00Z' },
  ],
  nextCursor: 'bc-page2',
};
export const cursorListPage2 = {
  items: [{ id: 'bc-00000000-0000-0000-0000-000000000004', name: CANARY, status: 'ARCHIVED', url: 'https://cursor.com/agents/bc-4', createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T11:00:00Z' }],
};
export const cursorDetails: Record<string, unknown> = {
  'bc-00000000-0000-0000-0000-000000000001': { repos: [{ url: 'https://github.com/Matheusqf/habblaud-qode', startingRef: 'main' }], name: CANARY },
  'bc-00000000-0000-0000-0000-000000000002': { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] },
  'bc-00000000-0000-0000-0000-000000000003': { repos: [{ url: 'https://github.com/alguem/privado' }] },
  'bc-00000000-0000-0000-0000-000000000004': { repos: [{ url: 'https://github.com/matheusqf/habblaud-qode' }] },
};

export const codexCloudFixture = {
  tasks: [
    { id: 'task_e_abc123', url: 'https://chatgpt.com/codex/tasks/task_e_abc123', title: `t ${CANARY}`, status: 'pending', updated_at: '2026-10-16T12:59:30Z', environment_id: 'env1', environment_label: 'Matheusqf/habblaud-qode', summary: { files_changed: 1 }, is_review: false },
    { id: 'task_e_def456', url: 'https://chatgpt.com/codex/tasks/task_e_def456', title: CANARY, status: 'ready', updated_at: '2026-10-16T12:00:00Z', environment_label: 'outro/privado' },
  ],
  cursor: null,
};
