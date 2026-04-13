/**
 * Brain — local knowledge base built by distill.
 *
 * Default location: ~/agentchannel/brain/ (configurable via distill.brainPath)
 *
 * Directory structure:
 *   brain/
 *   ├── index.md                ← topic directory + quick links
 *   ├── references.md           ← cross-channel topic references
 *   ├── timeline/
 *   │   ├── latest.md           ← rolling last 30 events
 *   │   └── YYYY-MM.md          ← monthly archive
 *   ├── decisions/
 *   │   ├── latest.md           ← rolling last 20 decisions
 *   │   └── YYYY-MM.md          ← monthly archive
 *   ├── topics/                 ← global, cross-channel
 *   │   ├── *.md
 *   │   └── archive/
 *   ├── channels/               ← per-channel synthesis
 *   │   └── {channel}/current.md
 *   └── views/                  ← per-agent view configs
 *       └── default.yaml
 *
 * Written ONLY by the distill daemon. All agents read-only.
 * Search powered by MiniSearch (in-memory, sub-millisecond).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BRAIN_DIR = join(homedir(), "agentchannel", "brain");

function resolveBrainDir(): string {
  // Read config to check for custom brain path
  try {
    const configPath = join(homedir(), ".agentchannel", "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.distill?.brainPath) return config.distill.brainPath;
    }
  } catch {}
  return DEFAULT_BRAIN_DIR;
}

export function getBrainDir(): string {
  return resolveBrainDir();
}

function dirs() {
  const brain = resolveBrainDir();
  return {
    brain,
    topics: join(brain, "topics"),
    archive: join(brain, "topics", "archive"),
    channels: join(brain, "channels"),
    views: join(brain, "views"),
  };
}

// ── Init ──────────────────────────────────────────────

export function ensureBrainDirs(): void {
  const d = dirs();
  const timelineDir = join(d.brain, "timeline");
  const decisionsDir = join(d.brain, "decisions");
  for (const dir of [d.brain, d.topics, d.archive, d.channels, d.views, timelineDir, decisionsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Top-level files
  for (const file of ["index.md", "references.md"]) {
    const path = join(d.brain, file);
    if (!existsSync(path)) writeFileSync(path, `# ${file.replace(".md", "")}\n\n`);
  }
  // latest.md in timeline/ and decisions/
  for (const sub of [timelineDir, decisionsDir]) {
    const latest = join(sub, "latest.md");
    if (!existsSync(latest)) writeFileSync(latest, `# latest\n\n`);
  }
}

// ── Topic pages ──────────────────────────────────────

export interface TopicFrontmatter {
  aliases: string[];
  sources: string[];        // channel names
  last_updated: string;     // ISO date
  created: string;
  update_count: number;
  ttl_days: number;
}

export function topicPath(slug: string): string {
  return join(dirs().topics, `${slug}.md`);
}

export function readTopic(slug: string): string | null {
  const path = topicPath(slug);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function writeTopic(slug: string, content: string): void {
  ensureBrainDirs();
  writeFileSync(topicPath(slug), content);
}

export function listTopics(): string[] {
  const d = dirs();
  if (!existsSync(d.topics)) return [];
  return readdirSync(d.topics)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

// ── Channel synthesis ─────────────────────────────────

export function channelSynthesisPath(channel: string): string {
  const dir = join(dirs().channels, channel);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "current.md");
}

export function readChannelSynthesis(channel: string): string | null {
  const path = channelSynthesisPath(channel);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function writeChannelSynthesis(channel: string, content: string): void {
  writeFileSync(channelSynthesisPath(channel), content);
}

// ── Top-level files ───────────────────────────────────

export function readBrainFile(name: string): string {
  const path = join(dirs().brain, name);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function writeBrainFile(name: string, content: string): void {
  ensureBrainDirs();
  writeFileSync(join(dirs().brain, name), content);
}

// ── Index management ──────────────────────────────────

export function updateIndex(entries: { question: string; slug: string; source: string }[]): void {
  const lines = ["# Brain Index\n"];
  // Group by first letter or domain
  for (const e of entries) {
    lines.push(`- ${e.question} → [${e.slug}](topics/${e.slug}.md) (from #${e.source})`);
  }
  lines.push("");
  writeBrainFile("index.md", lines.join("\n"));
}

// ── Timeline ──────────────────────────────────────────
// timeline/latest.md — rolling last 30 entries
// timeline/YYYY-MM.md — monthly archive

function timelineDir(): string { return join(resolveBrainDir(), "timeline"); }

export function appendTimeline(events: { date: string; channel: string; summary: string }[]): void {
  ensureBrainDirs();
  const dir = timelineDir();
  const latestPath = join(dir, "latest.md");

  // Append to monthly archive
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const monthPath = join(dir, `${month}.md`);
  const monthContent = existsSync(monthPath) ? readFileSync(monthPath, "utf8") : `# ${month}\n\n`;
  const newEntries = events.map((e) => `- **${e.date}** [#${e.channel}] ${e.summary}`);
  writeFileSync(monthPath, monthContent + newEntries.join("\n") + "\n");

  // Rebuild latest.md (last 30 entries from recent monthly files)
  const files = readdirSync(dir).filter((f) => f.match(/^\d{4}-\d{2}\.md$/)).sort().reverse();
  const allEntries: string[] = [];
  for (const file of files) {
    if (allEntries.length >= 30) break;
    const content = readFileSync(join(dir, file), "utf8");
    const entries = content.split("\n").filter((l) => l.startsWith("- "));
    allEntries.push(...entries);
  }
  writeFileSync(latestPath, "# Recent Events\n\n" + allEntries.slice(0, 30).join("\n") + "\n");
}

// ── Decisions ─────────────────────────────────────────
// decisions/latest.md — rolling last 20 decisions
// decisions/YYYY-MM.md — monthly archive

function decisionsDir(): string { return join(resolveBrainDir(), "decisions"); }

export function appendDecision(decision: { date: string; topic: string; summary: string; rationale: string; channel: string }): void {
  ensureBrainDirs();
  const dir = decisionsDir();

  // Append to monthly archive
  const month = decision.date.slice(0, 7); // YYYY-MM
  const monthPath = join(dir, `${month}.md`);
  const monthContent = existsSync(monthPath) ? readFileSync(monthPath, "utf8") : `# Decisions — ${month}\n\n`;
  const entry = `## ${decision.date} — ${decision.topic}\n\n${decision.summary}\n\n**Why:** ${decision.rationale}\n\n**Source:** #${decision.channel}\n\n`;
  writeFileSync(monthPath, monthContent + entry);

  // Rebuild latest.md (last 20 decisions from recent monthly files)
  const files = readdirSync(dir).filter((f) => f.match(/^\d{4}-\d{2}\.md$/)).sort().reverse();
  const allSections: string[] = [];
  for (const file of files) {
    if (allSections.length >= 20) break;
    const content = readFileSync(join(dir, file), "utf8");
    const sections = content.split(/^## /m).filter(Boolean).filter((s) => !s.startsWith("Decisions"));
    allSections.push(...sections.map((s) => `## ${s}`));
  }
  const latestPath = join(dir, "latest.md");
  writeFileSync(latestPath, "# Recent Decisions\n\n" + allSections.slice(0, 20).join("\n") + "\n");
}

// ── References ──────────────────────────────────────────────

export function updateReferences(refs: Record<string, string[]>): void {
  const lines = ["# Cross-Channel References\n"];
  for (const [entity, channels] of Object.entries(refs).sort()) {
    lines.push(`- **${entity}**: ${channels.map((c) => `#${c}`).join(", ")}`);
  }
  lines.push("");
  writeBrainFile("references.md", lines.join("\n"));
}

// ── View ──────────────────────────────────────────────

export interface View {
  name: string;
  channels: string[];
  interests: string[];
  exclude_channels?: string[];
  max_index_entries?: number;
}

export function readView(name: string): View | null {
  const path = join(dirs().views, `${name}.yaml`);
  if (!existsSync(path)) return null;
  // Simple YAML-like parser (no dependency needed for this format)
  const text = readFileSync(path, "utf8");
  const view: View = { name: "", channels: [], interests: [] };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) view.name = trimmed.slice(5).trim();
    if (trimmed.startsWith("- ") && text.indexOf("channels:") < text.indexOf(trimmed) && text.indexOf("interests:") > text.indexOf(trimmed)) {
      view.channels.push(trimmed.slice(2).trim());
    }
  }
  return view;
}

export function writeView(view: View): void {
  ensureBrainDirs();
  const lines = [
    `name: ${view.name}`,
    `channels:`,
    ...view.channels.map((c) => `  - ${c}`),
    `interests:`,
    ...view.interests.map((i) => `  - ${i}`),
  ];
  if (view.exclude_channels?.length) {
    lines.push(`exclude_channels:`);
    lines.push(...view.exclude_channels.map((c) => `  - ${c}`));
  }
  writeFileSync(join(dirs().views, `${view.name}.yaml`), lines.join("\n") + "\n");
}

// ── Search index (MiniSearch) ─────────────────────────

import MiniSearch from "minisearch";

let searchIndex: MiniSearch | null = null;

export function buildSearchIndex(): void {
  const slugs = listTopics();
  searchIndex = new MiniSearch({
    fields: ["slug", "content", "aliases"],
    storeFields: ["slug", "channels"],
    searchOptions: {
      boost: { slug: 3, aliases: 2, content: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });

  const docs: { id: string; slug: string; content: string; aliases: string; channels: string }[] = [];
  for (const slug of slugs) {
    const content = readTopic(slug);
    if (!content) continue;

    // Extract aliases from frontmatter
    const aliasMatch = content.match(/aliases:\s*\[([^\]]*)\]/);
    const aliases = aliasMatch ? aliasMatch[1] : "";

    // Extract sources from frontmatter
    const sourcesMatch = content.match(/sources:\s*\[([^\]]*)\]/);
    const channels = sourcesMatch ? sourcesMatch[1] : "";

    docs.push({ id: slug, slug, content, aliases, channels });
  }

  searchIndex.addAll(docs);
}

export function searchBrain(query: string, limit: number = 5): { slug: string; score: number; channels: string }[] {
  if (!searchIndex) buildSearchIndex();
  if (!searchIndex) return [];

  const results = searchIndex.search(query).slice(0, limit);
  return results.map((r) => ({
    slug: r.id,
    score: r.score,
    channels: (r as any).channels || "",
  }));
}
