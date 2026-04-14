import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerUpdateChannelTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "set_channel",
    {
      title: "Set Channel",
      description:
        "Set channel settings (description, readme, mode). Use this to configure a channel after creation or change settings later. " +
        "Only channel owners can set. Omit fields to keep their current value.",
      inputSchema: {
        channel: z.string().describe("Channel name to update"),
        description: z.string().optional().describe("Short description"),
        readme: z.string().optional().describe("Full markdown readme (shown at top of channel)"),
        mode: z.enum(["open", "announcement"]).optional().describe("open = everyone can send, announcement = only owners can send"),
      },
    },
    async ({ channel, description, readme, mode }) => {
      const client = getClient();
      const existing = client.getMeta(channel);
      const fp = client.getFingerprint();

      if (existing && !existing.owners.includes(fp)) {
        return {
          content: [{ type: "text" as const, text: `Only owners of #${channel} can update settings.` }],
        };
      }

      await client.publishMeta(channel, {
        name: existing?.name || channel,
        description: description ?? existing?.description,
        readme: readme ?? existing?.readme,
        subchannels: existing?.subchannels || [],
        descriptions: existing?.descriptions,
        owners: existing?.owners || [fp],
        created: existing?.created || Date.now(),
        public: existing?.public,
        listed: existing?.listed,
        tags: existing?.tags,
        mode: mode ?? existing?.mode,
      });

      const changes: string[] = [];
      if (description !== undefined) changes.push("description");
      if (readme !== undefined) changes.push("readme");
      if (mode !== undefined) changes.push(`mode → ${mode}`);

      return {
        content: [{
          type: "text" as const,
          text: `Updated #${channel}: ${changes.length ? changes.join(", ") : "no changes"}`,
        }],
      };
    }
  );
}
