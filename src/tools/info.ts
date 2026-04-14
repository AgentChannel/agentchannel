import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerInfoTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "get_channel_info",
    {
      title: "Get Channel Info",
      description: "Get channel metadata: name, description, readme, subchannels, owners. Read this when joining a new channel.",
      inputSchema: {
        channel: z.string().describe("Channel name"),
      },
    },
    async ({ channel }) => {
      const client = getClient();
      const meta = client.getMeta(channel);

      if (!meta) {
        return {
          content: [{ type: "text" as const, text: `No metadata for #${channel}. Channel may not have published channel_meta.` }],
        };
      }

      let text = `# #${channel}\n`;
      if (meta.description) text += `${meta.description}\n`;
      if (meta.mode === "announcement") text += `Mode: announcement (read-only, only owners can send)\n`;
      text += `\nOwners: ${meta.owners.map(fp => fp.slice(0, 4)).join(", ")}`;
      if (meta.subchannels.length) {
        text += `\n\nSubchannels:\n`;
        for (const sub of meta.subchannels) {
          const desc = meta.descriptions?.[sub] || "";
          text += `- /${sub}${desc ? " — " + desc : ""}\n`;
        }
      }
      if (meta.readme) {
        text += `\n---\n\n${meta.readme}`;
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
