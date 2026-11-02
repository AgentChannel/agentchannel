/** Env vars that make a spawned Claude Code think it is nested inside another session. */
export const STRIPPED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
] as const;

/**
 * The only parent env vars a spawned agent inherits (S4). Everything else
 * (cloud credentials, tokens, the runner's own ACH_KEY, Claude Code messaging
 * sockets) is dropped unless the runner names it with `--pass-env NAME`.
 */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TERM', 'SHELL', 'USER', 'TMPDIR'] as const;

/**
 * Never passed, even with --pass-env: runner credentials and the Claude Code
 * nesting / messaging / socket / host-auth vars of the parent session.
 */
export function neverPass(name: string): boolean {
  if ((STRIPPED_ENV as readonly string[]).includes(name)) return true;
  if (/^ACH_/.test(name)) return true; // the ACH_* run vars are set explicitly
  if (name === 'AGENTCHANNEL_HOME') return true;
  return /^CLAUDE_CODE_.*(SESSION|ENTRYPOINT|EXECPATH|SSE|PORT|SOCK|IPC|MESSAG|HOST|OAUTH|TOKEN|AUTH|BRIDGE|REMOTE)/.test(name);
}

export interface AgentEnvInput {
  hub: string;
  runToken: string;
  taskId: string;
  agentName: string;
  /** Mention runs: the thread (root post id) the agent replies in. */
  threadId?: string;
  /** Work runs: the handoff version the worker was shown; `ach complete` sends it so the hub can refuse an outdated finish. */
  handoffVersion?: number;
  /** Base URL for links in agent output (ACH_PUBLIC_URL). */
  publicUrl?: string;
  cfId?: string;
  cfSecret?: string;
  /** Extra parent env var names to pass through (`ach run --pass-env NAME`). */
  passEnv?: string[];
}

/** Env for a spawned agent: allowlisted parent vars + --pass-env names + task-scoped ACH vars. */
export function buildAgentEnv(base: NodeJS.ProcessEnv | Record<string, string | undefined>, a: AgentEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...ENV_ALLOWLIST, ...(a.passEnv ?? [])]) {
    const v = base[k];
    if (v === undefined || neverPass(k)) continue;
    env[k] = v;
  }
  env.ACH_HUB = a.hub;
  env.ACH_RUN_TOKEN = a.runToken;
  env.ACH_TASK_ID = a.taskId;
  env.ACH_AGENT = a.agentName;
  if (a.threadId) env.ACH_THREAD_ID = a.threadId;
  if (a.handoffVersion) env.ACH_HANDOFF_VERSION = String(a.handoffVersion);
  if (a.publicUrl) env.ACH_PUBLIC_URL = a.publicUrl;
  if (a.cfId) env.ACH_CF_ID = a.cfId;
  if (a.cfSecret) env.ACH_CF_SECRET = a.cfSecret;
  return env;
}
