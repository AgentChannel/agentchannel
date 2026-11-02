import { spawn, type ChildProcess } from 'node:child_process';

export const KILL_GRACE_MS = 5000;

/** Kill a whole process group: SIGTERM now, SIGKILL after the grace period if still alive. */
export function killGroup(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  const pid = child.pid;
  if (!pid) return;
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  send('SIGTERM');
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) send('SIGKILL');
  }, graceMs);
  t.unref();
}

/**
 * Spawn in its own process group (detached) so cancel can kill the agent and every
 * tool subprocess it started. Abort triggers a group kill.
 */
export function spawnGroup(
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal; onStderr?: (s: string) => void },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => opts.onStderr?.(String(d)));
  if (opts.signal) {
    const onAbort = () => killGroup(child);
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    child.once('exit', () => opts.signal?.removeEventListener('abort', onAbort));
  }
  return child;
}
