import { homedir } from 'node:os';
import type { CanUseTool, HookCallbackMatcher, Options, SDKMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Perm } from '../perm.js';
import { toolDenied, type PathPolicy } from './paths.js';
import { spawnGroup } from './procgroup.js';
import type { AdapterResult, AdapterRunOptions, RuntimeAdapter } from './types.js';

/** Best-effort Bash deny list for `workdir` (the SDK sandbox is the real boundary). */
export const BASH_DENY: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease\b)/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777\s+\//,
];

/** S3: the only `ach` subcommands a spawned agent is pre-approved to run. */
export const WORK_ACH_TOOLS = [
  'Bash(ach progress:*)',
  'Bash(ach ask:*)',
  'Bash(ach decide-request:*)',
  'Bash(ach ask-human:*)',
  'Bash(ach decide:*)',
  'Bash(ach complete:*)',
  'Bash(ach fail:*)',
  'Bash(ach task:*)',
  'Bash(ach channel:*)',
  'Bash(ach thread:*)',
  'Bash(ach reply:*)',
];
export const ANSWER_ACH_TOOLS = ['Bash(ach answer:*)', 'Bash(ach decide-request:*)', 'Bash(ach ask-human:*)', 'Bash(ach task:*)'];
/** Mention runs: read the thread and channel, reply in the thread (with evidence, or --escalate). */
export const MENTION_ACH_TOOLS = ['Bash(ach reply:*)', 'Bash(ach thread:*)', 'Bash(ach channel:*)'];

/** canUseTool for workdir: path policy (reads under $HOME, writes outside cwd) plus the Bash deny list. */
export function workdirCanUseTool(pol: PathPolicy): CanUseTool {
  return async (toolName, input) => {
    const why = toolDenied(pol, toolName, input);
    if (why) return { behavior: 'deny', message: why };
    if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      if (BASH_DENY.some((re) => re.test(cmd))) {
        return { behavior: 'deny', message: 'Command is on the AgentChannel deny list' };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * PreToolUse hook with the same path policy. Hooks run even for tools that
 * allowedTools pre-approves (Read/Glob/Grep), which canUseTool never sees.
 */
export function pathPolicyHook(pol: PathPolicy): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const why = toolDenied(pol, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        if (!why) return {};
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
      },
    ],
  };
}

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export interface ClaudePermInput {
  cwd: string;
  hub?: string;
  mode?: 'work' | 'answer' | 'mention';
  /** Readable roots under $HOME besides cwd (toolchain, git common dir). */
  readRoots?: string[];
  denyReadPaths?: string[];
  home?: string;
  /** B1: the AgentChannel home, denied to sandboxed commands (allowRead re-allows cwd and read roots). */
  achHome?: string;
  /** P2: hub `net_allow` of the agent; see sandboxNetwork(). */
  netAllow?: string[];
}

/**
 * P2: sandbox network policy. The hub host is always reachable (the agent's
 * `ach` needs it). A concrete list is a strict allowlist; "*" lifts the domain
 * restriction (admin-only on the hub).
 */
export function sandboxNetwork(hubHost: string | undefined, netAllow?: string[]): NonNullable<Options['sandbox']>['network'] {
  const list = netAllow ?? ['api.anthropic.com'];
  const domains = Array.from(new Set([...(hubHost ? [hubHost] : []), ...list.map((d) => d.toLowerCase())]));
  if (domains.includes('*')) return { allowedDomains: ['*'] };
  return netAllow ? { allowedDomains: domains, strictAllowlist: true } : { allowedDomains: domains };
}

/**
 * Permission-related query options. Pure, unit-tested.
 * - settingSources: [] (S1): no user/project/local settings, hooks, MCP servers
 *   or CLAUDE.md from the (sender-influenced) worktree.
 * - allowedTools: only the `ach` subcommands of the run's mode (S3).
 * - read/workdir: the SDK sandbox denies reads under $HOME except cwd and the
 *   read roots; a PreToolUse hook applies the same policy to file tools (S4).
 * - workdir writes: cwd only. The git common dir is NOT writable (S10); the
 *   runner commits after the run.
 */
export function claudePermOptions(perm: Perm, o: ClaudePermInput): Partial<Options> {
  const home = o.home ?? homedir();
  const denyRead = o.denyReadPaths ?? [];
  // Permission-rule paths: `//abs/path/**` means an absolute path.
  const disallowedTools = denyRead.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`]);
  const achTools = o.mode === 'answer' ? ANSWER_ACH_TOOLS : o.mode === 'mention' ? MENTION_ACH_TOOLS : WORK_ACH_TOOLS;
  // strictMcpConfig: no MCP servers from ~/.claude.json or .mcp.json either (only ones passed here: none)
  const base: Partial<Options> = { settingSources: [], strictMcpConfig: true, disallowedTools };
  if (perm === 'full') {
    return { ...base, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
  }
  const pol: PathPolicy = {
    home,
    cwd: o.cwd,
    readRoots: o.readRoots ?? [],
    writeRoots: perm === 'workdir' ? [o.cwd] : [],
    deny: denyRead,
  };
  const hubHost = hostOf(o.hub);
  const sandbox: Options['sandbox'] = {
    enabled: true,
    // read: only the pre-approved `ach` commands may run, sandboxed or not.
    autoAllowBashIfSandboxed: perm === 'workdir',
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: perm === 'workdir' ? [o.cwd] : [],
      denyRead: [home, ...(o.achHome ? [o.achHome] : []), ...denyRead],
      allowRead: [o.cwd, ...(o.readRoots ?? [])],
    },
    network: sandboxNetwork(hubHost, o.netAllow),
  };
  const common: Partial<Options> = {
    ...base,
    allowedTools: ['Read', 'Glob', 'Grep', ...achTools],
    sandbox,
    hooks: { PreToolUse: [pathPolicyHook(pol)] },
  };
  if (perm === 'read') return { ...common, permissionMode: 'dontAsk' };
  return { ...common, permissionMode: 'acceptEdits', canUseTool: workdirCanUseTool(pol) };
}

/** Error text of a result message (C9): never the word "success" for a failed run. */
export function resultError(m: { subtype?: string; is_error?: boolean; errors?: string[]; result?: string }): string {
  const errs = (m.errors ?? []).filter(Boolean).join('; ');
  if (errs) return errs;
  if (m.is_error && typeof m.result === 'string' && m.result.trim()) return m.result.trim();
  if (m.subtype && m.subtype !== 'success') return m.subtype;
  return 'the run ended with an error';
}

export interface ClaudeAdapterOptions {
  model?: string;
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude';
  constructor(private o: ClaudeAdapterOptions = {}) {}

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    const options: Options = {
      cwd: opts.cwd,
      env: opts.env,
      abortController,
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(this.o.model ? { model: this.o.model } : {}),
      ...claudePermOptions(opts.perm, {
        cwd: opts.cwd,
        hub: opts.hub,
        mode: opts.mode,
        readRoots: opts.readRoots,
        denyReadPaths: opts.denyReadPaths,
        home: opts.realHome ?? opts.env.HOME,
        achHome: opts.achHome,
        netAllow: opts.netAllow,
      }),
      spawnClaudeCodeProcess: (s) =>
        spawnGroup(s.command, s.args, {
          cwd: s.cwd,
          env: s.env,
          signal: s.signal,
          onStderr: (t) => opts.onEvent({ type: 'error', data: t }),
        }) as unknown as SpawnedProcess,
    };

    let sessionId: string | undefined;
    let finalText = '';
    let costUsd: number | undefined;
    let ok = false;
    let error: string | undefined;
    const lastText: string[] = [];
    try {
      for await (const m of query({ prompt: opts.prompt, options }) as AsyncIterable<SDKMessage>) {
        const anyM = m as any;
        if (anyM.session_id && anyM.session_id !== sessionId) {
          sessionId = anyM.session_id;
          opts.onEvent({ type: 'session', data: sessionId });
        }
        if (m.type === 'assistant') {
          for (const b of (anyM.message?.content ?? []) as any[]) {
            if (b.type === 'text' && b.text) {
              lastText.push(b.text);
              opts.onEvent({ type: 'text', data: b.text });
            } else if (b.type === 'tool_use') {
              opts.onEvent({ type: 'tool_start', data: { id: b.id, name: b.name, input: b.input } });
            }
          }
        } else if (m.type === 'user') {
          const content = anyM.message?.content;
          for (const b of (Array.isArray(content) ? content : []) as any[]) {
            if (b?.type === 'tool_result') opts.onEvent({ type: 'tool_end', data: { id: b.tool_use_id } });
          }
        } else if (m.type === 'result') {
          costUsd = anyM.total_cost_usd;
          opts.onEvent({ type: 'usage', data: { costUsd, usage: anyM.usage } });
          if (anyM.subtype === 'success' && !anyM.is_error) {
            ok = true;
            finalText = anyM.result ?? '';
          } else {
            error = resultError(anyM);
            finalText = lastText.join('\n');
          }
        } else {
          opts.onEvent({ type: 'tool', data: { type: m.type, subtype: anyM.subtype } });
        }
      }
    } catch (e: any) {
      ok = false;
      error = opts.signal.aborted ? 'aborted' : String(e?.message ?? e);
      opts.onEvent({ type: 'error', data: error });
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
    if (!finalText) finalText = lastText.join('\n');
    return { finalText, sessionId, costUsd, ok, error };
  }
}
