// Apelidos de protagonistas (só exibição): o id real e o nome canônico ficam intactos.
// `name` do snapshot de exibição = apelido; `canonicalName` = nome real (o único que vai para o
// servidor: editor de personagem, busca e persistência usam `canonicalName(a)`).
// Rascunho gerado com deepseek-v4.1-flash (OpenCode Go), revisto à mão.
import { hash32 } from './hash';
import type { AgentInfo, OfficeSnapshot } from './types';

export const NICKNAME_POOL: readonly { name: string; look: 'f' | 'm' }[] = [
  { name: 'Shrek', look: 'm' },
  { name: 'Forrest Gump', look: 'm' },
  { name: 'Indiana Jones', look: 'm' },
  { name: 'Neo', look: 'm' },
  { name: 'Marty McFly', look: 'm' },
  { name: 'Rocky', look: 'm' },
  { name: 'Woody', look: 'm' },
  { name: 'Buzz Lightyear', look: 'm' },
  { name: 'Mario', look: 'm' },
  { name: 'Harry Potter', look: 'm' },
  { name: 'Frodo', look: 'm' },
  { name: 'Simba', look: 'm' },
  { name: 'Ellen Ripley', look: 'f' },
  { name: 'Mulan', look: 'f' },
  { name: 'Moana', look: 'f' },
  { name: 'Elsa', look: 'f' },
  { name: 'Jack Sparrow', look: 'm' },
  { name: 'Homer Simpson', look: 'm' },
  { name: 'Bob Esponja', look: 'm' },
  { name: 'Chaves', look: 'm' },
  { name: 'Hermione', look: 'f' },
  { name: 'Lara Croft', look: 'f' },
  { name: 'Katniss', look: 'f' },
  { name: 'Wall-E', look: 'm' },
  { name: 'Luke Skywalker', look: 'm' },
  { name: 'Leia Organa', look: 'f' },
  { name: 'Han Solo', look: 'm' },
  { name: 'Batman', look: 'm' },
  { name: 'Superman', look: 'm' },
  { name: 'Spider-Man', look: 'm' },
  { name: 'Wonder Woman', look: 'f' },
  { name: 'Iron Man', look: 'm' },
  { name: 'Captain America', look: 'm' },
  { name: 'Thor', look: 'm' },
  { name: 'Hulk', look: 'm' },
  { name: 'Black Widow', look: 'f' },
  { name: 'Goku', look: 'm' },
  { name: 'Naruto', look: 'm' },
  { name: 'Luffy', look: 'm' },
  { name: 'Zoro', look: 'm' },
  { name: 'Nami', look: 'f' },
  { name: 'Ichigo', look: 'm' },
  { name: 'Sailor Moon', look: 'f' },
  { name: 'Ash Ketchum', look: 'm' },
  { name: 'Pikachu', look: 'm' },
  { name: 'Link', look: 'm' },
  { name: 'Zelda', look: 'f' },
  { name: 'Samus Aran', look: 'f' },
  { name: 'Sonic', look: 'm' },
  { name: 'Tails', look: 'm' },
  { name: 'Knuckles', look: 'm' },
  { name: 'Crash Bandicoot', look: 'm' },
  { name: 'Spyro', look: 'm' },
  { name: 'Master Chief', look: 'm' },
  { name: 'Kratos', look: 'm' },
  { name: 'Geralt', look: 'm' },
  { name: 'Aloy', look: 'f' },
  { name: 'Ellie', look: 'f' },
  { name: 'Joel', look: 'm' },
  { name: 'Nathan Drake', look: 'm' },
  { name: 'Sora', look: 'm' },
  { name: 'Cloud Strife', look: 'm' },
  { name: 'Tifa', look: 'f' },
  { name: 'Aerith', look: 'f' },
  { name: 'Solid Snake', look: 'm' },
  { name: 'Mega Man', look: 'm' },
  { name: 'Ryu', look: 'm' },
  { name: 'Chun-Li', look: 'f' },
  { name: 'Donkey Kong', look: 'm' },
  { name: 'Diddy Kong', look: 'm' },
  { name: 'Yoshi', look: 'm' },
  { name: 'Princess Peach', look: 'f' },
  { name: 'Luigi', look: 'm' },
  { name: 'Toad', look: 'm' },
  { name: 'Wario', look: 'm' },
  { name: 'Mônica', look: 'f' },
  { name: 'Cebolinha', look: 'm' },
  { name: 'Scooby-Doo', look: 'm' },
  { name: 'Mickey Mouse', look: 'm' },
  { name: 'Donald Duck', look: 'm' },
];

interface NicknameEntry {
  name: string;
  look: 'f' | 'm';
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assignNicknameEntries(ids: readonly string[]): Map<string, NicknameEntry> {
  const sorted = [...ids].sort(compareIds);
  const result = new Map<string, NicknameEntry>();
  const usedSlots = new Set<number>();
  const usedNames = new Set<string>();

  for (const id of sorted) {
    if (result.has(id)) continue;

    let entry: NicknameEntry | undefined;

    if (usedSlots.size < NICKNAME_POOL.length) {
      const start = hash32(id) % NICKNAME_POOL.length;

      for (let i = 0; i < NICKNAME_POOL.length; i++) {
        const slot = (start + i) % NICKNAME_POOL.length;

        if (!usedSlots.has(slot)) {
          usedSlots.add(slot);
          entry = NICKNAME_POOL[slot];
          break;
        }
      }
    } else {
      const base = NICKNAME_POOL[hash32(id) % NICKNAME_POOL.length];
      let suffix = 2;
      let candidate = `${base.name} ${suffix}`;

      while (usedNames.has(candidate)) {
        suffix += 1;
        candidate = `${base.name} ${suffix}`;
      }

      entry = { name: candidate, look: base.look };
    }

    if (entry !== undefined) {
      result.set(id, entry);
      usedNames.add(entry.name);
    }
  }

  return result;
}

export function assignNicknames(ids: readonly string[]): Map<string, string> {
  const entries = assignNicknameEntries(ids);

  return new Map(
    Array.from(entries, ([id, entry]) => [id, entry.name] as [string, string]),
  );
}

export function applyNicknames(snap: OfficeSnapshot): OfficeSnapshot {
  const entries = assignNicknameEntries(snap.agents.map((agent) => agent.id));

  return {
    ...snap,
    agents: snap.agents.map((agent) => {
      const entry = entries.get(agent.id);
      if (entry === undefined) return { ...agent };

      const originalName =
        canonicalName(agent);

      return {
        ...agent,
        name: entry.name,
        look: entry.look,
        canonicalName: originalName,
      } as NicknamedAgent;
    }),
  };
}

/** Agente no snapshot de exibição (com apelido aplicado). */
export type NicknamedAgent = AgentInfo & { canonicalName?: string };

/** Nome canônico (persistido no servidor), independente do apelido exibido. */
export function canonicalName(agent: AgentInfo): string {
  return (agent as NicknamedAgent).canonicalName ?? agent.name;
}

/** Nome original quando difere do exibido (para mostrar ao lado do apelido); senão undefined. */
export function originalNameShown(agent: AgentInfo): string | undefined {
  const c = (agent as NicknamedAgent).canonicalName;
  return c !== undefined && c !== agent.name ? c : undefined;
}

/** Os apelidos estão ligados? `?nicknames=0` ou localStorage `habblaud:nicknames`='0' desligam; storage que lança = padrão (ligado). */
export function nicknamesEnabled(search: string | undefined, storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    if (search !== undefined && new URLSearchParams(search).get('nicknames') === '0') return false;
  } catch {
    /* busca inválida: segue */
  }
  try {
    if (storage && storage.getItem('habblaud:nicknames') === '0') return false;
  } catch {
    /* sem storage (modo privado, bloqueado): fica no padrão */
  }
  return true;
}
