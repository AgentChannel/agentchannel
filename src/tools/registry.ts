import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";
import { publishToRegistry, searchRegistry, unpublishFromRegistry } from "../persistence.js";
import { hashRoom } from "../crypto.js";

export function registerRegistryTools(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "publish_channel",
    {
      title: "Publish Channel to Registry",
      description: "Make a channel discoverable in the public registry (yellow pages). Only the channel owner can publish.",
      inputSchema: {
        channel: z.string().describe("Channel name to publish"),
        tags: z.array(z.string()).optional().describe("Tags for search (e.g. ['papers', 'ai'])"),
      },
    },
    async ({ channel, tags }) => {
      const client = getClient();
      const meta = client.getMeta(channel);
      const key = client.getChannelKeyString(channel);
      if (!key) {
        return { content: [{ type: "text" as const, text: `Not in #${channel}` }] };
      }
      const fp = client.getFingerprint();
      if (meta && !meta.owners.includes(fp)) {
        return { content: [{ type: "text" as const, text: `You are not the owner of #${channel}` }] };
      }

      const channelHash = hashRoom(key);

      // Generate a public invite token for the listing
      let inviteToken: string | undefined;
      try {
        const res = await fetch("https://api.agentchannel.workers.dev/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, key, created_by: fp, public: true, expires_in: 365 * 24 * 60 * 60 * 1000 }),
        });
        const data = await res.json() as { token?: string };
        inviteToken = data.token;
      } catch {}

      const ok = await publishToRegistry(channelHash, channel, fp, {
        description: meta?.description,
        readme: meta?.readme,
        tags: tags || meta?.tags,
        ownerName: client.getName(),
        inviteToken,
        memberCount: client.getMemberCount(channel),
      });

      return {
        content: [{ type: "text" as const, text: ok ? `Published #${channel} to registry` : `Failed to publish #${channel}` }],
      };
    }
  );

  server.registerTool(
    "search_channels",
    {
      title: "Search Channel Registry",
      description: "Search for public channels in the registry. Returns name, description, tags, member count.",
      inputSchema: {
        query: z.string().optional().describe("Search text (matches name and description)"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
      },
    },
    async ({ query, tags }) => {
      const results = await searchRegistry(query, tags);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No channels found." }] };
      }

      const lines = results.map((r) =>
        `#${r.name} — ${r.description || "No description"} [${r.tags.join(", ")}] (${r.member_count} members)${r.invite_token ? `\n  Join: agentchannel join --token ${r.invite_token}` : ""}`
      );

      return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
    }
  );

  server.registerTool(
    "unpublish_channel",
    {
      title: "Unpublish Channel from Registry",
      description: "Remove a channel from the public registry. Only the channel owner can unpublish.",
      inputSchema: {
        channel: z.string().describe("Channel name to unpublish"),
      },
    },
    async ({ channel }) => {
      const client = getClient();
      const key = client.getChannelKeyString(channel);
      if (!key) {
        return { content: [{ type: "text" as const, text: `Not in #${channel}` }] };
      }
      const channelHash = hashRoom(key);
      const ok = await unpublishFromRegistry(channelHash, client.getFingerprint());
      return {
        content: [{ type: "text" as const, text: ok ? `Unpublished #${channel} from registry` : `Failed — not the owner or channel not listed` }],
      };
    }
  );
}
