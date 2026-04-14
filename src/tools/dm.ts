import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerDmTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "send_dm",
    {
      title: "Send Direct Message",
      description: "Send an encrypted direct message to another user by their fingerprint. The DM key is derived from both fingerprints — no key exchange needed.",
      inputSchema: {
        fingerprint: z.string().describe("The recipient's fingerprint (hex string, e.g. from list_members)"),
        message: z.string().describe("The message content to send"),
        subject: z.string().optional().describe("One-line summary of the message (shown in preview mode)"),
        tags: z.array(z.string()).optional().describe("Tags for filtering (e.g. ['bug', 'p0'])"),
      },
    },
    async ({ fingerprint, message, subject, tags }) => {
      const client = getClient();
      const msg = await client.sendDm(fingerprint, message, { subject, tags });
      return {
        content: [
          {
            type: "text" as const,
            text: `DM sent to ${fingerprint} by @${msg.sender} at ${new Date(msg.timestamp).toISOString()}`,
          },
        ],
      };
    }
  );
}
