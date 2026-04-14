import mqtt from "mqtt";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { execSync } from "node:child_process";
import { deriveKey, deriveSubKey, hashRoom, hashSub, deriveDmKey, hashDm, encrypt, decrypt } from "./crypto.js";
import { MessageStore } from "./store.js";
import { LocalStore } from "./local-store.js";
import { storeMessage, fetchHistory, registerMember } from "./persistence.js";
import { ensureIdentity, signMessage, verifySignature, getFingerprint } from "./identity.js";
import { checkTrust } from "./trust-store.js";
import { getSyncEnabled, updateChannelEpoch, getChannelEpoch, removeChannel } from "./config.js";
import type { ChatConfig, SingleChannelConfig, Message, Member, ChannelMeta, EncryptedPayload, RetractionPayload, EpochBumpPayload, RemovalNoticePayload } from "./types.js";
import type { Identity } from "./identity.js";

const DEFAULT_BROKER = "mqtt://35.238.24.59:1883";

function getDefaultName(): string {
  // 1. OS username
  try {
    const osName = userInfo().username;
    if (osName) return osName;
  } catch {}
  // 2. git user.name
  try {
    const gitName = execSync("git config --global user.name", { encoding: "utf-8", timeout: 2000 }).trim();
    if (gitName) return gitName;
  } catch {}
  // 3. fallback with fingerprint
  const fp = ensureIdentity().fingerprint.slice(0, 4);
  return `agent-${fp}`;
}

interface ChannelState {
  channel: string;
  subchannel?: string;
  key: Buffer;
  hash: string;          // MQTT topic hash (changes with epoch)
  channelHash: string;   // D1 storage hash (never changes)
}

function displayName(state: { channel: string; subchannel?: string }): string {
  return state.subchannel ? `#${state.channel}/${state.subchannel}` : `#${state.channel}`;
}

function fullId(state: { channel: string; subchannel?: string }): string {
  return state.subchannel ? `${state.channel}/${state.subchannel}` : state.channel;
}

export class AgentChatClient {
  private client: mqtt.MqttClient | null = null;
  private channels: Map<string, ChannelState> = new Map();
  private channelKeys: Map<string, string> = new Map(); // channel name -> raw key string
  private name: string;
  private broker: string;
  readonly store: MessageStore;
  readonly localStore: LocalStore;
  private onMessage?: (msg: Message) => void;
  private onMeta?: (channel: string, meta: ChannelMeta) => void;
  private channelMeta: Map<string, ChannelMeta> = new Map();
  private identity: Identity;
  private silent: boolean;

  constructor(config: ChatConfig) {
    this.name = config.name || getDefaultName();
    this.broker = config.broker || DEFAULT_BROKER;
    this.store = new MessageStore();
    this.localStore = new LocalStore();
    this.identity = ensureIdentity();
    this.silent = config.silent || false;

    for (const ch of config.channels) {
      const epoch = ch.epoch ?? 0;
      const key = ch.subchannel ? deriveSubKey(ch.key, ch.subchannel, epoch) : deriveKey(ch.key, epoch);
      const hash = ch.subchannel ? hashSub(ch.key, ch.subchannel) : hashRoom(ch.key);
      const channelHash = ch.channelHash || hash;
      this.channels.set(hash, { channel: ch.channel, subchannel: ch.subchannel, key, hash, channelHash });
      if (!ch.subchannel) this.channelKeys.set(ch.channel, ch.key);
    }
  }

  static fromSingle(config: SingleChannelConfig): AgentChatClient {
    return new AgentChatClient({
      channels: [{ channel: config.channel, subchannel: config.subchannel, key: config.key }],
      name: config.name,
      broker: config.broker,
      silent: config.silent,
    });
  }

  get memberName(): string {
    return this.name;
  }

  getFingerprint(): string {
    return this.identity.fingerprint;
  }

  getChannelKeyString(channel: string): string | undefined {
    return this.channelKeys.get(channel);
  }

  getName(): string {
    return this.name;
  }

  getMemberCount(channel: string): number {
    return this.store.getMembers(channel).length;
  }

  private msgTopic(hash: string): string {
    return `ac/1/${hash}`;
  }

  private presTopic(hash: string): string {
    return `ac/1/${hash}/p`;
  }

  async connect(): Promise<void> {
    const clientId = `agentchannel_${randomBytes(4).toString("hex")}`;
    const firstChannel = this.channels.values().next().value!;

    return new Promise((resolve, reject) => {
      const mqttOpts: any = {
        clientId,
        clean: true,
        connectTimeout: 10_000,
        reconnectPeriod: 3_000,
      };
      // Only set will message for long-lived connections (not silent)
      if (!this.silent) {
        mqttOpts.will = {
          topic: this.presTopic(firstChannel.hash),
          payload: Buffer.from(JSON.stringify({ name: this.name, status: "offline" })),
          qos: 1,
          retain: false,
        };
      }
      this.client = mqtt.connect(this.broker, mqttOpts);

      this.client.on("connect", () => {
        const topics: string[] = [];
        for (const [hash] of this.channels) {
          topics.push(this.msgTopic(hash));
          if (!this.silent) topics.push(this.presTopic(hash));
        }
        this.client!.subscribe(topics, { qos: 1 });

        // Always register as member (even in silent mode)
        for (const [_hash, state] of this.channels) {
          registerMember(state.channelHash, this.identity.fingerprint, this.name);
        }
        // Only announce presence for long-lived connections (not silent)
        if (!this.silent) {
          for (const [hash, state] of this.channels) {
            this.announcePresence(hash, "online");
            this.store.updateMember(this.name, state.channel, state.subchannel, this.identity.fingerprint);
          }
        }
        this.loadHistory().then(() => resolve());
      });

      this.client.on("message", (topic, payload) => {
        for (const [hash, state] of this.channels) {
          if (topic === this.msgTopic(hash)) {
            this.handleMessage(state, payload);
            return;
          }
          if (topic === this.presTopic(hash)) {
            this.handlePresence(state.channel, payload, state.subchannel);
            return;
          }
        }
      });

      this.client.on("error", (err) => {
        reject(err);
      });
    });
  }

  private handleMessage(state: ChannelState, payload: Buffer): void {
    try {
      const raw = payload.toString();
      const encrypted: EncryptedPayload = JSON.parse(raw);
      const decrypted = decrypt(encrypted, state.key);
      const msg: Message = JSON.parse(decrypted);
      msg.channel = state.channel;
      msg.subchannel = state.subchannel;
      if (!msg.type) msg.type = "chat";

      // Verify signature if present
      if (msg.signature && msg.senderKey) {
        const { signature, trustLevel: _tl, ...msgWithoutSig } = msg;
        const dataToVerify = JSON.stringify(msgWithoutSig);
        const sigValid = verifySignature(dataToVerify, msg.signature, msg.senderKey);
        if (!sigValid) {
          // Signature invalid — reject message
          return;
        }
        const trust = checkTrust(getFingerprint(msg.senderKey), msg.senderKey, msg.sender);
        msg.trustLevel = trust.level;
      } else {
        msg.trustLevel = "unsigned";
      }

      // Handle retraction messages — self-only, verify signature
      if (msg.type === "retraction") {
        try {
          const retraction: RetractionPayload = JSON.parse(msg.content);
          // Verify: retraction sender must match original message sender
          const target = this.store.getMessageById(retraction.target_id);
          if (target && target.senderKey && msg.senderKey === target.senderKey) {
            this.store.addRetraction(retraction.target_id);
            // Surface retraction as a system message
            const sysMsg: Message = {
              id: msg.id,
              channel: state.channel,
              subchannel: state.subchannel,
              sender: "system",
              content: `@${msg.sender} retracted message ${retraction.target_id}`,
              timestamp: Date.now(),
              type: "system",
            };
            this.store.addMessage(sysMsg);
            if (this.onMessage) this.onMessage(sysMsg);
          }
        } catch {}
        return;
      }

      // Handle epoch_bump DM — owner rotated channel key
      if (msg.type === "epoch_bump") {
        try {
          const bump: EpochBumpPayload = JSON.parse(msg.content);
          // Verify sender is a channel owner
          const meta = this.channelMeta.get(bump.channel);
          if (meta && msg.senderKey && meta.owners.includes(msg.senderKey)) {
            // Apply epoch rotation: derive new key + hash, resubscribe
            const newKey = deriveKey(bump.new_seed, bump.new_epoch);
            const newHash = hashRoom(bump.new_seed);

            // Unsubscribe from old topic, preserve channelHash
            let preservedChannelHash = "";
            for (const [hash, s] of this.channels) {
              if (s.channel === bump.channel && !s.subchannel) {
                preservedChannelHash = s.channelHash;
                if (this.client) {
                  this.client.unsubscribe([this.msgTopic(hash), this.presTopic(hash)]);
                }
                this.channels.delete(hash);
                break;
              }
            }

            // Subscribe to new topic (channelHash stays the same)
            this.channels.set(newHash, { channel: bump.channel, key: newKey, hash: newHash, channelHash: preservedChannelHash });
            this.channelKeys.set(bump.channel, bump.new_seed);
            if (this.client) {
              this.client.subscribe([this.msgTopic(newHash), this.presTopic(newHash)], { qos: 1 });
            }

            // Update config
            updateChannelEpoch(bump.channel, bump.new_seed, bump.new_epoch);

            // System message
            const removalInfo = bump.removed_fps?.length
              ? `Members removed: ${bump.removed_fps.join(", ")}`
              : "Manual key rotation";
            const sysMsg: Message = {
              id: randomBytes(4).toString("hex"),
              channel: bump.channel,
              sender: "system",
              content: `Channel key rotated to epoch ${bump.new_epoch}. ${removalInfo}`,
              timestamp: Date.now(),
              type: "system",
            };
            this.store.addMessage(sysMsg);
            if (this.onMessage) this.onMessage(sysMsg);
          }
        } catch {}
        return;
      }

            // Handle removal_notice DM — you were removed from a channel
      if (msg.type === "removal_notice") {
        try {
          const notice: RemovalNoticePayload = JSON.parse(msg.content);
          const reason = notice.reason ? ` Reason: ${notice.reason}` : "";
          const sysMsg: Message = {
            id: randomBytes(4).toString("hex"),
            channel: notice.channel,
            sender: "system",
            content: `You were removed from #${notice.channel} by ${notice.removed_by}.${reason}`,
            timestamp: Date.now(),
            type: "system",
          };
          this.store.addMessage(sysMsg);
          if (this.onMessage) this.onMessage(sysMsg);
        } catch {}
        return;
      }

      // Handle channel_meta messages — only accept from owner
      if (msg.type === "channel_meta") {
        try {
          const meta: ChannelMeta = JSON.parse(msg.content);
          const existing = this.channelMeta.get(state.channel);
          // First meta (no existing) or sender is one of the owners
          if (!existing || (msg.senderKey && existing.owners.includes(msg.senderKey))) {
            this.channelMeta.set(state.channel, meta);
            // Sync subchannels: join new ones, leave removed ones
            const rawKey = this.getChannelKeyString(state.channel);
            if (rawKey) {
              const metaSubs = new Set(meta.subchannels || []);

              // Leave subchannels no longer in meta
              for (const [hash, s] of this.channels) {
                if (s.channel === state.channel && s.subchannel && !metaSubs.has(s.subchannel)) {
                  if (this.client) {
                    this.client.unsubscribe([this.msgTopic(hash), this.presTopic(hash)]);
                  }
                  this.channels.delete(hash);
                  removeChannel(state.channel, s.subchannel);
                }
              }

              // Join new subchannels
              for (const sub of metaSubs) {
                const subKey = deriveSubKey(rawKey, sub);
                const subHash = hashSub(rawKey, sub);
                if (!this.channels.has(subHash)) {
                  this.channels.set(subHash, { channel: state.channel, subchannel: sub, key: subKey, hash: subHash, channelHash: subHash });
                  if (this.client) {
                    this.client.subscribe([this.msgTopic(subHash), this.presTopic(subHash)], { qos: 1 });
                  }
                }
              }
            }
            if (this.onMeta) this.onMeta(state.channel, meta);
          }
        } catch {}
        return;
      }

      this.store.addMessage(msg);
      this.store.updateMember(msg.sender, state.channel, state.subchannel, msg.senderKey);
      // Persist to cloud (best-effort)
      if (msg.type === "chat") {
        storeMessage(msg.id, state.channelHash, raw, msg.timestamp);
      }
      // Persist locally (if sync enabled)
      if (msg.type === "chat" && getSyncEnabled(state.channel, state.subchannel)) {
        try { this.localStore.appendMessage(msg); } catch {}
      }
      if (this.onMessage) {
        this.onMessage(msg);
      }
    } catch {
      // Decryption failed — wrong key or corrupted message, ignore
    }
  }

  private lastPresence: Map<string, string> = new Map(); // "name:channel" -> status

  private handlePresence(channel: string, payload: Buffer, subchannel?: string): void {
    try {
      const data = JSON.parse(payload.toString());
      const key = `${data.name}:${channel}`;
      const lastStatus = this.lastPresence.get(key);

      // Dedup: skip if same status as last
      if (lastStatus === data.status) return;
      this.lastPresence.set(key, data.status);

      // Skip own presence
      if (data.name === this.name) return;

      const label = subchannel ? `#${channel}/${subchannel}` : `#${channel}`;
      if (data.status === "online") {
        this.store.updateMember(data.name, channel, subchannel);
        const sysMsg: Message = {
          id: randomBytes(4).toString("hex"),
          channel,
          subchannel,
          sender: "system",
          content: `@${data.name} joined ${label}`,
          timestamp: Date.now(),
          type: "system",
        };
        this.store.addMessage(sysMsg);
        if (this.onMessage) this.onMessage(sysMsg);
      } else if (data.status === "offline") {
        this.store.removeMember(data.name, channel);
        // Leave is silent — no system message, no notification
      }
    } catch {
      // Ignore malformed presence
    }
  }

  private announcePresence(hash: string, status: "online" | "offline"): void {
    if (!this.client) return;
    this.client.publish(
      this.presTopic(hash),
      JSON.stringify({ name: this.name, status }),
      { qos: 1 }
    );
  }

  async send(content: string, channelName?: string, opts?: { subject?: string; tags?: string[] }): Promise<Message> {
    if (!this.client) throw new Error("Not connected");

    let target: ChannelState | undefined;
    if (channelName) {
      for (const state of this.channels.values()) {
        if (fullId(state) === channelName || state.channel === channelName) {
          target = state;
          break;
        }
      }
      if (!target) throw new Error(`Channel "${channelName}" not found`);
    } else {
      target = this.channels.values().next().value!;
    }

    // Announcement mode: only owners can send
    const meta = this.channelMeta.get(target.channel);
    if (meta?.mode === "announcement" && !meta.owners.includes(this.identity.fingerprint)) {
      throw new Error(`#${target.channel} is an announcement channel — only owners can send messages`);
    }

    const msg: Message = {
      id: randomBytes(8).toString("hex"),
      channel: target.channel,
      subchannel: target.subchannel,
      sender: this.name,
      content,
      subject: opts?.subject,
      tags: opts?.tags,
      timestamp: Date.now(),
      type: "chat",
      senderKey: this.identity.fingerprint,
    };

    // Sign the message (without signature field)
    const dataToSign = JSON.stringify(msg);
    msg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

    const encrypted = encrypt(JSON.stringify(msg), target.key);

    return new Promise((resolve, reject) => {
      this.client!.publish(
        this.msgTopic(target!.hash),
        JSON.stringify(encrypted),
        { qos: 1 },
        (err) => {
          if (err) reject(err);
          else resolve(msg);
        }
      );
    });
  }

  async joinChannel(config: { channel: string; subchannel?: string; key: string }): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    const key = config.subchannel ? deriveSubKey(config.key, config.subchannel) : deriveKey(config.key);
    const hash = config.subchannel ? hashSub(config.key, config.subchannel) : hashRoom(config.key);
    const channelHash = hash;
    if (this.channels.has(hash)) return;

    this.channels.set(hash, { channel: config.channel, subchannel: config.subchannel, key, hash, channelHash });
    if (!config.subchannel) this.channelKeys.set(config.channel, config.key);
    this.client.subscribe([this.msgTopic(hash), this.presTopic(hash)], { qos: 1 });
    this.announcePresence(hash, "online");
  }

  leaveChannel(channelName: string): void {
    if (!this.client) return;
    for (const [hash, state] of this.channels) {
      if (fullId(state) === channelName || state.channel === channelName) {
        this.client.unsubscribe([this.msgTopic(hash), this.presTopic(hash)]);
        this.announcePresence(hash, "offline");
        this.channels.delete(hash);
        return;
      }
    }
  }

  getChannels(): { channel: string; subchannel?: string }[] {
    return Array.from(this.channels.values()).map((s) => ({ channel: s.channel, subchannel: s.subchannel }));
  }

  private async loadHistory(): Promise<void> {
    for (const state of this.channels.values()) {
      try {
        const rows = await fetchHistory(state.hash, 0, 100);
        for (const row of rows) {
          // Skip if already in store
          if (this.store.getMessages(200).some((m) => m.id === row.id)) continue;
          try {
            const encrypted: EncryptedPayload = JSON.parse(row.ciphertext);
            const decrypted = decrypt(encrypted, state.key);
            const msg: Message = JSON.parse(decrypted);
            msg.channel = state.channel;
            msg.subchannel = state.subchannel;
            if (!msg.type) msg.type = "chat";
            if (msg.signature && msg.senderKey) {
              const { signature, trustLevel: _tl, ...msgWithoutSig } = msg;
              const dataToVerify = JSON.stringify(msgWithoutSig);
              const sigValid = verifySignature(dataToVerify, msg.signature, msg.senderKey);
              if (!sigValid) continue; // Skip messages with invalid signatures
              const trust = checkTrust(getFingerprint(msg.senderKey), msg.senderKey, msg.sender);
              msg.trustLevel = trust.level;
            } else {
              msg.trustLevel = "unsigned";
            }
            if (msg.type === "channel_meta") {
              try {
                const meta: ChannelMeta = JSON.parse(msg.content);
                this.channelMeta.set(state.channel, meta);
              } catch {}
              continue;
            }
            this.store.addMessage(msg);
            // Backfill local store from history
            if (msg.type === "chat" && getSyncEnabled(state.channel, state.subchannel)) {
              try { this.localStore.appendMessage(msg); } catch {}
            }
          } catch {
            // Can't decrypt — wrong key or corrupted
          }
        }
      } catch {
        // History fetch failed, continue without
      }
    }
  }

  setName(name: string): void {
    this.name = name;
  }

  setOnMessage(handler: (msg: Message) => void): void {
    this.onMessage = handler;
  }

  setOnMeta(handler: (channel: string, meta: ChannelMeta) => void): void {
    this.onMeta = handler;
  }

  getMeta(channel: string): ChannelMeta | undefined {
    return this.channelMeta.get(channel);
  }

  async publishMeta(channelName: string, meta: ChannelMeta): Promise<void> {
    if (!this.client) throw new Error("Not connected");

    let target: ChannelState | undefined;
    for (const state of this.channels.values()) {
      if (state.channel === channelName && !state.subchannel) {
        target = state;
        break;
      }
    }
    if (!target) throw new Error(`Channel "${channelName}" not found`);

    const msg: Message = {
      id: randomBytes(8).toString("hex"),
      channel: channelName,
      sender: this.name,
      content: JSON.stringify(meta),
      timestamp: Date.now(),
      type: "channel_meta",
      senderKey: this.identity.fingerprint,
    };

    const dataToSign = JSON.stringify(msg);
    msg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

    const encrypted = encrypt(JSON.stringify(msg), target.key);
    const raw = JSON.stringify(encrypted);

    return new Promise((resolve, reject) => {
      this.client!.publish(this.msgTopic(target!.hash), raw, { qos: 1 }, (err) => {
        if (err) reject(err);
        else {
          storeMessage(msg.id, target!.channelHash, raw, msg.timestamp);
          this.channelMeta.set(channelName, meta);
          resolve();
        }
      });
    });
  }

  // ── Kick / Epoch Rotation ───────────────────────────

  // Shared: broadcast epoch_bump DM to members + apply rotation locally
  private async broadcastEpochBump(channelName: string, recipients: Member[], bump: EpochBumpPayload): Promise<void> {
    if (!this.client) throw new Error("Not connected");

    // DM epoch_bump to each recipient
    for (const member of recipients) {
      if (!member.fingerprint || member.fingerprint === this.identity.fingerprint) continue;
      const dmMsg: Message = {
        id: randomBytes(8).toString("hex"),
        channel: `dm:${[this.identity.fingerprint, member.fingerprint].sort().join(":")}`,
        sender: this.name,
        content: JSON.stringify(bump),
        timestamp: Date.now(),
        type: "epoch_bump",
        senderKey: this.identity.fingerprint,
      };
      const dataToSign = JSON.stringify(dmMsg);
      dmMsg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

      const key = deriveDmKey(this.identity.fingerprint, member.fingerprint);
      const hash = hashDm(this.identity.fingerprint, member.fingerprint);
      const encrypted = encrypt(JSON.stringify(dmMsg), key);
      this.client.publish(this.msgTopic(hash), JSON.stringify(encrypted), { qos: 1 });
    }

    // Apply rotation locally (channelHash preserved — D1 key never changes)
    const newKey = deriveKey(bump.new_seed, bump.new_epoch);
    const newHash = hashRoom(bump.new_seed);

    let preservedChannelHash = "";
    for (const [hash, s] of this.channels) {
      if (s.channel === channelName && !s.subchannel) {
        preservedChannelHash = s.channelHash;
        this.client.unsubscribe([this.msgTopic(hash), this.presTopic(hash)]);
        this.channels.delete(hash);
        break;
      }
    }
    this.channels.set(newHash, { channel: channelName, key: newKey, hash: newHash, channelHash: preservedChannelHash });
    this.channelKeys.set(channelName, bump.new_seed);
    this.client.subscribe([this.msgTopic(newHash), this.presTopic(newHash)], { qos: 1 });
    updateChannelEpoch(channelName, bump.new_seed, bump.new_epoch);
  }

  async removeMember(channelName: string, targetFingerprint: string, opts?: { silent?: boolean; reason?: string }): Promise<void> {
    if (!this.client) throw new Error("Not connected");

    const meta = this.channelMeta.get(channelName);
    if (!meta || !meta.owners.includes(this.identity.fingerprint)) {
      throw new Error("Only channel owners can remove members");
    }

    const newSeed = randomBytes(32).toString("base64");
    const newEpoch = getChannelEpoch(channelName) + 1;
    const members = this.store.getMembers(channelName);
    const remaining = members.filter((m) => m.fingerprint && m.fingerprint !== targetFingerprint);

    await this.broadcastEpochBump(channelName, remaining, {
      channel: channelName,
      new_seed: newSeed,
      new_epoch: newEpoch,
      removed_fps: [targetFingerprint],
    });

    // Send removal_notice DM (unless --silent)
    if (!opts?.silent) {
      const noticePayload: RemovalNoticePayload = {
        channel: channelName,
        removed_at: Date.now(),
        removed_by: this.identity.fingerprint,
        reason: opts?.reason,
      };
      const noticeMsg: Message = {
        id: randomBytes(8).toString("hex"),
        channel: `dm:${[this.identity.fingerprint, targetFingerprint].sort().join(":")}`,
        sender: this.name,
        content: JSON.stringify(noticePayload),
        timestamp: Date.now(),
        type: "removal_notice",
        senderKey: this.identity.fingerprint,
      };
      const dataToSign = JSON.stringify(noticeMsg);
      noticeMsg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

      const key = deriveDmKey(this.identity.fingerprint, targetFingerprint);
      const hash = hashDm(this.identity.fingerprint, targetFingerprint);
      const encrypted = encrypt(JSON.stringify(noticeMsg), key);
      this.client.publish(this.msgTopic(hash), JSON.stringify(encrypted), { qos: 1 });
    }
  }

  async rotateChannel(channelName: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");

    const meta = this.channelMeta.get(channelName);
    if (!meta || !meta.owners.includes(this.identity.fingerprint)) {
      throw new Error("Only channel owners can rotate channel keys");
    }

    const newSeed = randomBytes(32).toString("base64");
    const newEpoch = getChannelEpoch(channelName) + 1;
    const members = this.store.getMembers(channelName);

    await this.broadcastEpochBump(channelName, members, {
      channel: channelName,
      new_seed: newSeed,
      new_epoch: newEpoch,
    });
  }

  // ── Retraction ──────────────────────────────────────

  async retractMessage(messageId: string, channelName?: string, reason?: string): Promise<Message> {
    if (!this.client) throw new Error("Not connected");

    // Find the target message
    const target = this.store.getMessageById(messageId);
    if (!target) throw new Error(`Message "${messageId}" not found`);

    // Verify ownership
    if (target.senderKey !== this.identity.fingerprint) {
      throw new Error("You can only retract your own messages");
    }

    // Verify 24h window
    const age = Date.now() - target.timestamp;
    if (age > 24 * 60 * 60 * 1000) {
      throw new Error("Retraction window expired (24h limit)");
    }

    const retraction: RetractionPayload = {
      target_id: messageId,
      retracted_at: Date.now(),
      reason,
    };

    const ch = channelName || target.channel;
    const targetChannel = target.subchannel ? `${target.channel}/${target.subchannel}` : target.channel;

    const msg: Message = {
      id: randomBytes(8).toString("hex"),
      channel: target.channel,
      subchannel: target.subchannel,
      sender: this.name,
      content: JSON.stringify(retraction),
      timestamp: Date.now(),
      type: "retraction",
      senderKey: this.identity.fingerprint,
    };

    const dataToSign = JSON.stringify(msg);
    msg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

    // Find the channel state for encryption
    let targetState: ChannelState | undefined;
    for (const state of this.channels.values()) {
      if (fullId(state) === targetChannel || state.channel === target.channel) {
        targetState = state;
        break;
      }
    }
    if (!targetState) throw new Error(`Channel not found for retraction`);

    const encrypted = encrypt(JSON.stringify(msg), targetState.key);

    return new Promise((resolve, reject) => {
      this.client!.publish(
        this.msgTopic(targetState!.hash),
        JSON.stringify(encrypted),
        { qos: 1 },
        (err) => {
          if (err) reject(err);
          else {
            this.store.addRetraction(messageId);
            resolve(msg);
          }
        }
      );
    });
  }

  // ── DM (Direct Message) support ──────────────────────

  async joinDm(theirFingerprint: string): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    const myFp = this.identity.fingerprint;
    const key = deriveDmKey(myFp, theirFingerprint);
    const hash = hashDm(myFp, theirFingerprint);
    const dmChannel = `dm:${[myFp, theirFingerprint].sort().join(":")}`;

    if (!this.channels.has(hash)) {
      this.channels.set(hash, { channel: dmChannel, key, hash, channelHash: hash });
      this.client.subscribe([this.msgTopic(hash)], { qos: 1 });
      // Load DM history
      try {
        const rows = await fetchHistory(hash, 0, 100);
        for (const row of rows) {
          if (this.store.getMessages(200).some((m) => m.id === row.id)) continue;
          try {
            const encrypted: EncryptedPayload = JSON.parse(row.ciphertext);
            const decrypted = decrypt(encrypted, key);
            const msg: Message = JSON.parse(decrypted);
            msg.channel = dmChannel;
            if (!msg.type) msg.type = "chat";
            if (msg.signature && msg.senderKey) {
              const { signature, trustLevel: _tl, ...msgWithoutSig } = msg;
              const dataToVerify = JSON.stringify(msgWithoutSig);
              const sigValid = verifySignature(dataToVerify, msg.signature, msg.senderKey);
              if (!sigValid) continue;
              const trust = checkTrust(getFingerprint(msg.senderKey), msg.senderKey, msg.sender);
              msg.trustLevel = trust.level;
            } else {
              msg.trustLevel = "unsigned";
            }
            this.store.addMessage(msg);
          } catch {}
        }
      } catch {}
    }
    return dmChannel;
  }

  async sendDm(theirFingerprint: string, content: string, opts?: { subject?: string; tags?: string[] }): Promise<Message> {
    if (!this.client) throw new Error("Not connected");
    const dmChannel = await this.joinDm(theirFingerprint);
    const myFp = this.identity.fingerprint;
    const key = deriveDmKey(myFp, theirFingerprint);
    const hash = hashDm(myFp, theirFingerprint);

    const msg: Message = {
      id: randomBytes(8).toString("hex"),
      channel: dmChannel,
      sender: this.name,
      content,
      subject: opts?.subject,
      tags: opts?.tags,
      timestamp: Date.now(),
      type: "chat",
      senderKey: this.identity.fingerprint,
    };

    const dataToSign = JSON.stringify(msg);
    msg.signature = signMessage(dataToSign, this.identity.privateKeyPem);

    const encrypted = encrypt(JSON.stringify(msg), key);

    return new Promise((resolve, reject) => {
      this.client!.publish(
        this.msgTopic(hash),
        JSON.stringify(encrypted),
        { qos: 1 },
        (err) => {
          if (err) reject(err);
          else {
            storeMessage(msg.id, hash, JSON.stringify(encrypted), msg.timestamp);
            resolve(msg);
          }
        }
      );
    });
  }

  getDmChannels(): { channel: string; theirFingerprint: string }[] {
    const results: { channel: string; theirFingerprint: string }[] = [];
    const myFp = this.identity.fingerprint;
    for (const state of this.channels.values()) {
      if (state.channel.startsWith("dm:")) {
        const parts = state.channel.replace("dm:", "").split(":");
        const theirFp = parts.find((fp) => fp !== myFp) || parts[0];
        results.push({ channel: state.channel, theirFingerprint: theirFp });
      }
    }
    return results;
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    if (!this.silent) {
      for (const [hash] of this.channels) {
        this.announcePresence(hash, "offline");
      }
    }
    return new Promise((resolve) => {
      this.client!.end(false, () => resolve());
    });
  }
}
