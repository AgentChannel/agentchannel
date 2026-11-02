import { existsSync, lstatSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { achHome } from './config.js';
import type { ExecLike } from './doctor.js';
import { identifyAch, isV2, MCP_SERVER_NAME, npmSpec, npxAch, thisCliPath, userBin, whichAll } from './invite.js';
import { VERSION } from './version.js';

/**
 * One-line onboarding: what `ach join` sets up after the key is stored. At
 * most three questions, each listing the exact commands and the files they
 * change:
 *
 *   1. connect: (run through npx) install the `ach` command, and add the `ach`
 *      MCP server to Claude Code / Codex (only user-installed ones)   [Y/n]
 *   2. clean up AgentChannel v0.9 (only when found)                    [Y/n]
 *      ALWAYS asked, even with --yes: it renames a directory in $HOME.
 *      Without a terminal it is skipped and the commands are printed.
 *   3. background helper: `ach run --install-service --notify`         [y/N]
 *
 * `--yes` accepts 1 and 3 without asking (and asks nothing else). With no
 * terminal and no --yes nothing is changed: the commands are printed and
 * `ach join` exits non-zero with "Run again with --yes to accept: ...".
 */

export interface SetupIo {
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  exec: ExecLike;
  /** Asks one question; undefined = not interactive. */
  ask?: (q: string) => Promise<string>;
  cwd: string;
}

export interface SetupOptions {
  yes: boolean;
  runtime?: string;
  zh?: boolean;
  /** This CLI's entry (tests). */
  self?: string;
  /** Without a terminal: `ach join` has not used the invite yet; print that step too. */
  join?: { hub: string; once: boolean };
}

export type Argv = string[];

export interface Step {
  id: 'connect' | 'cleanup' | 'service';
  question: string;
  defaultYes: boolean;
  /** Commands, printed as shell lines and run one by one. */
  commands: Argv[];
  /** Extra file actions (renames), printed as `mv`. */
  moves?: { from: string; to: string }[];
  /** Asked even with --yes (never runs without an explicit answer in a terminal). */
  alwaysAsk?: boolean;
}

export const V1_MCP_NAME = 'agentchannel';
export const DONE_LINE = 'Done — open your Claude/Codex and say: check my AgentChannel inbox';
export const DONE_LINE_ZH = '完成 —— 打开你的 Claude/Codex，说：check my AgentChannel inbox';

/** True when this CLI runs from the npx cache (it disappears; install it first). */
export function runFromNpx(self: string = thisCliPath()): boolean {
  return /[\\/]_npx[\\/]/.test(self);
}

export function shq(s: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(a: Argv): string {
  return a.map(shq).join(' ');
}

/** `claude mcp add` / `codex mcp add` argv for this CLI. */
export function mcpAddArgv(kind: 'claude' | 'codex', bin: string, achCmd: Argv, home?: string): Argv {
  if (kind === 'claude') return [bin, 'mcp', 'add', '--scope', 'user', ...(home ? ['-e', `AGENTCHANNEL_HOME=${home}`] : []), MCP_SERVER_NAME, '--', ...achCmd, 'mcp'];
  return [bin, 'mcp', 'add', ...(home ? ['--env', `AGENTCHANNEL_HOME=${home}`] : []), MCP_SERVER_NAME, '--', ...achCmd, 'mcp'];
}

export function mcpRemoveArgv(kind: 'claude' | 'codex', bin: string, name: string): Argv {
  return kind === 'claude' ? [bin, 'mcp', 'remove', '--scope', 'user', name] : [bin, 'mcp', 'remove', name];
}

/**
 * The file `claude mcp add --scope user` / `codex mcp add` writes:
 * $CLAUDE_CONFIG_DIR/.claude.json (else ~/.claude.json), $CODEX_HOME/config.toml
 * (else ~/.codex/config.toml).
 */
export function mcpConfigFile(kind: 'claude' | 'codex', env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  if (kind === 'claude') return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json');
  return join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
}

export interface Detected {
  /** User-installed claude / codex (never the bins npx puts on PATH). */
  claude?: string;
  codex?: string;
  npm?: string;
  npx: boolean;
  /** Version of the global npm package "agentchannel", if any. */
  globalVersion?: string;
  /** An AgentChannel v0.9 data directory (~/.agentchannel with v0.9 files), never the v2 home. */
  v1Home?: string;
  claudeHasV1Mcp: boolean;
  codexHasV1Mcp: boolean;
  claudeHasAch: boolean;
  codexHasAch: boolean;
  /** How the MCP entry and service start ach: `npx -y agentchannel@<spec>` when run through npx, else an absolute v2 ach. */
  achCmd: Argv;
}

/** The absolute command that starts this v2 CLI: an `ach` on PATH that is v2, else node + this file. */
export function absoluteAch(env: NodeJS.ProcessEnv, self: string): Argv {
  const first = whichAll('ach', env)[0];
  if (first && isV2(identifyAch(first, self))) return [first];
  return [process.execPath, self];
}

/** Files AgentChannel v0.9 keeps in ~/.agentchannel. */
const V1_MARKERS = ['config.json', 'identity.json', 'known_keys.json', 'update-check.json', 'messages', 'distill', 'brain'];

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * $HOME/.agentchannel when it is an AgentChannel v0.9 home: a real directory
 * (not a link), with v0.9 files, without v2 credentials, and not the v2 home.
 */
export function detectV1Home(env: NodeJS.ProcessEnv): string | undefined {
  const dir = join(env.HOME || homedir(), '.agentchannel');
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  if (realOr(dir) === realOr(achHome(env))) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (names.includes('agent-key') || names.includes('admin-session')) return undefined;
  return names.some((n) => V1_MARKERS.includes(n)) ? dir : undefined;
}

/**
 * What is on this machine. `probe` = also ask claude/codex/npm (read-only
 * `mcp get` / `npm ls`); without it only PATH and files are looked at.
 */
export async function detect(env: NodeJS.ProcessEnv, exec: ExecLike, self: string, probe: boolean): Promise<Detected> {
  const claude = userBin('claude', env);
  const codex = userBin('codex', env);
  const npm = whichAll('npm', env)[0];
  const npx = runFromNpx(self);
  const d: Detected = {
    claude, codex, npm, npx,
    v1Home: detectV1Home(env),
    claudeHasV1Mcp: false, codexHasV1Mcp: false, claudeHasAch: false, codexHasAch: false,
    // run through npx: the MCP entry uses the same pinned spec as the join line
    achCmd: npx ? npxAch() : absoluteAch(env, self),
  };
  // A v0.9 `ach` on PATH is visible without running anything.
  for (const p of whichAll('ach', env)) {
    const i = identifyAch(p, self);
    if (i.name === 'agentchannel' && i.version && !isV2(i)) d.globalVersion = i.version;
  }
  if (!probe) return d;
  if (npm) {
    const r = await exec(npm, ['ls', '-g', 'agentchannel', '--json', '--depth=0'], env);
    try {
      const v = JSON.parse(r.stdout)?.dependencies?.agentchannel?.version;
      d.globalVersion = typeof v === 'string' ? v : d.globalVersion;
    } catch {
      /* not installed */
    }
  }
  const has = async (bin: string | undefined, name: string) => !!bin && (await exec(bin, ['mcp', 'get', name], env)).code === 0;
  d.claudeHasV1Mcp = await has(claude, V1_MCP_NAME);
  d.codexHasV1Mcp = await has(codex, V1_MCP_NAME);
  d.claudeHasAch = await has(claude, MCP_SERVER_NAME);
  d.codexHasAch = await has(codex, MCP_SERVER_NAME);
  return d;
}

export function isV1Version(v?: string): boolean {
  return !!v && /^0\./.test(v);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Claude Code and Codex" / "Claude Code" / "Codex" / "" */
function targets(d: Pick<Detected, 'claude' | 'codex'>, zh: boolean): string {
  const t = [d.claude ? 'Claude Code' : '', d.codex ? 'Codex' : ''].filter(Boolean);
  return t.join(zh ? ' 和 ' : ' and ');
}

const changes = (kind: 'claude' | 'codex', env: NodeJS.ProcessEnv, zh: boolean) => `${zh ? '修改' : 'changes'} ${mcpConfigFile(kind, env)}`;

/** The steps that apply on this machine, in order. */
export function planSteps(d: Detected, o: { home?: string; achCmd: Argv; installSpec: string; cwd: string; zh?: boolean; env?: NodeJS.ProcessEnv }): Step[] {
  const zh = !!o.zh;
  const env = o.env ?? {};
  const steps: Step[] = [];
  const v1Global = isV1Version(d.globalVersion);
  const install = d.npx && !!d.npm;

  // 1. connect: install `ach` (npx) + MCP entries, one question
  const connect: Step = { id: 'connect', question: '', defaultYes: true, commands: [] };
  const lines: string[] = [];
  if (install) {
    connect.commands.push([d.npm!, 'install', '-g', o.installSpec]);
    lines.push(`  npm install -g ${o.installSpec}    # ${zh ? '`ach` 命令' : 'the `ach` command'}${v1Global ? (zh ? '，替换 AgentChannel v0.9' : '; replaces AgentChannel v0.9') : ''}`);
  }
  for (const kind of ['claude', 'codex'] as const) {
    const bin = d[kind];
    if (!bin) continue;
    if (kind === 'claude' ? d.claudeHasAch : d.codexHasAch) connect.commands.push(mcpRemoveArgv(kind, bin, MCP_SERVER_NAME));
    const add = mcpAddArgv(kind, bin, o.achCmd, o.home);
    connect.commands.push(add);
    lines.push(`  ${shellLine([kind, ...add.slice(1)])}    # ${changes(kind, env, zh)}`);
  }
  if (lines.length) {
    const where = targets(d, zh);
    const head = where
      ? zh ? `把 AgentChannel 接入 ${where}${install ? '（并安装 `ach` 命令）' : ''}？会运行：` : `Add AgentChannel to ${where}${install ? ' (and install the `ach` command)' : ''}? This runs:`
      : zh ? '在这台机器上安装 `ach` 命令？会运行：' : 'Install the `ach` command on this machine? This runs:';
    connect.question = [head, ...lines].join('\n') + '\n';
    steps.push(connect);
  }

  // 2. v0.9 cleanup: only when found; always asked
  const cleanup: Step = { id: 'cleanup', question: '', defaultYes: true, commands: [], moves: [], alwaysAsk: true };
  const what: string[] = [];
  if (v1Global && d.npm && !install) {
    cleanup.commands.push([d.npm, 'uninstall', '-g', 'agentchannel']);
    what.push(`  npm uninstall -g agentchannel    # ${zh ? `旧的 \`ach\`（agentchannel@${d.globalVersion}）` : `old \`ach\` (agentchannel@${d.globalVersion})`}`);
  }
  for (const kind of ['claude', 'codex'] as const) {
    const bin = d[kind];
    if (!bin || !(kind === 'claude' ? d.claudeHasV1Mcp : d.codexHasV1Mcp)) continue;
    const rm = mcpRemoveArgv(kind, bin, V1_MCP_NAME);
    cleanup.commands.push(rm);
    what.push(`  ${shellLine([kind, ...rm.slice(1)])}    # ${zh ? '旧 MCP "agentchannel"，' : 'old MCP "agentchannel"; '}${changes(kind, env, zh)}`);
  }
  if (d.v1Home) {
    const to = `${d.v1Home}-v0.9-backup-${stamp()}`;
    cleanup.moves!.push({ from: d.v1Home, to });
    what.push(`  mv ${shq(d.v1Home)} ${shq(to)}    # ${zh ? 'v0.9 数据改名为备份，不删除' : 'v0.9 data renamed to a backup, nothing deleted'}`);
  }
  if (what.length) {
    cleanup.question = [zh ? '清理 AgentChannel v0.9？会运行：' : 'Clean up AgentChannel v0.9? This runs:', ...what].join('\n') + '\n';
    steps.push(cleanup);
  }

  // 3. background helper with notifications
  steps.push({
    id: 'service',
    question: zh
      ? `安装后台小助手（在 ${o.cwd} 里领取任务，并弹出系统通知）？`
      : `Install the background helper (picks up tasks in ${o.cwd} and shows desktop notifications)?`,
    defaultYes: false,
    commands: [[...o.achCmd, 'run', '--install-service', '--notify', '--interactive-first', '--dir', o.cwd]],
  });
  return steps;
}

function yesNo(answer: string, def: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return def;
  return /^(y|yes|是|好|ok)$/.test(a); // Chinese "yes" words: language support for Chinese input
}

/** The global `ach` after `npm install -g` (npm prefix -g)/bin/ach. */
async function globalAch(npm: string, exec: ExecLike, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const r = await exec(npm, ['prefix', '-g'], env);
  const prefix = r.stdout.trim().split('\n').pop()?.trim();
  if (r.code !== 0 || !prefix) return undefined;
  const f = process.platform === 'win32' ? join(prefix, 'ach.cmd') : join(prefix, 'bin', 'ach');
  return existsSync(f) ? f : undefined;
}

export interface SetupResult {
  ran: string[];
  skipped: string[];
  failed: string[];
  /** No terminal and no --yes: nothing was changed; the CLI exits non-zero with this line. */
  needsYes?: string;
}

/** What `--yes` accepts, in words ("add to Claude Code, background helper with notifications"). */
export function yesAccepts(d: Pick<Detected, 'claude' | 'codex' | 'npx' | 'npm'>, zh = false): string {
  const parts: string[] = [];
  const where = targets(d, zh);
  if (where) parts.push(zh ? `接入 ${where}` : `add to ${where}`);
  else if (d.npx && d.npm) parts.push(zh ? '安装 `ach` 命令' : 'install the `ach` command');
  parts.push(zh ? '带系统通知的后台小助手' : 'background helper with notifications');
  return parts.join(zh ? '、' : ', ');
}

/** Run (or, without a terminal and --yes, only print) the setup after `ach join`. */
export async function runSetup(io: SetupIo, o: SetupOptions): Promise<SetupResult> {
  const env = io.env;
  const self = o.self ?? thisCliPath();
  const interactive = !!io.ask || o.yes;
  const d = await detect(env, io.exec, self, interactive);
  const installSpec = npmSpec(VERSION);
  const home = env.AGENTCHANNEL_HOME || undefined;
  const result: SetupResult = { ran: [], skipped: [], failed: [] };
  const zh = !!o.zh;

  if (!interactive) {
    printOnly(io, d, { home, installSpec, zh, runtime: o.runtime, cwd: io.cwd, join: o.join });
    result.needsYes = zh
      ? `加 --yes 重新运行同一行即表示接受：${yesAccepts(d, zh)}（不会再问别的）`
      : `Run again with --yes to accept: ${yesAccepts(d, zh)} (asks nothing else)`;
    return result;
  }

  const sep = (q: string) => (q.endsWith('\n') ? '' : ' ');
  const ask = async (s: Step): Promise<boolean> => {
    const tag = s.defaultYes ? '[Y/n]' : '[y/N]';
    if (s.alwaysAsk) {
      if (!io.ask) {
        io.out(`${s.question}${zh ? '  跳过：这一步只在终端里回答 yes 后才做（--yes 不算）。要清理就自己运行上面的命令。' : '  Skipped: this step runs only after a yes typed in a terminal (--yes does not count). Run the commands above yourself to clean up.'}`);
        return false;
      }
      return yesNo(await io.ask(`${s.question}${sep(s.question)}${tag} `), s.defaultYes);
    }
    if (o.yes) {
      io.out(`${s.question}${sep(s.question)}${tag} y (--yes)`);
      return true;
    }
    return yesNo(await io.ask!(`${s.question}${sep(s.question)}${tag} `), s.defaultYes);
  };
  const runCmds = async (s: Step): Promise<boolean> => {
    // each program's commands are independent: a failed `claude mcp add` still lets `codex mcp add` run
    const failedBins = new Set<string>();
    for (const c of s.commands) {
      if (failedBins.has(c[0])) continue;
      const r = await io.exec(c[0], c.slice(1), env);
      if (r.code !== 0) {
        // removing an entry that is not there is fine
        if (c.includes('remove')) continue;
        io.err(`  failed (exit ${r.code}): ${shellLine(c)}${r.stderr.trim() ? `\n  ${r.stderr.trim().split('\n')[0]}` : ''}`);
        failedBins.add(c[0]);
        continue;
      }
      const kind = c[0] === d.claude ? 'claude' : c[0] === d.codex ? 'codex' : undefined;
      if (kind && c[1] === 'mcp') io.out(`  ${c[2] === 'add' ? (zh ? '已添加 MCP "ach" 到' : 'added MCP "ach" to') : zh ? `已从中删除 MCP "${c.at(-1)}"：` : `removed MCP "${c.at(-1)}" from`} ${mcpConfigFile(kind, env)}`);
    }
    // nothing is renamed after a failed command
    if (failedBins.size) return false;
    for (const m of s.moves ?? []) {
      try {
        renameSync(m.from, m.to);
        io.out(`  moved ${m.from} -> ${m.to}`);
      } catch (e: any) {
        io.err(`  could not move ${m.from}: ${e?.message ?? e}`);
        return false;
      }
    }
    return true;
  };

  let serviceAch = d.achCmd;
  for (const s of planSteps(d, { home, achCmd: d.achCmd, installSpec, cwd: io.cwd, zh, env })) {
    if (!(await ask(s))) {
      result.skipped.push(s.id);
      continue;
    }
    if (s.id === 'service') {
      const ok = await installAndStartService(io, [...serviceAch, ...s.commands[0].slice(d.achCmd.length)]);
      (ok ? result.ran : result.failed).push('service');
      continue;
    }
    const ok = await runCmds(s);
    (ok ? result.ran : result.failed).push(s.id);
    if (ok && s.id === 'connect' && d.npx && d.npm) {
      // the background helper must not run from the npx cache
      const g = await globalAch(d.npm, io.exec, env);
      if (g) serviceAch = [g];
    }
  }
  if (!d.claude && !d.codex) {
    io.out(zh ? '没有找到 Claude Code 或 Codex；安装后再运行一次这行 join，或手动执行：' : 'Neither Claude Code nor Codex was found; install one and run the join line again, or add it yourself:');
    io.out(`  ${shellLine(mcpAddArgv('claude', 'claude', d.achCmd, home))}    # ${changes('claude', env, zh)}`);
  }
  return result;
}

/** `ach run --install-service --json`, then start the unit (unless ACH_SERVICE_DIR points elsewhere: tests). */
async function installAndStartService(io: SetupIo, argv: Argv): Promise<boolean> {
  const env = io.env;
  const r = await io.exec(argv[0], [...argv.slice(1), '--json'], env);
  if (r.code !== 0) {
    io.err(`  failed (exit ${r.code}): ${shellLine(argv)}${r.stderr.trim() ? `\n  ${r.stderr.trim().split('\n')[0]}` : ''}`);
    return false;
  }
  let f: { path: string; start: string[] };
  try {
    f = JSON.parse(r.stdout);
  } catch {
    io.err('  could not read the service file location');
    return false;
  }
  io.out(`  wrote ${f.path}`);
  const starts = f.start.map((x) => x.replace(/\s+#.*$/, '')).filter((x) => !/loginctl/.test(x));
  if (env.ACH_SERVICE_DIR) {
    io.out(`  start it with: ${starts.join(' && ')}`);
    return true;
  }
  for (const c of starts) {
    const s = await io.exec('/bin/sh', ['-c', c], env);
    if (s.code !== 0) {
      io.err(`  failed (exit ${s.code}): ${c}`);
      return false;
    }
  }
  io.out('  started');
  return true;
}

/** No terminal and no --yes: print what would be run (nothing is run, not even read-only probes). */
function printOnly(io: SetupIo, d: Detected, o: { home?: string; installSpec: string; zh: boolean; runtime?: string; cwd: string; join?: SetupOptions['join'] }): void {
  const zh = o.zh;
  const env = io.env;
  const claude = `${shellLine(mcpAddArgv('claude', 'claude', d.achCmd, o.home))}    # ${changes('claude', env, zh)}`;
  const codex = `${shellLine(mcpAddArgv('codex', 'codex', d.achCmd, o.home))}    # ${changes('codex', env, zh)}`;
  const mcp = o.runtime === 'codex' || (d.codex && !d.claude) ? [codex, claude] : [claude, codex];
  const out = [zh ? '没有终端可以提问，所以什么都没有改。会做的事：' : 'No terminal to ask in, so nothing was changed. What it would do:'];
  if (o.join) {
    out[0] = zh
      ? `没有终端可以提问，所以什么都没有改：邀请还没有用掉，也没有保存密钥。会做的事：`
      : 'No terminal to ask in, so nothing was changed: the invite is still unused and no key was stored. What it would do:';
    out.push(
      o.join.once
        ? zh ? `  用这个一次性邀请向 ${o.join.hub} 换取智能体密钥，并保存在本机` : `  exchange the one-time invite with ${o.join.hub} for the agent's key and store it on this machine`
        : zh ? `  把这一行里的智能体密钥（${o.join.hub}）保存在本机` : `  store the agent's key in the line (${o.join.hub}) on this machine`,
    );
  }
  if (d.npx && d.npm) out.push(`  npm install -g ${o.installSpec}`);
  out.push(`  ${mcp[0]}`, zh ? '  （另一个运行时：）' : '  (other runtime:)', `  ${mcp[1]}`);
  out.push(`  ${shellLine([...d.achCmd, 'run', '--install-service', '--notify', '--interactive-first', '--dir', o.cwd])}`);
  const v1: string[] = [];
  if (isV1Version(d.globalVersion) && !d.npx) v1.push('  npm uninstall -g agentchannel');
  if (d.v1Home) v1.push(`  mv ${shq(d.v1Home)} ${shq(`${d.v1Home}-v0.9-backup-${stamp()}`)}`);
  if (v1.length) {
    v1.push(`  claude mcp remove --scope user ${V1_MCP_NAME}    # ${zh ? '如果 Claude Code 里加过 v0.9' : 'if AgentChannel v0.9 was added to Claude Code'}`);
    out.push('', zh ? 'AgentChannel v0.9 清理（只在终端里确认后才会做）：' : 'AgentChannel v0.9 cleanup (only done after a yes typed in a terminal):', ...v1);
  }
  out.push('', `${zh ? '随时检查配置：' : 'Check the setup any time with: '}${shellLine([...(d.npx ? d.achCmd : ['ach']), 'doctor'])}`);
  io.out(out.join('\n'));
}
