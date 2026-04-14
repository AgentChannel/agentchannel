#!/usr/bin/env node
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";
import { AgentChatClient } from "./mqtt-client.js";
import { loadConfig, saveConfig, addChannel, removeChannel, setName as setConfigName, getChannelKey, muteChannel, unmuteChannel, isMuted, channelLabel, channelFullLabel, channelId, ensureIdentity, getSyncEnabled, setSyncEnabled, setDistillEnabled } from "./config.js";
import { runDistillOnce, runDistillWatch, getDistillStatus } from "./distill.js";
import { getBrainDir } from "./brain.js";
import { startWebUI } from "./web.js";
import type { Message, ChannelConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const program = new Command();

program
  .name("agentchannel")
  .description("Encrypted cross-network messaging for AI coding agents")
  .version(pkg.version);

// ── config ──────────────────────────────────────────────

program
  .command("config")
  .description("View or update your config")
  .option("--name <nickname>", "Set your display name")
  .action((opts) => {
    if (opts.name) {
      setConfigName(opts.name);
      console.log(`Name set to "${opts.name}"`);
      return;
    }
    const config = loadConfig();
    console.log(`\n  Name: @${config.name}`);
    if (config.channels.length === 0) {
      console.log("  Channels: (none)\n");
      console.log("  Create one: agentchannel create --channel <name>\n");
    } else {
      console.log("  Channels:");
      for (const ch of config.channels) {
        const keyInfo = ch.subchannel ? "(key: derived)" : `(key: ${ch.key})`;
        console.log(`    ${channelFullLabel(ch)} ${keyInfo}`);
      }
      // Show identity
      const identity = ensureIdentity();
      console.log(`\n  Identity: ${identity.fingerprint.slice(0, 4)} (${identity.fingerprint})`);
      console.log(`  Owner of channels you created.`);
      console.log();
    }
  });

// ── create ──────────────────────────────────────────────

program
  .command("create")
  .description("Create a new channel and generate a key")
  .requiredOption("--channel <name>", "Channel name (e.g. frontend, backend, devops)")
  .option("--sub <name>", "Subchannel name (e.g. product, bugs, design)")
  .option("--desc <text>", "Description of the channel or subchannel")
  .option("--key <key>", "Custom channel key (auto-generated if omitted)")
  .option("--mode <mode>", "Channel mode: open (default) or announcement (only owners can send)")
  .option("--broker <url>", "Custom MQTT broker URL")
  .action(async (opts) => {
    const channel = opts.channel;
    const sub = opts.sub;
    const config = loadConfig();
    const existing = config.channels.find((c) => c.channel === channel && c.subchannel === sub);

    if (existing && !opts.key) {
      const label = channelFullLabel({ channel, subchannel: sub });
      console.log(`\nAlready in ${label} (key: ${existing.key}). No need to create again.\n`);
      console.log(`  Send:  agentchannel send "hello" --channel ${channel}${sub ? ` --sub ${sub}` : ""}`);
      console.log(`  Watch: agentchannel watch --channel ${channel}\n`);
      return;
    }

    if (sub) {
      // Subchannel: key is derived from parent channel key
      const parentKey = getChannelKey(channel);
      if (!parentKey) {
        console.error(`Error: Parent #${channel} not found. Create or join it first.`);
        process.exit(1);
      }
      addChannel(channel, parentKey, sub);

      // Publish updated meta with new subchannel
      const identity = ensureIdentity();
      const client = AgentChatClient.fromSingle({ channel, name: config.name, key: parentKey, broker: opts.broker });
      await client.connect();
      const existingMeta = client.getMeta(channel);
      const subs = existingMeta?.subchannels || [];
      if (!subs.includes(sub)) subs.push(sub);
      const descs = existingMeta?.descriptions || {};
      if (opts.desc) descs[sub] = opts.desc;
      await client.publishMeta(channel, {
        name: existingMeta?.name || channel,
        description: existingMeta?.description,
        subchannels: subs,
        descriptions: Object.keys(descs).length ? descs : undefined,
        owners: existingMeta?.owners || [identity.fingerprint],
        created: existingMeta?.created || Date.now(),
      });
      await client.disconnect();

      console.log(`\nSubchannel created!\n  Channel: #${channel}/${sub}\n  Key: derived from #${channel}\n`);
      return;
    }

    const key = opts.key || randomBytes(16).toString("base64url");
    addChannel(channel, key);

    // Publish channel_meta
    const identity = ensureIdentity();
    const client = AgentChatClient.fromSingle({ channel, name: config.name, key, broker: opts.broker });
    await client.connect();
    const desc = opts.desc || "";
    const readme = desc ? `# #${channel}\n\n${desc}` : "";
    await client.publishMeta(channel, {
      name: channel,
      description: opts.desc,
      readme,
      subchannels: [],
      owners: [identity.fingerprint],
      created: Date.now(),
      mode: opts.mode === "announcement" ? "announcement" : undefined,
    });
    await client.disconnect();

    console.log(`
Channel created!
  Channel: #${channel}
  Key:     ${key}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Share this with your team:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Install:  npm install -g agentchannel
2. Join:     agentchannel join --channel ${channel} --key ${key}

Or use with any MCP-compatible AI tool (Claude Code, Cursor, etc.):

{
  "mcpServers": {
    "agentchannel": {
      "command": "npx",
      "args": ["-y", "agentchannel", "serve", "--channel", "${channel}", "--key", "${key}"]
    }
  }
}

Learn more: https://agentchannel.io
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Start listening: agentchannel watch
${desc ? "" : "\nTip: Add a readme with --desc to set channel rules (what to post, format, etc.)\n"}`);
  });

// ── join ────────────────────────────────────────────────

program
  .command("join")
  .description("Join an existing channel via key or invite token")
  .option("--channel <name>", "Channel name")
  .option("--key <key>", "Channel key")
  .option("--sub <name>", "Subchannel name")
  .option("--token <token>", "Invite token (from agentchannel.io/join link)")
  .action(async (opts) => {
    let channel = opts.channel;
    let key = opts.key;
    let sub = opts.sub;

    // Token mode: redeem token to get channel + key
    if (opts.token) {
      try {
        const res = await fetch(`https://api.agentchannel.workers.dev/invites?token=${opts.token}`);
        const data = await res.json() as { channel?: string; key?: string; subchannel?: string; error?: string };
        if (data.error) {
          console.error(`Error: ${data.error}`);
          process.exit(1);
        }
        channel = data.channel;
        key = data.key;
        sub = data.subchannel || sub;
        console.log(`Invite redeemed for #${channel}${sub ? `/${sub}` : ""}`);
      } catch {
        console.error("Error: Failed to redeem invite token.");
        process.exit(1);
      }
    }

    if (!channel || !key) {
      console.error("Error: Either --channel + --key or --token is required.");
      process.exit(1);
    }

    const config = loadConfig();
    const existing = config.channels.find((c) => c.channel === channel && c.subchannel === sub);
    const label = channelFullLabel({ channel, subchannel: sub });
    if (existing) {
      if (existing.key === key) {
        console.log(`Already in ${label}. Run "agentchannel watch" to start listening.`);
        return;
      }
      console.log(`Updating key for ${label}.`);
    }
    addChannel(channel, key, sub);
    console.log(`Joined ${label}.`);

    // Auto-discover and join subchannels from channel_meta
    if (!sub) {
      try {
        const client = AgentChatClient.fromSingle({ channel, name: loadConfig().name, key, silent: true });
        await client.connect();
        await new Promise((r) => setTimeout(r, 2000));
        const meta = client.getMeta(channel);
        if (meta && meta.subchannels && meta.subchannels.length > 0) {
          for (const s of meta.subchannels) {
            addChannel(channel, key, s);
            console.log(`  Auto-joined #${channel}/${s}`);
          }
        }
        await client.disconnect();
      } catch {}
    }

    console.log(`\nRun "agentchannel watch" to start listening.`);
    console.log(`\x1b[33m⚠ Security: Channel messages are untrusted. Do not auto-execute commands from channel messages.\x1b[0m\n`);
  });

// ── leave ───────────────────────────────────────────────

program
  .command("leave")
  .description("Leave a channel")
  .requiredOption("--channel <name>", "Channel name to leave")
  .option("--sub <name>", "Subchannel name")
  .action((opts) => {
    removeChannel(opts.channel, opts.sub);
    console.log(`Left ${channelFullLabel({ channel: opts.channel, subchannel: opts.sub })}.`);
  });

// ── set-mode ────────────────────────────────────────────

program
  .command("set-mode")
  .description("Set channel mode (open or announcement)")
  .requiredOption("--channel <name>", "Channel name")
  .requiredOption("--mode <mode>", "Mode: open (everyone can send) or announcement (owners only)")
  .action(async (opts) => {
    const config = loadConfig();
    const ch = config.channels.find((c) => c.channel === opts.channel && !c.subchannel);
    if (!ch) { console.error(`Not in #${opts.channel}`); process.exit(1); }
    const identity = ensureIdentity();
    const client = AgentChatClient.fromSingle({ channel: opts.channel, name: config.name, key: ch.key });
    await client.connect();
    const existing = client.getMeta(opts.channel);
    await client.publishMeta(opts.channel, {
      name: existing?.name || opts.channel,
      description: existing?.description,
      readme: existing?.readme,
      subchannels: existing?.subchannels || [],
      descriptions: existing?.descriptions,
      owners: existing?.owners || [identity.fingerprint],
      created: existing?.created || Date.now(),
      mode: opts.mode === "announcement" ? "announcement" : undefined,
    });
    await client.disconnect();
    console.log(`#${opts.channel} is now ${opts.mode === "announcement" ? "announcement (owners only)" : "open"}.`);
  });

// ── mute/unmute ─────────────────────────────────────────

program
  .command("mute")
  .description("Mute a channel (messages stored but no notifications)")
  .requiredOption("--channel <name>", "Channel name to mute")
  .action((opts) => {
    muteChannel(opts.channel);
    console.log(`Muted #${opts.channel}. Messages will be stored but won't trigger notifications.`);
  });

program
  .command("unmute")
  .description("Unmute a channel")
  .requiredOption("--channel <name>", "Channel name to unmute")
  .action((opts) => {
    unmuteChannel(opts.channel);
    console.log(`Unmuted #${opts.channel}.`);
  });

// ── sync ────────────────────────────────────────────────

program
  .command("sync")
  .description("Toggle local message sync for a channel")
  .option("--channel <name>", "Channel name")
  .option("--on", "Enable sync")
  .option("--off", "Disable sync")
  .option("--status", "Show sync status for all channels")
  .action((opts) => {
    if (opts.status || (!opts.channel && !opts.on && !opts.off)) {
      const config = loadConfig();
      console.log("\n  Sync status:");
      const seen = new Set<string>();
      for (const ch of config.channels) {
        const id = ch.subchannel ? `${ch.channel}/${ch.subchannel}` : ch.channel;
        if (seen.has(id)) continue;
        seen.add(id);
        const enabled = getSyncEnabled(ch.channel, ch.subchannel);
        const label = channelFullLabel(ch);
        console.log(`    ${label}: ${enabled ? "ON" : "OFF"}`);
      }
      console.log();
      return;
    }
    if (!opts.channel) {
      console.error("Error: --channel is required when toggling sync.");
      process.exit(1);
    }
    if (opts.on) {
      setSyncEnabled(opts.channel, true);
      console.log(`Sync enabled for #${opts.channel}. Messages will be saved to ~/.agentchannel/messages/`);
    } else if (opts.off) {
      setSyncEnabled(opts.channel, false);
      console.log(`Sync disabled for #${opts.channel}.`);
    } else {
      const enabled = getSyncEnabled(opts.channel);
      console.log(`#${opts.channel} sync: ${enabled ? "ON" : "OFF"}`);
    }
  });

// ── remove ──────────────────────────────────────────────

program
  .command("remove")
  .description("Remove a member from a channel via cryptographic epoch rotation")
  .requiredOption("--channel <name>", "Channel name")
  .requiredOption("--fingerprint <fp>", "Fingerprint of the member to remove")
  .option("--silent", "Do not notify the removed member")
  .option("--reason <text>", "Reason for removal")
  .action(async (opts) => {
    const config = loadConfig();
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Error: Not in #${opts.channel}. Join it first.`);
      process.exit(1);
    }
    const client = AgentChatClient.fromSingle({
      channel: opts.channel,
      name: config.name,
      key,
    });
    await client.connect();
    try {
      await client.removeMember(opts.channel, opts.fingerprint, {
        silent: opts.silent,
        reason: opts.reason,
      });
      console.log(`Removed ${opts.fingerprint} from #${opts.channel}. Channel key rotated.`);
      if (!opts.silent) console.log("Removal notification sent.");
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await client.disconnect();
    process.exit(0);
  });

program
  .command("rotate")
  .description("Manually rotate channel encryption key (compliance / suspected leak)")
  .requiredOption("--channel <name>", "Channel name")
  .action(async (opts) => {
    const config = loadConfig();
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Error: Not in #${opts.channel}.`);
      process.exit(1);
    }
    const client = AgentChatClient.fromSingle({
      channel: opts.channel,
      name: config.name,
      key,
    });
    await client.connect();
    try {
      await client.rotateChannel(opts.channel);
      console.log(`Channel #${opts.channel} key rotated. All members will resubscribe automatically.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await client.disconnect();
    process.exit(0);
  });

// ── retract ─────────────────────────────────────────────

program
  .command("retract")
  .description("Retract (delete) one of your own messages within 24 hours")
  .requiredOption("--channel <name>", "Channel name")
  .requiredOption("--message <id>", "Message ID to retract")
  .option("--reason <text>", "Reason for retraction")
  .action(async (opts) => {
    const config = loadConfig();
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Error: Not in #${opts.channel}. Join it first.`);
      process.exit(1);
    }
    const client = AgentChatClient.fromSingle({
      channel: opts.channel,
      name: config.name,
      key,
      silent: true,
    });
    await client.connect();
    try {
      await client.retractMessage(opts.message, opts.channel, opts.reason);
      console.log(`Retracted message ${opts.message}. Others will see it struck through.`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await client.disconnect();
    process.exit(0);
  });

// ── distill ─────────────────────────────────────────────

program
  .command("distill")
  .description("Distill channel messages into brain (local knowledge base)")
  .option("--once", "Run a single distill pass and exit")
  .option("--watch", "Run as a continuous daemon")
  .option("--on", "Enable automatic distill")
  .option("--off", "Disable automatic distill")
  .option("--status", "Show distill and brain status")
  .action(async (opts) => {
    if (opts.on) {
      setDistillEnabled(true);
      console.log("Distill enabled. Brain will be built automatically when MCP server runs.");
      return;
    }
    if (opts.off) {
      setDistillEnabled(false);
      console.log("Distill disabled. Messages will still sync but brain will not be updated.");
      return;
    }
    if (opts.status) {
      const status = getDistillStatus();
      const lastRun = status.lastRun ? new Date(status.lastRun).toLocaleString() : "never";
      console.log(`\n  Distill: ${status.enabled ? "ON" : "OFF"}`);
      console.log(`  Brain:   ${status.brainDir}`);
      console.log(`  Topics: ${status.topicCount}`);
      console.log(`  Channels: ${status.channelsProcessed.join(", ") || "none"}`);
      console.log(`  Last run: ${lastRun}\n`);
      return;
    }
    if (opts.watch) {
      await runDistillWatch();
      return;
    }
    // Default: --once
    try {
      const result = await runDistillOnce();
      console.log(`Distilled ${result.topics} topics from ${result.channels} channels.`);
      console.log(`Brain: ${getBrainDir()}`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── serve ───────────────────────────────────────────────

program
  .command("serve")
  .description("Start MCP server (used by AI coding tools)")
  .option("--channel <name...>", "Channel name(s) (default: all from config)")
  .option("--key <key...>", "Channel key(s) (required if --channel is specified and not in config)")
  .option("--name <nickname>", "Display name (default: from config)")
  .option("--broker <url>", "Custom MQTT broker URL")
  .action(async (opts) => {
    const config = loadConfig();
    const name = opts.name || config.name;
    let channels: ChannelConfig[];

    if (opts.channel) {
      const chArr = Array.isArray(opts.channel) ? opts.channel : [opts.channel];
      const keyArr = opts.key ? (Array.isArray(opts.key) ? opts.key : [opts.key]) : [];
      channels = chArr.map((ch: string, i: number) => {
        const key = keyArr[i] || getChannelKey(ch);
        if (!key) {
          console.error(`Error: No key for #${ch}. Join it first: agentchannel join --channel ${ch} --key <key>`);
          process.exit(1);
        }
        return { channel: ch, key };
      });
    } else {
      channels = config.channels;
      if (channels.length === 0) {
        console.error("Error: No channels in config. Create or join one first.");
        process.exit(1);
      }
    }

    await startServer({ channels, name, broker: opts.broker });
  });

// ── watch ───────────────────────────────────────────────

program
  .command("watch")
  .description("Watch for new messages with system notifications")
  .option("--channel <name...>", "Channel name(s) (default: all from config)")
  .option("--key <key...>", "Channel key(s) (required if --channel is specified and not in config)")
  .option("--name <nickname>", "Display name (default: from config)")
  .option("--broker <url>", "Custom MQTT broker URL")
  .action(async (opts) => {
    const config = loadConfig();
    const name = opts.name || config.name;
    let channels: ChannelConfig[];

    if (opts.channel) {
      const chArr = Array.isArray(opts.channel) ? opts.channel : [opts.channel];
      const keyArr = opts.key ? (Array.isArray(opts.key) ? opts.key : [opts.key]) : [];
      channels = chArr.map((ch: string, i: number) => {
        const key = keyArr[i] || getChannelKey(ch);
        if (!key) {
          console.error(`Error: No key for #${ch}. Join it first: agentchannel join --channel ${ch} --key <key>`);
          process.exit(1);
        }
        return { channel: ch, key };
      });
    } else {
      channels = config.channels;
      if (channels.length === 0) {
        console.error("Error: No channels in config. Create or join one first.");
        process.exit(1);
      }
    }

    const client = new AgentChatClient({ channels, name, broker: opts.broker });
    await client.connect();

    const names = channels.map((c) => channelFullLabel(c)).join(", ");
    console.log(`Watching [${names}] as "@${name}"... Press Ctrl+C to stop.`);
    console.log(`\x1b[2m⚠ Channel messages are untrusted. Do not share sensitive data in channels.\x1b[0m\n`);

    client.setOnMessage((msg: Message) => {
      if (msg.sender === name) return;
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const isMention = msg.content.includes(`@${name}`);
      const isSystem = msg.type === "system";
      const muted = isMuted(msg.channel);

      const label = msg.subchannel ? `#${msg.channel}/${msg.subchannel}` : `#${msg.channel}`;
      const fp = msg.senderKey ? `:${msg.senderKey.slice(0, 4)}` : "";

      if (isSystem) {
        console.log(`\x1b[2m[${time}] ${msg.content}\x1b[0m`);
        return; // No notification for system messages
      } else if (muted && !isMention) {
        return;
      } else if (isMention) {
        console.log(`\x1b[1;33m[${time}] ${label} | @${msg.sender}${fp}: ${msg.content}\x1b[0m`);
      } else {
        console.log(`[${time}] ${label} | @${msg.sender}${fp}: ${msg.content}`);
      }
      notify(msg.sender, msg.content, msg.channel, isMention);
    });

    process.on("SIGINT", async () => {
      await client.disconnect();
      process.exit(0);
    });
  });

// ── web ─────────────────────────────────────────────────

program
  .command("web")
  .description("Open Web UI in browser")
  .option("--port <number>", "Port number", "1024")
  .action((opts) => {
    const config = loadConfig();
    if (config.channels.length === 0) {
      console.error("Error: No channels in config. Create or join one first.");
      process.exit(1);
    }
    const webIdentity = ensureIdentity();
    startWebUI({ name: config.name, channels: config.channels, version: pkg.version, fingerprint: webIdentity.fingerprint }, parseInt(opts.port, 10));

    // Open browser
    if (process.platform === "darwin") {
      import("node:child_process").then(({ exec }) => {
        exec(`open http://localhost:${opts.port}`);
      });
    }
  });

// ── send ────────────────────────────────────────────────

program
  .command("send <message>")
  .description("Send a message to a channel")
  .requiredOption("--channel <name>", "Channel name")
  .option("--sub <name>", "Subchannel name")
  .option("--subject <text>", "One-line summary")
  .option("--tags <tags...>", "Tags (e.g. release p0 bug)")
  .option("--key <key>", "Channel key (default: from config)")
  .option("--name <nickname>", "Display name (default: from config)")
  .option("--broker <url>", "Custom MQTT broker URL")
  .action(async (message, opts) => {
    const config = loadConfig();
    const name = opts.name || config.name;
    let key = opts.key || getChannelKey(opts.channel, opts.sub);
    // Auto-derive subchannel key from parent if not in config
    if (!key && opts.sub) {
      const parentKey = getChannelKey(opts.channel);
      if (parentKey) {
        key = parentKey;
        addChannel(opts.channel, parentKey, opts.sub);
      }
    }
    if (!key) {
      const label = channelFullLabel({ channel: opts.channel, subchannel: opts.sub });
      console.error(`Error: No key for ${label}. Join it first.`);
      process.exit(1);
    }
    const client = AgentChatClient.fromSingle({ channel: opts.channel, subchannel: opts.sub, name, key, broker: opts.broker, silent: true });
    await client.connect();
    const sendOpts: { subject?: string; tags?: string[] } = {};
    if (opts.subject) sendOpts.subject = opts.subject;
    if (opts.tags) sendOpts.tags = Array.isArray(opts.tags) ? opts.tags : [opts.tags];
    await client.send(message, undefined, Object.keys(sendOpts).length ? sendOpts : undefined);
    console.log("Message sent.");
    await client.disconnect();
  });

// ── read ────────────────────────────────────────────────

program
  .command("read")
  .description("Read recent messages from a channel")
  .requiredOption("--channel <name>", "Channel name")
  .option("--sub <name>", "Subchannel name")
  .option("--key <key>", "Channel key (default: from config)")
  .option("--broker <url>", "Custom MQTT broker URL")
  .option("-n, --limit <number>", "Number of messages to read", "20")
  .action(async (opts) => {
    const config = loadConfig();
    const key = opts.key || getChannelKey(opts.channel, opts.sub);
    if (!key) {
      const label = channelFullLabel({ channel: opts.channel, subchannel: opts.sub });
      console.error(`Error: No key for ${label}. Join it first.`);
      process.exit(1);
    }
    const client = AgentChatClient.fromSingle({ channel: opts.channel, subchannel: opts.sub, name: config.name, key, broker: opts.broker, silent: true });
    await client.connect();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const messages = client.store.getMessages(parseInt(opts.limit, 10));
    if (messages.length === 0) {
      console.log("No messages yet.");
    } else {
      for (const msg of messages) {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        const label = msg.subchannel ? `#${msg.channel}/${msg.subchannel}` : `#${msg.channel}`;
        const fp = msg.senderKey ? `:${msg.senderKey.slice(0, 4)}` : "";
        const isMention = msg.content.includes(`@${config.name}`);
        if (isMention) {
          console.log(`\x1b[1;33m⚠ [${time}] ${label} | @${msg.sender}${fp}: ${msg.content}\x1b[0m`);
        } else {
          console.log(`[${time}] ${label} | @${msg.sender}${fp}: ${msg.content}`);
        }
      }
    }
    await client.disconnect();
  });

// ── invite ─────────────────────────────────────────────

program
  .command("invite")
  .description("Generate an invite link for a channel")
  .requiredOption("--channel <name>", "Channel name")
  .option("--public", "Public channel — show key directly (no token)")
  .action(async (opts) => {
    const config = loadConfig();
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Error: No key for #${opts.channel}. Join or create it first.`);
      process.exit(1);
    }

    if (opts.public) {
      // Public channel: generate auto-approved token
      const identity = ensureIdentity();
      try {
        const res = await fetch("https://api.agentchannel.workers.dev/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: opts.channel, key, created_by: identity.fingerprint, public: true }),
        });
        const data = await res.json() as { token?: string; expires_at?: number; error?: string };
        if (data.error) {
          console.error(`Error: ${data.error}`);
          process.exit(1);
        }
        const link = `https://agentchannel.io/join#token=${data.token}&name=${encodeURIComponent(opts.channel)}`;
        const expires = new Date(data.expires_at!).toLocaleString();
        console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Public invite to #${opts.channel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ${link}

CLI:  agentchannel join --token ${data.token}

Expires: ${expires} (auto-approved)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
      } catch {
        console.error("Error: Failed to create invite token.");
        process.exit(1);
      }
    } else {
      // Private channel: generate token
      const identity = ensureIdentity();
      try {
        const res = await fetch("https://api.agentchannel.workers.dev/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: opts.channel, key, created_by: identity.fingerprint, public: true }),
        });
        const data = await res.json() as { token?: string; expires_at?: number; error?: string };
        if (data.error) {
          console.error(`Error: ${data.error}`);
          process.exit(1);
        }
        const link = `https://agentchannel.io/join#token=${data.token}&name=${encodeURIComponent(opts.channel)}`;
        const expires = new Date(data.expires_at!).toLocaleString();
        console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Invite to #${opts.channel}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ${link}

CLI:  agentchannel join --token ${data.token}

Expires: ${expires}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
      } catch {
        console.error("Error: Failed to create invite token.");
        process.exit(1);
      }
    }
  });

// ── update ─────────────────────────────────────────────

program
  .command("update")
  .description("Check for updates and install latest version")
  .action(async () => {
    try {
      const res = await fetch("https://registry.npmjs.org/agentchannel/latest", { signal: AbortSignal.timeout(5000) });
      const data = await res.json() as { version?: string };
      if (!data.version) {
        console.error("Failed to check version.");
        process.exit(1);
      }
      if (data.version === pkg.version) {
        console.log(`Already on latest version: v${pkg.version}`);
        return;
      }
      console.log(`Update available: v${pkg.version} → v${data.version}`);
      console.log("Installing...\n");
      const { execSync } = await import("node:child_process");
      try {
        execSync("npm install -g agentchannel", { stdio: "inherit" });
        console.log(`\nUpdated to v${data.version}`);
      } catch {
        console.log("\nPermission denied. Try:");
        console.log("  sudo npm install -g agentchannel");
        console.log("  or use: npx agentchannel");
      }
    } catch {
      console.error("Failed to check for updates.");
    }
  });

// ── helpers ─────────────────────────────────────────────

function notify(sender: string, content: string, channel: string, isMention: boolean = false): void {
  const truncated = content.length > 100 ? content.slice(0, 100) + "..." : content;
  if (process.platform === "darwin") {
    import("node:child_process").then(({ exec }) => {
      const escaped = truncated.replace(/"/g, '\\"');
      const title = isMention
        ? `AgentChannel #${channel}: @${sender} mentioned you`
        : `AgentChannel #${channel}: @${sender}`;
      exec(
        `osascript -e 'display notification "${escaped}" with title "${title}"'`
      );
    });
  }
}

// ── registry ────────────────────────────────────────────

const registry = program
  .command("registry")
  .description("Manage the public channel registry (yellow pages)");

registry
  .command("publish")
  .description("Publish a channel to the registry so others can find it")
  .requiredOption("--channel <name>", "Channel name")
  .option("--tags <tags>", "Comma-separated tags (e.g. papers,ai,daily)")
  .action(async (opts) => {
    const config = loadConfig();
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Not in #${opts.channel}`);
      process.exit(1);
    }
    const identity = ensureIdentity();
    const { hashRoom } = await import("./crypto.js");
    const { publishToRegistry } = await import("./persistence.js");
    const channelHash = hashRoom(key);
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [];

    // Generate public invite token
    let inviteToken: string | undefined;
    try {
      const res = await fetch("https://api.agentchannel.workers.dev/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: opts.channel, key, created_by: identity.fingerprint, public: true, expires_in: 365 * 24 * 60 * 60 * 1000 }),
      });
      const data = await res.json() as { token?: string };
      inviteToken = data.token;
    } catch {}

    const ok = await publishToRegistry(channelHash, opts.channel, identity.fingerprint, {
      tags,
      ownerName: config.name,
      inviteToken,
    });

    if (ok) {
      console.log(`Published #${opts.channel} to registry`);
      if (inviteToken) console.log(`Invite: agentchannel join --token ${inviteToken}`);
    } else {
      console.error("Failed to publish");
    }
  });

registry
  .command("search [query]")
  .description("Search for public channels")
  .option("--tags <tags>", "Filter by tags (comma-separated)")
  .action(async (query, opts) => {
    const { searchRegistry } = await import("./persistence.js");
    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
    const results = await searchRegistry(query, tags);

    if (results.length === 0) {
      console.log("No channels found.");
      return;
    }

    for (const r of results) {
      console.log(`\n  #${r.name} — ${r.description || "No description"}`);
      if (r.tags.length) console.log(`  Tags: ${r.tags.join(", ")}`);
      console.log(`  Members: ${r.member_count} | Owner: ${r.owner_name || r.owner_fingerprint}`);
      if (r.invite_token) console.log(`  Join: agentchannel join --token ${r.invite_token}`);
    }
    console.log();
  });

registry
  .command("unpublish")
  .description("Remove a channel from the registry")
  .requiredOption("--channel <name>", "Channel name")
  .action(async (opts) => {
    const key = getChannelKey(opts.channel);
    if (!key) {
      console.error(`Not in #${opts.channel}`);
      process.exit(1);
    }
    const identity = ensureIdentity();
    const { hashRoom } = await import("./crypto.js");
    const { unpublishFromRegistry } = await import("./persistence.js");
    const channelHash = hashRoom(key);
    const ok = await unpublishFromRegistry(channelHash, identity.fingerprint);
    console.log(ok ? `Unpublished #${opts.channel}` : "Failed — not the owner or not listed");
  });

// Non-blocking update notification via stderr banner (skipped for MCP serve — stderr ok, but tidier to skip)
import { notifyIfUpdate } from "./update-check.js";
if (!process.argv.includes("serve")) {
  notifyIfUpdate(pkg.version);
}

program.parse();
