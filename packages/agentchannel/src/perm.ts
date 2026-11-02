export type Perm = 'read' | 'workdir' | 'full';

export const PERMS: readonly Perm[] = ['read', 'workdir', 'full'] as const;

export function isPerm(v: unknown): v is Perm {
  return typeof v === 'string' && (PERMS as readonly string[]).includes(v);
}

export function permRank(p: Perm): number {
  return PERMS.indexOf(p);
}

/** Lower of two permission levels. */
export function minPerm(a: Perm, b: Perm): Perm {
  return permRank(a) <= permRank(b) ? a : b;
}

/**
 * Effective perm for a run = min(hub perm_level, runner --perm).
 * An unknown or missing hub level is treated as 'read' (fail closed).
 * `full` therefore requires both the hub and the runner flag to say full.
 */
export function effectivePerm(hubLevel: unknown, flag: Perm): Perm {
  const hub: Perm = isPerm(hubLevel) ? hubLevel : 'read';
  return minPerm(hub, flag);
}
