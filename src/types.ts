export interface Message {
  id: string;
  channel: string;
  subchannel?: string;   // ##subchannel name (if in a subchannel)
  sender: string;
  content: string;
  timestamp: number;
  subject?: string;      // One-line summary (set by sender)
  tags?: string[];       // Message tags for filtering (e.g. ["bug", "p0"])
  replyTo?: string;      // Message ID this is replying to (for threads)
  format?: "text" | "markdown"; // Content format (default: markdown)
  type?: "chat" | "system" | "action_request" | "channel_meta";
  senderKey?: string;    // Ed25519 public key fingerprint (12 hex chars)
  signature?: string;    // Base64 Ed25519 signature
  trustLevel?: string;   // Set by receiver: tofu | verified | new | revoked | unsigned
}

export interface Member {
  name: string;
  channel: string;
  subchannel?: string;
  joinedAt: number;
  lastActive: number;
  fingerprint?: string;
}

export interface ChannelConfig {
  channel: string;
  subchannel?: string;
  key: string;
}

export interface ChatConfig {
  channels: ChannelConfig[];
  name: string;
  broker?: string;
  silent?: boolean;
}

export interface SingleChannelConfig {
  channel: string;
  subchannel?: string;
  name: string;
  key: string;
  broker?: string;
  silent?: boolean;
}

export interface ChannelMeta {
  name: string;
  description?: string;    // channel description (short)
  readme?: string;         // channel readme (full markdown, shown at top)
  subchannels: string[];
  descriptions?: Record<string, string>; // subchannel name -> description
  owners: string[];        // fingerprints of channel owners (first = creator)
  created: number;         // timestamp
  public?: boolean;        // true = auto-approve joins, false = owner must approve
  listed?: boolean;        // true = visible in registry (public yellow pages)
  tags?: string[];         // channel tags for registry search
}

export interface EncryptedPayload {
  iv: string;
  data: string;
  tag: string;
}

export interface WebhookConfig {
  id: string;
  channel: string;
  subchannel?: string;
  tags?: string[];       // trigger only on these tags
  senders?: string[];    // fingerprint whitelist
  url: string;           // POST target
}

export interface HandoffConfig {
  id: string;
  channel: string;
  subchannel?: string;
  tags?: string[];       // default: ["handoff-request"]
  senders?: string[];    // fingerprint whitelist
  url: string;           // POST target
  mode?: "ask" | "auto"; // ask = require approval (default), auto = execute immediately
  output?: string;       // channel/subchannel for ack/done replies (default: same channel)
}
