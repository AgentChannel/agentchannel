import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { RuntimeAdapter } from './types.js';

export * from './types.js';
export { ClaudeAdapter } from './claude.js';
export { CodexAdapter } from './codex.js';
export { FakeAdapter } from './fake.js';
export * from './paths.js';

/** The git common dir of a worktree (readable for git log/diff; never writable, S10). */
export function gitCommonDir(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? [resolve(cwd, out)] : [];
  } catch {
    return [];
  }
}

export function makeAdapter(runtime: string, o: { model?: string } = {}): RuntimeAdapter {
  if (runtime === 'claude') return new ClaudeAdapter({ model: o.model });
  if (runtime === 'codex') return new CodexAdapter({ model: o.model });
  throw new Error(`Unknown runtime "${runtime}" (use claude or codex)`);
}
