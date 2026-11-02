import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from '../client.js';
import type { ReadRepo } from './state.js';

const pexec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export function branchName(agentName: string, taskId: string): string {
  return `ach/${agentName}/${taskId.slice(0, 8)}`;
}

export interface Workspace {
  prepare(task: Task, agentName: string): Promise<string>;
  /** Remove the work dir for a task (the branch is kept). */
  remove(taskId: string): Promise<void>;
  /** Task ids that have a work dir. */
  list(): string[];
  /** mtime of a task's work dir. */
  mtime(taskId: string): number;
  /**
   * S1: agent-config files (.claude/, .mcp.json, CLAUDE.md, AGENTS.md) that the
   * task's links.base adds or changes relative to the runner's HEAD.
   */
  sensitiveChanges?(task: Task): Promise<string[]>;
  /**
   * Cross-repo: the task's links.repos (besides the primary repo), made readable.
   * Unknown names throw (the task fails with the message).
   */
  readRepos?(task: Task): Promise<ReadRepo[]>;
  /** S10: commit the work dir's changes on the task branch after a run. Returns the commit sha, if any. */
  commit?(taskId: string, message: string): Promise<string | undefined>;
}

/** Paths whose change by a sender-chosen base needs the worker owner's approval (S1). */
export function isSensitivePath(p: string): boolean {
  return /^\.claude(\/|$)/.test(p) || p === '.mcp.json' || /(^|\/)(CLAUDE|AGENTS)(\.local)?\.md$/i.test(p) || /(^|\/)\.codex(\/|$)/.test(p);
}

export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** P3: parse `--repo name=path` values (relative paths resolve against cwd). */
export function parseRepoFlags(values: string[], cwd: string = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf('=');
    const name = i > 0 ? v.slice(0, i).trim() : '';
    const path = i > 0 ? v.slice(i + 1).trim() : '';
    if (!REPO_NAME_RE.test(name) || !path) throw new Error(`--repo must be name=path (got "${v}")`);
    out[name] = resolve(cwd, path);
  }
  return out;
}

/**
 * Per-task git worktree (from links.base or HEAD) or a plain per-task dir.
 * P3: `links.repo` names the repo; `repos` maps names to local paths. A task
 * without links.repo uses `dir`. An unknown name is an error (the task fails).
 */
export class GitWorkspace implements Workspace {
  readonly root: string;
  constructor(
    readonly dir: string,
    home: string,
    private log: (s: string) => void = () => {},
    readonly repos: Record<string, string> = {},
  ) {
    this.root = join(home, 'work');
  }

  /** The local repo a task works in (P3). */
  repoDir(task: Task): string {
    const r = task.links?.repo;
    if (r === undefined || r === null || r === '') return this.dir;
    return this.lookup(r, 'links.repo');
  }

  /** Map a repo name to its local path, or fail with the names this runner knows. */
  lookup(r: unknown, what: string): string {
    if (typeof r !== 'string' || !REPO_NAME_RE.test(r)) throw new Error(`invalid ${what} ${JSON.stringify(r)}`);
    if (this.repos[r]) return this.repos[r];
    if (basename(this.dir) === r) return this.dir;
    const known = [...Object.keys(this.repos), basename(this.dir)].join(', ');
    throw new Error(`unknown repo "${r}": this runner knows ${known || '(none)'}. Restart it with --repo ${r}=<path> (or add it to "repos" in config.json).`);
  }

  /** Where read-only checkouts of a task's other repos go (next to, not inside, its worktree). */
  refRoot(taskId: string): string {
    return `${this.path(taskId)}.ref`;
  }

  /**
   * Cross-repo: links.repos = [{repo, base?}]. The primary repo (links.repo or
   * --dir) is skipped. With a base, the repo is checked out detached at that
   * base into <work>/<taskId>.ref/<name> (a git worktree; the agent can read it,
   * never write it). Without a base, the mapped repo itself is made readable.
   */
  async readRepos(task: Task): Promise<ReadRepo[]> {
    const list = task.links?.repos;
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error('links.repos must be a list of {repo, base?}');
    const primary = this.repoDir(task);
    const out: ReadRepo[] = [];
    for (const e of list) {
      const name = (e as any)?.repo;
      const dir = this.lookup(name, 'links.repos[].repo');
      if (dir === primary || out.some((x) => x.name === name)) continue;
      const base = (e as any)?.base;
      if (base === undefined || base === null || base === '' || !(await isGitRepo(dir))) {
        out.push({ name, path: dir, roots: [dir] });
        continue;
      }
      if (typeof base !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(base) || base.startsWith('-')) throw new Error(`invalid base for repo ${name}: ${JSON.stringify(base)}`);
      const p = join(this.refRoot(task.id), name);
      if (!existsSync(p)) {
        mkdirSync(this.refRoot(task.id), { recursive: true, mode: 0o700 });
        try {
          await git(dir, ['fetch', '--all', '--prune']);
        } catch (err: any) {
          this.log(`git fetch failed in ${dir}: ${err?.message ?? err}`);
        }
        const start = await this.resolveRef(dir, base);
        await git(dir, ['worktree', 'add', '--detach', p, start]);
      }
      const common = await git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '');
      out.push({ name, path: p, roots: [p, ...(common ? [common] : [])] });
    }
    return out;
  }

  path(taskId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`bad task id ${taskId}`);
    return join(this.root, taskId);
  }

  async prepare(task: Task, agentName: string): Promise<string> {
    const p = this.path(task.id);
    const dir = this.repoDir(task);
    if (existsSync(p)) return p;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!(await isGitRepo(dir))) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
      return p;
    }
    const branch = branchName(agentName, task.id);
    const base = typeof task.links?.base === 'string' ? (task.links.base as string) : undefined;
    let start = 'HEAD';
    if (base) {
      if (!/^[A-Za-z0-9._\/-]+$/.test(base) || base.startsWith('-')) throw new Error(`invalid links.base "${base}"`);
      try {
        await git(dir, ['fetch', '--all', '--prune']);
      } catch (e: any) {
        this.log(`git fetch failed: ${e?.message ?? e}`);
      }
      start = await this.resolveRef(dir, base);
    }
    let branchExists = false;
    try {
      await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      branchExists = true;
    } catch {
      /* new branch */
    }
    if (branchExists) await git(dir, ['worktree', 'add', p, branch]);
    else await git(dir, ['worktree', 'add', '-b', branch, p, start]);
    return p;
  }

  private async resolveRef(dir: string, base: string): Promise<string> {
    for (const cand of [base, `origin/${base}`]) {
      try {
        await git(dir, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
        return cand;
      } catch {
        /* try next */
      }
    }
    throw new Error(`links.base "${base}" not found in ${dir}`);
  }

  /** The main repo a worktree belongs to (any configured repo), from its git common dir. */
  private async ownerRepo(p: string): Promise<string | undefined> {
    try {
      const common = await git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const abs = isAbsolute(common) ? common : resolve(p, common);
      return basename(abs) === '.git' ? dirname(abs) : abs;
    } catch {
      return undefined;
    }
  }

  async remove(taskId: string): Promise<void> {
    const p = this.path(taskId);
    const ref = this.refRoot(taskId);
    if (existsSync(ref)) {
      for (const n of readdirSync(ref)) {
        const rp = join(ref, n);
        const owner = await this.ownerRepo(rp);
        if (owner && (await isGitRepo(owner))) await git(owner, ['worktree', 'remove', '--force', rp]).catch(() => '');
      }
      rmSync(ref, { recursive: true, force: true });
    }
    if (!existsSync(p)) return;
    const owner = (await this.ownerRepo(p)) ?? this.dir;
    if (await isGitRepo(owner)) {
      try {
        await git(owner, ['worktree', 'remove', '--force', p]);
        return;
      } catch {
        /* not a worktree of this repo; fall through */
      }
    }
    rmSync(p, { recursive: true, force: true });
    for (const d of new Set([owner, this.dir, ...Object.values(this.repos)])) {
      if (await isGitRepo(d)) await git(d, ['worktree', 'prune']).catch(() => '');
    }
  }

  async sensitiveChanges(task: Task): Promise<string[]> {
    const base = typeof task.links?.base === 'string' ? (task.links.base as string) : undefined;
    const dir = this.repoDir(task);
    if (!base || !(await isGitRepo(dir))) return [];
    const start = await this.resolveRef(dir, base);
    const out = await git(dir, ['diff', '--name-only', '--no-renames', `HEAD...${start}`, '--']);
    return out.split('\n').filter((l) => l && isSensitivePath(l));
  }

  /**
   * S10: agents cannot write the main repo's .git, so the runner commits for
   * them. Hooks are disabled (core.hooksPath=/dev/null, --no-verify): the work
   * dir content is agent-written and must never run outside the sandbox.
   */
  async commit(taskId: string, message: string): Promise<string | undefined> {
    const p = this.path(taskId);
    if (!existsSync(p) || !(await isGitRepo(p))) return undefined;
    const status = await git(p, ['status', '--porcelain']);
    if (!status) return undefined;
    const ident: string[] = [];
    try {
      await git(p, ['config', 'user.email']);
    } catch {
      ident.push('-c', 'user.name=AgentChannel runner', '-c', 'user.email=runner@agentchannel.invalid');
    }
    const safe = ['-c', 'core.hooksPath=/dev/null', ...ident];
    await git(p, [...safe, 'add', '-A']);
    await git(p, [...safe, 'commit', '--no-verify', '-q', '-m', message]);
    return git(p, ['rev-parse', 'HEAD']);
  }

  list(): string[] {
    try {
      return readdirSync(this.root).filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
    } catch {
      return [];
    }
  }

  mtime(taskId: string): number {
    try {
      return statSync(this.path(taskId)).mtimeMs;
    } catch {
      return 0;
    }
  }
}
