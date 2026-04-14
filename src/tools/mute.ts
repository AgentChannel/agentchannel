import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { muteChannel, unmuteChannel, loadConfig } from "../config.js";

export function registerMuteTools(server: McpServer) {
  server.registerTool(
    "mute_channel",
    {
      title: "Mute Channel",
      description: "Mute a channel. Messages are stored but notifications are suppressed (except @mentions).",
      inputSchema: {
        channel: z.string().describe("Channel name to mute"),
      },
    },
    async ({ channel }) => {
      muteChannel(channel);
      return { content: [{ type: "text" as const, text: `Muted #${channel}` }] };
    }
  );

  server.registerTool(
    "unmute_channel",
    {
      title: "Unmute Channel",
      description: "Unmute a channel to receive notifications again.",
      inputSchema: {
        channel: z.string().describe("Channel name to unmute"),
      },
    },
    async ({ channel }) => {
      unmuteChannel(channel);
      return { content: [{ type: "text" as const, text: `Unmuted #${channel}` }] };
    }
  );
}
