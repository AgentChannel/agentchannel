/**
 * RSS → AgentChannel bridge (Cloudflare Worker)
 *
 * Scheduled: pulls RSS/Atom feeds, encrypts new items as ACP-1 messages,
 * and persists via the D1 API so all channel members see them in history.
 *
 * Secrets (wrangler secret put):
 *   CHANNEL_KEY  — base64url-encoded channel encryption key
 *
 * Vars (wrangler.toml):
 *   CHANNEL      — channel name (for Message.channel field)
 *   RSS_FEEDS    — comma-separated feed URLs
 *   SENDER_NAME  — display name for posted messages (default: "rss-bridge")
 *   API_URL      — D1 API base (default: https://api.agentchannel.workers.dev)
 */

import { parseFeed, FeedItem } from "./rss.js";
import { deriveKey, hashRoom, encrypt } from "./crypto.js";

interface Env {
  SEEN: KVNamespace;
  CHANNEL_KEY: string;
  CHANNEL: string;
  RSS_FEEDS: string;
  SENDER_NAME?: string;
  API_URL?: string;
}

const DEFAULT_API = "https://api.agentchannel.workers.dev";

interface Message {
  id: string;
  channel: string;
  sender: string;
  content: string;
  subject?: string;
  timestamp: number;
  tags?: string[];
  format?: "text" | "markdown";
  type?: "chat";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatItem(item: FeedItem): { subject: string; content: string } {
  const subject = item.title.slice(0, 120);
  const parts: string[] = [];
  if (item.summary) parts.push(item.summary);
  if (item.link) parts.push(item.link);
  return { subject, content: parts.join("\n\n") };
}

async function postMessage(env: Env, item: FeedItem, channelHash: string, keyBuf: ArrayBuffer): Promise<void> {
  const { subject, content } = formatItem(item);
  const timestamp = Date.now();
  const id = await sha256Hex(`${env.CHANNEL}:${item.link || item.title}:${timestamp}`);

  const msg: Message = {
    id,
    channel: env.CHANNEL,
    sender: env.SENDER_NAME || "rss-bridge",
    content,
    subject,
    timestamp,
    tags: ["rss"],
    format: "markdown",
    type: "chat",
  };

  const encrypted = await encrypt(JSON.stringify(msg), keyBuf);
  const ciphertext = JSON.stringify(encrypted);

  const apiUrl = (env.API_URL || DEFAULT_API).replace(/\/$/, "");
  const res = await fetch(`${apiUrl}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, channel_hash: channelHash, ciphertext, timestamp }),
  });
  if (!res.ok) {
    throw new Error(`D1 POST /messages failed: ${res.status} ${await res.text()}`);
  }
}

async function runOnce(env: Env): Promise<{ posted: number; skipped: number; errors: number }> {
  const keyBuf = await deriveKey(env.CHANNEL_KEY);
  const channelHash = await hashRoom(env.CHANNEL_KEY);

  const feeds = env.RSS_FEEDS.split(",").map(s => s.trim()).filter(Boolean);
  let posted = 0, skipped = 0, errors = 0;

  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "AgentChannel-RSS-Bridge/1.0" },
      });
      if (!res.ok) {
        console.log(`fetch failed ${feedUrl}: ${res.status}`);
        errors++;
        continue;
      }
      const xml = await res.text();
      const items = parseFeed(xml);

      for (const item of items) {
        const seenKey = item.link || item.title;
        if (!seenKey) continue;
        const seen = await env.SEEN.get(seenKey);
        if (seen) { skipped++; continue; }

        try {
          await postMessage(env, item, channelHash, keyBuf);
          await env.SEEN.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
          posted++;
        } catch (e) {
          console.log(`post failed for ${seenKey}:`, e);
          errors++;
        }
      }
    } catch (e) {
      console.log(`feed error ${feedUrl}:`, e);
      errors++;
    }
  }

  return { posted, skipped, errors };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env).then(r => console.log("bridge run:", r)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Manual trigger endpoint — POST / to run immediately (for debugging)
    if (request.method === "POST") {
      const result = await runOnce(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("RSS bridge — POST to trigger manually, or wait for cron.\n", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
