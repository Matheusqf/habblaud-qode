import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MENTIONS_BYTES_MAX, MENTIONS_TOKENS_MAX, isPrivatePath, mentionsPrivate, parseConfig, pathTokens } from './config';
import { setLogFilter } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { setupQode } from './index';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  setLogFilter(undefined);
});

function dirs(): { root: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'qode-private-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'qode-alias-outside-'));
  tempRoots.push(root, outside);
  mkdirSync(join(root, 'files'), { recursive: true });
  mkdirSync(join(outside, 'aliases'), { recursive: true });
  return { root: join(root, 'files'), outside: join(outside, 'aliases') };
}

function homeDir(): string {
  const home = mkdtempSync(join(tmpdir(), 'qode-home-'));
  tempRoots.push(home);
  return home;
}

describe('interpretação shell do filtro de privacidade', () => {
  it('reconhece substituições e ANSI-C depois de alias criado após parseConfig', () => {
    const forms = [
      (secret: string) => `echo \`cat "${secret}"\``,
      (secret: string) => `echo "$(cat '${secret}')"`,
      (secret: string) => `cat $'${secret}'`,
      (secret: string) => `cat $'${secret.replace(' ', '\\x20')}'`,
      (secret: string) => `cat $'${secret.replace(' ', '\\040')}'`,
      (secret: string) => `cat $'${secret.replace(' ', '\\U00000020')}'`,
      (secret: string) => `bash -c 'cat "${secret}"'`,
      (secret: string) => `eval 'cat "${secret}"'`,
      (secret: string) => `echo "$(printf '%s' \"$(cat '${secret}')\")"`,
      (secret: string) => `echo "$(bash -c 'cat "${secret}"')"`,
      (secret: string) => `bash -c 'bash -c "cat \\\"${secret}\\\""'`,
    ];
    for (const make of forms) {
      const { root, outside } = dirs();
      const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
      const alias = join(outside, 'qode alias');
      symlinkSync(root, alias, 'dir');
      const secret = join(alias, 'secret.txt');
      expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(false);
      expect(isPrivatePath(cfg, secret)).toBe(true);
      const command = make(secret);
      expect(mentionsPrivate(cfg, command), command).toBe(true);
      expect(pathTokens(command, cfg.home)).toContain(secret);
    }
  });

  it('mantém aspas shell adjacentes entre letras e o controle de contração em prosa', () => {
    const { root, outside } = dirs();
    const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
    const alias = join(outside, 'qode alias');
    symlinkSync(root, alias, 'dir');
    const secret = join(alias, 'secret.txt');
    const command = `cat "${alias.slice(0, -10)}"q'ode al'ias/secret.txt`;
    expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(false);
    expect(pathTokens(command, cfg.home)).toContain(secret);
    expect(mentionsPrivate(cfg, command)).toBe(true);
    expect(mentionsPrivate(cfg, "I'm reading /tmp/public alias/secret.txt")).toBe(false);
  });

  it('decodifica octal de exatamente três dígitos e bytes UTF-8 ANSI-C', () => {
    const { root, outside } = dirs();
    const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
    const octalAlias = join(outside, 'qode 0alias');
    const unicodeAlias = join(outside, 'qode éalias');
    symlinkSync(root, octalAlias, 'dir');
    symlinkSync(root, unicodeAlias, 'dir');
    const octalPath = octalAlias.replace(' ', '\\040') + '/secret.txt';
    const bytePaths = [unicodeAlias.replace('é', '\\xC3\\xA9'), unicodeAlias.replace('é', '\\303\\251')].map((p) => `${p}/secret.txt`);
    expect(pathTokens(`cat $'${octalPath}'`, cfg.home)).toContain(join(octalAlias, 'secret.txt'));
    expect(mentionsPrivate(cfg, `cat $'${octalPath}'`)).toBe(true);
    for (const path of bytePaths) {
      const command = `cat $'${path}'`;
      expect(pathTokens(command, cfg.home)).toContain(join(unicodeAlias, 'secret.txt'));
      expect(mentionsPrivate(cfg, command)).toBe(true);
    }
  });

  it('extrai caminhos absolutos de atribuições e opções coladas sem aquecer alias', () => {
    const forms = [
      (secret: string) => `grep --file="${secret}" pattern /tmp/public`,
      (secret: string) => `INPUT="${secret}" cat /tmp/public`,
      (secret: string) => `grep -f"${secret}" /tmp/public`,
    ];
    for (const make of forms) {
      const { root, outside } = dirs();
      const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
      const alias = join(outside, 'qode alias');
      symlinkSync(root, alias, 'dir');
      const secret = join(alias, 'secret.txt');
      const publicPath = join(outside, 'public alias', 'secret.txt');
      expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(false);
      expect(pathTokens(make(secret), cfg.home)).toContain(secret);
      expect(mentionsPrivate(cfg, make(secret))).toBe(true);
      expect(mentionsPrivate(cfg, make(publicPath))).toBe(false);
    }
  });

  it('falha fechado para NUL e escapes ANSI-C não suportados', () => {
    const forms = [
      (secret: string) => `cat $'${secret}\\0ignored'`,
      (secret: string) => `cat $'${secret}\\x00ignored'`,
      (secret: string) => `cat $'${secret}\\u0000ignored'`,
      (secret: string) => `cat $'${secret}\\U00000000ignored'`,
      (secret: string) => `cat $'${secret}\\400ignored'`,
      (secret: string) => `cat $'${secret}\\cX'`,
    ];
    for (const make of forms) {
      const { root, outside } = dirs();
      const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
      const alias = join(outside, 'qode alias');
      symlinkSync(root, alias, 'dir');
      const secret = join(alias, 'secret.txt');
      expect(cfg.privateAliases.has(alias.toLowerCase())).toBe(false);
      expect(mentionsPrivate(cfg, make(secret))).toBe(true);
    }
  });

  it('contamina o Office e não publica o comando shell nem o conteúdo', () => {
    const rootBase = mkdtempSync(join(tmpdir(), 'qode-office-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'qode-office-alias-'));
    const root = join(rootBase, 'private');
    const data = join(rootBase, 'data');
    const home = join(rootBase, 'home');
    mkdirSync(root, { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(home, { recursive: true });
    tempRoots.push(rootBase, outside);
    const alias = join(outside, 'qode alias');
    symlinkSync(root, alias, 'dir');
    const secret = join(alias, 'secret.txt');
    writeFileSync(join(root, 'secret.txt'), 'SENTINEL');
    writeFileSync(join(data, 'qode.config.json'), JSON.stringify({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }));

    let office!: Office;
    const roomAliases = new RoomAliases(null);
    const qode = setupQode({ env: {}, dataDir: data, home, roomAliases, office: () => office });
    office = new Office({
      names: new NameStore(null),
      roomAlias: (p) => roomAliases.get(p),
      version: 'test',
      startedAt: 0,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      terminal: true,
      roomOf: qode.roomOf,
      privacy: qode.privacy,
    });
    const command = `echo \`cat "${secret}"\``;
    office.addMain({ id: 'public', account: '.claude', sessionId: 's', cwd: join(rootBase, 'public'), role: 'principal', startedAt: Date.now(), status: 'working' });
    office.addActivity('public', { id: 'a', kind: 'run', icon: '▶', text: 'SENTINEL', detail: command, at: Date.now() }, true);
    expect(qode.privacy!.isPrivate('public')).toBe(true);
    const published = JSON.stringify(office.commit().snapshot);
    expect(published).not.toContain('qode alias');
    expect(published).not.toContain('SENTINEL');
  });

  it('aceita caminhos públicos e não confunde prefixos vizinhos, mantendo os budgets', () => {
    const { root, outside } = dirs();
    const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
    const publicDir = join(outside, 'public');
    mkdirSync(publicDir, { recursive: true });
    const publicPath = join(publicDir, 'secret.txt');
    const neighbor = `${root}-neighbor/secret.txt`;
    expect(mentionsPrivate(cfg, `cat "${publicPath}"`)).toBe(false);
    expect(mentionsPrivate(cfg, `echo "$(cat '${publicPath}')"`)).toBe(false);
    expect(mentionsPrivate(cfg, `cat "${neighbor}"`)).toBe(false);
    expect(mentionsPrivate(cfg, "I'm working on it")).toBe(false);
    expect(mentionsPrivate(cfg, 'Use `foo` when ready')).toBe(false);
    expect(mentionsPrivate(cfg, `I'm reading ${root} secret.txt`)).toBe(true);
    expect(mentionsPrivate(cfg, `I'm reading ${publicPath}`)).toBe(false);

    const publicWords = Array.from({ length: MENTIONS_TOKENS_MAX }, (_, i) => `/tmp/public-workspace/file-${i}.txt`).join(' ');
    expect(mentionsPrivate(cfg, publicWords)).toBe(false);
    expect(mentionsPrivate(cfg, `${publicWords} /tmp/public-workspace/over-budget.txt`)).toBe(true);
    expect(mentionsPrivate(cfg, 'x'.repeat(MENTIONS_BYTES_MAX + 1))).toBe(true);
  });

  it('falha fechado ao exceder profundidade de substituição shell', () => {
    const { root, outside } = dirs();
    const cfg = parseConfig({ projetos: [{ nome: 'Privado', caminhos: [root], privado: true }] }, homeDir());
    const alias = join(outside, 'qode alias');
    symlinkSync(root, alias, 'dir');
    const secret = join(alias, 'secret.txt');
    const nested = `echo "$(echo \"$(echo \\\"$(cat '${secret}')\\\")\")"`;
    expect(mentionsPrivate(cfg, nested)).toBe(true);
    const deep = `${'$('.repeat(20_000)}x${')'.repeat(20_000)}`;
    expect(mentionsPrivate(cfg, deep)).toBe(true);
  });
});
