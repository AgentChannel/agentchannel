import { execFileSync } from 'node:child_process';
import type { SandboxMode, ThreadEvent, ThreadOptions, Usage } from '@openai/codex-sdk';
import { KILL_GRACE_MS } from './procgroup.js';
import type { Perm } from '../perm.js';
import type { AdapterResult, AdapterRunOptions, RuntimeAdapter } from './types.js';

/** USD per 1M tokens. Configurable via ACH_CODEX_PRICE='{"input":..,"cached_input":..,"output":..}'. */
export interface PriceTable {
  input: number;
  cached_input: number;
  output: number;
}
export const DEFAULT_CODEX_PRICE: PriceTable = { input: 1.25, cached_input: 0.125, output: 10 };

export function priceFromEnv(env: Record<string, string | undefined> = process.env): PriceTable {
  try {
    if (env.ACH_CODEX_PRICE) return { ...DEFAULT_CODEX_PRICE, ...JSON.parse(env.ACH_CODEX_PRICE) };
  } catch {
    /* fall through */
  }
  return DEFAULT_CODEX_PRICE;
}

export function estimateCost(u: Partial<Usage>, p: PriceTable): number {
  const cached = u.cached_input_tokens ?? 0;
  const input = Math.max(0, (u.input_tokens ?? 0) - cached);
  const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  return (input * p.input + cached * p.cached_input + output * p.output) / 1_000_000;
}

export function codexSandbox(perm: Perm): SandboxMode {
  return perm === 'read' ? 'read-only' : perm === 'workdir' ? 'workspace-write' : 'danger-full-access';
}

/**
 * Thread options. Pure, unit-tested.
 * - Answer runs: read-only sandbox, network off. The agent returns JSON
 *   (outputSchema) and the runner posts it, so it never needs the hub (S4).
 * - Work runs keep network on for `ach`.
 * - No additionalDirectories: the main repo's .git is never writable (S10);
 *   the runner commits after the run.
 */
export function codexThreadOptions(perm: Perm, cwd: string, model?: string, mode: 'work' | 'answer' | 'mention' = 'work'): ThreadOptions {
  // answer and mention runs are read-only and offline; the runner posts their JSON
  const answer = mode === 'answer' || mode === 'mention';
  return {
    workingDirectory: cwd,
    sandboxMode: answer ? 'read-only' : codexSandbox(perm),
    networkAccessEnabled: !answer,
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(model ? { model } : {}),
  };
}

/** Codex `--config` overrides set by the runner (key names checked against the bundled codex 0.165 binary). */
export type CodexRunnerConfig = {
  allow_login_shell: boolean;
  sandbox_workspace_write: { exclude_slash_tmp: boolean; exclude_tmpdir_env_var: boolean };
};

/**
 * Codex client options.
 * - allow_login_shell=false: by default Codex runs tool commands in a login
 *   shell, whose profile (path_helper, `brew shellenv`) reorders PATH, so a
 *   globally installed `ach` (e.g. AgentChannel v1) shadowed the runner's
 *   <home>/bin/ach shim and every `ach complete` failed (live test).
 * - sandbox_workspace_write.exclude_slash_tmp / exclude_tmpdir_env_var = true:
 *   in workspace-write, Codex by default also lets the agent write /tmp and
 *   $TMPDIR, which other processes of the user read (live test). Writes are now
 *   the working directory only.
 */
export function codexClientOptions(env: Record<string, string | undefined>): { env: Record<string, string>; config: CodexRunnerConfig } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') clean[k] = v;
  return {
    env: clean,
    config: {
      allow_login_shell: false,
      sandbox_workspace_write: { exclude_slash_tmp: true, exclude_tmpdir_env_var: true },
    },
  };
}

/** `root` and all its descendants, from `ps -axo pid=,ppid=,command=` output. Pure. */
export function processTree(psOut: string, root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push(pid);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    for (const c of kids.get(p) ?? []) if (!out.includes(c)) stack.push(c);
  }
  return out;
}

/** Pids of `codex exec ... --cd <cwd>` processes that are children of `parent`. Pure. */
export function codexChildren(psOut: string, parent: number, cwd: string): number[] {
  const res: number[] = [];
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || Number(m[2]) !== parent) continue;
    const cmd = m[3];
    if (/codex/.test(cmd) && / exec /.test(cmd) && (cmd.includes(`--cd ${cwd} `) || cmd.endsWith(`--cd ${cwd}`))) res.push(Number(m[1]));
  }
  return res;
}

/**
 * C7: @openai/codex-sdk 0.165.0 spawns `codex exec` itself (no new process
 * group, pid not exposed) and on abort SIGTERMs only that process. Codex runs
 * each tool command in its own process group, so those survived a cancel
 * (live test: `sleep 300 && echo done > done.txt` kept running, re-parented to
 * init). On abort we find this run's codex child by its `--cd`, then SIGTERM
 * every descendant and its process group, and SIGKILL survivors after a grace.
 */
export function killCodexTree(cwd: string, o: { parent?: number; ps?: () => string; kill?: (pid: number, sig: NodeJS.Signals) => void; graceMs?: number } = {}): number[] {
  if (process.platform === 'win32' && !o.ps) return [];
  const ps = o.ps ?? (() => execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
  let out: string;
  try {
    out = ps();
  } catch {
    return [];
  }
  const pids = codexChildren(out, o.parent ?? process.pid, cwd).flatMap((c) => processTree(out, c));
  const send = (sig: NodeJS.Signals) => {
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try {
          kill(target, sig);
        } catch {
          /* not a group leader, or already gone */
        }
      }
    }
  };
  send('SIGTERM');
  if (pids.length) setTimeout(() => send('SIGKILL'), o.graceMs ?? KILL_GRACE_MS).unref();
  return pids;
}

/** Codex runtime adapter (@openai/codex-sdk). Cancel: see killCodexTree. */
export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex';
  readonly structuredAnswers = true;
  constructor(private o: { model?: string; price?: PriceTable } = {}) {}

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const { Codex } = await import('@openai/codex-sdk');
    const codex = new Codex(codexClientOptions(opts.env));
    const to = codexThreadOptions(opts.perm, opts.cwd, this.o.model, opts.mode);
    const thread = opts.resume ? codex.resumeThread(opts.resume, to) : codex.startThread(to);
    const price = this.o.price ?? priceFromEnv(opts.env);

    let sessionId: string | undefined = opts.resume;
    if (sessionId) opts.onEvent({ type: 'session', data: sessionId });
    let finalText = '';
    let cost = 0;
    let sawUsage = false;
    let error: string | undefined;
    // registered before the SDK spawns codex, so it runs before the SDK's own kill
    const onAbort = () => killCodexTree(opts.cwd);
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const { events } = await thread.runStreamed(opts.prompt, {
        signal: opts.signal,
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      });
      for await (const ev of events as AsyncGenerator<ThreadEvent>) {
        switch (ev.type) {
          case 'thread.started':
            if (ev.thread_id !== sessionId) {
              sessionId = ev.thread_id;
              opts.onEvent({ type: 'session', data: sessionId });
            }
            break;
          case 'item.completed':
            if (ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning') opts.onEvent({ type: 'tool_end', data: { id: ev.item.id } });
            if (ev.item.type === 'agent_message') {
              finalText = ev.item.text;
              opts.onEvent({ type: 'text', data: ev.item.text });
            } else if (ev.item.type === 'error') {
              opts.onEvent({ type: 'error', data: ev.item.message });
            } else {
              opts.onEvent({ type: 'tool', data: { type: ev.item.type } });
            }
            break;
          case 'item.started':
            if (ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning') {
              opts.onEvent({ type: 'tool_start', data: { id: ev.item.id, type: ev.item.type } });
            } else opts.onEvent({ type: 'tool', data: { type: ev.type } });
            break;
          case 'item.updated':
          case 'turn.started':
            opts.onEvent({ type: 'tool', data: { type: ev.type } });
            break;
          case 'turn.completed':
            sawUsage = true;
            cost += estimateCost(ev.usage, price);
            opts.onEvent({ type: 'usage', data: { usage: ev.usage, costUsd: cost, estimated: true } });
            break;
          case 'turn.failed':
            error = ev.error.message;
            opts.onEvent({ type: 'error', data: error });
            break;
          case 'error':
            error = ev.message;
            opts.onEvent({ type: 'error', data: error });
            break;
        }
      }
    } catch (e: any) {
      error = opts.signal.aborted ? 'aborted' : String(e?.message ?? e);
      opts.onEvent({ type: 'error', data: error });
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
    sessionId = sessionId ?? thread.id ?? undefined;
    return {
      finalText,
      sessionId,
      costUsd: sawUsage ? cost : undefined,
      estimated: true,
      ok: !error,
      error,
    };
  }
}
