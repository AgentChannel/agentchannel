// Name helpers for `ach post` (channel by name/title, @name check) and
// `ach ask-human --to` (closest-name suggestions). Pure; the hub stays the
// authority (it parses mentions and validates `to_user` itself).
import { HubError, type Agent, type Channel, type Client } from './client.js';

/** Same shape as the hub's MENTION_RE (ach_lib.js); code spans/blocks ignored. */
const MENTION_RE = /(^|[^A-Za-z0-9_.\/-])@([a-z0-9][a-z0-9-]{1,40})(?![A-Za-z0-9-])/g;

export function mentionNames(text: string): string[] {
  const plain = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  for (const m of plain.matchAll(MENTION_RE)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** Closest candidate (case-insensitive), or undefined when nothing is near. */
export function closest(name: string, candidates: string[]): string | undefined {
  const n = name.toLowerCase();
  let best: string | undefined;
  let bd = Infinity;
  for (const c of candidates) {
    const l = c.toLowerCase();
    const d = l.startsWith(n) || n.startsWith(l) ? Math.min(1, editDistance(n, l)) : editDistance(n, l);
    if (d < bd) [best, bd] = [c, d];
  }
  return best !== undefined && bd <= Math.max(2, Math.floor(n.length / 3)) ? best : undefined;
}

/** "Web Team" / "web-team" / "#web-team" -> the channel's name, by name or title. */
export function matchChannel(ref: string, channels: Channel[]): Channel | undefined {
  const r = String(ref).trim().replace(/^#/, '');
  const low = r.toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-');
  return (
    channels.find((c) => c.name === r) ??
    channels.find((c) => c.name.toLowerCase() === low) ??
    channels.find((c) => String((c as any).title ?? '').trim().toLowerCase() === low) ??
    channels.find((c) => norm(c.name) === norm(r))
  );
}

/** Handles a person can be written as after @: "Alice Smith" -> "alice-smith", email local part. */
export function personHandles(p: { name?: string; email?: string }): string[] {
  const out = new Set<string>();
  const n = String(p.name ?? '').trim().toLowerCase();
  if (n) {
    out.add(n.replace(/\s+/g, '-'));
    out.add(n.replace(/\s+/g, ''));
    out.add(n.split(/\s+/)[0]);
  }
  const local = String(p.email ?? '').split('@')[0].toLowerCase();
  if (local) out.add(local);
  return [...out].filter(Boolean);
}

/** @names in `body` that match no agent or person, each with the closest known name. */
export function unknownMentions(body: string, agents: Agent[], people: { name?: string; email?: string }[]): { name: string; suggest?: string }[] {
  const agentNames = agents.map((a) => a.name).filter(Boolean);
  const handles = new Map<string, string>();
  for (const p of people) for (const h of personHandles(p)) handles.set(h, h);
  const known = new Set([...agentNames.map((a) => a.toLowerCase()), ...handles.keys()]);
  return mentionNames(body)
    .filter((n) => !known.has(n.toLowerCase()))
    .map((n) => ({ name: n, suggest: closest(n, [...agentNames, ...handles.keys()]) }));
}

/**
 * `--to`: omitted = your owner (the hub may add the other side for money), "self" = only your
 * owner, "both" = both owners, anything else names a person (`to_user`).
 */
export function decisionTo(to?: string): { to?: string; to_user?: string } {
  const t = String(to ?? '').trim();
  if (!t) return {};
  if (t === 'self' || t === 'both') return { to: t };
  return { to_user: t.replace(/^@/, '') };
}

/** Turns the hub's to_user refusals into one line an agent can act on. */
export async function explainToUser(e: unknown, person: string, c: Client, taskId: string): Promise<unknown> {
  if (!(e instanceof HubError)) return e;
  const body: any = e.body ?? {};
  if (e.status === 403 && e.code === 'not_member') {
    const ch = await c.getTask(taskId).then((r) => r?.task?.channel_name).catch(() => '');
    return new HubError(e.status, `${person} is not a member of ${ch ? `#${ch}` : "this task's channel"}; ask someone in the channel (or omit --to to ask your owner)`, e.code, e.body);
  }
  if (e.status === 400 && e.code === 'ambiguous') {
    const cands = (Array.isArray(body.candidates) ? body.candidates : []).map((x: any) => `${x.name}${x.email ? ` <${x.email}>` : ''}`);
    return new HubError(e.status, `more than one person is called ${person}${cands.length ? ` (${cands.join(', ')})` : ''}; use --to <email>`, e.code, e.body);
  }
  if (e.status === 404 && !/task/i.test(String(body.error ?? body.message ?? ''))) {
    const owners = await c.agents().then((a) => [...new Set(a.map((x) => x.owner_name ?? '').filter(Boolean))]).catch(() => [] as string[]);
    const near = closest(person, owners);
    return new HubError(e.status, `no active person "${person}"${near ? ` (did you mean ${near}?)` : ''}; use their name or email as the hub knows it`, e.code, e.body);
  }
  return e;
}
