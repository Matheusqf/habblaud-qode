// Areas por projeto: mapeia pastas/repos para uma área nomeada do escritório (rótulo da sala).
//
// Ideia adaptada de pixel-agents (https://github.com/pixel-agents-hq/pixel-agents, MIT,
// Copyright (c) 2026 Pablo De Lucca) — "Areas: paint named areas onto the office, map
// workspace folders to them". Implementação própria, sem código copiado; ver NOTICE.md.
//
// Puro: longest-prefix match sobre caminhos normalizados (separador '/', sem barra final).

export interface AreaDef {
  /** Nome exibido da área (ex.: "Singolo"). */
  name: string;
  /** Pastas (absolutas ou com ~) cujos projetos pertencem à área. */
  paths: string[];
}

function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

/** Área do caminho (prefixo mais longo, respeitando fronteira de pasta); undefined se nenhuma. */
export function areaFor(path: string, areas: readonly AreaDef[], home?: string): AreaDef | undefined {
  const p = norm(path);
  let best: AreaDef | undefined;
  let bestLen = -1;
  for (const a of areas) {
    for (const raw of a.paths) {
      let q = raw.startsWith('~') && home ? home + raw.slice(1) : raw;
      q = norm(q);
      if (!q) continue;
      if ((p === q || p.startsWith(q === '/' ? '/' : q + '/')) && q.length > bestLen) {
        best = a;
        bestLen = q.length;
      }
    }
  }
  return best;
}

/** Valida/filtra uma lista vinda de config (JSON); entradas inválidas são ignoradas. */
export function parseAreas(json: string | undefined | null): AreaDef[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: AreaDef[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const name = (e as { name?: unknown }).name;
    const paths = (e as { paths?: unknown }).paths;
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(paths)) continue;
    const ps = paths.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (ps.length) out.push({ name: name.trim().slice(0, 40), paths: ps });
  }
  return out;
}
