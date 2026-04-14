import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";

export function registerIdentityTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "get_identity",
    {
      title: "Get Identity",
      description: "Get your own name, fingerprint, and joined channels. Use this to know who you are.",
    },
    async () => {
      const client = getClient();
      const channels = client.getChannels();
      const name = client.memberName;
      const fp = client.getFingerprint();
      const chList = channels.map((c) =>
        c.subchannel ? `#${c.channel} ##${c.subchannel}` : `#${c.channel}`
      ).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `Name: @${name}\nFingerprint: ${fp}\n\nChannels:\n${chList}`,
        }],
      };
    }
  );
}
