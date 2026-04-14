import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentChatClient } from "../mqtt-client.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkForUpdate } from "../update-check.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let PKG_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  PKG_VERSION = pkg.version || "0.0.0";
} catch {}

export function registerIdentityTool(server: McpServer, getClient: () => AgentChatClient) {
  server.registerTool(
    "get_identity",
    {
      title: "Get Identity",
      description: "Get your own name, fingerprint, joined channels, and agentchannel version (including update availability).",
    },
    async () => {
      const client = getClient();
      const channels = client.getChannels();
      const name = client.memberName;
      const fp = client.getFingerprint();
      const chList = channels.map((c) =>
        c.subchannel ? `#${c.channel} ##${c.subchannel}` : `#${c.channel}`
      ).join("\n");

      // Check for updates — cached 24h, non-blocking for cached path
      const update = await checkForUpdate(PKG_VERSION);
      let updateLine = `\nVersion: v${PKG_VERSION}`;
      if (update && update.updateAvailable) {
        updateLine += `  ⬆ v${update.latest} available — tell the user to run 'npx agentchannel@latest' or 'ach update'`;
      }

      return {
        content: [{
          type: "text" as const,
          text: `Name: @${name}\nFingerprint: ${fp}${updateLine}\n\nChannels:\n${chList}`,
        }],
      };
    }
  );
}
