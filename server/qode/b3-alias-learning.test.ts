import { mkdirSync, symlinkSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { parseConfig, mentionsPrivate } from './config';
it('B3: mentionsPrivateTail não impede aprender alias de symlink (repro Zika)', () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'zr-')));
  const home = join(t, 'home'); const priv = join(home, 'Documents', 'PrivadoSintetico');
  mkdirSync(priv, { recursive: true }); writeFileSync(join(priv, 'secret'), 'x');
  const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: [priv], privado: true }] }, home);
  mkdirSync(join(t, 'outside')); const alias = join(t, 'outside', 'PrivadoSintetico'); symlinkSync(priv, alias);
  const a = mentionsPrivate(cfg, `ls ${alias}`);
  expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(true);
  const b = mentionsPrivate(cfg, `cat ${t}/outside/Priva*/secret`);
  expect(a).toBe(true); expect(b).toBe(true);
});

it('B3: alias de symlink com espaço no path é aprendido via prosa antes do tail (repro Zika residual)', () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'zr-')));
  const home = join(t, 'home'); const priv = join(home, 'Documents', 'PrivadoSintetico');
  mkdirSync(priv, { recursive: true }); writeFileSync(join(priv, 'secret'), 'x');
  const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: [priv], privado: true }] }, home);
  mkdirSync(join(t, 'outside space')); const alias = join(t, 'outside space', 'PrivadoSintetico'); symlinkSync(priv, alias);
  expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(false);
  expect(mentionsPrivate(cfg, `Reading ${alias}`)).toBe(true);
  expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(true);
  expect(mentionsPrivate(cfg, `cat "${t}/outside space"/Priva*/secret`)).toBe(true);
});

it('B3: alias sem espaço também fica em privateAliases após a 1ª menção', () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'zr-')));
  const home = join(t, 'home'); const priv = join(home, 'Documents', 'PrivadoSintetico');
  mkdirSync(priv, { recursive: true }); writeFileSync(join(priv, 'secret'), 'x');
  const cfg = parseConfig({ projetos: [{ nome: 'P', caminhos: [priv], privado: true }] }, home);
  mkdirSync(join(t, 'outside')); const alias = join(t, 'outside', 'PrivadoSintetico'); symlinkSync(priv, alias);
  expect(mentionsPrivate(cfg, `ls ${alias}`)).toBe(true);
  expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(true);
});
