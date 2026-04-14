import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { deriveKey, hashRoom, decrypt } from "./crypto.js";
import type { EncryptedPayload, Message } from "./types.js";

const MAX_HISTORY = 200;

// Resolve the ui/ directory relative to this file's location
// In dist/web.js the ui/ dir is at ../ui relative to dist/
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const UI_DIR = join(__dirname, "..", "ui");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStaticFile(filePath: string): { body: string | Buffer; contentType: string } | null {
  if (!existsSync(filePath)) return null;
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const body = readFileSync(filePath);
  return { body, contentType };
}

export function startWebUI(config: { name: string; channels: { channel: string; key: string; subchannel?: string; channelHash?: string }[]; version?: string; fingerprint?: string }, port: number = 1024): void {
  const msgHistory: Message[] = [];
  const channelStates = config.channels.map((ch) => ({
    channel: ch.channel,
    key: deriveKey(ch.key),
    hash: hashRoom(ch.key),
  }));

  const mqttClient = mqtt.connect("mqtt://broker.agentchannel.io:1883");
  mqttClient.on("connect", () => {
    for (const cs of channelStates) mqttClient.subscribe(`ac/1/${cs.hash}`);
  });

  mqttClient.on("message", (_topic, payload) => {
    for (const cs of channelStates) {
      if (_topic === `ac/1/${cs.hash}`) {
        try {
          const encrypted: EncryptedPayload = JSON.parse(payload.toString());
          const decrypted = decrypt(encrypted, cs.key);
          const msg: Message = JSON.parse(decrypted);
          msg.channel = cs.channel;
          msgHistory.push(msg);
          if (msgHistory.length > MAX_HISTORY) msgHistory.shift();
        } catch {}
      }
    }
  });

  // Build the config injection script
  function buildConfigScript(targetChannel?: string): string {
    const configJson = JSON.stringify(config);
    let script = `<script>window.__AC_CONFIG__=${configJson};`;
    if (targetChannel) {
      script += `window.__AC_INITIAL_CHANNEL__=${JSON.stringify(targetChannel)};`;
    }
    script += `</script>`;
    return script;
  }

  // Read index.html template once
  const indexHtmlPath = join(UI_DIR, "index.html");

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = reqUrl.pathname;

    // API endpoints
    if (pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(config));
      return;
    }

    if (pathname === "/api/messages" || pathname === "/api/history") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(msgHistory));
      return;
    }

    if (pathname === "/api/identity") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ name: config.name, fingerprint: config.fingerprint }));
      return;
    }

    if (pathname === "/api/members") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      // Members are tracked client-side via cloud API; return empty for now
      res.end(JSON.stringify([]));
      return;
    }

    if (pathname === "/api/send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (pathname === "/api/set-name" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { name } = JSON.parse(body);
          if (name) {
            config.name = name;
            // Save to config file
            import("./config.js").then(({ setName }) => setName(name));
          }
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, name }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // Create channel
    if (pathname === "/api/create-channel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { channel, key, desc } = JSON.parse(body);
          const { addChannel, ensureIdentity } = await import("./config.js");
          addChannel(channel, key);

          // Publish channel_meta with readme
          try {
            const { AgentChatClient } = await import("./mqtt-client.js");
            const identity = ensureIdentity();
            const readme = desc ? `# #${channel}\n\n${desc}` : "";
            const tmpClient = AgentChatClient.fromSingle({ channel, name: config.name, key });
            await tmpClient.connect();
            await tmpClient.publishMeta(channel, {
              name: channel,
              description: desc || "",
              readme,
              subchannels: [],
              owners: [identity.fingerprint],
              created: Date.now(),
            });
            await tmpClient.disconnect();
          } catch { /* best effort */ }

          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, channel }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    // Leave channel (member self-leave — persists removal to config.json)
    if (pathname === "/api/leave-channel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { channel, subchannel } = JSON.parse(body);
          if (!channel) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "channel required" }));
            return;
          }
          const { removeChannel } = await import("./config.js");
          if (subchannel) {
            // Leave just the subchannel
            removeChannel(channel, subchannel);
          } else {
            // Leave channel AND all its subchannels
            const { loadConfig, saveConfig } = await import("./config.js");
            const cfg = loadConfig();
            cfg.channels = cfg.channels.filter((c) => c.channel !== channel);
            saveConfig(cfg);
          }
          // Also drop from the running web server's in-memory state
          config.channels = config.channels.filter((c) => {
            if (subchannel) return !(c.channel === channel && c.subchannel === subchannel);
            return c.channel !== channel;
          });
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, channel, subchannel }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // Add subchannel (owner only — enforced by publishMeta metadata check on receive)
    if (pathname === "/api/add-subchannel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { channel, subchannel, description } = JSON.parse(body);
          const { validateSubchannelName } = await import("./crypto.js");
          if (!subchannel || !validateSubchannelName(subchannel)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid subchannel name" }));
            return;
          }
          const chCfg = config.channels.find((c) => c.channel === channel && !c.subchannel);
          if (!chCfg) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel not found" }));
            return;
          }
          const { AgentChatClient } = await import("./mqtt-client.js");
          const { ensureIdentity } = await import("./config.js");
          const identity = ensureIdentity();
          const tmpClient = AgentChatClient.fromSingle({ channel, name: config.name, key: chCfg.key });
          await tmpClient.connect();
          // Wait briefly for meta to load from history
          await new Promise((r) => setTimeout(r, 600));
          const existing = tmpClient.getMeta(channel);
          if (!existing) {
            await tmpClient.disconnect();
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel has no meta yet — owner must run set_channel first" }));
            return;
          }
          if (!existing.owners.includes(identity.fingerprint)) {
            await tmpClient.disconnect();
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Only owners can add subchannels" }));
            return;
          }
          const subs = [...(existing.subchannels || [])];
          if (subs.includes(subchannel)) {
            await tmpClient.disconnect();
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, channel, subchannel, noop: true }));
            return;
          }
          subs.push(subchannel);
          const descriptions = { ...(existing.descriptions || {}) };
          if (description) descriptions[subchannel] = description;
          await tmpClient.publishMeta(channel, { ...existing, subchannels: subs, descriptions });
          await tmpClient.disconnect();
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, channel, subchannel }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // Remove subchannel (owner only)
    if (pathname === "/api/remove-subchannel" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { channel, subchannel } = JSON.parse(body);
          const chCfg = config.channels.find((c) => c.channel === channel && !c.subchannel);
          if (!chCfg) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel not found" }));
            return;
          }
          const { AgentChatClient } = await import("./mqtt-client.js");
          const { ensureIdentity, removeChannel } = await import("./config.js");
          const identity = ensureIdentity();
          const tmpClient = AgentChatClient.fromSingle({ channel, name: config.name, key: chCfg.key });
          await tmpClient.connect();
          await new Promise((r) => setTimeout(r, 600));
          const existing = tmpClient.getMeta(channel);
          if (!existing) {
            await tmpClient.disconnect();
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Channel has no meta" }));
            return;
          }
          if (!existing.owners.includes(identity.fingerprint)) {
            await tmpClient.disconnect();
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Only owners can remove subchannels" }));
            return;
          }
          const subs = existing.subchannels || [];
          if (!subs.includes(subchannel)) {
            await tmpClient.disconnect();
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, channel, subchannel, noop: true }));
            return;
          }
          const newSubs = subs.filter((s) => s !== subchannel);
          const descriptions = { ...(existing.descriptions || {}) };
          delete descriptions[subchannel];
          await tmpClient.publishMeta(channel, { ...existing, subchannels: newSubs, descriptions });
          await tmpClient.disconnect();
          // Also drop from local config so the sidebar doesn't re-render it
          removeChannel(channel, subchannel);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, channel, subchannel }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    // Sync & Distill settings
    if (pathname === "/api/sync" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { channel, enabled } = JSON.parse(body);
          const { setSyncEnabled } = await import("./config.js");
          setSyncEnabled(channel, enabled);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, channel, sync: enabled }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    if (pathname === "/api/distill" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { enabled } = JSON.parse(body);
          const { setDistillEnabled } = await import("./config.js");
          setDistillEnabled(enabled);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, distill: enabled }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request" }));
        }
      });
      return;
    }

    if (pathname === "/api/distill-status") {
      import("./distill.js").then(({ getDistillStatus }) => {
        const status = getDistillStatus();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(status));
      }).catch(() => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ enabled: false, brainDir: "~/.agentchannel/brain", entityCount: 0, channelsProcessed: [] }));
      });
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // Static files from ui/ directory
    // Try exact path first (for /style.css, /app.js, etc.)
    if (pathname !== "/" && !pathname.startsWith("/channel/")) {
      const staticFile = serveStaticFile(join(UI_DIR, pathname));
      if (staticFile) {
        res.writeHead(200, { "Content-Type": staticFile.contentType });
        res.end(staticFile.body);
        return;
      }
    }

    // For / and /channel/* routes, serve index.html with injected config
    let targetChannel = "";
    const channelMatch = pathname.match(/^\/channel\/([^/]+)(?:\/sub\/([^/]+))?/);
    if (channelMatch) {
      const ch = decodeURIComponent(channelMatch[1]);
      const sub = channelMatch[2] ? decodeURIComponent(channelMatch[2]) : undefined;
      targetChannel = sub ? `${ch}/${sub}` : ch;
    }

    const indexFile = serveStaticFile(indexHtmlPath);
    if (!indexFile) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error: ui/index.html not found. Make sure the ui/ directory is present.");
      return;
    }

    // Inject config script before </head>
    const configScript = buildConfigScript(targetChannel || undefined);
    const htmlContent = indexFile.body.toString().replace("</head>", configScript + "\n</head>");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(htmlContent);
  });

  const MAX_PORT = port + 10;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const nextPort = (server.address() as any)?.port ? (server.address() as any).port + 1 : port + 1;
      if (nextPort > MAX_PORT) {
        console.error(`No available port found (tried ${port}-${MAX_PORT}). Kill old processes or specify a different port.`);
        process.exit(1);
      }
      console.log(`Port ${port} in use, trying ${nextPort}...`);
      server.listen(nextPort, () => {
        console.log(`AgentChannel Web UI: http://localhost:${nextPort}`);
      });
    }
  });

  server.listen(port, () => {
    console.log(`AgentChannel Web UI: http://localhost:${port}`);
  });
}
