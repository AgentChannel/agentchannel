/**
 * Distill Daemon — transforms channel messages into brain (local wiki).
 *
 * Subscribe = Distill = Grow. Always. No exceptions.
 *
 * Two-pass ingest:
 *   Pass 1 (no LLM): extract metadata skeleton from message fields
 *   Pass 2 (LLM): topic extraction, synthesis, conflict detection
 *
 * Single-writer: only one distill process writes to brain/.
 * Lockfile at ~/.agentchannel/distill/.lock prevents concurrent runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LocalStore } from "./local-store.js";
import { loadConfig, getDistillConfig, getChannelEpoch } from "./config.js";
import { fetchHistory } from "./persistence.js";
import { deriveKey, hashRoom, decrypt } from "./crypto.js";
import {
  ensureBrainDirs,
  writeTopic,
  readTopic,
  listTopics,
  writeChannelSynthesis,
  writeBrainFile,
  readBrainFile,
  updateReferences,
  getBrainDir,
  buildSearchIndex,
  appendTimeline,
  appendDecision,
} from "./brain.js";
import type { Message, EncryptedPayload } from "./types.js";

const DISTILL_DIR = join(homedir(), ".agentchannel", "distill");
const STATE_FILE = join(DISTILL_DIR, "state.json");
const LOCK_FILE = join(DISTILL_DIR, ".lock");
const LOG_FILE = join(DISTILL_DIR, "log.jsonl");

// ── State management ──────────────────────────────────

interface DistillState {
  last_processed: Record<string, number>; // channel -> timestamp
  last_run: number;
}

function ensureDistillDir(): void {
  if (!existsSync(DISTILL_DIR)) mkdirSync(DISTILL_DIR, { recursive: true });
}

function loadState(): DistillState {
  ensureDistillDir();
  if (!existsSync(STATE_FILE)) return { last_processed: {}, last_run: 0 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_processed: {}, last_run: 0 };
  }
}

function saveState(state: DistillState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function appendLog(entry: { timestamp: number; channel: string; action: string; details?: string }): void {
  ensureDistillDir();
  const line = JSON.stringify({ ...entry, ts: new Date(entry.timestamp).toISOString() });
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Lock ──────────────────────────────────────────────

function acquireLock(): boolean {
  ensureDistillDir();
  if (existsSync(LOCK_FILE)) {
    // Check if lock is stale (>10 min)
    try {
      const lockTime = parseInt(readFileSync(LOCK_FILE, "utf8"), 10);
      if (Date.now() - lockTime < 10 * 60 * 1000) return false;
    } catch {}
  }
  writeFileSync(LOCK_FILE, String(Date.now()));
  return true;
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// ── LLM interface ─────────────────────────────────────

interface LLMResponse {
  content: string;
}

function isAnthropicEndpoint(url: string): boolean {
  return url.includes("anthropic.com");
}

async function callLLM(prompt: string): Promise<string> {
  const config = getDistillConfig();
  const apiKey = config.apiKey || process.env.DISTILL_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  const model = config.model || (process.env.ANTHROPIC_API_KEY ? "claude-haiku-4-5-20251001" : "gpt-4o-mini");
  const baseUrl = config.baseUrl || config.endpoint || (process.env.ANTHROPIC_API_KEY ? "https://api.anthropic.com" : "https://api.openai.com");

  if (!apiKey) {
    throw new Error("No API key configured for distill. Set distill.apiKey in config, or DISTILL_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY env var.");
  }

  if (isAnthropicEndpoint(baseUrl)) {
    // Anthropic Messages API
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }
    const data = await res.json() as any;
    return data.content?.[0]?.text || "";
  } else {
    // OpenAI-compatible API (OpenAI, Ollama, local models, etc.)
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API error ${res.status}: ${text}`);
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || "";
  }
}

// ── Pass 1: Metadata extraction (no LLM) ─────────────

interface MessageBatch {
  channel: string;
  subchannel?: string;
  messages: Message[];
}

interface MetadataSkeleton {
  senders: Map<string, number>;       // name -> msg count
  tags: Map<string, number>;          // tag -> count
  topics: string[];                    // subjects from messages
  replyChains: string[][];            // chains of message IDs
  timeRange: { start: number; end: number };
}

function extractMetadata(messages: Message[]): MetadataSkeleton {
  const senders = new Map<string, number>();
  const tags = new Map<string, number>();
  const topics: string[] = [];
  const replyMap = new Map<string, string>(); // msg id -> parent id

  for (const msg of messages) {
    senders.set(msg.sender, (senders.get(msg.sender) || 0) + 1);
    if (msg.tags) {
      for (const tag of msg.tags) {
        tags.set(tag, (tags.get(tag) || 0) + 1);
      }
    }
    if (msg.subject) topics.push(msg.subject);
    if (msg.replyTo) replyMap.set(msg.id, msg.replyTo);
  }

  // Build reply chains
  const replyChains: string[][] = [];
  const visited = new Set<string>();
  for (const [id, parentId] of replyMap) {
    if (visited.has(id)) continue;
    const chain = [parentId, id];
    visited.add(id);
    replyChains.push(chain);
  }

  return {
    senders,
    tags,
    topics,
    replyChains,
    timeRange: {
      start: messages[0]?.timestamp || 0,
      end: messages[messages.length - 1]?.timestamp || 0,
    },
  };
}

// ── Pass 2: LLM synthesis ─────────────────────────────

async function synthesizeTopics(channel: string, messages: Message[], existingTopics: string[]): Promise<{
  topics: { slug: string; content: string }[];
  synthesis: string;
  timeline: { date: string; summary: string }[];
  decisions: { topic: string; summary: string; rationale: string }[];
}> {
  const msgTexts = messages.map((m) => {
    const date = new Date(m.timestamp).toISOString().slice(0, 10);
    const tags = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
    return `[${date}] @${m.sender}${tags}: ${m.content}`;
  }).join("\n\n");

  const existingList = existingTopics.length > 0
    ? `\nExisting topic pages (update if relevant, do not duplicate):\n${existingTopics.map((e) => `- ${e}`).join("\n")}`
    : "";

  const prompt = `You are a knowledge distillation agent. Analyze these messages from channel #${channel} and produce structured output.
${existingList}

Messages:
${msgTexts}

Respond with EXACTLY this JSON structure (no other text):
{
  "topics": [
    {
      "slug": "lowercase-hyphenated-name",
      "content": "Full markdown content for topic page including YAML frontmatter with aliases, sources, last_updated, created fields"
    }
  ],
  "synthesis": "A markdown summary of the key themes and activity in this batch of messages (2-4 paragraphs)",
  "timeline": [
    {"date": "YYYY-MM-DD", "summary": "One-line description of what happened"}
  ],
  "decisions": [
    {"topic": "short topic name", "summary": "what was decided", "rationale": "why"}
  ]
}

Rules:
- Only extract topics that are EXPLICITLY discussed, do not infer or speculate
- Topic slugs: lowercase, hyphenated, descriptive (e.g. "epoch-rotation", "hkdf-sha256")
- Topic content: include YAML frontmatter with aliases (alternative names), sources (channel names)
- Topic pages should be under 2000 tokens
- Synthesis: factual summary of the batch, not opinions
- Timeline: only significant events, not every message
- Decisions: only explicit decisions, not suggestions or proposals
- If no topics/decisions found, return empty arrays`;

  try {
    const response = await callLLM(prompt);
    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { topics: [], synthesis: "", timeline: [], decisions: [] };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    appendLog({ timestamp: Date.now(), channel, action: "llm_error", details: String(err) });
    return { topics: [], synthesis: "", timeline: [], decisions: [] };
  }
}

// ── Main distill loop ─────────────────────────────────

async function distillChannel(channel: string, subchannel: string | undefined, messages: Message[]): Promise<number> {
  if (messages.length === 0) return 0;

  const channelId = subchannel ? `${channel}/${subchannel}` : channel;

  // Pass 1: metadata
  const meta = extractMetadata(messages);
  appendLog({
    timestamp: Date.now(),
    channel: channelId,
    action: "pass1",
    details: `${messages.length} msgs, ${meta.senders.size} senders, ${meta.topics.length} topics`,
  });

  // Pass 2: LLM synthesis
  const existing = listTopics();
  const result = await synthesizeTopics(channelId, messages, existing);

  // Write topics
  for (const topic of result.topics) {
    const existingContent = readTopic(topic.slug);
    if (existingContent) {
      // Merge: LLM already knows about existing topics via prompt
      writeTopic(topic.slug, topic.content);
    } else {
      writeTopic(topic.slug, topic.content);
    }
    appendLog({ timestamp: Date.now(), channel: channelId, action: "topic", details: topic.slug });
  }

  // Write channel synthesis
  if (result.synthesis) {
    const header = `# #${channelId} — Current\n\nLast updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    writeChannelSynthesis(channelId, header + result.synthesis);
  }

  // Update timeline (monthly archive + latest.md)
  if (result.timeline.length > 0) {
    appendTimeline(result.timeline.map((t) => ({ ...t, channel: channelId })));
  }

  // Update decisions (monthly archive + latest.md)
  if (result.decisions.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    for (const d of result.decisions) {
      appendDecision({ date, topic: d.topic, summary: d.summary, rationale: d.rationale, channel: channelId });
    }
  }

  return result.topics.length;
}

// ── Rebuild index and xref ────────────────────────────

function rebuildIndex(): void {
  const topics = listTopics();
  const entries: { question: string; slug: string; source: string }[] = [];
  const xrefs: Record<string, string[]> = {};

  for (const slug of topics) {
    const content = readTopic(slug);
    if (!content) continue;

    // Extract sources from frontmatter
    const sourcesMatch = content.match(/sources:\s*\[([^\]]*)\]/);
    const sources = sourcesMatch
      ? sourcesMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, ""))
      : ["unknown"];

    // Use slug as question basis
    const title = slug.replace(/-/g, " ");
    entries.push({ question: `What is ${title}?`, slug, source: sources[0] || "unknown" });

    // Build xref
    xrefs[slug] = sources;
  }

  // Write index
  const lines = ["# Brain Index\n"];
  for (const e of entries.sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`- ${e.question} → [${e.slug}](topics/${e.slug}.md) (from #${e.source})`);
  }
  lines.push(`\n_${entries.length} topics, last rebuilt: ${new Date().toISOString().slice(0, 10)}_\n`);
  writeBrainFile("index.md", lines.join("\n"));

  // Write xref
  updateReferences(xrefs);
}

// ── Public API ────────────────────────────────────────

export async function runDistillOnce(): Promise<{ channels: number; topics: number }> {
  const distillConfig = getDistillConfig();
  if (!distillConfig.enabled) {
    return { channels: 0, topics: 0 };
  }

  if (!acquireLock()) {
    throw new Error("Another distill process is running. Remove ~/.agentchannel/distill/.lock if stale.");
  }

  try {
    ensureBrainDirs();
    const config = loadConfig();
    const state = loadState();
    const localStore = new LocalStore();
    let totalTopics = 0;
    let channelsProcessed = 0;

    for (const ch of config.channels) {
      if (ch.subchannel) continue; // Process main channels only, subchannels included via their parent

      const channelId = ch.channel;
      const since = state.last_processed[channelId] || 0;

      // Try local store first, fall back to archive
      let messages = localStore.readMessages(ch.channel, undefined, since);

      if (messages.length === 0) {
        // Fall back to cloud archive — decrypt ciphertext locally
        try {
          const hash = hashRoom(ch.key);
          const key = deriveKey(ch.key);
          const rows = await fetchHistory(hash, since, 200);
          for (const row of rows) {
            try {
              const encrypted = JSON.parse(row.ciphertext);
              const decrypted = decrypt(encrypted, key);
              const msg: Message = JSON.parse(decrypted);
              msg.channel = ch.channel;
              if (!msg.type) msg.type = "chat";
              if (msg.type === "channel_meta" || msg.type === "retraction") continue;
              messages.push(msg);
            } catch {}
          }
        } catch {}
      }

      if (messages.length === 0) continue;

      // Filter out system/meta messages
      messages = messages.filter((m) => m.type === "chat" || !m.type);

      const topicCount = await distillChannel(ch.channel, undefined, messages);
      totalTopics += topicCount;
      channelsProcessed++;

      // Update state
      const latestTimestamp = messages[messages.length - 1]?.timestamp || since;
      state.last_processed[channelId] = latestTimestamp;
    }

    // Rebuild global index, references, and search index
    if (totalTopics > 0) {
      rebuildIndex();
      buildSearchIndex();
    }

    state.last_run = Date.now();
    saveState(state);

    appendLog({
      timestamp: Date.now(),
      channel: "*",
      action: "complete",
      details: `${channelsProcessed} channels, ${totalTopics} topics`,
    });

    return { channels: channelsProcessed, topics: totalTopics };
  } finally {
    releaseLock();
  }
}

export async function runDistillWatch(intervalMs: number = 5 * 60 * 1000): Promise<never> {
  console.log(`Distill daemon started (interval: ${intervalMs / 1000}s). Brain: ${getBrainDir()}`);
  while (true) {
    try {
      const result = await runDistillOnce();
      if (result.topics > 0) {
        console.log(`Distilled ${result.topics} topics from ${result.channels} channels`);
      }
    } catch (err) {
      console.error("Distill error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function getDistillStatus(): {
  enabled: boolean;
  lastRun: number;
  brainDir: string;
  topicCount: number;
  channelsProcessed: string[];
} {
  const config = getDistillConfig();
  const state = loadState();
  const topics = listTopics();
  return {
    enabled: config.enabled,
    lastRun: state.last_run,
    brainDir: getBrainDir(),
    topicCount: topics.length,
    channelsProcessed: Object.keys(state.last_processed),
  };
}
