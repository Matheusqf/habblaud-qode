// Servidor do QODE Office: observa as sessões abertas do Claude Code (todas as contas),
// mantém o modelo do escritório e transmite via SSE. Sem dependências de runtime.
//   npm run dev    -> tsx server/index.ts --dev (Vite em middleware mode, HMR no mesmo servidor)
//   npm start      -> node dist/server/index.js (serve dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { codexDirsRefused, isDefaultDir } from './accounts/detect';
import { AccountsService } from './accounts/service';
import { isTruthy, loadConfig, messagesOffReason, terminalOffReason, worldSocketUrl } from './config';
import { createApiHandler, sendJson } from './http/app';
import { createRequestGuard, isLoopbackHost } from './http/guard';
import { authEnabled, createAuth, loadAuthFile, remoteEnabled } from './http/auth';
import { securityPreflight } from './http/security-preflight';
import { createReadOnlyRouter, loadRemoteRoConfig, remoteRoPreflight, roAuthFileSource, RO_HOST } from './http/remote-ro';
import { createRemoteDto } from './http/remote-dto';
import { createRemoteView } from './http/remote-view';
import { createRemoteGate, isRemoteRequest, loadSecret, RemoteSessions, startRemoteListener, type RemoteListener } from './http/remote';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { TerminalStreams } from './http/terminal';
import { createTimelineHandler } from './http/timeline';
import { TIMELINE_DIR, TimelineRecorder } from './history/timeline';
import { DayStatsService } from './history/daystats';
import { describeStateMigration, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { RoomAliases } from './model/room-aliases';
import { createPtyRoutes } from './http/pty';
import { claudeBinFrom, isExecutableFile, loadPty, PtyManager, type ScreenFactory, type SpawnPty } from './pty/manager';
import { loadHeadlessScreen } from './pty/screen';
import { openMainAgent, SessionHistory } from './sources/history';
import { HistorySet, SourceSet } from './sources/source';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';
import { codexAccountOf } from './codex/http';
import { createCodexQueueRunner, findCodexBin } from './messages/codex';
import { createMessageRoutes } from './messages/http';
import { MessageRegistry } from './messages/registry';
import type { CodexLive } from './sources/codex/live';
import { ClaudeWatcher } from './sources/watcher';
import { discoverCodexDirs } from './sources/codex/accounts';
import { CodexHistory } from './sources/codex/history';
import { CodexSource } from './sources/codex/source';
import { readOnlyRunner } from './sources/opencode/reader';
import { OpenCodeSource } from './sources/opencode/source';
import { createBuildReader, readBuildInfo } from './build';
import { setupQode } from './qode';
import { qodePreflight, qodeRequired } from './qode/preflight';
import { setupContinuityFixture } from './qode/continuity-reader';
import { setupTaskRegistry } from './qode/task-registry-reader';
import { UpdateChecker } from './updates/checker';
import { loadCloudConfig } from './cloud/contract';
import { buildCloudCollectors } from './cloud/collectors';
import { CloudSource } from './cloud/source';
import { getLocale, tr } from '../shared/i18n';
import type { WorldLocale } from '../shared/world/protocol';
import { createCliRunner, createOpener, SpawnService } from './spawn/spawn';
import { runnableClaudeBin } from './claude-bin';
import { AttachmentStore } from './spawn/attachments';
import { recentFolders } from './spawn/folders';
import { isDemoId } from '../shared/timeline';
import { DictationService } from './dictation/dictation';
import { createWhisperTranscriber, findWhisper } from './dictation/whisper';
import { DeliveryIndex } from './deliveries/deliveries';
import { FileFetcher } from './deliveries/fetcher';
import { WorldClient } from './world/client';
import { createWorldRoutes } from './world/http';
import { WorldService } from './world/service';
import { WorldSettingsStore } from './world/settings';
import { OwnerSocial } from './world/social';
import { BuildingTokens } from './world/tokens';
import { BuildingUplink } from './world/uplink';
import { WorldViewer } from './world/viewer';

const config = loadConfig();
const startedAt = Date.now();

// Nome antigo (CodeTown, até a 0.3.2): leva ~/.codetown para ~/.habblaud antes de ler qualquer estado e avisa
// das variáveis CODETOWN_* que não valem mais. No Docker, quem migra é o docker:up.
if (!config.inDocker) {
  const r = migrateLegacyStateDir(config.home);
  const msg = describeStateMigration(r);
  if (msg) (r.error ? log.warn : log.info)(msg);
}
const legacyEnv = legacyEnvWarning(Object.keys(process.env));
if (legacyEnv) log.warn(legacyEnv);

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();
// Nomes de sala escolhidos pelo usuário (botão direito > Renomear).
const roomAliases = new RoomAliases(join(config.dataDir, 'rooms.json'));
roomAliases.load();
// B4: auth/remoto/ALLOWED_HOSTS — fail-closed antes de Vite, ingestão ou listen (não depende de QODE_REQUIRED).
{
  const problems = securityPreflight({
    env: process.env,
    dataDir: config.dataDir,
    host: config.host,
    inDocker: config.inDocker,
    dev: config.dev,
    allowedHosts: config.allowedHosts,
  });
  if (problems.length) {
    log.error(`Preflight de segurança recusou iniciar:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}
// Entrada remota só-leitura: preflight ANTES de qualquer fonte/listener. Com HABBLAUD_REMOTE_RO ligado exige também
// privacidade QODE válida (qode.config.json), independentemente de HABBLAUD_QODE_REQUIRED (review ZikaBOT #14 P1).
const roConfig = loadRemoteRoConfig(process.env);
{
  const problems = remoteRoPreflight({
    env: process.env,
    dev: config.dev,
    demo: config.demo,
    host: config.host,
    qode: { dataDir: config.dataDir, home: config.home, inDocker: config.inDocker, allowedHosts: config.allowedHosts },
  });
  if (problems.length) {
    log.error(`Preflight da entrada só-leitura recusou iniciar:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}
// Fork QODE: com HABBLAUD_QODE_REQUIRED=1, recusa iniciar a ingestão se a config/bind não forem seguros.
if (qodeRequired(process.env)) {
  const problems = qodePreflight({ env: process.env, dataDir: config.dataDir, home: config.home, host: config.host, inDocker: config.inDocker, allowedHosts: config.allowedHosts });
  if (problems.length) {
    log.error(`QODE preflight (HABBLAUD_QODE_REQUIRED=1) recusou iniciar:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  log.info('QODE preflight: ok.');
}
// Fork QODE (server/qode): uma sala por projeto e privacidade por allowlist, pelo qode.config.json. Sem ele, nada muda.
const qode = setupQode({ env: process.env, dataDir: config.dataDir, home: config.home, inDocker: config.inDocker, roomAliases, office: () => office });
// Defesa em profundidade (P1): o RO nunca arranca com o Office sem filtro de privacidade (setupQode sem config).
if (roConfig.enabled && !qode.privacy) {
  log.error('Entrada só-leitura: privacidade QODE não ficou ativa (qode.config.json ausente/ilegível). Recusado iniciar.');
  process.exit(1);
}

// Office, contas e fontes de agentes se referenciam (avisos de mudança / fontes): ligação tardia.
const late: { office?: Office; agents?: SourceSet; permissions?: PermissionRegistry; messages?: MessageRegistry; ptys?: PtyManager; ptyOff?: string } = {};
// Versão nova: consulta a release mais recente no GitHub a cada 6 h (HABBLAUD_UPDATE_CHECK=0 desliga).
const updates = new UpdateChecker({
  current: config.version,
  repo: config.repo,
  enabled: config.updateCheck,
  file: join(config.dataDir, 'updates.json'),
  onChange: () => late.office?.markDirty(),
});
updates.load();
// Habblaud World (server/world/): na QODE só liga com HABBLAUD_WORLD=1 (server.habblaud.com, ou HABBLAUD_WORLD_URL).
// Sem a flag nada sai do computador; uma HABBLAUD_WORLD_URL recusada deixa o recurso desligado.
const worldStore = new WorldSettingsStore(join(config.dataDir, 'world.json'));
if (config.world.enabled && config.world.url) worldStore.load();
// O social leve do dono (world/social.ts): likes do dia, "enquanto você estava fora", batidas na porta e bloqueados.
const worldSocial = config.world.enabled ? new OwnerSocial({ session: () => worldStore.get()?.deviceId, onChange: () => late.office?.markDirty() }) : undefined;
const world = config.world.enabled
  ? new WorldService({
      config: config.world,
      terminal: config.terminal,
      store: worldStore,
      client: config.world.url ? new WorldClient({ baseUrl: config.world.url, version: config.version }) : undefined,
      onChange: () => late.office?.markDirty(),
      social: worldSocial,
    })
  : undefined;
const accounts = new AccountsService({
  dirs: config.claudeDirs,
  home: config.home,
  env: process.env,
  usageDir: config.usageDir,
  onChange: () => late.office?.markDirty(),
});
const office = new Office({
  names,
  roomAlias: (path) => roomAliases.get(path),
  version: config.version,
  // No modo dev o Vite serve o cliente direto do código-fonte: não há build para comparar.
  build: config.dev ? undefined : createBuildReader(config.rootDir),
  startedAt,
  accounts: (sessions) => accounts.list(sessions),
  sources: () => late.agents?.sources() ?? [],
  accountName: (id) => accounts.find(id)?.detected.name,
  terminal: config.terminal,
  permissions: () => late.permissions?.snapshot() ?? new Map(),
  messages: config.messages ? () => late.messages?.reachable() ?? new Set() : undefined,
  ptys: () => (late.ptys ? { status: late.ptys.status(), list: late.ptys.list() } : { status: { enabled: false, reason: late.ptyOff ?? tr('desligado') }, list: [] }),
  updates: () => updates.status(),
  roomOf: qode.roomOf,
  privacy: qode.privacy,
  world: () => world?.meta() ?? { enabled: false, configured: false, state: 'off' },
});
// Fontes de agentes, uma por ferramenta (sources/source.ts): a do Claude Code e, depois dela, a do Codex (quando há
// pastas do Codex; HABBLAUD_CODEX=0 desliga), com o histórico dela no HistorySet abaixo e as contas registradas por
// ela mesma (accounts.setProviderAccounts). `codex` também recebe os eventos dos hooks do Codex (CodexLive).
const claude = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker });
const agents = new SourceSet([claude]);
const codexDirs = config.codex ? discoverCodexDirs(process.env, config.home) : [];
const codex = codexDirs.length ? new CodexSource({ accounts, office, dirs: codexDirs, env: process.env, home: config.home }) : undefined;
if (codex) agents.add(codex);
// Agentes cloud (server/cloud): observe-only, desligado por padrão (HABBLAUD_CLOUD=1 + allowlist HABBLAUD_CLOUD_PROJECTS).
const cloudConfig = loadCloudConfig(process.env);
if (cloudConfig.enabled) {
  const collectors = buildCloudCollectors(cloudConfig, process.env);
  if (!cloudConfig.projects.size) log.warn('Cloud: HABBLAUD_CLOUD=1 sem HABBLAUD_CLOUD_PROJECTS: nada será mostrado.');
  agents.add(new CloudSource({ office, collectors }));
}
// OpenCode (sources/opencode/): opt-in (HABBLAUD_OPENCODE=1) + allowlist de projetos (HABBLAUD_OPENCODE_PROJECTS). Só
// metadados (modelo, atividade inferida, tokens, custo), lidos do SQLite em modo somente leitura (reader.ts).
if (config.opencode) {
  const opencodeDir = process.env.HABBLAUD_OPENCODE_DATA?.trim() || join(config.home, '.local', 'share', 'opencode');
  if (!config.opencodeProjects.length) log.warn('OpenCode: HABBLAUD_OPENCODE=1 sem HABBLAUD_OPENCODE_PROJECTS; nenhuma sessão vai entrar.');
  agents.add(
    new OpenCodeSource({ accounts, office, dataDir: opencodeDir, projects: config.opencodeProjects, run: readOnlyRunner(join(opencodeDir, 'opencode.db')) }),
  );
}
// Eventos dos hooks do Codex (POST /api/codex/events, mod/habblaud-codex/hook.mjs): vão para a fonte do Codex ao vivo
// (CodexLive); sem ela (nenhuma pasta do Codex ou HABBLAUD_CODEX=0) a rota responde {ok: false}.
const codexLive: CodexLive | undefined = codex;
late.office = office;
late.agents = agents;
// Página que pode responder pelo escritório: Host local na porta local; na remota, só com permissions liberado.
const hub = new Hub(office, {
  canAnswer: (req) => (isRemoteRequest(req) ? !!config.remote?.allow.has('permissions') : isLoopbackHost(req.headers.host)),
});
// "Meu dia": amostra o escritório a cada segundo e persiste em <dataDir>/stats/ (ver history/daystats.ts).
const stats = new DayStatsService({ dir: join(config.dataDir, 'stats'), snapshot: () => hub.current() });
stats.load();
// O prédio no Habblaud World (world/uplink.ts): só com o servidor do mundo aceito. Conecta sozinho com a conta aprovada, o
// personagem criado, a trava do terminal e sem pausa; o pacote sai só da projeção (shared/world/projection.ts).
const worldTokens = new BuildingTokens({ stats });
const worldUplink =
  world && config.world.url
    ? new BuildingUplink({
        url: worldSocketUrl(config.world.url),
        version: config.version,
        build: () => {
          const b = readBuildInfo(config.rootDir);
          return { commit: b.commit, dirty: b.dirty };
        },
        locale: () => getLocale() as WorldLocale,
        store: worldStore,
        canAct: () => config.terminal,
        agents: () => qode.officeView(office).list(),
        subscribe: (cb) => office.onChange(cb),
        booting: () => office.isBooting(),
        tokens: () => worldTokens.read(),
        lastFile: join(config.dataDir, 'world-last-uplink.json'),
        onGoodbye: (reason) => world.goodbye(reason),
        onLeft: () => world.leftElsewhere(),
        onChange: () => office.markDirty(),
      })
    : undefined;
if (world && worldUplink) world.attachUplink(worldUplink);
// A cena Mundo (world/viewer.ts): a cidade pela mesma conexão do prédio, só com a cena aberta no navegador.
const worldViewer = worldUplink ? new WorldViewer() : undefined;
if (worldUplink && worldViewer) {
  worldViewer.attach(worldUplink);
  worldUplink.attachCity(worldViewer);
}
if (worldUplink && worldSocial) {
  worldSocial.attach(worldUplink);
  worldUplink.attachOwner(worldSocial);
}
// Terminal: só existe com bind local (ver terminalOffReason em config.ts).
// Cada agente com o parser da ferramenta dele (o do Claude Code por padrão).
const terminals = config.terminal
  ? new TerminalStreams({
      office,
      transcriptPathOf: qode.transcriptPathOf((id) => agents.transcriptPathOf(id)),
      parserFor: qode.parserFor((id) => agents.parserFor(id)),
    })
  : undefined;
// Histórico do terminal (sessões recentes, abertas ou encerradas, de todas as ferramentas): mesma trava.
const history = config.terminal
  ? new HistorySet([new SessionHistory({ accounts: () => accounts.entries(), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) })])
  : undefined;
if (history && codex) history.add(new CodexHistory({ accounts: () => accounts.entriesOf('codex'), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) }));
// Entregas: o fim de cada pedido, lido dos transcripts do histórico (mesma trava do terminal). Os arquivos entregues
// são lidos aqui (Node, ou pasta de conta montada no Docker) ou pelo auxiliar do host.
const historyView = history && qode.history(history);
const deliveries = historyView
  ? new DeliveryIndex(
      qode.deliveries({
        sessions: () => historyView.list(),
        resolve: (account, sessionId) => {
          const r = historyView.resolve(account, sessionId);
          return 'path' in r ? r : undefined;
        },
        isBusy: (id) => {
          const st = office.list().find((a) => a.id === id)?.status;
          return st === 'working' || st === 'waiting' || st === 'shell';
        },
        agentName: (id) => office.list().find((a) => a.id === id)?.name,
      }),
    )
  : undefined;
const deliveryFiles = deliveries
  ? new FileFetcher({
      direct: !config.inDocker,
      mapHostPath: (p) => {
        for (const e of accounts.entries()) {
          const host = e.detected.configDir.replace(/\/+$/, '');
          if (host && p.startsWith(`${host}/`)) return `${e.dir.replace(/\/+$/, '')}${p.slice(host.length)}`;
        }
        return undefined;
      },
    })
  : undefined;
// Linha do tempo do timelapse: grava cada snapshot novo (com throttle) em <dataDir>/timeline.
const timelineDir = join(config.dataDir, TIMELINE_DIR);
const timeline = config.timeline ? new TimelineRecorder({ dir: timelineDir }) : undefined;
if (timeline) hub.onSnapshot((snap) => timeline.ingest(snap));
// Responder pelo escritório (hook PermissionRequest): age sobre as sessões, então segue a mesma trava.
const permissions = config.terminal
  ? new PermissionRegistry({
      office: qode.officeView(office),
      viewers: () => hub.localSize,
      answerLater: () => !!config.remote?.allow.has('permissions'),
      // Só o Claude Code: a busca da resposta dada no terminal lê o formato do transcript dele.
      transcriptPathOf: (id) => claude.transcriptPathOf(id),
      // Pedidos do hook do Codex: a conta pela pasta CODEX_HOME que ele manda.
      codexAccount: (account, codexHome) => codexAccountOf(accounts.entriesOf('codex'), account, codexHome),
      demoDecide: (id, d) => office.decideDemoPermission(id, d),
      demoDetail: (id) => office.demoPermission(id),
    })
  : undefined;
late.permissions = permissions;
// Mensagens pelo escritório (plugin habblaud-mensagens): entram na sessão como se você as tivesse digitado, então
// seguem a mesma trava (e HABBLAUD_MENSAGENS=0 desliga só elas). Ao Codex vão por `codex queue` (messages/codex.ts):
// fora do Docker o próprio servidor roda o comando (HABBLAUD_CODEX_BIN ou `codex` do PATH); no Docker, o auxiliar do
// host (npm run codex:bridge).
const codexBin = config.messages && !config.inDocker ? findCodexBin(process.env) : undefined;
// Terminal interativo e Novo agente: os dois rodam o Claude Code neste computador, então pedem a mesma liberação,
// HABBLAUD_PTY=1 (aceita os mesmos valores do HABBLAUD_TERMINAL).
const ptyFlag = process.env.HABBLAUD_PTY?.trim();
const ptyOptIn = isTruthy(ptyFlag);
// Novo agente pelo escritório (sessão do Claude Code em segundo plano, ou a tela do app do Claude preenchida): a
// liberação acima mais a trava das mensagens. No Docker, quem roda é o auxiliar do host (npm run codex:bridge).
const spawnOn = config.messages && ptyOptIn;
const attachments = spawnOn ? new AttachmentStore() : undefined;
const spawnBin = config.inDocker ? undefined : runnableClaudeBin(process.env);
const spawn = spawnOn
  ? new SpawnService(config.inDocker ? { attachments } : { opener: createOpener(), cli: spawnBin ? createCliRunner(spawnBin) : undefined, attachments })
  : undefined;
// Ditado: no Docker quem transcreve é o auxiliar do host; no Node, o servidor, se achar o Whisper local.
const whisper = config.messages && !config.inDocker ? findWhisper() : undefined;
const dictation = config.messages
  ? new DictationService(whisper && !('missing' in whisper) ? { transcriber: createWhisperTranscriber(whisper) } : {})
  : undefined;
const messages = config.messages
  ? new MessageRegistry({
      office: qode.officeView(office),
      demoAgent: (id) => office.demoAgent(id),
      demoDeliver: (id, text) => office.deliverDemoMessage(id, text),
      codex: {
        run: codexBin ? createCodexQueueRunner(codexBin) : undefined,
        homeOf: (account) => accounts.entriesOf('codex').find((e) => e.id === account)?.detected.configDir,
      },
    })
  : undefined;
late.messages = messages;

// Terminal interativo (abrir/assumir sessões e encerrar agentes): opt-in com HABBLAUD_PTY=1, só com bind local, fora
// do Docker, com node-pty e o executável do claude no PATH.
const claudeBinSetting = process.env.HABBLAUD_CLAUDE_BIN?.trim();
const claudeBin = claudeBinFrom();
let spawnPty: SpawnPty | null = null;
let ptyScreen: ScreenFactory | undefined;
let ptyOff: string | undefined;
if (!ptyOptIn) ptyOff = ptyFlag ? tr('desligado por HABBLAUD_PTY={0}', [ptyFlag]) : tr('desligado (ligue com HABBLAUD_PTY=1)');
else if (config.inDocker) ptyOff = tr('indisponível no Docker (rode com npm start)');
else if (!config.terminal) ptyOff = tr('mesma trava do terminal ({0})', [terminalOffReason(process.env, config.host, config.inDocker)]);
else if (!claudeBin) ptyOff = claudeBinSetting ? tr('HABBLAUD_CLAUDE_BIN não encontrado no PATH ({0})', [claudeBinSetting]) : tr('executável "claude" não encontrado no PATH (defina HABBLAUD_CLAUDE_BIN)');
else if (!isExecutableFile(claudeBin)) ptyOff = tr('o executável do Claude Code não roda: {0} (confira o HABBLAUD_CLAUDE_BIN)', [claudeBin]);
else {
  const loaded = await loadPty();
  spawnPty = loaded.spawn;
  ptyOff = loaded.reason;
  if (spawnPty) {
    const screen = await loadHeadlessScreen();
    ptyScreen = screen.create ?? undefined;
    if (screen.reason) log.warn(tr('Terminal interativo sem a tela completa ({0}): ao reconectar, modos como a colagem entre colchetes podem se perder.', [screen.reason]));
  }
}
const ptys = spawnPty
  ? new PtyManager({
      spawn: spawnPty,
      claudeBin: claudeBin ?? 'claude',
      accounts: () => accounts.entries().map((a) => ({ id: a.id, dir: a.dir, isDefault: isDefaultDir(a.dir, config.home) })),
      agent: (id) => {
        const a = qode.officeView(office).get(id);
        return a && { id: a.id, kind: a.kind, account: a.account, sessionId: a.sessionId, cwd: office.roomPath(a.roomId) };
      },
      blockedCwd: (cwd) => qode.blockedCwd(cwd),
      hidden: (info) => qode.hiddenPty(info),
      onChange: () => office.markDirty(),
      createScreen: ptyScreen,
    })
  : undefined;
if (ptys) office.onChange(() => ptys.enforcePrivacy());
late.ptys = ptys;
late.ptyOff = ptyOff;

if (config.demo) office.setDemo(true);
// As fontes síncronas (a do Claude Code) terminam o boot aqui, antes de o hub começar a transmitir.
void agents.start();
accounts.start();
hub.start();
if (timeline) {
  timeline.start();
  timeline.ingest(hub.current());
}
permissions?.start();
messages?.start();
stats.start();
updates.start();
worldUplink?.start();
const ticker = setInterval(() => {
  try {
    office.tick();
  } catch (err) {
    log.warnOnce(`tick:${errMsg(err)}`, tr('Falha no relógio do escritório: {0}', [errMsg(err)]));
  }
}, 250);

const api = createApiHandler({
  renameRoom: (id, name) => {
    const path = office.roomPath(id);
    if (!path) return undefined;
    roomAliases.set(path, name);
    office.refreshRoomNames();
    return office.roomName(id);
  },
  office,
  hub,
  accounts,
  sources: () => agents.sources(),
  version: config.version,
  inDocker: config.inDocker,
  health: () => ({ qode: qode.health() }),
  continuity: setupContinuityFixture(process.env, config.host, config.dataDir),
  tasks: setupTaskRegistry(process.env, config.host, config.dataDir),
  terminal: config.terminal,
  terminals,
  sessions: historyView,
  timeline: createTimelineHandler({ dir: timelineDir, recording: !!timeline }),
  permissions: permissions ? createPermissionRoutes(qode.permissionRoutes(permissions)) : undefined,
  messages: messages ? createMessageRoutes(messages) : undefined,
  pty: ptys ? createPtyRoutes(ptys) : undefined,
  spawn,
  attachments,
  dictation,
  deliveries,
  files: deliveryFiles,
  spawnFolders: async () => {
    const snap = hub.current();
    const last = new Map<string, number>();
    for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
    const rooms = snap.rooms.filter((r) => !isDemoId(r.id)).map((r) => ({ path: r.path, lastAt: last.get(r.id) ?? 0 }));
    return recentFolders(history ? await history.list().catch(() => []) : [], rooms);
  },
  codexLive,
  stats,
  updates,
  remote: config.remote ? { is: isRemoteRequest, allows: (f) => config.remote!.allow.has(f) } : undefined,
  world: world ? createWorldRoutes(world, worldViewer, worldSocial) : undefined,
});

const server = http.createServer();
let closeVite: (() => Promise<void>) | undefined;

function parseUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** Quem atende o que não é /api: o Vite (dev) ou os arquivos de dist/client (produção). */
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (config.dev) {
  // Import dinâmico: o bundle de produção nunca carrega o Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(config.rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

// Host/Origin/Content-Type: barra DNS rebinding e CSRF antes de qualquer rota (inclusive o Vite).
const guard = createRequestGuard({ allowedHosts: config.allowedHosts });
// B4 L1: auth opt-in (HABBLAUD_AUTH=1 ou HABBLAUD_REMOTE=1). Sem a variável, comportamento atual.
const auth = createAuth({
  enabled: authEnabled(process.env),
  dataDir: config.dataDir,
  hooksToken: process.env.HABBLAUD_HOOKS_TOKEN,
  // Secure/__Host pelo perfil canónico (remoto) ou TLS real — nunca X-Forwarded-Proto.
  secureCookies: remoteEnabled(process.env),
});
if (auth.enabled && !loadAuthFile(config.dataDir)) {
  // securityPreflight já recusou na ausência de senha; este ramo é defesa em profundidade.
  log.warn('HABBLAUD_AUTH ligado mas sem auth.json válido (fail-closed): rode `npm run auth:set-password`. Login recusado até lá.');
}

server.on('request', (req, res) => {
  const url = parseUrl(req);
  try {
    if (guard(req, res)) return;
    if (auth.handle(req, res, url.pathname)) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(tr('Erro ao responder {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
    if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
    else res.destroy();
  }
});

// Entrada remota só-leitura (fatia 4): desligada por padrão; porta própria SEMPRE em 127.0.0.1 (para um proxy
// privado como Tailscale Serve à frente — nunca Funnel/0.0.0.0). Ver docs/QODE-REMOTE-RO.md.
if (roConfig.enabled && roConfig.port) {
  let roGeneration = loadAuthFile(config.dataDir)?.generation;
  // Vista própria, fora do Hub (não conta como página local → não desvia permissões), com o DTO remoto.
  const roView = createRemoteView({ hub, dto: createRemoteDto() });
  const ro = createReadOnlyRouter({
    // Uma leitura do auth.json por verificação (senha + generation do MESMO snapshot).
    authFile: roAuthFileSource(config.dataDir),
    view: roView,
    shell: (req, res, url) => fallback(req, res, url),
    updates: () => ({ version: config.version, ...updates.status() }),
    expectedOrigin: process.env.HABBLAUD_REMOTE_RO_ORIGIN?.trim() || undefined,
    secureCookie: true,
  });
  // Senha trocada (auth:set-password) ou auth.json ausente/inválido: revoga e fecha streams abertos. Cada pedido já
  // confere a generation; o sweep fecha os SSE abertos.
  setInterval(() => {
    const g = loadAuthFile(config.dataDir)?.generation;
    if (g !== roGeneration) {
      roGeneration = g;
      ro.revokeAll();
    }
    ro.sweep();
  }, 5_000).unref();
  process.on('SIGUSR2', () => ro.revokeAll());
  const roServer = http.createServer((req, res) => {
    try {
      ro.handle(req, res);
    } catch (err) {
      log.warn(`Entrada só-leitura: erro (${errMsg(err)}).`);
      if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
      else res.destroy();
    }
  });
  roServer.listen(roConfig.port, RO_HOST, () => log.info(`   Entrada só-leitura: http://${RO_HOST}:${roConfig.port} (atrás de proxy privado; sem Funnel).`));
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(tr('A porta {0} já está em uso (defina HABBLAUD_PORT para usar outra).', [config.port]));
  else log.error(tr('Erro no servidor HTTP: {0}', [errMsg(err)]));
  process.exit(1);
});

/**
 * Porta remota (celular na rede local): o mesmo app, mas toda requisição passa pelo login (http/remote.ts) antes da
 * API. A porta principal segue só local; quem separa as duas é a porta em que a conexão chegou.
 */
let remoteListener: RemoteListener | undefined;
if (config.remote) {
  const remote = config.remote;
  const gate = createRemoteGate({
    config: remote,
    sessions: new RemoteSessions(loadSecret(join(config.dataDir, 'remote-secret')), remote, Date.now, join(config.dataDir, 'remote-revoked.json')),
    secure: !!remote.tls,
    caFile: remote.tls?.caFile,
  });
  remoteListener = startRemoteListener(
    remote,
    (req, res) => {
      const url = parseUrl(req);
      try {
        if (guard(req, res)) return;
        if (gate(req, res, url)) return;
        if (!api(req, res, url)) fallback(req, res, url);
      } catch (err) {
        log.warn(tr('Erro ao responder (remoto) {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
        else res.destroy();
      }
    },
    log,
    config.allowedHosts,
  );
  remoteListener.server.once('listening', () => {
    const allow = [...remote.allow].join(', ') || tr('só ver');
    const where = config.inDocker ? tr('publicada pelo HABBLAUD_REMOTE_BIND') : remote.host;
    const scheme = remote.tls ? 'HTTPS' : tr('HTTP SEM criptografia (HABBLAUD_REMOTE_INSECURE_HTTP)');
    log.info(tr('   Acesso remoto: ligado na porta {0} ({1}), {2}, com login; libera: {3}.', [remote.port, where, scheme, allow]));
    if (remote.allow.has('spawn') && !spawn) log.warn(tr('   Acesso remoto: "spawn" liberado, mas o Novo agente está desligado (ligue com HABBLAUD_PTY=1).'));
  });
} else if (config.remoteWarning) {
  log.warn(`   ${config.remoteWarning}.`);
}

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(tr('🏢 QODE Office {0}{1}{2} em http://{3}:{4}', [config.version, config.dev ? ' (dev)' : '', config.inDocker ? ' (docker)' : '', host, config.port]));
  const list = accounts.entries();
  if (!list.length) log.warn(tr('Nenhuma pasta do Claude Code encontrada (defina HABBLAUD_CLAUDE_DIRS).'));
  for (const dir of codexDirsRefused(process.env, config.home)) {
    log.warn(tr('{0} é uma pasta do Codex, não do Claude Code: fica fora das contas do Claude Code.', [dir]));
  }
  for (const a of list) {
    const src = agents.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(tr('   Conta {0} ({1}): {2} sessão(ões) aberta(s) · uso: {3} · {4}', [a.detected.short, a.id, src?.sessions ?? 0, usage, a.dir]));
  }
  if (codex) {
    const codexAccounts = codex.accountEntries();
    const open = codex.sources().reduce((n, s) => n + s.sessions, 0);
    log.info(tr('   Codex: {0} conta(s), {1} sessão(ões) aberta(s).', [codexAccounts.length, open]));
    for (const a of codexAccounts) {
      log.info(tr('   Conta {0} do Codex ({1}): uso: {2} · {3}', [a.detected.short, a.id, accounts.usageView(a.id).status, a.detected.configDir]));
    }
  } else {
    log.info(tr('   Codex: {0}.', [config.codex ? tr('nenhuma pasta do Codex encontrada (defina HABBLAUD_CODEX_DIRS)') : tr('desligado (HABBLAUD_CODEX=0)')]));
  }
  if (office.isDemo()) log.info(tr('   Modo demonstração ligado (agentes simulados misturados aos reais).'));
  if (config.terminal) log.info(tr('   Terminal: ligado (acesso só local).'));
  else log.info(tr('   Terminal: desligado ({0}).', [terminalOffReason(process.env, config.host, config.inDocker)]));
  log.info(ptys ? tr('   Terminal interativo: ligado ({0}).', [claudeBin]) : tr('   Terminal interativo: {0}.', [ptyOff ?? tr('desligado')]));
  log.info(
    !spawn
      ? tr('   Novo agente: desligado ({0}).', [!ptyOptIn ? tr('ligue com HABBLAUD_PTY=1') : tr('mesma trava das mensagens')])
      : config.inDocker
        ? tr('   Novo agente: ligado, pelo auxiliar do host (deixe npm run codex:bridge rodando no computador).')
        : spawnBin
          ? tr('   Novo agente: ligado ({0} --bg; pasta ainda não confiável abre no app do Claude).', [spawnBin])
          : tr('   Novo agente: ligado, só pelo app do Claude (claude não encontrado no PATH).'),
  );
  log.info(timeline ? tr('   Linha do tempo (timelapse): gravando em {0}.', [timelineDir]) : tr('   Linha do tempo (timelapse): gravação desligada (HABBLAUD_TIMELINE).'));
  log.info(tr('   Responder pelo escritório: {0}.', [config.terminal ? tr('ligado (precisa do mod: npm run mod:install; ou do hook antigo: npm run hooks:install)') : tr('desligado (mesma trava do terminal)')]));
  log.info(
    config.messages
      ? tr('   Mensagens pelo escritório: ligadas (precisa do plugin habblaud-mensagens: npm run mod:install).')
      : tr('   Mensagens pelo escritório: desligadas ({0}).', [messagesOffReason(process.env, config.host, config.inDocker)]),
  );
  if (config.messages) {
    log.info(
      codexBin
        ? tr('   Mensagens ao Codex: pelo codex queue ({0}).', [codexBin])
        : config.inDocker
          ? tr('   Mensagens ao Codex: pelo auxiliar do host (deixe npm run codex:bridge rodando no Mac).')
          : tr('   Mensagens ao Codex: sem o binário do Codex (codex no PATH ou HABBLAUD_CODEX_BIN); o auxiliar npm run codex:bridge também serve.'),
    );
  }
  if (config.world.warning) log.warn(`   ${config.world.warning}.`);
  log.info(
    !world
      ? tr('   Habblaud World: escondido (HABBLAUD_WORLD=0).')
      : !config.world.url
        ? tr('   Habblaud World: desligado (HABBLAUD_WORLD_URL recusada).')
        : tr('   Habblaud World: {0}, conta neste computador: {1}{2}.', [
            config.world.defaultUrl ? tr('{0} (padrão)', [config.world.url]) : config.world.url,
            world.state(),
            config.terminal ? '' : tr(' (só leitura: a trava do terminal está desligada)'),
          ]),
  );
  log.info(
    updates.enabled
      ? tr('   Versão nova: verificando as releases de github.com/{0} a cada 6 h.', [config.repo])
      : tr('   Versão nova: verificação desligada ({0}).', [config.repo ? 'HABBLAUD_UPDATE_CHECK' : tr('package.json sem repositório no GitHub')]),
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(tr('Encerrando ({0})…', [signal]));
  clearInterval(ticker);
  stats.stop();
  agents.stop();
  accounts.stop();
  hub.stop();
  terminals?.stop();
  timeline?.stop();
  permissions?.stop();
  messages?.stop();
  ptys?.stopAll();
  updates.stop();
  worldViewer?.stop();
  worldUplink?.stop();
  world?.stop();
  names.flush();
  void closeVite?.();
  remoteListener?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
