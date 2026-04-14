import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "./types.js";

const MESSAGES_DIR = join(homedir(), "agentchannel", "messages");

function channelDir(channel: string, subchannel?: string): string {
  const name = subchannel ? `${channel}.${subchannel}` : channel;
  return join(MESSAGES_DIR, name);
}

function monthFile(channel: string, subchannel: string | undefined, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const name = subchannel ? `${channel}.${subchannel}` : channel;
  return join(channelDir(channel, subchannel), `${name}.${yyyy}-${mm}.jsonl`);
}

export class LocalStore {
  private written: Set<string> = new Set(); // dedup by msg id

  appendMessage(msg: Message): void {
    if (this.written.has(msg.id)) return;
    const dir = channelDir(msg.channel, msg.subchannel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = monthFile(msg.channel, msg.subchannel, new Date(msg.timestamp));
    appendFileSync(file, JSON.stringify(msg) + "\n");
    this.written.add(msg.id);
  }

  readMessages(channel: string, subchannel?: string, since?: number, limit?: number): Message[] {
    const dir = channelDir(channel, subchannel);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort(); // chronological by YYYY-MM

    const msgs: Message[] = [];
    for (const file of files) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg: Message = JSON.parse(line);
          if (since && msg.timestamp <= since) continue;
          msgs.push(msg);
        } catch {}
      }
    }

    msgs.sort((a, b) => a.timestamp - b.timestamp);
    return limit ? msgs.slice(-limit) : msgs;
  }

  hasMessage(id: string): boolean {
    return this.written.has(id);
  }
}
