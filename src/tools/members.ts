import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerMembersTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "list_members",
    {
      title: "List Members",
      description: "List members in a #channel or #channel/subchannel with last active time and fingerprint.",
      inputSchema: {
        channel: z.string().optional().describe("Channel name (optional, shows all if omitted)"),
        subchannel: z.string().optional().describe("Subchannel name"),
      },
    },
    async ({ channel, subchannel }) => {
      const client = getClient();
      const key = subchannel && channel ? `${channel}/${subchannel}` : channel;
      const members = client.store.getMembers(key);

      if (members.length === 0) {
        const label = subchannel ? `#${channel}/${subchannel}` : channel ? `#${channel}` : "any channel";
        return {
          content: [{ type: "text" as const, text: `No members in ${label}.` }],
        };
      }

      const formatted = members
        .map((m) => {
          const active = client.store.formatLastActive(m.lastActive);
          const label = m.subchannel ? `#${m.channel}/${m.subchannel}` : `#${m.channel}`;
          const fp = m.fingerprint ? `:${m.fingerprint.slice(0, 4)}` : "";
          return `- @${m.name}${fp} in ${label} (active ${active})`;
        })
        .join("\n");

      return {
        content: [{ type: "text" as const, text: `Members:\n${formatted}` }],
      };
    }
  );
}
