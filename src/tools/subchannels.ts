import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";
import { validateSubchannelName } from "../crypto.js";

export function registerSubchannelTools(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "add_subchannel",
    {
      title: "Add Subchannel",
      description:
        "Add a subchannel under an existing channel. Only channel owners can add. " +
        "Subchannel names must match [a-zA-Z0-9._-]{1,64}. " +
        "Other members' clients will auto-join when they receive the updated channel meta.",
      inputSchema: {
        channel: z.string().describe("Parent channel name"),
        subchannel: z.string().describe("Subchannel name (no leading slash)"),
        description: z.string().optional().describe("Short description for the subchannel"),
      },
    },
    async ({ channel, subchannel, description }) => {
      if (!validateSubchannelName(subchannel)) {
        return { content: [{ type: "text" as const, text: `Invalid subchannel name "${subchannel}". Must match [a-zA-Z0-9._-]{1,64}.` }] };
      }
      const client = getClient();
      const existing = client.getMeta(channel);
      const fp = client.getFingerprint();

      if (!existing) {
        return { content: [{ type: "text" as const, text: `#${channel} has no meta yet. Only channel owners can add subchannels; the owner must first publish meta via set_channel.` }] };
      }
      if (!existing.owners.includes(fp)) {
        return { content: [{ type: "text" as const, text: `Only owners of #${channel} can add subchannels.` }] };
      }

      const subs = [...(existing.subchannels || [])];
      if (subs.includes(subchannel)) {
        return { content: [{ type: "text" as const, text: `#${channel}/${subchannel} already exists.` }] };
      }
      subs.push(subchannel);

      const descriptions = { ...(existing.descriptions || {}) };
      if (description) descriptions[subchannel] = description;

      await client.publishMeta(channel, {
        ...existing,
        subchannels: subs,
        descriptions,
      });

      return { content: [{ type: "text" as const, text: `Added subchannel #${channel}/${subchannel}` + (description ? ` — ${description}` : "") }] };
    }
  );

  server.registerTool(
    "remove_subchannel",
    {
      title: "Remove Subchannel",
      description:
        "Remove a subchannel from a channel. Only channel owners can remove. " +
        "Other members' clients will auto-leave when they receive the updated channel meta. " +
        "Existing messages in the subchannel remain in D1 history but become inaccessible through the UI.",
      inputSchema: {
        channel: z.string().describe("Parent channel name"),
        subchannel: z.string().describe("Subchannel name to remove"),
      },
    },
    async ({ channel, subchannel }) => {
      const client = getClient();
      const existing = client.getMeta(channel);
      const fp = client.getFingerprint();

      if (!existing) {
        return { content: [{ type: "text" as const, text: `#${channel} has no meta yet.` }] };
      }
      if (!existing.owners.includes(fp)) {
        return { content: [{ type: "text" as const, text: `Only owners of #${channel} can remove subchannels.` }] };
      }

      const subs = existing.subchannels || [];
      if (!subs.includes(subchannel)) {
        return { content: [{ type: "text" as const, text: `#${channel}/${subchannel} does not exist.` }] };
      }

      const newSubs = subs.filter((s) => s !== subchannel);
      const descriptions = { ...(existing.descriptions || {}) };
      delete descriptions[subchannel];

      await client.publishMeta(channel, {
        ...existing,
        subchannels: newSubs,
        descriptions,
      });

      return { content: [{ type: "text" as const, text: `Removed subchannel #${channel}/${subchannel}. Other members' clients will auto-leave on next meta sync.` }] };
    }
  );
}
