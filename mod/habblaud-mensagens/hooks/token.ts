// B4: token Bearer dos hooks do mod: HABBLAUD_HOOKS_TOKEN, senão <HABBLAUD_DATA_DIR|HOME/.habblaud>/hooks.token
// (o ficheiro que `npm run auth:set-password` cria). Mesma regra do servidor/permission-hook/codex-bridge:
// env curto (<32) = inválido (não cai no ficheiro); ficheiro com <32 chars = ausente. Sem imports: puro e testável.
export type EnvGet = (key: string) => Promise<string | undefined> | string | undefined
export type ReadText = (path: string) => Promise<string | undefined> | string | undefined

export async function resolveModHooksToken(env: EnvGet, read?: ReadText): Promise<string | undefined> {
  const direct = (await env('HABBLAUD_HOOKS_TOKEN'))?.trim()
  if (direct) return direct.length >= 32 ? direct : undefined
  if (!read) return undefined
  const home = (await env('HOME'))?.trim() || (await env('USERPROFILE'))?.trim()
  const dir = (await env('HABBLAUD_DATA_DIR'))?.trim()?.replace(/[\\/]+$/, '') || (home ? `${home.replace(/[\\/]+$/, '')}/.habblaud` : undefined)
  if (!dir) return undefined
  try {
    const t = (await read(`${dir}/hooks.token`))?.trim()
    return t && t.length >= 32 ? t : undefined
  } catch {
    return undefined
  }
}

/** Leitor de ficheiro do engine do Claude Code, se esta versão o expõe ($.fs.read); senão undefined (só env). */
export function engineReader($: unknown): ReadText | undefined {
  const fs = ($ as { fs?: { read?: (p: string) => unknown } })?.fs
  if (typeof fs?.read !== 'function') return undefined
  return async (p) => {
    const v = await fs.read!(p)
    return typeof v === 'string' ? v : (v as { text?: unknown })?.text as string | undefined
  }
}
