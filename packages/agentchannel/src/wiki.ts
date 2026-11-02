// Team Memory (formerly "wiki"): `ach memory pull/push` as
// Markdown files with YAML front matter, and the worker prompt's wiki block.
// The front matter is a small YAML subset (what the hub writes and what an
// agent is asked to add): scalars, inline lists, and a `figures:` list of maps.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Client, WikiContext } from './client.js';

export interface WikiFigure {
  id?: string;
  metric: string;
  value: string;
  unit?: string;
  env?: string;
  as_of: string;
  source: string;
  /** Exempt from staleness (a fact that does not go out of date). */
  stable?: string | boolean;
  /** When the source said it (orders rows of the same as_of date). */
  at?: string;
  /** The id of the row this one corrects (a correction supersedes it directly). */
  corrects?: string;
}

export interface WikiFile {
  slug: string;
  title: string;
  channel: string;
  topics: string[];
  version: number;
  figures: WikiFigure[];
  body: string;
  /** Optional per-page change note (front matter `note:`); the push note is the default. */
  note?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function scalar(v: string): string {
  const s = v.trim();
  if (s.startsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function inlineList(v: string): string[] {
  const s = v.trim();
  if (!s.startsWith('[')) return s ? [scalar(s)] : [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(String);
  } catch {
    /* plain YAML flow list */
  }
  return s
    .slice(1, -1)
    .split(',')
    .map((x) => scalar(x))
    .filter((x) => x.length);
}

/** Parse one wiki file (front matter + body). `name` is the file name (slug fallback). */
export function parseWikiFile(text: string, name = ''): WikiFile {
  const src = String(text).replace(/\r\n/g, '\n');
  const out: WikiFile = { slug: basename(name, '.md').toLowerCase(), title: '', channel: '', topics: [], version: 0, figures: [], body: src };
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { ...out, title: out.slug };
  out.body = src.slice(m[0].length);
  let inFigures = false;
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (cur) out.figures.push(cur as unknown as WikiFigure);
    cur = null;
  };
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    const cont = /^\s{3,}([A-Za-z_]+):\s*(.*)$/.exec(line);
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (inFigures && item) {
      flush();
      cur = { [item[1]]: scalar(item[2]) };
    } else if (inFigures && cont && cur) {
      cur[cont[1]] = scalar(cont[2]);
    } else if (top) {
      flush();
      inFigures = false;
      const [, k, v] = top;
      if (k === 'figures') inFigures = v.trim() !== '[]';
      else if (k === 'topics') out.topics = inlineList(v);
      else if (k === 'version') out.version = parseInt(scalar(v), 10) || 0;
      else if (k === 'slug') out.slug = scalar(v).toLowerCase();
      else if (k === 'title') out.title = scalar(v);
      else if (k === 'channel') out.channel = scalar(v).replace(/^#/, '');
      else if (k === 'note') out.note = scalar(v);
    } else {
      throw new Error(`${name || 'wiki file'}: cannot read front matter line: ${line}`);
    }
  }
  flush();
  if (!out.title) out.title = out.slug;
  return out;
}

const q = (s: unknown) => JSON.stringify(String(s ?? ''));

/** The inverse of parseWikiFile (what `ach memory pull` writes for a new page template). */
export function formatWikiFile(f: WikiFile): string {
  const lines = ['---', `slug: ${f.slug}`, `title: ${q(f.title)}`, `channel: ${q(f.channel)}`, `topics: [${f.topics.map(q).join(', ')}]`, `version: ${f.version}`];
  if (f.note !== undefined) lines.push(`note: ${q(f.note)}`);
  if (!f.figures.length) lines.push('figures: []');
  else {
    lines.push('figures:');
    for (const g of f.figures) {
      const keys = ['id', 'metric', 'value', 'unit', 'env', 'as_of', 'source', 'stable', 'at', 'corrects'] as const;
      let first = true;
      for (const k of keys) {
        if (g[k] === undefined) continue;
        lines.push(`${first ? '  - ' : '    '}${k}: ${k === 'id' ? g[k] : q(g[k])}`);
        first = false;
      }
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n${f.body.replace(/^\n+/, '')}`;
}

/** `ach memory pull <dir>`: every page (or one channel's) as <slug>.md. Returns the files written. */
export async function wikiPull(client: Client, dir: string, channel?: string): Promise<string[]> {
  const r = await client.wikiExport(channel);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of r.files ?? []) {
    if (!SLUG_RE.test(String(f.slug))) continue;
    const p = join(dir, `${f.slug}.md`);
    writeFileSync(p, f.content);
    written.push(p);
  }
  // a template for a new topic page (files starting with "_" are never pushed)
  writeFileSync(
    join(dir, '_new-page.md.example'),
    formatWikiFile({ slug: 'new-topic', title: 'New topic', channel: channel ?? '', topics: [], version: 0, figures: [], body: r.template ?? '' }),
  );
  return written;
}

/** Reads <dir>/*.md (not starting with "_") into a push request. New figure rows are those without an id. */
export function readWikiDir(dir: string): { pages: Record<string, unknown>[]; figures: Record<string, unknown>[] } {
  const pages: Record<string, unknown>[] = [];
  const figures: Record<string, unknown>[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name.startsWith('_') || name.startsWith('.')) continue;
    const f = parseWikiFile(readFileSync(join(dir, name), 'utf8'), name);
    if (!SLUG_RE.test(f.slug)) throw new Error(`${name}: slug "${f.slug}" must match ^[a-z0-9][a-z0-9-]{0,79}$`);
    pages.push({ slug: f.slug, title: f.title, channel: f.channel, topics: f.topics, body: f.body, base_version: f.version, ...(f.note ? { note: f.note } : {}) });
    for (const g of f.figures) {
      if (g.id) continue;
      const stable = g.stable === true || g.stable === 'true';
      figures.push({ topic: f.slug, metric: g.metric, value: g.value, unit: g.unit ?? '', env: g.env ?? '', as_of: g.as_of, source: g.source, ...(stable ? { stable: true } : {}), ...(g.at ? { at: g.at } : {}), ...(g.corrects ? { corrects: g.corrects } : {}) });
    }
  }
  return { pages, figures };
}

/** `ach memory push <dir> --note`: only changed pages get a new version (the hub compares). Per-page `note:` in front matter overrides the push note for that page. */
export async function wikiPush(client: Client, dir: string, note: string) {
  const req = readWikiDir(dir);
  return client.wikiPush({ ...req, note });
}

// ---------------------------------------------------------------- worker prompt

/** ~1k tokens. The hub already trims to this; the runner enforces it again. */
export const WIKI_PROMPT_CHARS = 4000;

/**
 * The Memory part of a worker prompt, layered and trimmed by priority (the hub
 * already trims; the runner enforces it again): 1. decisions confirmed by
 * people are trusted lines ("follow by default"); 2. current figures, 3.
 * lessons, 4. a few lines of the team overview go into the untrusted data
 * block, each with its usage wording (agent-recorded decisions: "verify first";
 * figures: "as of … (env)"; overview: "background only"; old volatile items:
 * "may be outdated, verify").
 */
export function wikiPromptParts(w: WikiContext | null | undefined, max = WIKI_PROMPT_CHARS): { trusted: string[]; data: Record<string, unknown> | null } {
  if (!w) return { trusted: [], data: null };
  let left = max;
  // decisions first but at most half the budget, so figures and lessons always get room
  const fit = <T>(list: T[] | undefined, size: (x: T) => number, cap = Infinity): T[] => {
    const out: T[] = [];
    let used = 0;
    for (const x of Array.isArray(list) ? list : []) {
      const n = size(x);
      if (n > left || used + n > cap) continue;
      left -= n;
      used += n;
      out.push(x);
    }
    return out;
  };
  const all = Array.isArray(w.decisions) ? w.decisions : [];
  const human = fit(all.filter((d) => d.human_confirmed !== false), (d) => String(d.text).length + 80, max / 2);
  const agentMade = fit(all.filter((d) => d.human_confirmed === false), (d) => String(d.text).length + 80, max / 2 - (max - left));
  const figures = fit(w.figures, (f) => JSON.stringify(f).length, max * 0.3);
  const lessons = fit(w.lessons, (l) => JSON.stringify(l).length);
  const overview = fit(w.overview, (l) => String(l).length + 4);
  const trusted = human.length
    ? [
        'Team decisions confirmed by people (team Memory; follow them by default):',
        ...human.map((d) => `- ${JSON.stringify(String(d.text))}${d.decider ? ` (confirmed by ${JSON.stringify(String(d.decider))}` : ' ('}${d.as_of ? `, as of ${d.as_of}` : ''})${d.url ? ` ${d.url}` : ''}`),
        '',
      ]
    : [];
  const use = {
    decisions_recorded: 'recorded by an agent from evidence, not confirmed by a person: verify first',
    figures: 'current value as of the date shown (env if given); stale: true means it may be outdated, verify',
    lessons: 'agent-written lessons: verify first',
    overview: 'team overview: background only',
  };
  const any = agentMade.length || figures.length || lessons.length || overview.length;
  const data = any
    ? {
        use,
        ...(agentMade.length ? { decisions_recorded: agentMade.map((d) => ({ text: d.text, as_of: d.as_of, url: d.url })) } : {}),
        figures,
        lessons,
        ...(overview.length ? { overview } : {}),
        pages: (w.pages ?? []).map((p) => ({ slug: p.slug, title: p.title })),
      }
    : null;
  return { trusted, data };
}
