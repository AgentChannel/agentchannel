import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerKickTools(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "remove_member",
    {
      title: "Remove Member",
      description:
        "Remove a member from a channel via cryptographic epoch rotation. " +
        "Only the channel owner can remove. The removed member will lose access to future messages. " +
        "By default, a notification is sent to the removed member.",
      inputSchema: {
        channel: z.string().describe("Channel name"),
        fingerprint: z.string().describe("Fingerprint of the member to remove"),
        reason: z.string().optional().describe("Optional reason shown to removed member"),
        silent: z.boolean().optional().describe("If true, do not notify the removed member (default: false)"),
      },
    },
    async ({ channel, fingerprint, reason, silent }) => {
      const client = getClient();
      try {
        await client.removeMember(channel, fingerprint, { silent, reason });
        const notif = silent ? " (silent — no notification sent)" : "";
        return {
          content: [{ type: "text" as const, text: `Removed ${fingerprint} from #${channel}. Channel key rotated.${notif}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Remove failed: ${err.message}` }],
        };
      }
    }
  );

  server.registerTool(
    "rotate_channel",
    {
      title: "Rotate Channel Key",
      description:
        "Manually rotate the channel encryption key without removing anyone. " +
        "Use for compliance requirements or suspected key compromise. " +
        "Only the channel owner can rotate.",
      inputSchema: {
        channel: z.string().describe("Channel name to rotate"),
      },
    },
    async ({ channel }) => {
      const client = getClient();
      try {
        await client.rotateChannel(channel);
        return {
          content: [{ type: "text" as const, text: `Channel #${channel} key rotated. All members will resubscribe automatically.` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Rotation failed: ${err.message}` }],
        };
      }
    }
  );
}
