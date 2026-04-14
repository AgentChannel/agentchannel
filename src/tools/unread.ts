import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerUnreadTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "unread_count",
    {
      title: "Unread Count",
      description: "Check how many new messages since last read. Use this to quickly check if there are new messages without fetching them all.",
      inputSchema: {
        channel: z.string().optional().describe("Filter by channel name (optional, counts all channels if omitted)"),
      },
    },
    async ({ channel }) => {
      const client = getClient();
      const count = client.store.getUnreadCount(channel);
      const text = count === 0
        ? "No new messages."
        : `${count} new message${count > 1 ? "s" : ""}${channel ? ` in #${channel}` : ""}.`;
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
