import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { userInfo } from "node:os";
import type { ChannelConfig, WebhookConfig, HandoffConfig } from "./types.js";
import { validateSubchannelName, hashRoom, hashSub, legacyHashRoom, legacyHashSub } from "./crypto.js";

// Re-export identity for convenience
export { ensureIdentity } from "./identity.js";

const CONFIG_DIR = join(homedir(), ".agentchannel");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface DistillConfig {
  enabled: boolean;           // default true
  endpoint?: string;          // OpenAI-compatible API endpoint
  apiKey?: string;            // API key (or use env DISTILL_API_KEY)
  model?: string;             // model name (user's choice)
  baseUrl?: string;           // for ollama etc
  brainPath?: string;         // custom brain directory (default: ~/agentchannel/brain)
}

export interface AppConfig {
  name: string;
  channels: ChannelConfig[];
  muted: string[];
  permissions: Record<string, string[]>;
  webhooks?: WebhookConfig[];
  handoffs?: HandoffConfig[];
  distill?: DistillConfig;
}

const OFFICIAL_KEY = "agentchannel-public-2026";
// Official channel uses current (ACP-1 spec) hashing, not legacy — it was
// published post-migration with hashRoom(). Hardcoding channelHash here lets
// defaultConfig() + migration both land at the same location as the publisher.
const OFFICIAL_CHANNEL_HASH = hashRoom(OFFICIAL_KEY);
const OFFICIAL_CHANNELS = [
  { channel: "AgentChannel", key: OFFICIAL_KEY, channelHash: OFFICIAL_CHANNEL_HASH },
];

function defaultConfig(): AppConfig {
  return {
    name: userInfo().username,
    channels: OFFICIAL_CHANNELS,
    muted: [],
    permissions: {},
  };
}

// Migrate old "channel/sub" format to { channel, subchannel }
function migrateChannel(ch: { channel: string; subchannel?: string; key: string }): { channel: string; subchannel?: string; key: string } {
  if (!ch.subchannel && ch.channel.includes("/")) {
    const parts = ch.channel.split("/");
    return { channel: parts[0], subchannel: parts.slice(1).join("/"), key: ch.key };
  }
  return ch;
}

// Display label: #channel or #channel/subchannel
export function channelLabel(ch: { channel: string; subchannel?: string }): string {
  return ch.subchannel ? `#${ch.channel}/${ch.subchannel}` : `#${ch.channel}`;
}

// Full display: #channel/subchannel
export function channelFullLabel(ch: { channel: string; subchannel?: string }): string {
  return ch.subchannel ? `#${ch.channel}/${ch.subchannel}` : `#${ch.channel}`;
}

// Unique identifier for a channel/subchannel combo
export function channelId(ch: { channel: string; subchannel?: string }): string {
  return ch.subchannel ? `${ch.channel}/${ch.subchannel}` : ch.channel;
}

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_FILE)) return defaultConfig();
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const rawChannels = Array.isArray(data.channels) ? data.channels : [];
    // Migrate old "/" format and deduplicate
    const channels = rawChannels.map(migrateChannel);
    // Migrate: ensure every channel has a stable channelHash
    // Most pre-migration channels used legacy derivation (:epoch:0), preserve that for D1 compat.
    // BUT the official #AgentChannel was published post-migration with current hashRoom — any
    // existing legacy hash for it points to an empty row. Force-fix to the correct hash.
    for (const ch of channels) {
      const isOfficial = ch.key === OFFICIAL_KEY && ch.channel === "AgentChannel";
      if (isOfficial) {
        const correctHash = ch.subchannel ? hashSub(ch.key, ch.subchannel) : hashRoom(ch.key);
        if (ch.channelHash !== correctHash) ch.channelHash = correctHash;
      } else if (!ch.channelHash) {
        ch.channelHash = ch.subchannel ? legacyHashSub(ch.key, ch.subchannel) : legacyHashRoom(ch.key);
      }
    }
    // Ensure official channel is always present
    if (!channels.some((c: { channel: string; subchannel?: string }) => c.channel.toLowerCase() === "agentchannel" && !c.subchannel)) {
      for (const oc of OFFICIAL_CHANNELS) channels.push(oc);
    }
    return {
      name: data.name || userInfo().username,
      channels,
      muted: Array.isArray(data.muted) ? data.muted : [],
      permissions: data.permissions || {},
      webhooks: Array.isArray(data.webhooks) ? data.webhooks : [],
      handoffs: Array.isArray(data.handoffs) ? data.handoffs : [],
    };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: AppConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function addChannel(channel: string, key: string, subchannel?: string): void {
  if (subchannel && !validateSubchannelName(subchannel)) {
    throw new Error(`Invalid subchannel name "${subchannel}". Must match [a-zA-Z0-9._-]{1,64}`);
  }
  const config = loadConfig();
  const existing = config.channels.find((c) => c.channel === channel && c.subchannel === subchannel);
  if (existing) {
    existing.key = key;
    if (!existing.channelHash) {
      existing.channelHash = subchannel ? hashSub(key, subchannel) : hashRoom(key);
    }
  } else {
    const channelHash = subchannel ? hashSub(key, subchannel) : hashRoom(key);
    config.channels.push(subchannel ? { channel, subchannel, key, channelHash } : { channel, key, channelHash });
  }
  saveConfig(config);
}

export function removeChannel(channel: string, subchannel?: string): void {
  const config = loadConfig();
  if (subchannel) {
    // Remove only the specific subchannel
    config.channels = config.channels.filter((c) => !(c.channel === channel && c.subchannel === subchannel));
  } else {
    // Remove channel AND all its subchannels
    config.channels = config.channels.filter((c) => c.channel !== channel);
  }
  saveConfig(config);
}

export function setName(name: string): void {
  const config = loadConfig();
  config.name = name;
  saveConfig(config);
}

export function getChannelKey(channel: string, subchannel?: string): string | undefined {
  const config = loadConfig();
  return config.channels.find((c) => c.channel === channel && c.subchannel === subchannel)?.key;
}

export function muteChannel(channel: string): void {
  const config = loadConfig();
  if (!config.muted.includes(channel)) {
    config.muted.push(channel);
    saveConfig(config);
  }
}

export function unmuteChannel(channel: string): void {
  const config = loadConfig();
  config.muted = config.muted.filter((c) => c !== channel);
  saveConfig(config);
}

export function isMuted(channel: string): boolean {
  const config = loadConfig();
  return config.muted.includes(channel);
}

// ── Sync toggle ──────────────────────────────────────────

export function getSyncEnabled(channel: string, subchannel?: string): boolean {
  const config = loadConfig();
  const ch = config.channels.find((c) => c.channel === channel && c.subchannel === subchannel);
  if (!ch) return false;
  if (ch.sync !== undefined) return ch.sync;
  // Default: private channels sync ON, public channels sync OFF
  // For now treat all channels as private (sync ON) — public detection requires meta
  return true;
}

export function setSyncEnabled(channel: string, enabled: boolean, subchannel?: string): void {
  const config = loadConfig();
  const ch = config.channels.find((c) => c.channel === channel && c.subchannel === subchannel);
  if (ch) {
    ch.sync = enabled;
    saveConfig(config);
  }
}

// ── Epoch management ─────────────────────────────────────

export function getChannelEpoch(channel: string): number {
  const config = loadConfig();
  const ch = config.channels.find((c) => c.channel === channel && !c.subchannel);
  return ch?.epoch ?? 0;
}

export function getDistillConfig(): DistillConfig {
  const config = loadConfig();
  return config.distill ?? { enabled: true };
}

export function setDistillEnabled(enabled: boolean): void {
  const config = loadConfig();
  if (!config.distill) config.distill = { enabled };
  else config.distill.enabled = enabled;
  saveConfig(config);
}

export function updateChannelEpoch(channel: string, newKey: string, newEpoch: number): void {
  const config = loadConfig();
  // Update main channel + all its subchannels
  for (const ch of config.channels) {
    if (ch.channel === channel) {
      ch.key = newKey;
      ch.epoch = newEpoch;
    }
  }
  saveConfig(config);
}

export function getPermissions(user: string): string[] {
  const config = loadConfig();
  return config.permissions[user] || [];
}

// --- Webhook & Handoff management ---

export function addWebhook(wh: Omit<WebhookConfig, "id">): WebhookConfig {
  const config = loadConfig();
  if (!config.webhooks) config.webhooks = [];
  const entry: WebhookConfig = { id: crypto.randomUUID().slice(0, 8), ...wh };
  config.webhooks.push(entry);
  saveConfig(config);
  return entry;
}

export function addHandoff(hf: Omit<HandoffConfig, "id">): HandoffConfig {
  const config = loadConfig();
  if (!config.handoffs) config.handoffs = [];
  const entry: HandoffConfig = { id: crypto.randomUUID().slice(0, 8), ...hf };
  config.handoffs.push(entry);
  saveConfig(config);
  return entry;
}

export function listHooks(): { webhooks: WebhookConfig[]; handoffs: HandoffConfig[] } {
  const config = loadConfig();
  return { webhooks: config.webhooks || [], handoffs: config.handoffs || [] };
}

export function deleteHook(id: string): boolean {
  const config = loadConfig();
  const wLen = config.webhooks?.length || 0;
  const hLen = config.handoffs?.length || 0;
  if (config.webhooks) config.webhooks = config.webhooks.filter((w) => w.id !== id);
  if (config.handoffs) config.handoffs = config.handoffs.filter((h) => h.id !== id);
  const deleted = (config.webhooks?.length || 0) < wLen || (config.handoffs?.length || 0) < hLen;
  if (deleted) saveConfig(config);
  return deleted;
}
