import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterResult, AdapterRunOptions, RuntimeAdapter } from './types.js';

export interface AchCallResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Invokes the `ach` CLI with the spawned agent's env. */
export type AchCall = (args: string[], env: Record<string, string>, cwd: string) => Promise<AchCallResult>;

export type FakeStep =
  | { ach: string[]; unset?: string[]; set?: Record<string, string> }
  | { text: string }
  | { wait: number }
  | { waitForAbort: true }
  | { fail: string }
  | { cost: number }
  | { toolStart: string }
  | { toolEnd: string }
  | { throw: string };

export interface FakeRunInfo {
  index: number;
  prompt: string;
  resume?: string;
  cwd: string;
  perm: string;
  mode?: 'work' | 'answer' | 'mention';
  env: Record<string, string>;
  denyReadPaths?: string[];
  readRoots?: string[];
  outputSchema?: unknown;
  netAllow?: string[];
}

export interface FakeAdapterOptions {
  /** Steps for each run; receives the run info so a script can branch on prompt / resume. */
  script: (info: FakeRunInfo) => FakeStep[];
  ach?: AchCall;
  /** Behave like codex: answer runs return JSON and the runner posts it. */
  structuredAnswers?: boolean;
}

/** Default: spawn this package's CLI with node. */
export const spawnAch: AchCall = (args, env, cwd) =>
  new Promise((res) => {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const p = spawn(process.execPath, [cli, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', on);
      res();
    }, ms);
    const on = () => {
      clearTimeout(t);
      rej(new Error('aborted'));
    };
    signal.addEventListener('abort', on, { once: true });
  });
}

/** Scripted runtime for tests. Never calls a model. */
export class FakeAdapter implements RuntimeAdapter {
  readonly name = 'fake';
  readonly structuredAnswers: boolean;
  runs: FakeRunInfo[] = [];
  achCalls: { args: string[]; env: Record<string, string>; result: AchCallResult }[] = [];
  constructor(private o: FakeAdapterOptions) {
    this.structuredAnswers = !!o.structuredAnswers;
  }

  async run(opts: AdapterRunOptions): Promise<AdapterResult> {
    const info: FakeRunInfo = {
      index: this.runs.length,
      prompt: opts.prompt,
      resume: opts.resume,
      cwd: opts.cwd,
      perm: opts.perm,
      mode: opts.mode,
      env: opts.env,
      denyReadPaths: opts.denyReadPaths,
      readRoots: opts.readRoots,
      outputSchema: opts.outputSchema,
      netAllow: opts.netAllow,
    };
    this.runs.push(info);
    const sessionId = opts.resume ?? `fake-session-${info.index}-${Math.random().toString(36).slice(2, 8)}`;
    opts.onEvent({ type: 'session', data: sessionId });
    const ach = this.o.ach ?? spawnAch;
    let text = '';
    let cost: number | undefined;
    try {
      for (const step of this.o.script(info)) {
        if (opts.signal.aborted) throw new Error('aborted');
        if ('ach' in step) {
          // unset/set: what a misbehaving agent could do to its own env (`env -u ACH_RUN_TOKEN ach ...`)
          const env = { ...opts.env, ...(step.set ?? {}) };
          for (const k of step.unset ?? []) delete env[k];
          const result = await ach(step.ach, env, opts.cwd);
          this.achCalls.push({ args: step.ach, env, result });
          opts.onEvent({ type: 'tool', data: { ach: step.ach, code: result.code } });
        } else if ('text' in step) {
          text = step.text;
          opts.onEvent({ type: 'text', data: step.text });
        } else if ('wait' in step) {
          await sleep(step.wait, opts.signal);
        } else if ('waitForAbort' in step) {
          await sleep(2 ** 30, opts.signal);
        } else if ('cost' in step) {
          cost = step.cost;
          opts.onEvent({ type: 'usage', data: { costUsd: cost } });
        } else if ('toolStart' in step) {
          opts.onEvent({ type: 'tool_start', data: { id: step.toolStart } });
        } else if ('toolEnd' in step) {
          opts.onEvent({ type: 'tool_end', data: { id: step.toolEnd } });
        } else if ('fail' in step) {
          return { finalText: text, sessionId, costUsd: cost, ok: false, error: step.fail };
        } else if ('throw' in step) {
          throw new Error(step.throw);
        }
      }
    } catch (e: any) {
      return { finalText: text, sessionId, costUsd: cost, ok: false, error: opts.signal.aborted ? 'aborted' : String(e?.message ?? e) };
    }
    return { finalText: text, sessionId, costUsd: cost, ok: true };
  }
}
