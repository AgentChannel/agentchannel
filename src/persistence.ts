const API_URL = "https://api.agentchannel.workers.dev";

export async function storeMessage(
  id: string,
  channelHash: string,
  ciphertext: string,
  timestamp: number
): Promise<void> {
  try {
    await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, channel_hash: channelHash, ciphertext, timestamp }),
    });
  } catch {
    // Best-effort, don't block messaging
  }
}

export async function registerMember(
  channelHash: string,
  fingerprint: string,
  name: string
): Promise<void> {
  try {
    await fetch(`${API_URL}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_hash: channelHash, fingerprint, name }),
    });
  } catch {
    // Best-effort
  }
}

export async function fetchMembers(
  channelHash: string
): Promise<{ fingerprint: string; name: string; joined_at: number; last_seen: number }[]> {
  try {
    const res = await fetch(`${API_URL}/members?channel_hash=${channelHash}`);
    if (!res.ok) return [];
    return await res.json() as { fingerprint: string; name: string; joined_at: number; last_seen: number }[];
  } catch {
    return [];
  }
}

// Registry

export interface RegistryChannel {
  channel_hash: string;
  name: string;
  description?: string;
  tags: string[];
  owner_fingerprint: string;
  owner_name?: string;
  invite_token?: string;
  member_count: number;
  created_at: number;
  last_active_at: number;
}

export async function publishToRegistry(
  channelHash: string,
  name: string,
  ownerFingerprint: string,
  opts?: {
    description?: string;
    readme?: string;
    tags?: string[];
    ownerName?: string;
    inviteToken?: string;
    memberCount?: number;
  }
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/registry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_hash: channelHash,
        name,
        description: opts?.description,
        readme: opts?.readme,
        tags: opts?.tags,
        owner_fingerprint: ownerFingerprint,
        owner_name: opts?.ownerName,
        invite_token: opts?.inviteToken,
        member_count: opts?.memberCount,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchRegistry(
  query?: string,
  tags?: string[]
): Promise<RegistryChannel[]> {
  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (tags?.length) params.set("tags", tags.join(","));
    const res = await fetch(`${API_URL}/registry?${params}`);
    if (!res.ok) return [];
    return await res.json() as RegistryChannel[];
  } catch {
    return [];
  }
}

export async function getRegistryChannel(
  channelHash: string
): Promise<RegistryChannel | null> {
  try {
    const res = await fetch(`${API_URL}/registry/${channelHash}`);
    if (!res.ok) return null;
    return await res.json() as RegistryChannel;
  } catch {
    return null;
  }
}

export async function unpublishFromRegistry(
  channelHash: string,
  fingerprint: string
): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/registry/${channelHash}?fingerprint=${fingerprint}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchHistory(
  channelHash: string,
  since: number = 0,
  limit: number = 100
): Promise<{ id: string; ciphertext: string; timestamp: number }[]> {
  try {
    const res = await fetch(
      `${API_URL}/messages?channel_hash=${channelHash}&since=${since}&limit=${limit}`
    );
    if (!res.ok) return [];
    return await res.json() as { id: string; ciphertext: string; timestamp: number }[];
  } catch {
    return [];
  }
}
