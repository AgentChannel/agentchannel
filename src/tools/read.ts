import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function registerReadTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "read_messages",
    {
      title: "Read Messages",
      description: "Read recent messages from #channels or /subchannels. Use preview=true to get a compact list (saves tokens), then get_message to read full content.",
      inputSchema: {
        limit: z.number().optional().default(20).describe("Number of recent messages to return (default 20, max 100)"),
        channel: z.string().optional().describe("Filter by channel name"),
        subchannel: z.string().optional().describe("Filter by subchannel name"),
        preview: z.boolean().optional().default(true).describe("Default true: returns compact preview (id + sender + subject). Set false for full content. Use get_message(id) to expand individual messages."),
        tag: z.string().optional().describe("Filter by tag (e.g. 'bug', 'p0')"),
        mention_only: z.boolean().optional().default(false).describe("If true, only return messages that @mention you"),
      },
    },
    async ({ limit, channel, subchannel, preview, tag, mention_only }) => {
      const client = getClient();
      let messages = client.store.getMessages(Math.min(limit, 100));

      if (channel) {
        messages = messages.filter((m) => m.channel === channel);
      }
      if (subchannel) {
        messages = messages.filter((m) => m.subchannel === subchannel);
      }
      if (tag) {
        messages = messages.filter((m) => m.tags?.includes(tag));
      }
      if (mention_only) {
        const myName = client.memberName;
        messages = messages.filter((m) => m.content.includes(`@${myName}`));
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No messages yet." }],
        };
      }

      const myName = client.memberName;
      const formatted = messages
        .map((m) => {
          const time = new Date(m.timestamp).toLocaleTimeString();
          const mention = m.content.includes(`@${myName}`) ? " ⚠️[MENTION]" : "";
          if (m.type === "system") return `[${time}] ${m.content}`;

          const label = m.subchannel ? `#${m.channel}/${m.subchannel}` : `#${m.channel}`;
          const fp = m.senderKey ? `:${m.senderKey.slice(0, 4)}` : "";

          const retracted = m.retracted ? " ~~RETRACTED~~" : "";

          if (preview) {
            const subj = m.subject || "";
            const body = m.content.replace(/\n+/g, " ").trim();
            const bodyShort = body.length > 60 ? body.slice(0, 60) + "..." : body;
            const line = subj ? `${subj} — ${bodyShort}` : bodyShort;
            const tagStr = m.tags?.length ? ` [${m.tags.join(",")}]` : "";
            return `[${m.id}] [${time}] ${label} | @${m.sender}${fp}:${tagStr} ${line}${mention}${retracted}`;
          }

          const trust = m.trustLevel ? ` [${m.trustLevel.toUpperCase()}]` : "";
          return `[${time}] ${label} | @${m.sender}${fp}${trust}: ${m.content}${mention}${retracted}`;
        })
        .join("\n");

      client.store.markAsRead();

      // Check for pending desktop push notifications (from Tauri desktop app)
      let pushNotice = "";
      try {
        const notifPath = join(homedir(), ".agentchannel", "notifications.json");
        if (existsSync(notifPath)) {
          const raw = readFileSync(notifPath, "utf8");
          const pending = JSON.parse(raw) as Array<{ sender: string; channel: string; subchannel?: string; content: string; timestamp: number }>;
          if (pending.length > 0) {
            pushNotice = "\n\n--- PUSH NOTIFICATIONS (from desktop app) ---\n" +
              pending.map((n) => {
                const label = n.subchannel ? `#${n.channel} ##${n.subchannel}` : `#${n.channel}`;
                return `[MENTION] ${label} @${n.sender}: ${n.content.slice(0, 120)}`;
              }).join("\n");
            // Clear after delivering
            writeFileSync(notifPath, "[]", "utf8");
          }
        }
      } catch {
        // Desktop app not running or no notifications — skip
      }

      return {
        content: [{ type: "text" as const, text: formatted + pushNotice }],
      };
    }
  );
}
