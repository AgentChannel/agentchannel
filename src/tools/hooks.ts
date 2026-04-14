import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addWebhook, addHandoff, listHooks, deleteHook } from "../config.js";

export function registerHookTools(server: McpServer) {
  server.registerTool(
    "create_webhook",
    {
      title: "Create Webhook",
      description:
        "Register a webhook: when a matching message arrives in a channel, POST it to a URL. " +
        "Filter by tags and/or sender fingerprints. Messages must be signed to trigger webhooks.",
      inputSchema: {
        channel: z.string().describe("Channel to watch"),
        subchannel: z.string().optional().describe("Subchannel to watch (optional)"),
        tags: z.array(z.string()).optional().describe("Only trigger on messages with these tags"),
        senders: z.array(z.string()).optional().describe("Only trigger on messages from these fingerprints"),
        url: z.string().url().describe("URL to POST the message payload to"),
      },
    },
    async ({ channel, subchannel, tags, senders, url }) => {
      const wh = addWebhook({ channel, subchannel, tags, senders, url });
      return {
        content: [{
          type: "text" as const,
          text: `Webhook created (id: ${wh.id})\n` +
            `Channel: #${channel}${subchannel ? `/${subchannel}` : ""}\n` +
            `Tags: ${tags?.join(", ") || "any"}\n` +
            `Senders: ${senders?.join(", ") || "any signed"}\n` +
            `URL: ${url}`,
        }],
      };
    }
  );

  server.registerTool(
    "create_handoff",
    {
      title: "Create Handoff",
      description:
        "Register a handoff listener: when a matching message arrives, POST it to a URL and auto-reply with an ACK. " +
        "Use this for agent-to-agent task delegation. The receiver should send handoff-done or handoff-fail when finished. " +
        "Convention: always include a subject. On handoff-done, report usage (tokens, duration, model) in the message.",
      inputSchema: {
        channel: z.string().describe("Channel to watch for handoff requests"),
        subchannel: z.string().optional().describe("Subchannel to watch (optional)"),
        tags: z.array(z.string()).optional().describe("Trigger tags (default: any)"),
        senders: z.array(z.string()).optional().describe("Only accept handoffs from these fingerprints"),
        url: z.string().url().describe("URL to POST the handoff request to"),
        mode: z.enum(["ask", "auto"]).optional().describe("ask (default) = require approval before executing, auto = execute immediately"),
        output: z.string().optional().describe("Channel for ack/done replies (e.g. 'tasks/reviews'). Default: same channel as request"),
      },
    },
    async ({ channel, subchannel, tags, senders, url, mode, output }) => {
      const hf = addHandoff({ channel, subchannel, tags, senders, url, mode, output });
      return {
        content: [{
          type: "text" as const,
          text: `Handoff listener created (id: ${hf.id})\n` +
            `Channel: #${channel}${subchannel ? `/${subchannel}` : ""}\n` +
            `Tags: ${tags?.join(", ") || "any"}\n` +
            `Senders: ${senders?.join(", ") || "any signed"}\n` +
            `URL: ${url}\n` +
            `Mode: ${mode || "ask"}\n` +
            `Output: ${output || "same channel"}`,
        }],
      };
    }
  );

  server.registerTool(
    "list_hooks",
    {
      title: "List Hooks",
      description: "List all registered webhooks and handoff listeners.",
      inputSchema: {},
    },
    async () => {
      const { webhooks, handoffs } = listHooks();
      const lines: string[] = [];

      if (webhooks.length === 0 && handoffs.length === 0) {
        return { content: [{ type: "text" as const, text: "No hooks registered." }] };
      }

      if (webhooks.length > 0) {
        lines.push("## Webhooks");
        for (const w of webhooks) {
          lines.push(
            `- [${w.id}] #${w.channel}${w.subchannel ? `/${w.subchannel}` : ""} ` +
            `tags:${w.tags?.join(",") || "*"} senders:${w.senders?.join(",") || "*"} → ${w.url}`
          );
        }
      }

      if (handoffs.length > 0) {
        lines.push("## Handoffs");
        for (const h of handoffs) {
          lines.push(
            `- [${h.id}] #${h.channel}${h.subchannel ? `/${h.subchannel}` : ""} ` +
            `tags:${h.tags?.join(",") || "*"} senders:${h.senders?.join(",") || "*"} → ${h.url} (auto-ack)`
          );
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "delete_hook",
    {
      title: "Delete Hook",
      description: "Delete a webhook or handoff listener by its ID.",
      inputSchema: {
        id: z.string().describe("Hook ID to delete (from list_hooks)"),
      },
    },
    async ({ id }) => {
      const deleted = deleteHook(id);
      return {
        content: [{
          type: "text" as const,
          text: deleted ? `Hook ${id} deleted.` : `Hook ${id} not found.`,
        }],
      };
    }
  );
}
