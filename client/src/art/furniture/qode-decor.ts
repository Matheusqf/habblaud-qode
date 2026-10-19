// Decoração da marca (pura, desenhada em código; nenhum asset externo, foto ou logotipo de terceiros):
// pôster "de show" homenagem (skate/rock BR anos 2000, texto e arte ORIGINAIS: "QODE JR"), néon de
// parede e mascotes originais do QODE e do WorkToDo. Mesmas convenções 3/4 do kit.
import { mix } from '../core/color';
import type { PixelBuf } from '../core/pixbuf';
import { floorSheet, wallSheet, type BufFurniture } from '../core/sprite';
import { contact } from './kit';

/** Fonte bitmap de 5 linhas e largura variável (só as letras usadas nos cartazes). */
const CAPS: Readonly<Record<string, readonly string[]>> = {
  Q: ['.##.', '#..#', '#..#', '#.##', '.###'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['###', '#..', '##.', '#..', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  ' ': ['..', '..', '..', '..', '..'],
};

export function capsWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += (CAPS[ch] ?? CAPS[' '])[0].length + 1;
  return Math.max(0, w - 1);
}

/** Desenha `text` (maiúsculas da tabela CAPS) a partir de (x, y); devolve a largura. */
function caps(b: PixelBuf, text: string, x: number, y: number, c: string): number {
  let cx = x;
  for (const ch of text) {
    const g = CAPS[ch] ?? CAPS[' '];
    g.forEach((row, r) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') b.set(cx + i, y + r, c);
    });
    cx += g[0].length + 1;
  }
  return cx - x - 1;
}

/** Pontos acesos de um texto (para o halo do néon). */
function capsPoints(text: string, x: number, y: number): [number, number][] {
  const pts: [number, number][] = [];
  let cx = x;
  for (const ch of text) {
    const g = CAPS[ch] ?? CAPS[' '];
    g.forEach((row, r) => {
      for (let i = 0; i < row.length; i++) if (row[i] === '#') pts.push([cx + i, y + r]);
    });
    cx += g[0].length + 1;
  }
  return pts;
}

function wallShadow(b: PixelBuf, x: number, y: number, w: number, h: number): void {
  for (let yy = y + 1; yy <= y + h; yy++) b.under(x + w, yy, 'rgba(30,34,52,0.16)');
  for (let xx = x + 1; xx <= x + w; xx++) b.under(xx, y + h, 'rgba(30,34,52,0.16)');
}

/** Fita adesiva nos cantos de cima (charme de cartaz colado). */
function tape(b: PixelBuf, x: number, y: number, w: number): void {
  const t = 'rgba(236,226,190,0.9)';
  b.rect(x - 1, y - 1, 3, 2, t);
  b.rect(x + w - 2, y - 1, 3, 2, t);
}

/**
 * Pôster de show (2 tiles). 'qode_jr': homenagem ORIGINAL ao rock/skate brasileiro dos anos 2000
 * (fundo preto, letreiro "QODE" com "JR" em laranja e um skate em kickflip; nenhum logotipo real).
 * 'worktodo': checklist da marca WorkToDo (faixa índigo, dois itens feitos e um em andamento).
 */
export function gigPoster(variant: string | undefined): BufFurniture {
  const s = wallSheet(2);
  const b = s.buf;
  const x = 3;
  const y = -28;
  const w = 26;
  const h = 22;
  if (variant === 'worktodo') {
    b.rect(x, y, w, h, '#f3efe4');
    b.rect(x, y, w, 8, '#4f46e5');
    b.hline(x, x + w - 1, y + 8, '#312e81');
    const title = 'TODO';
    caps(b, title, x + Math.floor((w - capsWidth(title)) / 2), y + 2, '#ffffff');
    const rows: [number, boolean][] = [[y + 11, true], [y + 15, true], [y + 19, false]];
    for (const [ry, done] of rows) {
      b.rect(x + 3, ry - 1, 4, 4, done ? '#22a06b' : '#ffffff');
      if (!done) {
        b.hline(x + 3, x + 6, ry - 1, '#818cf8');
        b.hline(x + 3, x + 6, ry + 2, '#818cf8');
        b.vline(x + 3, ry - 1, ry + 2, '#818cf8');
        b.vline(x + 6, ry - 1, ry + 2, '#818cf8');
      } else {
        b.set(x + 4, ry + 1, '#ffffff');
        b.set(x + 5, ry + 2, '#ffffff');
        b.set(x + 6, ry, '#ffffff');
      }
      b.hline(x + 9, x + (done ? 21 : 18), ry + 1, done ? '#a7a3b8' : '#312e81');
    }
    tape(b, x, y, w);
  } else {
    // 'qode_jr'
    b.rect(x, y, w, h, '#16131b');
    b.rect(x + 1, y + 1, w - 2, h - 2, '#1d1924');
    const t1 = 'QODE';
    const t1x = x + Math.floor((w - capsWidth(t1)) / 2);
    caps(b, t1, t1x + 1, y + 3, '#6b2346'); // sombra vinho (pichação), escura para o letreiro ler a 32 px
    caps(b, t1, t1x, y + 2, '#f4efe6');
    const t2 = 'JR';
    const t2x = x + Math.floor((w - capsWidth(t2)) / 2);
    caps(b, t2, t2x + 1, y + 9, '#7a2d17');
    caps(b, t2, t2x, y + 8, '#ff8a3d');
    // skate em kickflip: shape inclinado, lixa, rodinhas e riscos de movimento
    const sx = x + 6;
    const sy = y + 18;
    b.line(sx, sy, sx + 13, sy - 3, '#f7d154', 2);
    b.line(sx + 1, sy - 1, sx + 12, sy - 4, '#e05a5a');
    b.set(sx + 2, sy + 2, '#f4efe6');
    b.set(sx + 11, sy, '#f4efe6');
    b.hline(x + 2, x + 4, sy - 1, '#8a7fa0');
    b.hline(x + 1, x + 3, sy + 1, '#5e566e');
    // estrelinhas
    b.set(x + 3, y + 3, '#f7d154');
    b.set(x + w - 4, y + 9, '#f7d154');
    b.set(x + w - 3, y + 16, '#8be9fd');
    tape(b, x, y, w);
  }
  b.outline();
  wallShadow(b, x - 1, y - 1, w + 2, h + 2);
  return { base: s };
}

/** Desenha texto em néon sobre a placa: halo (cor misturada) e depois o tubo aceso. */
function neonText(b: PixelBuf, text: string, x: number, y: number, tube: string, board: string): void {
  const pts = capsPoints(text, x, y);
  const lit = new Set(pts.map(([px, py]) => `${px},${py}`));
  const halo = mix(board, tube, 0.38);
  for (const [px, py] of pts) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!lit.has(`${px + dx},${py + dy}`)) b.set(px + dx, py + dy, halo);
    }
  }
  const core = mix(tube, '#ffffff', 0.35);
  for (const [px, py] of pts) b.set(px, py, core);
}

/**
 * Placa de néon (2 tiles) numa chapa escura, para ler bem em parede clara.
 * 'qode': "QODE" em ciano e "</>" em rosa. 'worktodo': "WORK"/"TODO" em índigo com um ✓ verde.
 */
export function neonSign(variant: string | undefined): BufFurniture {
  const s = wallSheet(2);
  const b = s.buf;
  const board = '#1c1a2b';
  const x = 1;
  const y = -28;
  const w = 30;
  const h = 17;
  b.rect(x, y, w, h, board);
  if (variant === 'worktodo') {
    neonText(b, 'WORK', x + 2, y + 2, '#818cf8', board);
    neonText(b, 'TODO', x + 3, y + 10, '#a5b0ff', board);
    // ✓ verde (tubo de 1px com halo)
    const pts: [number, number][] = [[x + 22, y + 9], [x + 23, y + 10], [x + 24, y + 11], [x + 25, y + 10], [x + 26, y + 9], [x + 26, y + 8], [x + 27, y + 7], [x + 27, y + 6], [x + 28, y + 5], [x + 28, y + 4]];
    const halo = mix(board, '#34d399', 0.38);
    for (const [px, py] of pts) {
      b.set(px - 1, py, halo);
      b.set(px, py + 1, halo);
    }
    for (const [px, py] of pts) b.set(px, py, '#86efac');
  } else {
    const t1 = 'QODE';
    neonText(b, t1, x + Math.floor((w - capsWidth(t1)) / 2), y + 2, '#5fd3f3', board);
    const t2 = '</>';
    neonText(b, t2, x + Math.floor((w - capsWidth(t2)) / 2), y + 10, '#ff6fb5', board);
  }
  b.outline();
  wallShadow(b, x - 1, y - 1, w + 2, h + 2);
  return { base: s };
}

/** Pôster pequeno (1 tile) da marca, para paredes cheias. 'qode_jr': "JR" laranja e skate; 'worktodo': ✓ grande. */
export function miniPoster(variant: string | undefined): BufFurniture {
  const s = wallSheet(1);
  const b = s.buf;
  const x = 2;
  const y = -28;
  const w = 12;
  const h = 16;
  if (variant === 'worktodo') {
    b.rect(x, y, w, h, '#4f46e5');
    b.rect(x + 1, y + 1, w - 2, 3, '#312e81');
    for (const [px, py] of [[3, 9], [4, 10], [5, 11], [6, 10], [7, 9], [8, 8], [9, 7], [9, 6]] as const) {
      b.set(x + px, y + py, '#86efac');
      b.set(x + px, y + py + 1, '#22a06b');
    }
  } else {
    b.rect(x, y, w, h, '#16131b');
    caps(b, 'JR', x + 3, y + 3, '#ff8a3d');
    b.line(x + 2, y + 12, x + 9, y + 10, '#f7d154');
    b.set(x + 3, y + 13, '#f4efe6');
    b.set(x + 8, y + 12, '#f4efe6');
    b.set(x + 9, y + 2, '#f7d154');
  }
  tape(b, x, y, w);
  b.outline();
  wallShadow(b, x - 1, y - 1, w + 2, h + 2);
  return { base: s };
}

/** Mascotes ORIGINAIS (templates ASCII; '.' = transparente). Nenhum personagem de terceiros. */
const MASCOTS: Readonly<Record<string, { rows: readonly string[]; pal: Readonly<Record<string, string>> }>> = {
  // Bloby: gota-geleia ciano do QODE, com brilho e olhos grandes
  blob: {
    rows: [
      '....bbbb....',
      '..bbbbbbbb..',
      '.bhhbbbbbbb.',
      '.bhbbbbbbbb.',
      'bbbwkbbwkbbb',
      'bbbkkbbkkbbb',
      'bpbbbbbbbbpb',
      'bbbbbmmbbbbb',
      'bbbbbbbbbbbb',
      '.dbbdbbdbbd.',
    ],
    pal: { b: '#4cc9d9', h: '#bff3fb', w: '#ffffff', k: '#1d2433', p: '#f7a1c4', m: '#1d2433', d: '#2f9fb3' },
  },
  // Tanja: tangerina redonda com folhinha e pezinhos (o laranja da casa, sem forma quadrada)
  tangerine: {
    rows: [
      '......ll....',
      '.....lll....',
      '.....s......',
      '...oooooo...',
      '..ohoooooo..',
      '.ohoooooooo.',
      '.oowkoowkoo.',
      'oookkookkooo',
      'oproooooopro',
      'ooooommooooo',
      '.oooooooooo.',
      '..dooooood..',
      '...f....f...',
    ],
    pal: { o: '#f39a3d', h: '#ffd29a', w: '#ffffff', k: '#2a1d14', p: '#ff7b8a', r: '#ff7b8a', m: '#7a2d17', d: '#c96a1f', l: '#4cae6a', s: '#6b4a32', f: '#7a2d17' },
  },
  // Checko: caixinha de tarefa do WorkToDo, com o ✓ no peito
  check: {
    rows: [
      '.iiiiiiiiii.',
      'iqqiiiiiiiii',
      'iqiwkiiwkiii',
      'iiikkiikkiii',
      'iiiiiiiiiiGi',
      'iiGiiiiiGiii',
      'iiiGiiiGiiii',
      'iiiiGiGiiiii',
      'iiiiiGiiiiii',
      '.jiiiiiiiij.',
      '..f......f..',
    ],
    pal: { i: '#6366f1', q: '#c7d2fe', w: '#ffffff', k: '#1e1b4b', G: '#86efac', j: '#4338ca', f: '#312e81' },
  },
  // Postit: lembrete amarelo com a ponta dobrada e um lápis
  sticky: {
    rows: [
      'yyyyyyyyyy..',
      'yhhyyyyyyyy.',
      'yhyyyyyyyyyc',
      'ywkyyywkyycc',
      'ykkyyykkyyyy',
      'yyyyyyyyyyyy',
      'yyyyymyyyyyy',
      'yyyyyyyyyyyy',
      'yllllllyyyya',
      'yyyyyyyyyyaP',
      '.dyyyyyyyd.P',
      '..f....f...e',
    ],
    pal: { y: '#f7d154', h: '#fff1a8', c: '#d9b23a', w: '#ffffff', k: '#3a2f14', m: '#3a2f14', l: '#d9b23a', d: '#c99a2a', f: '#6b4a32', a: '#e05a5a', P: '#f2a03d', e: '#3a3f4b' },
  },
};

export const MASCOT_VARIANTS = ['blob', 'tangerine', 'check', 'sticky'] as const;

/** Mascote de chão (1x1): template centrado no tile, com sombra de contato. */
export function mascot(variant: string | undefined): BufFurniture {
  const m = MASCOTS[variant ?? 'blob'] ?? MASCOTS.blob;
  const s = floorSheet(1, 1, 8);
  const b = s.buf;
  const w = m.rows[0].length;
  const h = m.rows.length;
  b.stamp(m.rows, Math.floor((16 - w) / 2), 15 - h, m.pal);
  b.outline();
  contact(b, 2, 14, 12, 2, 0.24);
  return { base: s };
}
