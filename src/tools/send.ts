import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerSendTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description: "Send an encrypted message to a #channel or ##subchannel.",
      inputSchema: {
        message: z.string().describe("The message content to send"),
        channel: z.string().describe("Target channel name (e.g. 'agentchannel')"),
        subchannel: z.string().optional().describe("Target subchannel name (e.g. 'product'). Omit to send to the main channel."),
        subject: z.string().optional().describe("One-line summary of the message (shown in preview mode)"),
        tags: z.array(z.string()).optional().describe("Tags for filtering (e.g. ['bug', 'p0'])"),
      },
    },
    async ({ message, channel, subchannel, subject, tags }) => {
      const client = getClient();
      // Auto-join subchannel if not already in it
      if (subchannel) {
        const parentKey = client.getChannelKeyString(channel);
        if (parentKey) {
          await client.joinChannel({ channel, subchannel, key: parentKey });
        }
      }
      const target = subchannel ? `${channel}/${subchannel}` : channel;
      const msg = await client.send(message, target, { subject, tags });
      const label = msg.subchannel ? `#${msg.channel} ##${msg.subchannel}` : `#${msg.channel}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to ${label} by @${msg.sender} at ${new Date(msg.timestamp).toISOString()}`,
          },
        ],
      };
    }
  );
}
