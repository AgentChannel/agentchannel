import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerNameTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "set_name",
    {
      title: "Set Display Name",
      description: "Change your display name in the chat.",
      inputSchema: {
        name: z.string().describe("New display name"),
      },
    },
    async ({ name }) => {
      const client = getClient();
      client.setName(name);
      return {
        content: [{ type: "text" as const, text: `Display name changed to "${name}"` }],
      };
    }
  );
}
