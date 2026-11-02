import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

/**
 * P4: everything a teammate needs to connect, in one copy-paste line:
 * `ach join <blob>`.
 * - `ach2.` + base64url(JSON {hub, join, cf_id?, cf_secret?}) (current): `join`
 *   is a one-time join token the client exchanges for the agent key
 *   (POST /api/ach/invite/exchange). Once used or expired the line is worthless.
 * - `ach1.` + base64url(JSON {hub, key, cf_id?, cf_secret?}) (older hubs):
 *   carries the agent key itself; still accepted.
 * Either way the line is private until used: send it privately.
 */
export interface Invite {
  hub: string;
  /** ach1: the agent key. */
  key?: string;
  /** ach2: the one-time join token. */
  join?: string;
  cf_id?: string;
  cf_secret?: string;
}

const PREFIX = 'ach1.';
const PREFIX2 = 'ach2.';
export const JOIN_TOKEN_RE = /^ach_jt_[a-z0-9]{15}_[A-Za-z0-9]{40}$/;

export function encodeInvite(i: Invite): string {
  const o: Invite = i.join ? { hub: i.hub.replace(/\/+$/, ''), join: i.join } : { hub: i.hub.replace(/\/+$/, ''), key: i.key };
  if (i.cf_id && i.cf_secret) {
    o.cf_id = i.cf_id;
    o.cf_secret = i.cf_secret;
  }
  return (i.join ? PREFIX2 : PREFIX) + Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

export function decodeInvite(blob: string): Invite {
  const s = blob.trim();
  const v2 = s.startsWith(PREFIX2);
  if (!v2 && !s.startsWith(PREFIX)) throw new Error('not an AgentChannel invite (expected ach2.<...> or ach1.<...>)');
  let o: any;
  try {
    o = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('invite is corrupted (copy the whole line)');
  }
  if (!o || typeof o.hub !== 'string' || !/^https?:\/\/[^\s]+$/.test(o.hub)) throw new Error('invite has no valid hub URL');
  let hubUrl: URL;
  try {
    hubUrl = new URL(o.hub);
  } catch {
    throw new Error('invite has no valid hub URL');
  }
  // the key (or the join token, exchanged for one) and the front-door pass travel to this address
  if (hubUrl.protocol !== 'https:' && !isLocalHost(hubUrl.hostname)) {
    throw new Error(`invite points at ${hubUrl.host} over plain http://: refusing to send a key there (ask your admin for the https:// line)`);
  }
  let out: Invite;
  if (v2) {
    if (typeof o.join !== 'string' || !JOIN_TOKEN_RE.test(o.join)) throw new Error('invite has no valid join token');
    out = { hub: o.hub.replace(/\/+$/, ''), join: o.join };
  } else {
    if (typeof o.key !== 'string' || !/^ach_sk_[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(o.key)) throw new Error('invite has no valid agent key');
    out = { hub: o.hub.replace(/\/+$/, ''), key: o.key };
  }
  if (typeof o.cf_id === 'string' && typeof o.cf_secret === 'string' && o.cf_id && o.cf_secret) {
    out.cf_id = o.cf_id;
    out.cf_secret = o.cf_secret;
  }
  return out;
}

/**
 * Hosts where plain http:// is acceptable: this machine (localhost,
 * 127.0.0.1, ::1, *.localhost) and the reserved *.test names (local dev/test
 * setups). Anything else must be https://.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.test');
}

/** True when a hub URL is https://, or http:// to a local host (isLocalHost). */
export function hubTransportOk(hub: string): boolean {
  try {
    const u = new URL(hub);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname));
  } catch {
    return false;
  }
}

/**
 * The npm spec in the join line: `agentchannel@2` (the v2 major) for a
 * release. A prerelease (2.0.0-rc.2) is
 * not matched by the range "2", so the line pins the exact version until 2.0.0.
 */
export function npmSpec(version: string = VERSION): string {
  return /-/.test(version) ? `agentchannel@${version}` : `agentchannel@${version.split('.')[0]}`;
}

/** The one line a teammate pastes: npx fetches v2 and `join` sets everything up. */
export function joinLine(blob: string, version: string = VERSION): string {
  return `npx -y ${npmSpec(version)} join ${blob}`;
}

/** `npx -y agentchannel@<spec>`: how messages and MCP entries start v2 without relying on PATH. */
export function npxAch(version: string = VERSION): string[] {
  return ['npx', '-y', npmSpec(version)];
}

/** The join line minus the blob (for parsing tests and docs). */
export const JOIN_LINE_RE = /^npx -y agentchannel@\S+ join (ach[12]\.\S+)$/;

/** What a teammate needs to run the join line. */
export const JOIN_HINT =
  'They paste the line in a terminal (Node 20+); npx fetches the CLI. If AgentChannel v0.9 is installed globally, `npm uninstall -g agentchannel` first; `ach doctor` checks which `ach` is on PATH.';

/** The MCP server name printed for `claude mcp add` / `codex mcp add` (v1 used "agentchannel"). */
export const MCP_SERVER_NAME = 'ach';

/** Every executable `name` on PATH, in PATH order (like `which -a`). */
export function whichAll(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    const f = join(d, name);
    try {
      accessSync(f, constants.X_OK);
      if (!out.includes(f)) out.push(f);
    } catch {
      /* next */
    }
  }
  return out;
}

/**
 * True for executables that are not the user's own install: anything in an
 * npx cache (`.../_npx/...`) or in a node_modules/.bin (e.g. npx puts this
 * package's dependencies' bins, such as the `codex` of @openai/codex-sdk, on
 * PATH while `npx agentchannel` runs).
 */
export function isBundledBin(p: string): boolean {
  return /[\\/]_npx[\\/]/.test(p) || /[\\/]node_modules[\\/]\.bin[\\/]/.test(p);
}

/** The first user-installed `name` on PATH (bundled/npx-cache bins skipped). */
export function userBin(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return whichAll(name, env).find((p) => !isBundledBin(p) && !isBundledBin(real(p) ?? p));
}

/** True when an executable `name` is on PATH. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return whichAll(name, env).length > 0;
}

/** This CLI's entry file (dist/src/cli.js). */
export function thisCliPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Which AgentChannel an `ach` executable is, without running it: follow the
 * symlink (npm global bins are symlinks) up to the nearest package.json.
 * `ours` = it is this very CLI.
 */
export function identifyAch(path: string, self: string = thisCliPath()): { path: string; real?: string; name?: string; version?: string; ours: boolean } {
  const r = real(path);
  const ours = !!r && r === real(self);
  let d = r ? dirname(r) : undefined;
  for (let i = 0; d && i < 6; i++, d = dirname(d)) {
    try {
      const pj = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      if (pj && typeof pj.name === 'string') return { path, real: r, name: pj.name, version: String(pj.version ?? ''), ours };
    } catch {
      /* go up */
    }
    if (dirname(d) === d) break;
  }
  return { path, real: r, ours };
}

/** True for a v2 `ach` (this CLI, or any agentchannel 2.x). */
export function isV2(i: { ours: boolean; version?: string }): boolean {
  return i.ours || /^2\./.test(i.version ?? '');
}

function shq(s: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact `claude mcp add` / `codex mcp add` commands for this machine. They
 * are printed, never run. `achCmd` is how to start the CLI (an absolute v2
 * `ach`, or `npx -y agentchannel@<spec>`).
 */
export function mcpCommands(o: { achCmd: string[]; home?: string }): { claude: string; codex: string } {
  const cmd = o.achCmd.map(shq).join(' ');
  const envClaude = o.home ? ` -e AGENTCHANNEL_HOME=${shq(o.home)}` : '';
  const envCodex = o.home ? ` --env AGENTCHANNEL_HOME=${shq(o.home)}` : '';
  return {
    claude: `claude mcp add --scope user${envClaude} ${MCP_SERVER_NAME} -- ${cmd} mcp`,
    codex: `codex mcp add${envCodex} ${MCP_SERVER_NAME} -- ${cmd} mcp`,
  };
}

/**
 * How the MCP entry starts this CLI: `ach` when the first `ach` on PATH is a
 * v2 one, else this exact CLI by absolute path (a v0.9 `ach` earlier on PATH,
 * or none, must never be what the MCP entry runs). Never `npx agentchannel`,
 * which is v1 on npm.
 */
export function achCommand(env: NodeJS.ProcessEnv = process.env, self: string = thisCliPath()): string[] {
  // run through npx: the cache may be cleared, so entries use the pinned npx spec
  if (/[\\/]_npx[\\/]/.test(self)) return npxAch();
  const first = whichAll('ach', env)[0];
  if (first && isV2(identifyAch(first, self))) return ['ach'];
  return [process.execPath, self];
}

/**
 * When the first `ach` on PATH is AgentChannel v0.9 (v1), a v2 command typed
 * as `ach ...` runs v1 and fails with v1's own error. The fix to print, or
 * undefined when v2 (or nothing) comes first.
 */
export function v1ShadowHint(env: NodeJS.ProcessEnv = process.env, self: string = thisCliPath(), zh = false): string | undefined {
  const first = whichAll('ach', env)[0];
  if (!first) return undefined;
  const i = identifyAch(first, self);
  if (isV2(i) || i.name !== 'agentchannel' || !/^0\./.test(i.version ?? '')) return undefined;
  const npx = `${npxAch().join(' ')} …`;
  return zh
    ? `注意：PATH 上的 \`ach\` 是 AgentChannel v${i.version}（${first}），不是 v2，所以 \`ach ...\` 会报 v0.9 的错误。修复：npm uninstall -g agentchannel（或改用 ${npx}）。`
    : `Note: the \`ach\` on your PATH is AgentChannel v${i.version} (${first}), not v2, so \`ach ...\` fails with v0.9 errors. Fix: npm uninstall -g agentchannel (or use ${npx}).`;
}

/**
 * `ach admin invite <agent>`: a paragraph the admin sends and the engineer
 * pastes into their own Claude Code / Codex, which then does the setup and
 * asks before installing the background helper. `line` is joinLine(...).
 */
export function agentInvitePrompt(line: string, lang: 'en' | 'zh' = 'en'): string {
  // a one-time (ach2) line says so: the second run (with --yes) reuses the key the first one saved
  const once = / ach2\./.test(` ${line}`);
  const spec = /^npx -y (\S+) join /.exec(line)?.[1] ?? npmSpec();
  const npx = `npx -y ${spec}`;
  if (lang === 'zh') {
    return (
      `请帮我接入团队的 AgentChannel${once ? '（这行邀请只能在一台机器上用）' : ''}：1. 运行 \`${line}\`。如果它提示用 --yes 重新运行，先告诉我它会做什么（接入 Claude Code 或 Codex、安装带系统通知的后台小助手），我同意后再加 --yes 运行同一行；` +
      `2. 发一条测试通知给我（\`${npx} notify --test\`），确认能弹出来；3. 告诉我收件箱里现在有什么。` +
      `任何一步失败，运行 \`${npx} doctor\`，按提示修好再继续。`
    );
  }
  return (
    `Please connect me to my team's AgentChannel${once ? ' (the join line works on one machine only)' : ''}: 1. Run \`${line}\`. If it says to run again with --yes, tell me what that sets up (adding it to Claude Code or Codex, and the background helper with desktop notifications) and run the same line with --yes only after I agree; ` +
    `2. Send me a test notification (\`${npx} notify --test\`) and check that it pops up; 3. Tell me what is in my inbox now. ` +
    `If any step fails, run \`${npx} doctor\`, fix what it says, and continue.`
  );
}
