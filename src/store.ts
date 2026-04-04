import type { Message, Member } from "./types.js";

const MAX_MESSAGES = 100;

export class MessageStore {
  private messages: Message[] = [];
  // channel -> name -> Member
  private members: Map<string, Map<string, Member>> = new Map();
  private lastReadTimestamp: number = Date.now();

  addMessage(msg: Message): void {
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }
  }

  getMessages(limit: number = 20): Message[] {
    return this.messages.slice(-limit);
  }

  getMessageById(id: string): Message | undefined {
    return this.messages.find((m) => m.id === id);
  }

  getUnreadCount(channel?: string): number {
    let msgs = this.messages.filter((m) => m.timestamp > this.lastReadTimestamp);
    if (channel) {
      msgs = msgs.filter((m) => m.channel === channel);
    }
    return msgs.length;
  }

  markAsRead(): void {
    this.lastReadTimestamp = Date.now();
  }

  updateMember(name: string, channel: string, subchannel?: string, fingerprint?: string): void {
    const key = subchannel ? `${channel}/${subchannel}` : channel;
    let channelMembers = this.members.get(key);
    if (!channelMembers) {
      channelMembers = new Map();
      this.members.set(key, channelMembers);
    }
    const existing = channelMembers.get(name);
    if (existing) {
      existing.lastActive = Date.now();
      if (fingerprint) existing.fingerprint = fingerprint;
    } else {
      channelMembers.set(name, { name, channel, subchannel, joinedAt: Date.now(), lastActive: Date.now(), fingerprint });
    }
  }

  removeMember(name: string, channel: string): void {
    this.members.get(channel)?.delete(name);
  }

  getMembers(channel?: string): Member[] {
    if (channel) {
      return Array.from(this.members.get(channel)?.values() || []);
    }
    const all: Member[] = [];
    for (const channelMembers of this.members.values()) {
      for (const member of channelMembers.values()) {
        all.push(member);
      }
    }
    return all;
  }

  formatLastActive(timestamp: number): string {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
}
