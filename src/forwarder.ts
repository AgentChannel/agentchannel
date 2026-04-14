import type { Message, WebhookConfig, HandoffConfig } from "./types.js";
import type { AgentChatClient } from "./mqtt-client.js";
import { loadConfig } from "./config.js";

export class MessageForwarder {
  private client: AgentChatClient;

  constructor(client: AgentChatClient) {
    this.client = client;
  }

  onMessage(msg: Message): void {
    // Skip system messages and unsigned messages
    if (msg.type === "system" || msg.type === "channel_meta") return;
    if (!msg.signature || !msg.senderKey) return;

    // Only trigger for trusted senders (TOFU or verified)
    if (msg.trustLevel !== "tofu" && msg.trustLevel !== "verified") return;

    // Skip own messages (prevent loops)
    if (msg.senderKey === this.client.getFingerprint()) return;

    const config = loadConfig();

    for (const wh of config.webhooks || []) {
      if (this.matches(msg, wh)) {
        this.postWebhook(wh.url, msg, "webhook");
      }
    }

    for (const hf of config.handoffs || []) {
      if (this.matches(msg, hf)) {
        const mode = hf.mode || "ask";
        if (mode === "auto") {
          // Auto mode: POST + ACK immediately
          this.postWebhook(hf.url, msg, "handoff");
          this.sendAck(msg, hf.output);
        } else {
          // Ask mode: surface request in channel, wait for approval
          this.sendPendingNotice(msg, hf);
        }
      }
    }
  }

  private matches(msg: Message, filter: WebhookConfig | HandoffConfig): boolean {
    // Channel must match
    if (msg.channel !== filter.channel) return false;
    if (filter.subchannel && msg.subchannel !== filter.subchannel) return false;

    // Tag filter: message must have at least one matching tag
    if (filter.tags && filter.tags.length > 0) {
      if (!msg.tags || !msg.tags.some((t) => filter.tags!.includes(t))) return false;
    }

    // Sender whitelist
    if (filter.senders && filter.senders.length > 0) {
      if (!filter.senders.includes(msg.senderKey!)) return false;
    }

    return true;
  }

  private async postWebhook(url: string, msg: Message, type: "webhook" | "handoff"): Promise<void> {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message: {
            id: msg.id,
            channel: msg.channel,
            subchannel: msg.subchannel,
            sender: msg.sender,
            senderKey: msg.senderKey,
            content: msg.content,
            subject: msg.subject,
            tags: msg.tags,
            timestamp: msg.timestamp,
            replyTo: msg.replyTo,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Fire and forget — don't crash the server
    }
  }

  private async sendAck(msg: Message, output?: string): Promise<void> {
    try {
      const target = output || (msg.subchannel ? `${msg.channel}/${msg.subchannel}` : msg.channel);
      await this.client.send(
        `Acknowledged handoff from @${msg.sender}: ${msg.subject || msg.content.slice(0, 100)}`,
        target,
        { tags: ["handoff-ack"], subject: `ACK: ${msg.subject || msg.id}` }
      );
    } catch {
      // Best effort
    }
  }

  private async sendPendingNotice(msg: Message, hf: HandoffConfig): Promise<void> {
    try {
      const target = hf.output || (msg.subchannel ? `${msg.channel}/${msg.subchannel}` : msg.channel);
      await this.client.send(
        `Handoff request from @${msg.sender} (${msg.senderKey}): ${msg.subject || msg.content.slice(0, 100)}\n` +
        `Hook: ${hf.id} | Mode: ask — awaiting approval`,
        target,
        { tags: ["handoff-pending"], subject: `PENDING: ${msg.subject || msg.id}` }
      );
    } catch {
      // Best effort
    }
  }
}
