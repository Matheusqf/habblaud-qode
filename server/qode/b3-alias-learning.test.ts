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
  const learned = [...cfg.privateAliases];
  const b = mentionsPrivate(cfg, `cat ${t}/outside/Priva*/secret`);
  expect(a).toBe(true); expect(b).toBe(true);
});
