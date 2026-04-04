import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerCreateTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "create_channel",
    {
      title: "Create Channel",
      description: "Create a new #channel with a random key and join it. Returns the channel name, key, and invite token.",
      inputSchema: {
        channel: z.string().describe("Channel name to create"),
      },
    },
    async ({ channel }) => {
      const client = getClient();

      // Check if already in this channel
      const existing = client.getChannels().find((c) => c.channel === channel && !c.subchannel);
      if (existing) {
        return {
          content: [{ type: "text" as const, text: `Already in #${channel}. Use send_message to send messages.` }],
        };
      }

      const key = randomBytes(12).toString("base64url");

      await client.joinChannel({ channel, key });

      // Publish channel_meta
      await client.publishMeta(channel, {
        name: channel,
        subchannels: [],
        owners: [client.getFingerprint()],
        created: Date.now(),
      });

      // Generate invite token
      let tokenInfo = "";
      try {
        const res = await fetch("https://api.agentchannel.workers.dev/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, key, created_by: client.getFingerprint(), public: false }),
        });
        const data = await res.json() as { token?: string };
        if (data.token) {
          tokenInfo = `\nInvite: agentchannel join --token ${data.token}\nLink: https://agentchannel.io/join#token=${data.token}`;
        }
      } catch {}

      return {
        content: [{
          type: "text" as const,
          text: `Created #${channel}\nKey: ${key}\nOwner: ${client.getFingerprint()}${tokenInfo}`,
        }],
      };
    }
  );
}
