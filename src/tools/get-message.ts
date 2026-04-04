import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerGetMessageTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "get_message",
    {
      title: "Get Message",
      description: "Get the full content of a single message by ID. Use read_messages(preview=true) first to get message IDs.",
      inputSchema: {
        id: z.string().describe("Message ID from read_messages preview"),
      },
    },
    async ({ id }) => {
      const client = getClient();
      const msg = client.store.getMessageById(id);

      if (!msg) {
        return {
          content: [{ type: "text" as const, text: `Message ${id} not found.` }],
        };
      }

      const time = new Date(msg.timestamp).toLocaleTimeString();
      const trust = msg.trustLevel ? ` [${msg.trustLevel.toUpperCase()}]` : "";
      const fp = msg.senderKey ? `:${msg.senderKey.slice(0, 4)}` : "";
      const label = msg.subchannel ? `#${msg.channel} ##${msg.subchannel}` : `#${msg.channel}`;
      const text = `[${time}] ${label} | @${msg.sender}${fp}${trust}:\n\n${msg.content}`;

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
