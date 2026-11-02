import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * realpath of p, or of its nearest existing ancestor plus the rest (for files
 * that do not exist yet). macOS maps /tmp to /private/tmp and /var to
 * /private/var, so every comparison goes through this.
 */
export function realish(p: string, depth = 0): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      // A dangling symlink still points somewhere: follow it.
      try {
        if (depth < 40 && lstatSync(cur).isSymbolicLink()) {
          return realish(join(resolve(dirname(cur), readlinkSync(cur)), ...rest.reverse()), depth + 1);
        }
      } catch {
        /* not there at all */
      }
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(realish(root), realish(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Root of this npm package (dist/src/adapters/paths.js -> package dir): the `ach` shim runs code from here. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Paths under $HOME a spawned agent may read besides its cwd (S4): the node
 * install, npm and git config, and this package (the `ach` CLI). The git
 * common dir of the worktree is added by the caller.
 */
export function toolchainReadRoots(home = homedir()): string[] {
  const nodePrefix = resolve(dirname(process.execPath), '..');
  return [
    nodePrefix,
    packageRoot(),
    join(home, '.gitconfig'),
    join(home, '.config', 'git'),
    join(home, '.npmrc'),
    join(home, '.npm'),
  ];
}

export interface PathPolicy {
  home: string;
  cwd: string;
  /** Readable roots under $HOME besides cwd. */
  readRoots: string[];
  /** Writable roots (empty = read-only). */
  writeRoots: string[];
  /** Never readable or writable, even inside an allowed root. */
  deny: string[];
}

/** Undefined = allowed, else the reason for denying a read of p. */
export function readDenied(pol: PathPolicy, p: string): string | undefined {
  const abs = resolve(pol.cwd, p);
  if (pol.deny.some((d) => isInside(d, abs))) return `${p} is a protected AgentChannel file`;
  if (!isInside(pol.home, abs)) return undefined;
  if ([pol.cwd, ...pol.readRoots].some((r) => isInside(r, abs))) return undefined;
  return `reads under ${pol.home} are limited to the task directory and toolchain paths`;
}

export function writeDenied(pol: PathPolicy, p: string): string | undefined {
  const abs = resolve(pol.cwd, p);
  if (pol.deny.some((d) => isInside(d, abs))) return `${p} is a protected AgentChannel file`;
  if (pol.writeRoots.some((r) => isInside(r, abs))) return undefined;
  return `writes are only allowed inside ${pol.cwd}`;
}

export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** File paths a tool call touches (relative paths are resolved against cwd by the policy). */
export function toolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[k] === 'string' && input[k]) out.push(input[k] as string);
  }
  // Glob/Grep patterns may be absolute ("/Users/x/**/*.pem"): check their fixed prefix.
  for (const k of ['pattern', 'glob']) {
    const v = input[k];
    if ((toolName === 'Glob' || k === 'glob') && typeof v === 'string' && (isAbsolute(v) || v.startsWith('~'))) {
      const fixed = v.replace(/^~(?=\/|$)/, homedir()).split(/[*?[{]/)[0];
      out.push(fixed || '/');
    }
  }
  if ((READ_TOOLS.has(toolName) || toolName === 'Glob' || toolName === 'Grep') && !out.length) out.push('.');
  return out;
}

/** Deny reason for a tool call under the policy, or undefined to allow. */
export function toolDenied(pol: PathPolicy, toolName: string, input: Record<string, unknown>): string | undefined {
  const write = WRITE_TOOLS.has(toolName);
  if (!write && !READ_TOOLS.has(toolName)) return undefined;
  for (const p of toolPaths(toolName, input)) {
    const why = write ? writeDenied(pol, p) ?? readDenied(pol, p) : readDenied(pol, p);
    if (why) return why;
  }
  return undefined;
}

export function existing(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p));
}
