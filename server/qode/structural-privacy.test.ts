import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { MENTIONS_BYTES_MAX, MENTIONS_TOKENS_MAX, mentionsPrivate, parseConfig } from './config';

// Extração ESTRUTURAL de candidatos: todo "/" fora de um nome inicia um candidato, sem lista de caracteres de cola.
// Só caminhos sintéticos (diretório temporário); nenhum comando é executado.
function env() {
  const tmp = tempDir('structural-');
  const home = join(tmp.dir, 'home');
  const A = join(home, 'GitHub');
  mkdirSync(join(A, 'priv'), { recursive: true });
  mkdirSync(join(A, 'pub'), { recursive: true });
  writeFileSync(join(A, 'priv', '.env'), 'CANARY');
  symlinkSync(join(A, 'priv'), join(A, 'cafe\u0301'));
  const cfg = parseConfig({ projetos: [{ nome: 'Pub', caminhos: ['~/GitHub/pub'] }, { nome: 'P', privado: true, caminhos: ['~/GitHub/priv'] }] }, home);
  return { home, A, cfg };
}

describe('candidatos estruturais (qualquer prefixo colado)', () => {
  const { A, cfg } = env();
  const priv = (s: string) => expect(mentionsPrivate(cfg, s), s).toBe(true);
  const pub = (s: string) => expect(mentionsPrivate(cfg, s), s).toBe(false);

  it('operadores e pontuação colados antes do caminho com grupo/glob', () => {
    for (const s of [
      'echo x >|$HOME/GitHub/(priv|x)/out',
      'false||$HOME/GitHub/(priv|x)/.env',
      'cat|$HOME/GitHub/(priv|x)/.env',
      'files=(~/GitHub/(priv|x)/*)',
      'a=($HOME/GitHub/(priv|x)/.env)',
      'a+=($HOME/GitHub/@(priv)/x)',
      'diff <($HOME/GitHub/(priv|x)/.env)',
      '{cat,$HOME/GitHub/@(priv)/x}',
      `{cat,${A}/pr?v/x}`,
      '{a,$HOME/GitHub/P*/x}',
      `PATH=$PATH:${A}/(priv|x)`,
      `a,${A}/(priv|x)/x`,
      `{x,${A}/priv}/f`,
      `{${A}/priv,x}`,
      `X=${A}/priv:${A}/pub`,
      `cat ${A}/pr?v|grep a`,
      `cat ${A}/pr?v>out`,
      `cat ${A}/pr?v;ls`,
      `(cat ${A}/pr?v)`,
      `cat ${A}/(|a)pr?v|grep`,
    ]) priv(s);
  });

  it('${IFS} e outras caudas coladas, sem nenhum grupo', () => {
    for (const s of [
      'cat${IFS}$HOME/GitHub/pr?v/.env',
      'cat${IFS}$HOME/GitHub/(priv|x)/.env',
      `cat\${IFS}${A}/p*/.env`,
      `cat\${IFS}${A}/pub/../priv/.env`,
      `cat\${IFS}${A}/priv/.env`,
    ]) priv(s);
  });

  it('ANSI-C $\'...\' colado antes do caminho e ${HOME<op>…}', () => {
    priv("cat $'\\x2f'" + A.slice(1) + '/(priv|x)/.env');
    priv("cat $'\\x2f'" + A.slice(1) + '/pr?v/.env');
    priv("cat $'\\057'" + A.slice(1) + '/priv/.env');
    priv('cat ${HOME%/}/GitHub/priv/.env');
    priv('cat ${HOME:-/x}/GitHub/(priv|x)/.env');
    priv('cat ${HOME/a/b}/GitHub/pr?v/.env');
    priv('cat ${HOME:-${X}}/GitHub/priv/.env');
    priv('cat ${HOME/GitHub/priv');
    priv("cat $'\\xZZ'/x"); // ANSI-C inválido = ambíguo = privado
  });

  it('extglob/zsh: negação, repetição e alias NFD', () => {
    priv(`cat ${A}/^pub/.env`);
    priv(`cat ${A}/priv#/.env`);
    priv(`cat ${A}/caf*/.env`);
    priv(`cat ${A}/caf(\u00e9|x)/.env`);
    priv(`x=${A}/caf*`);
    priv(`cat|${A}/caf(\u00e9|x)/.env`);
  });

  it('caça adversarial: opção colada, barra invertida, aberturas sem par, cola dentro do caminho', () => {
    priv('grep -f$HOME/GitHub/(priv|x)/.env');
    priv(`gcc -I${A}/pr?v/inc`);
    priv(`cat --file${A}/pr?v/.env`);
    priv(`cat|${A}/pr\\iv/x`);
    priv(`cat|${A}/pr?v\\nls`);
    priv(`cat ${A}/priv\\nls`);
    priv(`cat ${A}/pr?v(|grep a`);
    priv(`cat ${A}/pr?v{|grep a`);
    priv(`cat ${A}/pr?v[;ls`);
    priv(`cat|"${A}/"pr?v`);
    priv(`cat|'${A}'/pr?v`);
    priv(`cat|${A}/pr$'\\x69'v/x`);
    priv(`cat|${A}/pr''iv/x`);
    priv(`cat|$HOME/GitHub/pr%3Fv/x`.replace('%3F', '?'));
    priv(`echo $"${A}/priv"`);
    priv(`cat <<<${A}/pr?v`);
    priv(`cat 2>&1|${A}/pr?v`);
    priv(`x=$(cat|${A}/pr?v)`);
    priv('cat|${HOME}/GitHub/pr?v');
    priv('cat|${HOME@Q}/GitHub/pr?v');
    priv('cat|~/GitHub/pr?v');
    priv('echo>~/GitHub/pr?v');
    priv('cat<~/GitHub/pr?v');
    priv('(~/GitHub/pr?v)');
    priv(`cat \${x:-${A}/(priv|x)/.env}`);
    priv(`cat \${x-${A}/pr?v}`);
    priv(`cat \${x:=${A}/p*}`);
    priv('cat$IFS$HOME/GitHub/priv/.env');
    priv('cat$IFS$HOME/GitHub/(priv|x)/.env');
    priv('cat$IFS${HOME}/GitHub/pr?v');
    priv(`cat$IFS${A}/pr?v/.env`);
    priv(`cat$IFS${A}/priv/.env`);
    priv(`cat%7c${A}/pr?v`);
    priv(`cat\\u007c${A}/pr?v`);
    priv(`cat ${A}/pr?v%7cgrep`);
    priv(`cat|"${A}/cafe\u0301 x"/y`.replace('cafe\u0301 x', 'priv x'));
  });

  it('substitui\u00e7\u00e3o por crase colada antes do caminho (sa\u00edda com tab/espa\u00e7o separa a palavra)', () => {
    // bash: cat`printf '\t'`/abs/pr?v/.env l\u00ea o arquivo (a crase some do texto no unshell e colava "cat\u2026/abs").
    priv(`cat\`printf '\\t'\`${A}/pr?v/.env`);
    priv(`cat\`printf '\\t'\`${A}/(priv|x)/.env`);
    priv(`cat\`printf ' '\`${A}/priv/../pr?v/.env`);
    pub(`cat\`printf '\\t'\`${A}/pub/x.txt`);
  });

  it('controles públicos continuam públicos', () => {
    pub('cat $HOME/GitHub/pub/(a|b).txt');
    pub(`cat<${A}/pub/(a|b)`);
    pub(`P=${A}/pub/(a|b)`);
    pub(`${A}/pub/x.txt|grep a`);
    pub(`cat|${A}/pub/(a|b)/x`);
    pub(`false||${A}/pub/(a|b)/x`);
    pub(`files=(${A}/pub/*)`);
    pub(`{cat,${A}/pub/x}`);
    pub(`cat\${IFS}${A}/pub/x`);
    pub(`cat ${A}/pub{,lic}/x`);
    pub('cat ${HOME}/GitHub/pub/x');
    pub(`PATH=$PATH:${A}/pub`);
    pub('cat $HOME/GitHub/pub/x $HOME/GitHub/pub/(a|b)');
    pub('echo a/b/c and/or 1/2 https://example.test/a/b');
  });

  it('custo: mais de MENTIONS_TOKENS_MAX candidatos falha fechado; 96KB roda rápido', () => {
    const many = Array.from({ length: MENTIONS_TOKENS_MAX }, (_, i) => `/tmp/public-workspace/f-${i}`).join(' ');
    pub(many);
    priv(`${many} /tmp/public-workspace/extra`);
    let worst = 0;
    for (const unit of ['/a|', '|/a', '>/a:', '(/a)', '/a/(b|c)', ',/x,', '${IFS}/q', "$'\\x2f'q", '/', '{/a,', '/(|', '(((', '%7c/', '\\/', '$IFS/'] as const) {
      const text = unit.repeat(Math.ceil(MENTIONS_BYTES_MAX / unit.length)).slice(0, MENTIONS_BYTES_MAX);
      for (const width of [0, 60, 4000]) {
        const input = width ? text.replace(new RegExp(`(.{${width}})`, 'g'), '$1 ').slice(0, MENTIONS_BYTES_MAX) : text;
        const t0 = performance.now();
        mentionsPrivate(cfg, input);
        worst = Math.max(worst, performance.now() - t0);
      }
    }
    expect(worst).toBeLessThan(1000);
  });

  it('padding gigante de "/" ou candidato maior que TOKEN_MAX', () => {
    priv(`cat|${A}${'/'.repeat(5000)}(priv|x)/x`);
    pub(`cat|${A}/pub${'/'.repeat(5000)}(a|b).txt`);
    priv(`cat|${A}/pub/${'x'.repeat(5000)}(a|b)`);
  });
});
