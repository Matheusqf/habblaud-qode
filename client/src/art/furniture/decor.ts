// Decoração extra (pura, desenhada em código; nenhum asset externo): itens do escritório estilo
// "Gather" (aquário, globo, alvo de dardos) e do tema sazonal de Halloween (abóbora, caldeirão,
// teia, morcego). Mesmas convenções 3/4 do kit.
import { ramp } from '../core/color';
import { floorSheet, wallSheet, type BufFurniture } from '../core/sprite';
import { M, contact } from './kit';

const PUMPKIN = ramp('#e7832f', 0.08);

function pumpkinAt(b: import('../core/pixbuf').PixelBuf, cx: number, by: number, r: number): void {
  const ry = Math.max(2, Math.round(r * 0.75));
  b.ellipse(cx - r * 0.45, by - ry, r * 0.6, ry, PUMPKIN.dk);
  b.ellipse(cx + r * 0.45, by - ry, r * 0.6, ry, PUMPKIN.dk);
  b.ellipse(cx, by - ry, r * 0.6, ry, PUMPKIN.base);
  b.vline(Math.round(cx - r * 0.35), by - ry * 2 + 1, by - 1, PUMPKIN.dd);
  b.vline(Math.round(cx + r * 0.35), by - ry * 2 + 1, by - 1, PUMPKIN.dd);
  b.set(Math.round(cx - 1), by - ry - 1, PUMPKIN.hi);
  b.rect(Math.round(cx), by - ry * 2 - 2, 2, 3, '#5b7a2e');
}

/** Abóbora (variant 'single') ou pilha de abóboras (variant 'stack'). */
export function pumpkin(variant: string | undefined): BufFurniture {
  const s = floorSheet(1, 1, 14);
  const b = s.buf;
  if (variant === 'stack') {
    pumpkinAt(b, 8, 15, 7);
    pumpkinAt(b, 8, 6, 5);
  } else {
    pumpkinAt(b, 8, 15, 6);
    // olhos e boca (jack-o'-lantern)
    b.set(6, 10, '#ffd75a');
    b.set(10, 10, '#ffd75a');
    b.hline(6, 10, 13, '#ffd75a');
  }
  b.outline();
  contact(b, 1, 14, 14, 2, 0.22);
  return { base: s };
}

export function cauldron(): BufFurniture {
  const s = floorSheet(1, 1, 8);
  const b = s.buf;
  const iron = ramp('#3a3d4a', 0.07);
  b.ellipse(8, 10, 7, 5, iron.base);
  b.ellipse(8, 6, 7, 2, iron.dk);
  b.ellipse(8, 6, 6, 1.4, '#7ad34a');
  b.set(6, 5, '#c6f59a');
  b.set(10, 4, '#c6f59a');
  b.set(9, 2, '#a8e57c');
  b.vline(3, 13, 15, iron.dd);
  b.vline(13, 13, 15, iron.dd);
  b.outline();
  contact(b, 1, 14, 14, 2, 0.24);
  return { base: s };
}

/** Aquário redondo sobre um móvel baixo. */
export function aquarium(): BufFurniture {
  const s = floorSheet(1, 1, 12);
  const b = s.buf;
  b.rect(2, 8, 12, 8, M.walnut.base);
  b.hline(2, 13, 8, M.walnut.lt);
  b.hline(2, 13, 15, M.walnut.dk);
  b.ellipse(8, 3, 6, 5, 'rgba(150,210,240,0.85)');
  b.rect(3, 4, 11, 3, '#4aa3d8');
  b.rect(6, 2, 3, 2, '#f08a2a');
  b.set(9, 2, '#f08a2a');
  b.set(4, 0, '#ffffff');
  b.outline();
  contact(b, 1, 14, 14, 2, 0.2);
  return { base: s };
}

/** Globo terrestre de mesa (sobre um banquinho). */
export function globe(): BufFurniture {
  const s = floorSheet(1, 1, 12);
  const b = s.buf;
  b.rect(4, 10, 8, 6, M.oakDark.base);
  b.hline(4, 11, 10, M.oakDark.lt);
  b.vline(8, 7, 10, '#c9a14a');
  b.ellipse(8, 3, 5, 5, '#3f7fd8');
  b.rect(6, 0, 3, 3, '#4cae6a');
  b.rect(9, 4, 2, 3, '#4cae6a');
  b.set(6, 0, '#9fd0ff');
  b.outline();
  contact(b, 2, 14, 12, 2, 0.2);
  return { base: s };
}

export function dartboard(): BufFurniture {
  const s = wallSheet(1);
  const b = s.buf;
  b.ellipse(8, -20, 6, 6, '#2b2f3b');
  b.ellipse(8, -20, 5, 5, '#e9dcc0');
  b.ellipse(8, -20, 3.5, 3.5, '#e05a5a');
  b.ellipse(8, -20, 2, 2, '#e9dcc0');
  b.set(8, -20, '#2f9e5a');
  b.line(11, -23, 13, -25, '#3f7fd8');
  b.outline();
  return { base: s };
}

export function cobweb(variant: string | undefined): BufFurniture {
  const s = wallSheet(1);
  const b = s.buf;
  const c = 'rgba(235,235,245,0.85)';
  const right = variant === 'right';
  const ox = right ? 15 : 0;
  const sx = right ? -1 : 1;
  const y0 = -30;
  for (let i = 0; i < 4; i++) b.line(ox, y0, ox + sx * (13 - i * 3), y0 + i * 4, c);
  for (const r of [4, 8, 12]) b.line(ox + sx * r, y0, ox, y0 + r, c);
  b.set(ox + sx * 6, y0 + 8, '#1c1c24');
  b.set(ox + sx * 6, y0 + 9, '#1c1c24');
  return { base: s };
}

/** Quadro com um morcego (decoração de Halloween). */
export function batFrame(): BufFurniture {
  const s = wallSheet(1);
  const b = s.buf;
  b.rect(1, -27, 14, 11, '#2f3440');
  b.rect(2, -26, 12, 9, '#4ac0e0');
  const bat = '#1c1c24';
  b.rect(7, -23, 3, 3, bat);
  b.line(3, -24, 7, -22, bat);
  b.line(13, -24, 9, -22, bat);
  b.line(3, -24, 5, -20, bat);
  b.line(13, -24, 11, -20, bat);
  b.set(7, -24, bat);
  b.set(9, -24, bat);
  b.outline();
  return { base: s };
}

/** Faixa de abóboras pendurada (guirlanda), 3 tiles. */
export function pumpkinGarland(): BufFurniture {
  const s = wallSheet(3);
  const b = s.buf;
  b.line(1, -30, 24, -25, '#2b2f3b');
  b.line(24, -25, 47, -30, '#2b2f3b');
  for (const x of [8, 24, 40]) {
    const y = x === 24 ? -19 : -21;
    b.ellipse(x, y, 4, 3.5, PUMPKIN.base);
    b.set(x - 2, y - 1, '#2b1a10');
    b.set(x + 2, y - 1, '#2b1a10');
    b.hline(x - 2, x + 2, y + 1, '#2b1a10');
  }
  b.outline();
  return { base: s };
}
