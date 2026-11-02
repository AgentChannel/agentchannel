/**
 * Team onboarding from GitHub (docs/import-github.md).
 *
 *   ach admin import github --org <org> [--since 60d] [--plan plan.json] [--out plan.json] [--dry-run]
 *     [--closed-days 7 | --all] [--exclude security,secret | --no-exclude]
 *   ach admin sync github [--org <org>]
 *   ach admin invite --feishu [--people a,b] [--yes]   |   ach admin invite --people a,b --yes (print links)
 *
 * GitHub is read on THIS machine with the admin's own `gh` login (gh also
 * honors GITHUB_TOKEN / GH_TOKEN). The hub never sees a GitHub token: it gets a
 * plan (channels with repo mappings, people) and compact items (issues/PRs:
 * title, state, who, a short excerpt, the link; never comment threads).
 * Nothing here writes to GitHub. Feishu invites go through the local
 * `lark-cli` and are only sent with --yes.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from './client.js';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

/** Runs `gh` / `lark-cli` (ACH_GH_CLI / ACH_LARK_CLI override the binaries). */
export function makeExec(env: NodeJS.ProcessEnv): Exec {
  const bins: Record<string, string | undefined> = { gh: env.ACH_GH_CLI, 'lark-cli': env.ACH_LARK_CLI };
  return (cmd, args) =>
    new Promise((res) => {
      execFile(bins[cmd] || cmd, args, { env, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err: any, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return res({ code: 127, stdout: '', stderr: `${cmd}: not found` });
        res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
}

export class ImportError extends Error {}

// ------------------------------------------------------------------ types

export interface GhItem {
  kind: 'github_issue' | 'github_pr';
  repo: string; // owner/name
  number: number;
  url: string;
  state: string; // open | closed | merged
  title: string;
  author: string;
  author_bot: boolean;
  assignees: string[];
  created_at: string;
  updated_at: string;
  /** when it was closed or merged ('' while open) */
  closed_at: string;
  labels: string[];
  excerpt: string;
}

export interface RepoData {
  full: string;
  name: string;
  description: string;
  pushedAt: string;
  commits: { login: string; name: string; bot: boolean }[];
  issues: GhItem[];
  prs: GhItem[];
}

export interface Collected {
  org: string;
  since: string;
  self: string;
  repos: RepoData[];
  users: Record<string, { name: string; email: string; bot: boolean }>;
}

export interface PlanChannel { name: string; title?: string; description?: string; repos: string[]; visibility?: 'team' | 'private'; stats?: { issues: number; prs: number; commits: number } }
export interface PlanPerson {
  github_login: string;
  name: string;
  email?: string;
  is_admin?: boolean;
  self?: boolean;
  invite: boolean;
  role?: string;
  note?: string;
  channels?: string[];
  stats?: { commits: number; issues_opened: number; prs_opened: number; assigned: number; commits_by_repo: Record<string, number> };
  feishu_open_id?: string;
}
export interface Plan {
  version: 1;
  source: { kind: 'github'; org: string };
  since: string;
  generated_at: string;
  channels: PlanChannel[];
  people: PlanPerson[];
  bots: string[];
  unlinked_commit_authors: string[];
  counts: { repos: number; issues: number; prs: number; commits: number };
}

// ------------------------------------------------------------------ helpers

/** "60d", "8w", "3m" (months), or an ISO date -> ISO time. */
export function parseSince(s: string | undefined, now = Date.now()): string {
  const v = (s ?? '60d').trim();
  const m = /^(\d{1,4})([dwm])$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 10) * (m[2] === 'd' ? 1 : m[2] === 'w' ? 7 : 30);
    return new Date(now - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new ImportError(`--since: expected 60d, 8w, 3m or a date, got "${v}"`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const BOT_NAMES = /^(codex|claude|claude-code|copilot|github-actions|dependabot|renovate|workbuddy|cursor|devin|openhands|sweep)(-|$)/i;

/** Bots never become people: [bot] logins, GitHub type Bot, known agent names, *bot. */
export function isBot(login: string, flagged = false): boolean {
  if (!login) return false;
  return flagged || /\[bot\]$/i.test(login) || BOT_NAMES.test(login) || /(^|-)bot$/i.test(login);
}

function slug(s: string): string {
  const v = s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40).replace(/[-_]+$/, '');
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : 'repo-' + Math.abs(hash(s)).toString(36).slice(0, 6);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function excerptOf(body: string | undefined, max = 600): string {
  let t = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/<img[^>]*>/gi, '[image]')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

async function ghJson(exec: Exec, args: string[], what: string, optional = false): Promise<any> {
  const r = await exec('gh', args);
  if (r.code === 127) throw new ImportError('`gh` (GitHub CLI) is not installed. Install it and run `gh auth login` (or set GITHUB_TOKEN).');
  if (r.code !== 0) {
    if (optional) return null;
    const msg = r.stderr.trim().split('\n')[0] || `exit ${r.code}`;
    if (/auth|login|401|credentials/i.test(r.stderr)) throw new ImportError(`gh is not logged in (${msg}). Run \`gh auth login\` or set GITHUB_TOKEN.`);
    throw new ImportError(`gh ${what} failed: ${msg}`);
  }
  try {
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    throw new ImportError(`gh ${what}: unexpected output`);
  }
}

function toItem(kind: GhItem['kind'], repo: string, x: any): GhItem {
  return {
    kind,
    repo,
    number: Number(x.number),
    url: String(x.url ?? ''),
    state: String(x.state ?? '').toLowerCase(),
    title: String(x.title ?? ''),
    author: String(x.author?.login ?? ''),
    author_bot: !!x.author?.is_bot,
    assignees: (Array.isArray(x.assignees) ? x.assignees : []).map((a: any) => String(a?.login ?? '')).filter(Boolean),
    created_at: String(x.createdAt ?? ''),
    updated_at: String(x.updatedAt ?? ''),
    closed_at: String(x.mergedAt || x.closedAt || (String(x.state ?? '').toLowerCase() === 'open' ? '' : x.updatedAt ?? '')),
    labels: (Array.isArray(x.labels) ? x.labels : []).map((l: any) => String(typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean),
    excerpt: excerptOf(x.body),
  };
}

const ISSUE_FIELDS = 'number,title,state,author,assignees,createdAt,updatedAt,closedAt,url,body,labels';
const PR_FIELDS = ISSUE_FIELDS + ',mergedAt';

/** Items whose labels or title name one of these are never sent to the hub (case-insensitive substring). The Chinese terms are language support for Chinese labels. */
export const DEFAULT_EXCLUDE = ['security', '安全', '漏洞', 'secret', '密钥'];
/** Closed/merged items newer than this become posts by default; older ones only seed the wiki. */
export const DEFAULT_CLOSED_DAYS = 7;
/** Closed/merged items used to seed Memory (links only): the last N months by default, or all (--seed-all). */
export const DEFAULT_SEED_MONTHS = 6;

export interface Selection {
  items: GhItem[]; // posted: open, or closed/merged after the cutoff
  archive: GhItem[]; // older closed/merged inside the seed range: Memory seed links only
  tooOld: GhItem[]; // closed/merged before the seed range: not sent
  excluded: GhItem[]; // sensitive: never sent
  closedCutoff: string; // '' = --all
  seedCutoff?: string; // '' = --seed-all
}

export function isExcluded(i: Pick<GhItem, 'title' | 'labels'>, terms: string[]): boolean {
  if (!terms.length) return false;
  const hay = [i.title, ...(i.labels ?? [])].map((x) => String(x).toLowerCase());
  return terms.some((t) => t && hay.some((h) => h.includes(t.toLowerCase())));
}

/**
 * What gets posted. Sensitive items (labels/title match `exclude`) are dropped
 * entirely. Open items are posted; closed/merged ones only when they closed
 * after `closedCutoff` ('' = all of them); older closed ones go to `archive`.
 */
export function selectItems(all: GhItem[], o: { exclude: string[]; closedCutoff: string; seedCutoff?: string }): Selection {
  const sel: Selection = { items: [], archive: [], tooOld: [], excluded: [], closedCutoff: o.closedCutoff, seedCutoff: o.seedCutoff ?? '' };
  for (const i of all) {
    const at = i.closed_at || i.updated_at;
    if (isExcluded(i, o.exclude)) sel.excluded.push(i);
    else if (i.state === 'open' || !o.closedCutoff || at >= o.closedCutoff) sel.items.push(i);
    else if (!o.seedCutoff || at >= o.seedCutoff) sel.archive.push(i);
    else sel.tooOld.push(i);
  }
  return sel;
}

/** --exclude a,b / --no-exclude -> the exclusion terms. */
export function excludeTerms(values: Record<string, unknown>): string[] {
  if (values['no-exclude']) return [];
  const v = sv(values.exclude);
  if (v === undefined) return DEFAULT_EXCLUDE;
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

/** --seed-all / --seed-months N -> the Memory seed cutoff ('' = everything). */
export function seedCutoff(values: Record<string, unknown>, now: number): string {
  if (values['seed-all']) return '';
  const raw = sv(values['seed-months']);
  const n = raw === undefined ? DEFAULT_SEED_MONTHS : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 240) throw new ImportError(`--seed-months: expected a whole number of months (1-240), got "${raw}"`);
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The two import ranges as the hub stores them (wizard-ready API fields). */
export function importRanges(values: Record<string, unknown>): { post_closed_days?: number; seed_months?: number; seed?: 'all' } {
  const out: { post_closed_days?: number; seed_months?: number; seed?: 'all' } = {};
  const cd = sv(values['post-closed-days']) ?? sv(values['closed-days']);
  out.post_closed_days = values.all ? 3650 : cd === undefined ? DEFAULT_CLOSED_DAYS : Number(cd);
  if (values['seed-all']) out.seed = 'all';
  else out.seed_months = sv(values['seed-months']) === undefined ? DEFAULT_SEED_MONTHS : Number(sv(values['seed-months']));
  return out;
}

/** --all / --closed-days N (alias --post-closed-days) -> the closed-item cutoff ('' = no cutoff). */
export function closedCutoff(values: Record<string, unknown>, now: number): string {
  if (values.all) return '';
  const raw = sv(values['post-closed-days']) ?? sv(values['closed-days']);
  const n = raw === undefined ? DEFAULT_CLOSED_DAYS : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw new ImportError(`--closed-days: expected a whole number of days, got "${raw}"`);
  return new Date(now - n * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Issues and PRs of one repo updated since `since`. */
export async function fetchItems(exec: Exec, full: string, since: string, log?: (s: string) => void): Promise<{ issues: GhItem[]; prs: GhItem[] }> {
  const q = `updated:>=${since.slice(0, 10)}`;
  const iss = (await ghJson(exec, ['issue', 'list', '-R', full, '--state', 'all', '--limit', '1000', '--search', q, '--json', ISSUE_FIELDS], `issue list ${full}`, true)) ?? [];
  const prs = (await ghJson(exec, ['pr', 'list', '-R', full, '--state', 'all', '--limit', '1000', '--search', q, '--json', PR_FIELDS], `pr list ${full}`, true)) ?? [];
  const keep = (x: any) => !x.updatedAt || x.updatedAt >= since;
  log?.(`  ${full}: ${iss.length} issues, ${prs.length} PRs`);
  return { issues: iss.filter(keep).map((x: any) => toItem('github_issue', full, x)), prs: prs.filter(keep).map((x: any) => toItem('github_pr', full, x)) };
}

export interface GhRelease { repo: string; tag: string; name: string; url: string; published_at: string }

/** Releases of one repo published since `since` (read-only; drafts skipped). Missing access -> none. */
export async function fetchReleases(exec: Exec, full: string, since: string): Promise<GhRelease[]> {
  const list = (await ghJson(exec, ['release', 'list', '-R', full, '--limit', '30', '--json', 'tagName,name,publishedAt,isDraft'], `release list ${full}`, true)) ?? [];
  return (Array.isArray(list) ? list : [])
    .filter((r: any) => r && !r.isDraft && r.tagName && String(r.publishedAt ?? '') >= since)
    .map((r: any) => ({
      repo: full,
      tag: String(r.tagName),
      name: String(r.name ?? ''),
      url: `https://github.com/${full}/releases/tag/${encodeURIComponent(String(r.tagName))}`,
      published_at: String(r.publishedAt ?? ''),
    }));
}

/** Read the org from GitHub: active repos, commits, issues, PRs, people. Read-only. */
export async function collectGithub(
  exec: Exec,
  org: string,
  since: string,
  o: { repos?: string[]; commits?: boolean; log?: (s: string) => void } = {},
): Promise<Collected> {
  const me = await ghJson(exec, ['api', 'user'], 'api user');
  const self = String(me?.login ?? '');
  let targets: { full: string; name: string; description: string; pushedAt: string }[];
  if (o.repos) {
    targets = o.repos.map((full) => ({ full, name: full.split('/')[1] ?? full, description: '', pushedAt: '' }));
  } else {
    const list = (await ghJson(exec, ['repo', 'list', org, '--limit', '1000', '--json', 'name,description,isArchived,pushedAt,updatedAt'], `repo list ${org}`)) ?? [];
    targets = list
      .filter((r: any) => !r.isArchived && ((r.pushedAt ?? '') >= since || (r.updatedAt ?? '') >= since))
      .map((r: any) => ({ full: `${org}/${r.name}`, name: String(r.name), description: String(r.description ?? ''), pushedAt: String(r.pushedAt ?? '') }));
  }
  o.log?.(`reading ${targets.length} repo(s) of ${org} since ${since.slice(0, 10)} with your gh login (${self || 'unknown'})`);
  const repos: RepoData[] = [];
  for (const t of targets) {
    const items = await fetchItems(exec, t.full, since, o.log);
    let commits: RepoData['commits'] = [];
    if (o.commits !== false) {
      const cs = (await ghJson(exec, ['api', `repos/${t.full}/commits?since=${encodeURIComponent(since)}&per_page=100`], `commits ${t.full}`, true)) ?? [];
      commits = (Array.isArray(cs) ? cs : []).map((c: any) => ({
        login: String(c?.author?.login ?? ''),
        name: String(c?.commit?.author?.name ?? ''),
        bot: c?.author?.type === 'Bot',
      }));
    }
    repos.push({ ...t, commits, ...items });
  }
  // display names / public emails for the people we saw (bots skipped)
  const logins = new Set<string>();
  for (const r of repos) {
    for (const c of r.commits) if (c.login && !isBot(c.login, c.bot)) logins.add(c.login);
    for (const i of [...r.issues, ...r.prs]) {
      if (i.author && !isBot(i.author, i.author_bot)) logins.add(i.author);
      for (const a of i.assignees) if (!isBot(a)) logins.add(a);
    }
  }
  const users: Collected['users'] = {};
  for (const l of logins) {
    const u = await ghJson(exec, ['api', `users/${l}`], `user ${l}`, true);
    users[l] = { name: String(u?.name ?? '') || l, email: String(u?.email ?? ''), bot: u?.type === 'Bot' };
  }
  return { org, since, self, repos, users };
}

// ------------------------------------------------------------------ plan heuristic

const activity = (r: RepoData) => r.commits.length + r.issues.length + r.prs.length;

/**
 * Default channel mapping: repos grouped by name prefix (`shop-web`,
 * `shop-api` -> #shop); a repo that dominates a big group, or an active
 * singleton, gets its own channel; quiet singletons go to #general; at most
 * `maxChannels` channels besides #general. The plan is a starting point: edit it.
 */
export function defaultChannels(repos: RepoData[], maxChannels = 8): PlanChannel[] {
  const groups = new Map<string, RepoData[]>();
  for (const r of repos) {
    const key = r.name.toLowerCase().split(/[-_.]/)[0] || r.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const chans: { name: string; repos: RepoData[] }[] = [];
  const general: RepoData[] = [];
  const total = repos.reduce((s, r) => s + activity(r), 0) || 1;
  for (const [key, rs] of groups) {
    const act = rs.reduce((s, r) => s + activity(r), 0);
    if (rs.length === 1) {
      // an active singleton (≥ 5% of the org's activity, and > 10 events) is its own channel
      if (act > 10 && act / total >= 0.05) chans.push({ name: slug(rs[0].name), repos: rs });
      else general.push(...rs);
      continue;
    }
    const sorted = [...rs].sort((a, b) => activity(b) - activity(a));
    const rest = [...sorted];
    // a repo carrying ≥ 40% of a group of 4+ gets its own channel
    if (rs.length >= 4 && activity(sorted[0]) / (act || 1) >= 0.4 && activity(sorted[0]) > 10) {
      chans.push({ name: slug(sorted[0].name), repos: [sorted[0]] });
      rest.shift();
    }
    if (act === 0) general.push(...rest);
    else chans.push({ name: slug(key), repos: rest });
  }
  chans.sort((a, b) => b.repos.reduce((s, r) => s + activity(r), 0) - a.repos.reduce((s, r) => s + activity(r), 0));
  const kept = chans.slice(0, maxChannels);
  for (const c of chans.slice(maxChannels)) general.push(...c.repos);
  // names must be unique (a group key may equal a split-out repo name)
  const used = new Set<string>(['general']);
  const out: PlanChannel[] = [];
  for (const c of kept) {
    let name = c.name;
    for (let i = 2; used.has(name); i++) name = `${c.name}-${i}`.slice(0, 40);
    used.add(name);
    out.push(chanOut(name, c.repos));
  }
  out.push(chanOut('general', general, 'Team-wide discussion and tasks'));
  return out;
}

function chanOut(name: string, rs: RepoData[], desc?: string): PlanChannel {
  const d = desc ?? (rs.length === 1 && rs[0].description ? rs[0].description : `GitHub: ${rs.map((r) => r.name).join(', ')}`);
  return {
    name,
    description: d.slice(0, 2000),
    repos: rs.map((r) => r.full),
    stats: {
      issues: rs.reduce((s, r) => s + r.issues.length, 0),
      prs: rs.reduce((s, r) => s + r.prs.length, 0),
      commits: rs.reduce((s, r) => s + r.commits.length, 0),
    },
  };
}

/** People from commits, issues and PRs; roles inferred; bots excluded. */
export function inferPeople(c: Collected, channels: PlanChannel[]): { people: PlanPerson[]; bots: string[]; unlinked: string[] } {
  const chanOf = new Map<string, string>();
  for (const ch of channels) for (const r of ch.repos) chanOf.set(r.toLowerCase(), ch.name);
  type Acc = { login: string; commits: number; byRepo: Record<string, number>; opened: number; prs: number; assigned: number; chans: Map<string, number> };
  const acc = new Map<string, Acc>();
  const bots = new Set<string>();
  const unlinked = new Set<string>();
  const get = (login: string): Acc => {
    const k = login.toLowerCase();
    if (!acc.has(k)) acc.set(k, { login, commits: 0, byRepo: {}, opened: 0, prs: 0, assigned: 0, chans: new Map() });
    return acc.get(k)!;
  };
  const touch = (a: Acc, repo: string, w: number) => {
    const ch = chanOf.get(repo.toLowerCase());
    if (ch) a.chans.set(ch, (a.chans.get(ch) ?? 0) + w);
  };
  const botUser = (l: string) => !!c.users[l]?.bot;
  for (const r of c.repos) {
    for (const cm of r.commits) {
      if (!cm.login) {
        if (cm.name && !isBot(cm.name)) unlinked.add(cm.name);
        else if (cm.name) bots.add(cm.name);
        continue;
      }
      if (isBot(cm.login, cm.bot || botUser(cm.login))) { bots.add(cm.login); continue; }
      const a = get(cm.login);
      a.commits++;
      a.byRepo[r.name] = (a.byRepo[r.name] ?? 0) + 1;
      touch(a, r.full, 1);
    }
    for (const it of [...r.issues, ...r.prs]) {
      if (it.author) {
        if (isBot(it.author, it.author_bot || botUser(it.author))) bots.add(it.author);
        else {
          const a = get(it.author);
          if (it.kind === 'github_pr') a.prs++;
          else a.opened++;
          touch(a, r.full, 1);
        }
      }
      for (const as of it.assignees) {
        if (isBot(as, botUser(as))) { bots.add(as); continue; }
        const a = get(as);
        a.assigned++;
        touch(a, r.full, 2);
      }
    }
  }
  const people: PlanPerson[] = [];
  for (const a of acc.values()) {
    const total = a.commits + a.opened + a.prs + a.assigned;
    const self = !!c.self && a.login.toLowerCase() === c.self.toLowerCase();
    const top = Object.entries(a.byRepo).sort((x, y) => y[1] - x[1]).slice(0, 3);
    const parts: string[] = [];
    if (top.length) parts.push(`commits: ${top.map(([n, k]) => `${n} ${k}`).join(', ')}`);
    if (a.opened) parts.push(`opened ${a.opened} issue(s)`);
    if (a.prs) parts.push(`opened ${a.prs} PR(s)`);
    if (a.assigned) parts.push(`assigned ${a.assigned}`);
    const label = self ? 'admin' : a.commits >= 10 ? 'maintainer' : a.opened >= 5 && a.commits < 3 ? 'reporter / tester' : 'contributor';
    const invite = self || total >= 3 || a.assigned > 0;
    const u = c.users[a.login];
    people.push({
      github_login: a.login,
      name: u?.name || a.login,
      ...(u?.email ? { email: u.email } : {}),
      is_admin: self,
      ...(self ? { self: true } : {}),
      invite,
      role: `${label}${parts.length ? ` (${parts.join('; ')})` : ''}`,
      ...(invite ? {} : { note: 'occasional contributor: confirm who this is before inviting' }),
      channels: [...a.chans.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n),
      stats: { commits: a.commits, issues_opened: a.opened, prs_opened: a.prs, assigned: a.assigned, commits_by_repo: a.byRepo },
    });
  }
  people.sort((x, y) => Number(!!y.self) - Number(!!x.self) || Number(y.invite) - Number(x.invite) || score(y) - score(x));
  return { people, bots: [...bots].sort(), unlinked: [...unlinked].sort() };
}

const score = (p: PlanPerson) => (p.stats ? p.stats.commits + p.stats.issues_opened + p.stats.prs_opened + p.stats.assigned : 0);

export function buildPlan(c: Collected, now = new Date()): Plan {
  const channels = defaultChannels(c.repos);
  const { people, bots, unlinked } = inferPeople(c, channels);
  return {
    version: 1,
    source: { kind: 'github', org: c.org },
    since: c.since,
    generated_at: now.toISOString(),
    channels,
    people,
    bots,
    unlinked_commit_authors: unlinked,
    counts: {
      repos: c.repos.length,
      issues: c.repos.reduce((s, r) => s + r.issues.length, 0),
      prs: c.repos.reduce((s, r) => s + r.prs.length, 0),
      commits: c.repos.reduce((s, r) => s + r.commits.length, 0),
    },
  };
}

export function readPlan(file: string): Plan {
  let p: any;
  try {
    p = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: any) {
    throw new ImportError(`--plan ${file}: ${e?.message ?? e}`);
  }
  if (!p || !Array.isArray(p.channels) || !Array.isArray(p.people)) throw new ImportError(`--plan ${file}: expected {channels: [...], people: [...]}`);
  for (const ch of p.channels) if (!ch || typeof ch.name !== 'string' || !Array.isArray(ch.repos)) throw new ImportError(`--plan ${file}: every channel needs name and repos`);
  for (const pp of p.people) if (!pp || typeof pp.github_login !== 'string') throw new ImportError(`--plan ${file}: every person needs github_login`);
  return p as Plan;
}

/** {channel: {login: {commits}}} from the plan's per-person commits by repo (bots excluded). */
export function channelStats(plan: Plan): Record<string, Record<string, { commits: number }>> {
  const chanOf = new Map<string, string>();
  for (const ch of plan.channels) for (const r of ch.repos) chanOf.set((r.split('/')[1] ?? r).toLowerCase(), ch.name);
  const out: Record<string, Record<string, { commits: number }>> = {};
  for (const p of plan.people) {
    if (isBot(p.github_login)) continue;
    for (const [repo, n] of Object.entries(p.stats?.commits_by_repo ?? {})) {
      const ch = chanOf.get(repo.toLowerCase());
      if (!ch) continue;
      out[ch] ??= {};
      out[ch][p.github_login] = { commits: (out[ch][p.github_login]?.commits ?? 0) + n };
    }
  }
  return out;
}

function hubItem(i: GhItem) {
  return {
    kind: i.kind, repo: i.repo, number: i.number, url: i.url, state: i.state, title: i.title,
    author: i.author, assignees: i.assignees, created_at: i.created_at, updated_at: i.updated_at, excerpt: i.excerpt, labels: i.labels ?? [],
  };
}

/** An older closed item: a link for the wiki seed, never a post (no excerpt). */
function archiveItem(i: GhItem) {
  return {
    kind: i.kind, repo: i.repo, number: i.number, url: i.url, title: i.title, state: i.state,
    author: i.author, updated_at: i.updated_at, closed_at: i.closed_at,
  };
}

const CHUNK = 200;

type Counts = Record<string, number>;
function addCounts(a: Counts, b: Counts | undefined) {
  for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + (v as number);
}

/** Push plan + items to the hub in chunks; the last request records the sync time. */
export async function pushToHub(
  admin: Client,
  source: string,
  o: { plan?: Plan; items: GhItem[]; archive?: GhItem[]; stats?: Record<string, unknown>; syncAt: string; since: string; ranges?: Record<string, unknown>; releases?: GhRelease[] },
): Promise<{ counts: Counts; people: any[]; skipped: string[]; channels: any[] }> {
  const counts: Counts = {};
  let people: any[] = [];
  let skipped: string[] = [];
  let channels: any[] = [];
  const items = o.items.map(hubItem);
  const archive = (o.archive ?? []).map(archiveItem);
  const n = Math.max(1, Math.ceil(items.length / CHUNK), Math.ceil(archive.length / CHUNK));
  for (let i = 0; i < n; i++) {
    const first = i === 0;
    const last = i === n - 1;
    const body: any = { source, items: items.slice(i * CHUNK, (i + 1) * CHUNK) };
    const arch = archive.slice(i * CHUNK, (i + 1) * CHUNK);
    if (arch.length) body.archive = arch;
    if (first && o.plan) {
      body.plan = {
        channels: o.plan.channels.map((c) => ({
          name: c.name, title: c.title, description: c.description, repos: c.repos,
          ...(c.visibility ? { visibility: c.visibility } : {}),
        })),
        people: o.plan.people.map((p) => ({
          github_login: p.github_login, name: p.name, email: p.email, is_admin: !!p.is_admin, self: !!p.self, invite: p.invite !== false,
          ...(p.role ? { role: p.role } : {}),
          ...(Array.isArray(p.channels) ? { channels: p.channels } : {}),
          ...(p.feishu_open_id ? { feishu_open_id: p.feishu_open_id } : {}),
        })),
      };
    }
    if (first && o.stats) body.stats = o.stats;
    if (first && o.ranges) body.ranges = o.ranges;
    if (last) body.sync = { at: o.syncAt, since: o.since };
    if (last && o.releases?.length) body.releases = o.releases;
    const r = await admin.request<any>('POST', '/api/ach/admin/import/apply', body);
    addCounts(counts, r?.counts);
    if (r?.people) people = r.people;
    if (r?.skipped_people) skipped = r.skipped_people;
    if (r?.channels) channels = r.channels;
  }
  return { counts, people, skipped, channels };
}

// ------------------------------------------------------------------ output

function pad(s: string, n: number) {
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

/** One set of numbers for the dry-run header and the "Would import" line. */
export function selectionCounts(sel: Selection) {
  const all = [...sel.items, ...sel.archive, ...(sel.tooOld ?? []), ...sel.excluded];
  return {
    read: all.length,
    issues: all.filter((i) => i.kind === 'github_issue').length,
    prs: all.filter((i) => i.kind === 'github_pr').length,
    items: sel.items.length,
    open: sel.items.filter((i) => i.state === 'open').length,
    recently_closed: sel.items.filter((i) => i.state !== 'open').length,
    archived: sel.archive.length,
    too_old: (sel.tooOld ?? []).length,
    excluded: sel.excluded.length,
  };
}

export function selectionLine(sel: Selection, channels: number): string {
  const c = selectionCounts(sel);
  const closed = sel.closedCutoff ? `closed/merged since ${sel.closedCutoff.slice(0, 10)}` : 'closed/merged (--all)';
  const parts = [`Would import ${c.items} issue(s)/PR(s) into ${channels} channel(s) (${c.open} open + ${c.recently_closed} ${closed})`];
  if (c.archived) parts.push(`${c.archived} older closed -> Memory seed links only (${sel.seedCutoff ? `closed since ${sel.seedCutoff.slice(0, 10)}` : 'all, --seed-all'}), not posted`);
  if (c.too_old) parts.push(`${c.too_old} closed before the seed range, not sent (--seed-months N or --seed-all to include)`);
  if (c.excluded) parts.push(`${c.excluded} excluded as sensitive, never sent`);
  return parts.join('; ') + '.';
}

export function planSummary(plan: Plan, file?: string, sel?: Selection): string {
  const L: string[] = [];
  const sc = sel ? selectionCounts(sel) : undefined;
  const iss = sc ? sc.issues : plan.counts.issues;
  const prs = sc ? sc.prs : plan.counts.prs;
  L.push(`GitHub org ${plan.source.org}, since ${plan.since.slice(0, 10)}: ${plan.counts.repos} active repo(s), ${iss} issue(s), ${prs} PR(s), ${plan.counts.commits} commit(s)`);
  if (sc) L.push(`  of these ${sc.read}: ${sc.items} to post, ${sc.archived} older closed (Memory seed links), ${sc.too_old} older than the seed range, ${sc.excluded} excluded as sensitive`);
  L.push('');
  L.push(`Channels (${plan.channels.length}):`);
  for (const c of plan.channels) {
    const s = c.stats ? `${c.stats.issues} issues · ${c.stats.prs} PRs · ${c.stats.commits} commits` : '';
    L.push(`  ${pad('#' + c.name + (c.visibility === 'private' ? ' [private]' : ''), 18)}${pad(s, 36)}${c.repos.map((r) => r.split('/')[1] ?? r).join(', ') || '-'}`);
  }
  L.push('');
  L.push('People:');
  for (const p of plan.people.filter((x) => x.invite !== false)) {
    L.push(`  ${pad(p.github_login, 18)}${pad(p.name, 18)}${p.is_admin ? '[admin] ' : ''}${p.role ?? ''}${p.channels?.length ? `  -> ${p.channels.map((c) => '#' + c).join(' ')}` : ''}`);
  }
  const later = plan.people.filter((x) => x.invite === false);
  if (later.length) L.push(`  not invited (occasional; set "invite": true in the plan to include): ${later.map((p) => p.github_login).join(', ')}`);
  if (plan.bots.length) L.push(`Bots (never invited): ${plan.bots.join(', ')}`);
  if (plan.unlinked_commit_authors?.length) L.push(`Commit authors without a GitHub login (map by hand if they matter): ${plan.unlinked_commit_authors.join(', ')}`);
  if (file) {
    L.push('');
    L.push(`Plan written to ${file}. Nothing was changed on GitHub or the hub.`);
    L.push(`Edit it (channel names, which repos go where, "visibility": "private" for members-only channels,`);
    L.push(`people's "channels" (their membership) and "role", names, emails, invite true/false), then:`);
    L.push(`Note: the hub widens access compared with GitHub: every hub member can read a "team" channel even if`);
    L.push(`they cannot see that repo on GitHub. Mark channels of private repos "private" and list their members.`);
    L.push(`  ach admin import github --org ${plan.source.org} --plan ${file}`);
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ commands

export interface CmdIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  exec?: Exec;
  fetch?: import('./client.js').FetchLike;
  now?: () => number;
}

function sv(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

/** `ach admin import github` */
export async function importGithub(values: Record<string, unknown>, positionals: string[], io: CmdIo, admin: () => Client): Promise<number> {
  if (positionals[0] !== 'github') throw new ImportError('usage: ach admin import github --org <org> [--since 60d] [--plan plan.json] [--out plan.json] [--dry-run] [--closed-days 7 | --all] [--exclude a,b | --no-exclude]');
  const exec = io.exec ?? makeExec(io.env);
  const now = io.now?.() ?? Date.now();
  const planFile = sv(values.plan);
  let plan: Plan | undefined = planFile ? readPlan(resolve(io.cwd, planFile)) : undefined;
  const org = sv(values.org) ?? plan?.source?.org;
  if (!org || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(org)) throw new ImportError('import github: --org <org> is required');
  // read far enough back for the Memory seed range (default 6 months; --seed-all: everything)
  const seedCut = seedCutoff(values, now);
  const defaultSince = seedCut === '' ? '2008-01-01T00:00:00Z' : [parseSince('60d', now), seedCut].sort()[0];
  const since = sv(values.since) ? parseSince(sv(values.since), now) : plan?.since ? parseSince(plan.since, now) : defaultSince;
  const syncAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const log = (s: string) => io.err(s);

  let items: GhItem[];
  if (plan) {
    const repos = [...new Set(plan.channels.flatMap((c) => c.repos))];
    log(`reading ${repos.length} repo(s) from the plan since ${since.slice(0, 10)} with your gh login`);
    items = [];
    for (const full of repos) {
      const r = await fetchItems(exec, full, since, log);
      items.push(...r.issues, ...r.prs);
    }
  } else {
    const c = await collectGithub(exec, org, since, { log });
    plan = buildPlan(c, new Date(now));
    items = c.repos.flatMap((r) => [...r.issues, ...r.prs]);
  }

  const sel = selectItems(items, { exclude: excludeTerms(values), closedCutoff: closedCutoff(values, now), seedCutoff: seedCut });
  const counts = selectionCounts(sel);

  if (values['dry-run']) {
    const file = resolve(io.cwd, sv(values.out) ?? `ach-import-${org}.json`);
    if (!planFile || sv(values.out)) writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
    if (values.json) io.out(JSON.stringify({ plan, items: counts.items, counts, plan_file: file }, null, 2));
    else {
      io.out(planSummary(plan, file, sel));
      io.out(selectionLine(sel, plan.channels.length));
    }
    return 0;
  }

  if (sel.excluded.length) io.err(`${sel.excluded.length} item(s) excluded as sensitive (labels/title match: ${excludeTerms(values).join(', ')}); they are never sent. --exclude a,b or --no-exclude to change.`);
  const r = await pushToHub(admin(), `github:${org}`, { plan, items: sel.items, archive: sel.archive, stats: channelStats(plan), syncAt, since, ranges: importRanges(values) });
  (r as any).excluded = sel.excluded.length;
  if (values.json) {
    io.out(JSON.stringify(r, null, 2));
    return 0;
  }
  const c = r.counts;
  io.out(`channels: ${c.channels_created ?? 0} created, ${c.channels_updated ?? 0} updated`);
  io.out(`people: ${c.people_created ?? 0} created, ${c.people_matched ?? 0} matched${r.skipped.length ? `; not invited: ${r.skipped.join(', ')}` : ''}`);
  io.out(`issues/PRs: ${c.items_created ?? 0} new, ${c.items_updated ?? 0} updated, ${c.items_unchanged ?? 0} unchanged${c.items_unmapped ? ` (${c.items_unmapped} from unmapped repos went to #general)` : ''}`);
  io.out(`older closed: ${sel.archive.length} kept as Memory seed links (not posted)${sel.seedCutoff ? ` (seed range: since ${sel.seedCutoff.slice(0, 10)})` : ' (seed range: all)'}; older than the seed range: ${(sel.tooOld ?? []).length}; excluded as sensitive: ${sel.excluded.length}`);
  io.out('Access: everyone on the hub can read "team" channels, even repos they cannot see on GitHub; use "visibility": "private" + people "channels" in the plan for members-only channels.');
  io.out('Next: ach admin invite --feishu   (preview; add --yes to send)   or   ach admin invite --people <a,b> --yes   (print one-time links)');
  io.out(`Keep it current: ach admin sync github --org ${org} --every 5m   (or every 5 minutes from cron)`);
  return 0;
}

/** --every 5m / 30s / 1h -> milliseconds (at least 1 minute unless ACH_SYNC_MIN_MS allows less, for tests). */
export function parseEvery(v: string, env: NodeJS.ProcessEnv = {}): number {
  const m = /^(\d{1,5})(s|m|h)$/.exec(v.trim());
  if (!m) throw new ImportError(`--every: expected 30s, 5m or 1h, got "${v}"`);
  const ms = Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000);
  const min = Number(env.ACH_SYNC_MIN_MS ?? 60_000);
  if (ms < min) throw new ImportError(`--every: at least ${Math.round(min / 1000)}s`);
  return ms;
}

/**
 * `ach admin sync github [--every 5m [--runs N]]`: one sync, or a loop (a failed
 * run is reported and the loop goes on). The hub dedupes events, so a repeated
 * sync never notifies twice.
 */
export async function syncGithub(values: Record<string, unknown>, positionals: string[], io: CmdIo, admin: () => Client): Promise<number> {
  const every = sv(values.every);
  if (!every) return syncGithubOnce(values, positionals, io, admin);
  if (positionals[0] !== 'github') throw new ImportError('usage: ach admin sync github [--org <org>] [--every 5m]');
  const ms = parseEvery(every, io.env);
  const runs = sv(values.runs) ? Number(sv(values.runs)) : Infinity;
  if (!(runs >= 1)) throw new ImportError('--runs: expected a positive number');
  for (let i = 1; ; i++) {
    try {
      await syncGithubOnce(values, positionals, io, admin);
    } catch (e: any) {
      io.err(`sync github failed (will retry in ${every}): ${e?.message ?? e}`);
    }
    if (i >= runs) return 0;
    await new Promise((r) => setTimeout(r, ms));
  }
}

async function syncGithubOnce(values: Record<string, unknown>, positionals: string[], io: CmdIo, admin: () => Client): Promise<number> {
  if (positionals[0] !== 'github') throw new ImportError('usage: ach admin sync github [--org <org>]');
  const exec = io.exec ?? makeExec(io.env);
  const now = io.now?.() ?? Date.now();
  const a = admin();
  const st = await a.request<any>('GET', '/api/ach/admin/import/state');
  const sources = Object.keys(st?.sources ?? {}).filter((k) => k.startsWith('github:'));
  let org = sv(values.org);
  if (!org) {
    if (sources.length !== 1) throw new ImportError(sources.length ? `sync github: --org is required (imported: ${sources.map((s) => s.slice(7)).join(', ')})` : 'sync github: nothing imported yet; run `ach admin import github --org <org>` first');
    org = sources[0].slice(7);
  }
  const prev = st.sources?.[`github:${org}`];
  if (!prev?.last_sync) throw new ImportError(`sync github: ${org} was never imported; run \`ach admin import github --org ${org}\` first`);
  // 1 h overlap: an item updated during the last run is read again (idempotent)
  const since = sv(values.since) ? parseSince(sv(values.since), now) : new Date(Date.parse(prev.last_sync) - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const repos: string[] = [...new Set<string>((st.channels ?? []).filter((c: any) => !c.archived).flatMap((c: any) => c.repos ?? []))].filter((r) => r.toLowerCase().startsWith(org!.toLowerCase() + '/'));
  if (!repos.length) throw new ImportError(`sync github: no channel has ${org} repos mapped`);
  const items: GhItem[] = [];
  const releases: GhRelease[] = [];
  for (const full of repos) {
    const r = await fetchItems(exec, full, since);
    items.push(...r.issues, ...r.prs);
    releases.push(...(await fetchReleases(exec, full, since)));
  }
  // an item that closed since the last sync must still update its post (it
  // was open there): the cutoff is the earlier of the last sync and N days ago
  // the ranges saved by the import (or a wizard) apply unless flags override them
  const rv: Record<string, unknown> = { ...values };
  const saved = st?.ranges;
  if (saved) {
    if (rv['closed-days'] === undefined && rv['post-closed-days'] === undefined && !rv.all) rv['closed-days'] = String(saved.post_closed_days);
    if (rv['seed-months'] === undefined && !rv['seed-all']) {
      if (saved.seed_all) rv['seed-all'] = true;
      else rv['seed-months'] = String(saved.seed_months);
    }
  }
  const cut = closedCutoff(rv, now);
  const sel = selectItems(items, { exclude: excludeTerms(rv), closedCutoff: cut && since < cut ? since : cut, seedCutoff: seedCutoff(rv, now) });
  const syncAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const r = await pushToHub(a, `github:${org}`, { items: sel.items, archive: sel.archive, syncAt, since: prev.since || since, releases });
  const c = r.counts;
  if (values.json) io.out(JSON.stringify({ org, since, repos: repos.length, counts: c, archived: sel.archive.length, excluded: sel.excluded.length }, null, values.every ? 0 : 2));
  else io.out(`synced ${org} since ${since}: ${repos.length} repo(s); ${c.items_created ?? 0} new, ${c.items_updated ?? 0} updated, ${c.items_unchanged ?? 0} unchanged; ${c.releases ?? 0} release(s); ${sel.archive.length} older closed (Memory seed links only), ${sel.excluded.length} excluded as sensitive`);
  return 0;
}

// ------------------------------------------------------------------ invites

export function inviteMessage(name: string, link: string, workspace?: string, assigned?: number): string {
  // "AgentChannel (AgentChannel)" reads wrong: a workspace named like the product is left out
  const w = String(workspace ?? '').trim();
  const ws = w && !/agent\s*channel/i.test(w) ? ` (${w})` : '';
  // nothing assigned to this person on GitHub: do not promise "your items"
  const none = assigned === 0;
  return [
    none
      ? `${name}，你好：团队在用 AgentChannel${ws} 协作，你的频道已经在里面了（目前没有分给你的 GitHub 事项）。`
      : `${name}，你好：团队在用 AgentChannel${ws} 协作，你的频道和分给你的 GitHub 事项已经在里面了。`,
    `用下面这个一次性链接登录（24 小时内有效，只能用一次，之后浏览器会保持登录）：`,
    link,
    '',
    none
      ? `Hi ${name}: the team works in AgentChannel${ws}. Your channels are already there (nothing on GitHub is assigned to you yet).`
      : `Hi ${name}: the team works in AgentChannel${ws}. Your channels and the GitHub items assigned to you are already there.`,
    `Log in with this one-time link (valid 24 h, works once; your browser stays logged in afterwards).`,
  ].join('\n');
}

interface LarkHit { open_id: string; name: string; email: string }

async function larkAvailable(exec: Exec): Promise<boolean> {
  const r = await exec('lark-cli', ['--version']);
  return r.code === 0;
}

const LARK_SEARCH_SCOPE = 'contact:user:search';

/** The exact login that grants missing user scopes (lark-cli's own syntax; scopes add up across logins). */
export function larkScopeHint(scopes: string[] = [LARK_SEARCH_SCOPE]): string {
  return `lark-cli auth login --scope "${scopes.join(' ')}"`;
}

/** Missing scopes named in a lark-cli error (JSON `missing_scopes`, or the scope named in the text). */
export function larkMissingScopes(out: string): string[] {
  const found = new Set<string>();
  for (const chunk of [out, ...out.split('\n')]) {
    try {
      const j = JSON.parse(chunk);
      const walk = (v: any) => {
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
          if (k === 'missing_scopes' && Array.isArray(x)) {
            for (const sc of x) if (typeof sc === 'string') found.add(sc);
          } else walk(x);
        }
      };
      walk(j);
    } catch {
      /* not JSON */
    }
  }
  if (!found.size && /scope|permission|99991679|99991672|unauthori[sz]ed/i.test(out)) {
    for (const m of out.matchAll(/\b([a-z_]+:[a-z_]+(?::[a-z_]+)+)\b/g)) found.add(m[1]);
    if (!found.size && /scope/i.test(out)) found.add(LARK_SEARCH_SCOPE);
  }
  return [...found];
}

type LarkSearch = { hits: LarkHit[] } | { error: string; scopes: string[] };

async function larkSearch(exec: Exec, query: string): Promise<LarkSearch> {
  const r = await exec('lark-cli', ['contact', '+search-user', '--query', query, '--as', 'user', '--exclude-external-users', '--format', 'json']);
  if (r.code !== 0) {
    const text = `${r.stdout}\n${r.stderr}`;
    return { error: (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`, scopes: larkMissingScopes(text) };
  }
  try {
    const j = JSON.parse(r.stdout);
    const users = j?.data?.users ?? j?.users ?? [];
    return {
      hits: (Array.isArray(users) ? users : []).map((u: any) => ({
        open_id: String(u.open_id ?? ''),
        name: String(u.localized_name ?? u.name ?? ''),
        email: String(u.enterprise_email || u.email || ''),
      })).filter((u: LarkHit) => u.open_id),
    };
  } catch {
    return { error: 'unexpected lark-cli output', scopes: larkMissingScopes(r.stdout) };
  }
}

function searchFailed(x: { error: string; scopes: string[] }): { why: string; scopes?: string[] } {
  if (x.scopes.length) return { why: `lark-cli is missing scope ${x.scopes.join(', ')}`, scopes: x.scopes };
  return { why: `lark-cli search failed (${x.error}); check \`lark-cli auth status\`` };
}

/** github person -> Feishu open_id: stored mapping, else email, else exact name match. */
async function resolveFeishu(exec: Exec, p: any): Promise<{ open_id?: string; why: string; candidates?: LarkHit[]; scopes?: string[] }> {
  if (p.feishu_open_id) return { open_id: p.feishu_open_id, why: 'mapped' };
  const email = String(p.email ?? '').toLowerCase();
  if (email) {
    const r = await larkSearch(exec, email);
    if ('error' in r) return searchFailed(r);
    const exact = r.hits.filter((h) => h.email.toLowerCase() === email);
    if (exact.length === 1) return { open_id: exact[0].open_id, why: 'email' };
  }
  for (const q of [p.name, p.github_login].filter(Boolean)) {
    const r = await larkSearch(exec, q);
    if ('error' in r) return searchFailed(r);
    const hits = r.hits;
    const exact = hits.filter((h) => h.name.toLowerCase() === String(q).toLowerCase());
    if (exact.length === 1) return { open_id: exact[0].open_id, why: 'name' };
    if (hits.length > 1 || exact.length > 1) return { why: `ambiguous "${q}"`, candidates: hits.slice(0, 5) };
  }
  return { why: 'no Feishu match' };
}

/**
 * `ach admin invite --feishu [--people a,b] [--map login=ou_x ...] [--yes]`
 * `ach admin invite --people a,b --yes` (no Feishu: print the links to copy)
 * Without --yes nothing is minted or sent: the messages are previewed.
 */
export async function invitePeople(values: Record<string, unknown>, io: CmdIo, admin: () => Client): Promise<number> {
  const exec = io.exec ?? makeExec(io.env);
  const a = admin();
  const st = await a.request<any>('GET', '/api/ach/admin/import/state');
  const meRes = await a.request<any>('GET', '/api/ach/me').catch(() => null);
  const settings = await a.request<any>('GET', '/api/ach/settings').catch(() => null);
  const workspace: string | undefined = settings?.workspace_name || settings?.workspace || undefined;
  const want = (sv(values.people) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let people: any[] = (st?.people ?? []).filter((p: any) => !p.deactivated && p.id !== meRes?.id);
  if (want.length) {
    people = people.filter((p) => want.includes(String(p.github_login).toLowerCase()) || want.includes(String(p.name).toLowerCase()) || want.includes(String(p.email).toLowerCase()));
    const found = new Set(people.flatMap((p) => [String(p.github_login).toLowerCase(), String(p.name).toLowerCase(), String(p.email).toLowerCase()]));
    const missing = want.filter((w) => !found.has(w));
    if (missing.length) io.err(`not on the hub (import them first or check the spelling): ${missing.join(', ')}`);
  } else {
    people = people.filter((p) => p.github_login);
  }
  if (!people.length) throw new ImportError('invite: nobody to invite (import people first, or pass --people <login,...>)');
  const maps: Record<string, string> = {};
  for (const m of (Array.isArray(values.map) ? values.map : []) as string[]) {
    const [k, v] = m.split('=');
    if (!k || !/^ou_[A-Za-z0-9_-]+$/.test(v ?? '')) throw new ImportError(`--map ${m}: expected <github_login>=ou_...`);
    maps[k.toLowerCase()] = v;
  }
  for (const p of people) if (maps[String(p.github_login).toLowerCase()]) p.feishu_open_id = maps[String(p.github_login).toLowerCase()];

  const yes = !!values.yes;
  const feishu = !!values.feishu;
  const placeholder = '<one-time login link: minted when you run again with --yes>';
  let lark = false;
  if (feishu) {
    lark = await larkAvailable(exec);
    if (!lark) io.err('lark-cli is not installed or not on PATH: the links will be printed for you to send by hand.');
  }

  const plan: { p: any; open_id?: string; why: string; candidates?: LarkHit[]; scopes?: string[] }[] = [];
  let missingScopes: string[] | undefined;
  for (const p of people) {
    if (feishu && lark && !missingScopes) {
      const x = await resolveFeishu(exec, p);
      if (x.scopes) missingScopes = x.scopes;
      plan.push({ p, ...x });
    } else if (missingScopes) plan.push({ p, open_id: p.feishu_open_id || undefined, why: p.feishu_open_id ? 'mapped' : `lark-cli is missing scope ${missingScopes.join(', ')}` });
    else plan.push({ p, why: feishu ? 'no lark-cli' : 'manual' });
  }
  if (missingScopes) {
    io.err(`lark-cli cannot search Feishu contacts: your lark-cli login lacks the scope ${missingScopes.join(', ')}. Grant it, then run this again:`);
    io.err(`  ${larkScopeHint(missingScopes)}`);
  }

  const unresolved = plan.filter((x) => feishu && lark && !x.open_id);
  if (!yes) {
    io.out(feishu ? 'Preview (nothing minted or sent). Feishu DMs that would be sent:' : 'Preview (nothing minted). Links that would be printed:');
    for (const x of plan) {
      io.out('');
      io.out(`--- ${x.p.name} (${x.p.github_login || x.p.email || x.p.id})${x.open_id ? ` -> Feishu ${x.open_id} [${x.why}]` : feishu && lark ? ` -> NOT RESOLVED: ${x.why}` : ''}`);
      io.out(inviteMessage(x.p.name, placeholder, workspace, typeof x.p.assigned_open === 'number' ? x.p.assigned_open : undefined));
    }
    if (unresolved.length) {
      io.out('');
      io.out('Unresolved (add --map <github_login>=ou_xxx, or they get a printed link):');
      for (const x of unresolved) io.out(`  ${x.p.github_login}: ${x.why}${x.candidates?.length ? `; candidates: ${x.candidates.map((c) => `${c.name} ${c.email} ${c.open_id}`).join(' | ')}` : ''}`);
    }
    io.out('');
    io.out('Run again with --yes to mint the links' + (feishu ? ' and send the DMs.' : ' and print them.'));
    return 0;
  }

  const results: any[] = [];
  const newMaps: { github_login: string; feishu_open_id: string; match_only: true }[] = [];
  for (const x of plan) {
    const link = await a.adminUserLoginLink(x.p.id);
    const url = link.url.startsWith('http') ? link.url : `${a.hub}${link.path}`;
    const msg = inviteMessage(x.p.name, url, workspace, typeof x.p.assigned_open === 'number' ? x.p.assigned_open : undefined);
    if (feishu && lark && x.open_id) {
      const r = await exec('lark-cli', ['im', '+messages-send', '--user-id', x.open_id, '--text', msg, '--idempotency-key', `ach-inv-${x.p.id}-${link.expires_at.slice(0, 13)}`.slice(0, 50)]);
      if (r.code === 0) {
        results.push({ person: x.p.name, sent: 'feishu', open_id: x.open_id });
        io.out(`sent Feishu DM to ${x.p.name}`);
        if (x.p.github_login && x.why !== 'mapped') newMaps.push({ github_login: x.p.github_login, feishu_open_id: x.open_id, match_only: true });
        else if (x.p.github_login && maps[String(x.p.github_login).toLowerCase()]) newMaps.push({ github_login: x.p.github_login, feishu_open_id: x.open_id, match_only: true });
        continue;
      }
      io.err(`Feishu DM to ${x.p.name} failed (${r.stderr.trim().split('\n')[0] || r.code}); send the link by hand:`);
    }
    results.push({ person: x.p.name, sent: 'manual', url });
    io.out(`${x.p.name}: ${url}`);
  }
  // avatars: Feishu pictures of the people just messaged (fetched here, cached on the hub)
  const dmd = plan.filter((x) => results.some((r) => r.sent === 'feishu' && r.person === x.p.name));
  if (dmd.length) {
    const { syncFeishuAvatars } = await import('./avatars.js');
    await syncFeishuAvatars(a, dmd.map((x) => ({ id: x.p.id, name: x.p.name, email: x.p.email, feishu_open_id: x.open_id })), { exec, fetch: io.fetch, log: io.err });
  }
  if (newMaps.length) await a.request('POST', '/api/ach/admin/import/apply', { source: `github:${Object.keys(st?.sources ?? {})[0]?.slice(7) || 'manual'}`, plan: { people: newMaps } }).catch(() => undefined);
  if (values.json) io.out(JSON.stringify(results, null, 2));
  io.err('Each link works once and expires in 24 h; a new invite replaces the older link.');
  return 0;
}
