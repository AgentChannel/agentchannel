import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerRetractTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "retract_message",
    {
      title: "Retract Message",
      description:
        "Retract (delete) one of your own messages within 24 hours. " +
        "The message will be struck through in the channel view. " +
        "This does NOT undo any webhook/hook side effects that already fired.",
      inputSchema: {
        message_id: z.string().describe("ID of the message to retract"),
        reason: z.string().optional().describe("Optional reason for retraction"),
      },
    },
    async ({ message_id, reason }) => {
      const client = getClient();
      try {
        await client.retractMessage(message_id, undefined, reason);
        return {
          content: [{ type: "text" as const, text: `Message ${message_id} retracted. Others will see it struck through.` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Retraction failed: ${err.message}` }],
        };
      }
    }
  );
}
