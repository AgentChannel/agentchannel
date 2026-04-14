import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readTopic, listTopics, readBrainFile, readChannelSynthesis, getBrainDir, searchBrain } from "../brain.js";
import { getDistillStatus } from "../distill.js";

export function registerBrainTools(server: McpServer) {
  server.registerTool(
    "brain_query",
    {
      title: "Query Brain",
      description:
        "Search the local brain (knowledge base built by distill) for information about a topic. " +
        "Returns relevant topic pages and synthesis. Use this to recall decisions, concepts, or context from past channel discussions.",
      inputSchema: {
        query: z.string().describe("What to search for (e.g. 'epoch rotation', 'HKDF', 'what did we decide about auth')"),
      },
    },
    async ({ query }) => {
      // Fast search via MiniSearch (prefix + fuzzy matching)
      const hits = searchBrain(query, 5);

      if (hits.length === 0) {
        return { content: [{ type: "text" as const, text: `No brain entries found for "${query}". Brain may not have been distilled yet, or this topic hasn't been discussed.` }] };
      }

      // Return top 3 full pages, capped at ~3000 tokens
      let result = `## Brain: ${query}\n\n`;
      let totalLen = 0;
      let shown = 0;
      for (const hit of hits) {
        const content = readTopic(hit.slug);
        if (!content) continue;
        if (totalLen + content.length > 12000) break;
        result += `### ${hit.slug}\n\n${content}\n\n---\n\n`;
        totalLen += content.length;
        shown++;
      }

      if (hits.length > shown) {
        result += `_${hits.length - shown} more matches: ${hits.slice(shown).map((h) => h.slug).join(", ")}_\n`;
      }

      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "brain_recent",
    {
      title: "Brain Recent",
      description:
        "Get recent events and updates from the brain timeline. " +
        "Use this to catch up on what happened while you were away.",
      inputSchema: {
        limit: z.number().optional().describe("Max entries to return (default: 20)"),
      },
    },
    async ({ limit }) => {
      const max = limit || 20;
      const timeline = readBrainFile("timeline/latest.md");

      if (!timeline || timeline.trim() === "# latest") {
        return { content: [{ type: "text" as const, text: "No timeline entries yet. Brain may not have been distilled yet." }] };
      }

      // Extract entries (lines starting with "- ")
      const entries = timeline.split("\n").filter((l) => l.startsWith("- ")).slice(0, max);

      const status = getDistillStatus();
      const lastRun = status.lastRun ? new Date(status.lastRun).toISOString() : "never";

      let result = `## Recent Events\n\n${entries.join("\n")}\n\n_Brain last updated: ${lastRun}, ${status.topicCount} topics_\n`;
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "brain_decide",
    {
      title: "Brain Decisions",
      description:
        "Look up decisions that were made about a specific topic. " +
        "Use this to recall why a particular choice was made.",
      inputSchema: {
        topic: z.string().describe("Topic to search decisions for (e.g. 'broker', 'kick', 'domain')"),
      },
    },
    async ({ topic }) => {
      const decisions = readBrainFile("decisions/latest.md");

      if (!decisions || decisions.trim() === "# latest") {
        return { content: [{ type: "text" as const, text: "No decisions recorded yet." }] };
      }

      const topicLower = topic.toLowerCase();
      // Split by ## headers and find matching sections
      const sections = decisions.split(/^## /m).filter(Boolean);
      const matches = sections.filter((s) => s.toLowerCase().includes(topicLower));

      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No decisions found about "${topic}".` }] };
      }

      const result = matches.map((s) => `## ${s}`).join("\n");
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.registerTool(
    "brain_status",
    {
      title: "Brain Status",
      description: "Show the current status of the brain and distill daemon.",
      inputSchema: {},
    },
    async () => {
      const status = getDistillStatus();
      const lastRun = status.lastRun ? new Date(status.lastRun).toISOString() : "never";
      const text = [
        `Distill: ${status.enabled ? "ON" : "OFF"}`,
        `Brain: ${status.brainDir}`,
        `Entities: ${status.topicCount}`,
        `Channels processed: ${status.channelsProcessed.join(", ") || "none"}`,
        `Last run: ${lastRun}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
