import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerChannelTools(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "join_channel",
    {
      title: "Join Channel",
      description: "Join a new #channel or /subchannel dynamically without restarting.",
      inputSchema: {
        channel: z.string().describe("Channel name to join"),
        key: z.string().describe("Channel key for encryption"),
        subchannel: z.string().optional().describe("Subchannel name (key is derived automatically)"),
      },
    },
    async ({ channel, key, subchannel }) => {
      const client = getClient();
      await client.joinChannel({ channel, subchannel, key });
      const label = subchannel ? `#${channel}/${subchannel}` : `#${channel}`;
      return {
        content: [{ type: "text" as const, text: `Joined ${label}` }],
      };
    }
  );

  server.registerTool(
    "leave_channel",
    {
      title: "Leave Channel",
      description: "Leave a #channel or /subchannel.",
      inputSchema: {
        channel: z.string().describe("Channel name to leave"),
        subchannel: z.string().optional().describe("Subchannel name to leave"),
      },
    },
    async ({ channel, subchannel }) => {
      const client = getClient();
      const target = subchannel ? `${channel}/${subchannel}` : channel;
      client.leaveChannel(target);
      const label = subchannel ? `#${channel}/${subchannel}` : `#${channel}`;
      return {
        content: [{ type: "text" as const, text: `Left ${label}` }],
      };
    }
  );

  server.registerTool(
    "list_channels",
    {
      title: "List Channels",
      description: "List all #channels and /subchannels you are currently in.",
    },
    async () => {
      const client = getClient();
      const channels = client.getChannels();
      if (channels.length === 0) {
        return { content: [{ type: "text" as const, text: "Not in any channels." }] };
      }
      const formatted = channels
        .map((c) => c.subchannel ? `#${c.channel}/${c.subchannel}` : `#${c.channel}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: `Channels:\n${formatted}` }],
      };
    }
  );
}
